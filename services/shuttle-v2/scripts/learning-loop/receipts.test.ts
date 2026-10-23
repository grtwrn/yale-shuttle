import { afterEach, describe, expect, it } from 'vitest';
import { setup, sourceKey, build } from './__fixtures__/exact-source';
import { verifyExactReceipts, verifyExactReceiptsAsync } from './receipts';
import { digest } from './stream';
import { resetModelParams } from '../../web/src/eta/params';
import { registerRoutePaths } from '../../web/src/anchor';
import { horizonOf } from '../reestimate-lib.mjs';
import { observe, recordForecast } from './lib.mjs';

afterEach(() => { resetModelParams(); registerRoutePaths(null); });
async function* asynchronously(records: any[]) { for (const record of records) { await Promise.resolve(); yield record; } }
function fixture() {
  const f = setup(), initialChain = f.stream.chain, records: { raw: string; input: any }[] = [];
  const retain = (packet: unknown) => {
    const input = { receivedAt: f.clock(), source: structuredClone(packet) }, raw = JSON.stringify(input); records.push({ input, raw }); return digest(raw);
  };
  for (let i = 5; i < 8; i++) {
    f.publish(i); const packet = f.source.read(f.stream.epoch, f.stream.cursor); retain(packet); f.stream.advance(packet);
  }
  const live = f.source.read(f.stream.epoch, f.stream.cursor), hash = retain(live), forecasts = f.stream.sample(live.feed, f.clock());
  const p = forecasts.champion.find(p => p.eta > 120 && p.eta < 1800)!, b = forecasts.challenger.find(b => b.bus.bus_id === p.bus.bus_id && b.stop === p.stop)!;
  const row = { at: f.clock(), phase: 'calibration', r: p.bus.route_id, busId: p.bus.bus_id, busName: p.bus.bus_name,
    stop: p.stop, h: horizonOf(p.eta, 1800), inputHash: hash, champion: p, challenger: b, det: null };
  const state = { id: 'candidate', sourceKey, productionBuild: build, startedAt: f.seed.at + 1, champion: f.champion,
    candidate: { params: f.candidate.params }, source: { seedSha256: f.stream.seedSha256, epoch: f.seed.epoch,
      seedCursor: f.seed.cursor, seedAt: f.seed.at, seedReceivedAt: f.seed.at, initialChain } };
  return { f, records, row, state };
}
function matchedFixture() {
  const f = fixture();
  const row = { ...f.row, det: 10, arrivedAt: f.row.at + 10000, availableAt: f.row.at + 20000,
    arrivalInputHash: '', outcomeInputHash: '' };
  const receipts = [10000, 20000].map(delta => {
    const input = structuredClone(f.records.at(-1)!.input), time = row.at + delta;
    input.receivedAt = time; input.source.responseAt = time;
    const bus = input.source.feed.buses.find((b: any) => b.bus_id === row.busId && b.route_id === row.r && b.bus_name === row.busName);
    Object.assign(bus, input.source.feed.stop_coords[row.stop], { observed_at: time, stationary: true, at_stop_id: row.stop });
    const receipt = { input, raw: '' }; f.records.push(receipt); return receipt;
  });
  function rehash() {
    for (const receipt of receipts) receipt.raw = JSON.stringify(receipt.input);
    row.arrivalInputHash = digest(receipts[0]!.raw); row.outcomeInputHash = digest(receipts[1]!.raw);
  }
  rehash();
  const bus = (i: number) => receipts[i]!.input.source.feed.buses.find((b: any) => b.bus_id === row.busId && b.bus_name === row.busName);
  return { ...f, row, receipts, rehash, bus };
}
describe('original seed and exact-input receipt verification', () => {
  it('verifies all source observations even when a sampled HTTP view contains no new frame', async () => {
    const f = fixture(), expected = verifyExactReceipts(f.state, [f.row], f.records, f.f.seed); expect(expected).toMatchObject({ framesVerified: 3, sampledCursorsVerified: 1 });
    expect(await verifyExactReceiptsAsync(f.state, [f.row], asynchronously(f.records), f.f.seed)).toEqual(expected);
  });
  it('refuses a claimed arrival supported only by an unrelated retained forecast receipt', async () => {
    const f = fixture();
    const row = { ...f.row, det: 1, arrivedAt: f.row.at + 1000, availableAt: f.row.at + 10000,
      arrivalInputHash: f.row.inputHash, outcomeInputHash: f.row.inputHash };
    expect(() => verifyExactReceipts(f.state, [row], f.records, f.f.seed)).toThrow();
    await expect(verifyExactReceiptsAsync(f.state, [row], asynchronously(f.records), f.f.seed)).rejects.toThrow();
  });
  it('binds a matched wait to two distinct fresh live curb observations in both readers', async () => {
    const f = matchedFixture(), expected = verifyExactReceipts(f.state, [f.row], f.records, f.f.seed);
    expect(expected).toMatchObject({ framesVerified: 3, sampledCursorsVerified: 1 });
    expect(await verifyExactReceiptsAsync(f.state, [f.row], asynchronously(f.records), f.f.seed)).toEqual(expected);
    f.records.push(structuredClone(f.receipts[0]!));
    expect(verifyExactReceipts(f.state, [f.row], f.records, f.f.seed)).toEqual(expected);
  });
  it('accepts the actual outcome matcher output without substituting annotated times', () => {
    const f = matchedFixture(), visits = { pending: {}, visits: {} };
    recordForecast(visits, f.row.champion.bus, f.row.stop, f.row.at, f.row.champion, f.row.challenger, f.row.phase, f.row.inputHash);
    expect(observe(visits, f.receipts[0]!.input.source.feed, f.receipts[0]!.input.receivedAt, f.row.arrivalInputHash)).toEqual([]);
    const rows = observe(visits, f.receipts[1]!.input.source.feed, f.receipts[1]!.input.receivedAt, f.row.outcomeInputHash);
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ det: 10, arrivedAt: f.row.arrivedAt, availableAt: f.row.availableAt });
    expect(verifyExactReceipts(f.state, rows, f.records, f.f.seed).framesVerified).toBe(3);
  });
  it('refuses a curb observation taken from a model catchup response', async () => {
    const f = matchedFixture();
    f.receipts[0]!.input.source.frames = structuredClone(f.records[2]!.input.source.frames); f.rehash();
    expect(() => verifyExactReceipts(f.state, [f.row], f.records, f.f.seed)).toThrow('curb receipt');
    await expect(verifyExactReceiptsAsync(f.state, [f.row], asynchronously(f.records), f.f.seed)).rejects.toThrow('curb receipt');
  });
  it.each(['route', 'provider', 'name', 'stop', 'moving', 'distance', 'coordinate', 'stale', 'confirmation-moving'])
  ('refuses rehashed outcome bodies with invalid %s evidence', async mode => {
    const f = matchedFixture(), bus = f.bus(mode === 'confirmation-moving' ? 1 : 0);
    if (mode === 'route') bus.route_id++;
    if (mode === 'provider') bus.bus_id++;
    if (mode === 'name') bus.bus_name += '-other';
    if (mode === 'stop') bus.at_stop_id++;
    if (mode === 'moving' || mode === 'confirmation-moving') bus.stationary = false;
    if (mode === 'distance') bus.lat += .002;
    if (mode === 'coordinate') delete f.receipts[0]!.input.source.feed.stop_coords[f.row.stop];
    if (mode === 'stale') bus.observed_at -= 30001;
    f.rehash();
    expect(() => verifyExactReceipts(f.state, [f.row], f.records, f.f.seed)).toThrow('curb receipt');
    await expect(verifyExactReceiptsAsync(f.state, [f.row], asynchronously(f.records), f.f.seed)).rejects.toThrow('curb receipt');
  });
  it.each(['arrivedAt', 'availableAt', 'det', 'too-soon', 'pre-forecast-receipt', 'reversed-receipts', 'same-receipt'])
  ('refuses outcome timing inconsistent with retained observations: %s', async mode => {
    const f = matchedFixture();
    if (mode === 'arrivedAt') f.row.arrivedAt++;
    if (mode === 'availableAt') f.row.availableAt++;
    if (mode === 'det') f.row.det++;
    if (mode === 'too-soon') f.bus(1).observed_at = f.bus(0).observed_at + 8999;
    if (mode === 'pre-forecast-receipt') f.receipts[0]!.input.receivedAt = f.row.at - 1;
    if (mode === 'reversed-receipts') f.receipts[1]!.input.receivedAt = f.row.at + 9000;
    for (const receipt of f.receipts) receipt.input.source.responseAt = Math.max(f.row.at, receipt.input.receivedAt);
    f.rehash();
    if (mode === 'same-receipt') f.row.outcomeInputHash = f.row.arrivalInputHash;
    expect(() => verifyExactReceipts(f.state, [f.row], f.records, f.f.seed)).toThrow('Scored curb outcome');
    await expect(verifyExactReceiptsAsync(f.state, [f.row], asynchronously(f.records), f.f.seed)).rejects.toThrow('Scored curb outcome');
  });
  it.each(['missing-frame', 'changed-frame', 'changed-context', 'changed-row-chain', 'changed-runtime-model', 'missing-http'])
  ('refuses %s without accepting annotated control metadata as proof', async mode => {
    const f = fixture();
    if (mode === 'missing-frame') f.records.splice(1, 1);
    if (mode === 'changed-frame') f.records[0]!.input.source.frames[0].json += ' ';
    if (mode === 'changed-context') f.records[0]!.input.source.frames[0].contextJson += ' ';
    if (mode === 'changed-row-chain') (f.row.champion.control.source as any).chain = 'a'.repeat(64);
    if (mode === 'changed-runtime-model') (f.row.champion.control.source as any).challengerModel = 'a'.repeat(64);
    if (mode === 'missing-http') f.records.pop();
    for (const r of f.records) r.raw = JSON.stringify(r.input);
    expect(() => verifyExactReceipts(f.state, [f.row], f.records, f.f.seed)).toThrow();
    await expect(verifyExactReceiptsAsync(f.state, [f.row], asynchronously(f.records), f.f.seed)).rejects.toThrow();
  });
  it('accepts identical crash-replay input receipts but rejects conflicting duplicates', async () => {
    const f = fixture(); f.records.splice(1, 0, structuredClone(f.records[0]!));
    expect(verifyExactReceipts(f.state, [f.row], f.records, f.f.seed).framesVerified).toBe(3);
    expect((await verifyExactReceiptsAsync(f.state, [f.row], asynchronously(f.records), f.f.seed)).framesVerified).toBe(3);
    const changed = f.records[1]!.input.source.frames[0]; changed.observationVersion++;
    f.records[1]!.raw = JSON.stringify(f.records[1]!.input);
    expect(() => verifyExactReceipts(f.state, [f.row], f.records, f.f.seed)).toThrow('Conflicting');
    await expect(verifyExactReceiptsAsync(f.state, [f.row], asynchronously(f.records), f.f.seed)).rejects.toThrow('Conflicting');
  });
  it('refuses a late read failure after all required records were yielded', async () => {
    const f = fixture(); async function* failed() { yield* asynchronously(f.records); throw Error('late retained-file read failure'); }
    await expect(verifyExactReceiptsAsync(f.state, [f.row], failed(), f.f.seed)).rejects.toThrow('late retained-file read failure');
  });
  it('closes an asynchronous input iterator when receipt validation fails', async () => {
    const f = fixture(); let closed = false; f.records[0]!.input.source.frames[0].json += ' ';
    async function* invalid() { try { yield* asynchronously(f.records); } finally { closed = true; } }
    await expect(verifyExactReceiptsAsync(f.state, [f.row], invalid(), f.f.seed)).rejects.toThrow(); expect(closed).toBe(true);
  });
});
