import { afterEach, describe, expect, it } from 'vitest';
import { setup, sourceKey, build } from './__fixtures__/exact-source';
import { verifyExactReceipts } from './receipts';
import { digest } from './stream';
import { resetModelParams } from '../../web/src/eta/params';
import { registerRoutePaths } from '../../web/src/anchor';
import { horizonOf } from '../reestimate-lib.mjs';

afterEach(() => { resetModelParams(); registerRoutePaths(null); });
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
describe('original seed and exact-input receipt verification', () => {
  it('verifies all source observations even when a sampled HTTP view contains no new frame', () => {
    const f = fixture(); expect(verifyExactReceipts(f.state, [f.row], f.records, f.f.seed)).toMatchObject({ framesVerified: 3, sampledCursorsVerified: 1 });
  });
  it.each(['missing-frame', 'changed-frame', 'changed-context', 'changed-row-chain', 'changed-runtime-model', 'missing-http'])
  ('refuses %s without accepting annotated control metadata as proof', mode => {
    const f = fixture();
    if (mode === 'missing-frame') f.records.splice(1, 1);
    if (mode === 'changed-frame') f.records[0]!.input.source.frames[0].json += ' ';
    if (mode === 'changed-context') f.records[0]!.input.source.frames[0].contextJson += ' ';
    if (mode === 'changed-row-chain') (f.row.champion.control.source as any).chain = 'a'.repeat(64);
    if (mode === 'changed-runtime-model') (f.row.champion.control.source as any).challengerModel = 'a'.repeat(64);
    if (mode === 'missing-http') f.records.pop();
    for (const r of f.records) r.raw = JSON.stringify(r.input);
    expect(() => verifyExactReceipts(f.state, [f.row], f.records, f.f.seed)).toThrow();
  });
  it('accepts identical crash-replay input receipts but rejects conflicting duplicates', () => {
    const f = fixture(); f.records.splice(1, 0, structuredClone(f.records[0]!));
    expect(verifyExactReceipts(f.state, [f.row], f.records, f.f.seed).framesVerified).toBe(3);
    const changed = f.records[1]!.input.source.frames[0]; changed.observationVersion++;
    f.records[1]!.raw = JSON.stringify(f.records[1]!.input);
    expect(() => verifyExactReceipts(f.state, [f.row], f.records, f.f.seed)).toThrow('Conflicting');
  });
});
