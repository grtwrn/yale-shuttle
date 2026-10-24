import { digest, initialSourceChain, modelKey, nextSourceChain, validateExactFrame } from './stream';
import { MATCH_MS, productionControlInputValid, qualificationUsesFinalIntervals,UNIT } from './lib.mjs';
import { haversineM } from '../canary-metrics.mjs';

type CurbEvidence = { observedAt: number; receivedAt: number };

/** Check the live curb observation itself, independently of the scored row.
 * Catchup frames advance model history but never supply observed arrivals. */
function curbEvidence(row: any, input: any): CurbEvidence | null {
  const packet = input.source, feed = packet?.feed;
  const buses = feed?.buses?.filter((bus: any) => bus.route_id === row.r && bus.bus_id === row.busId && bus.bus_name === row.busName);
  const bus = buses?.length === 1 ? buses[0] : null, coord = feed?.stop_coords?.[row.stop];
  if (packet?.hasMore !== false || packet.cursor !== packet.latest || packet.frames?.length !== 0
    || !bus || !coord || bus.at_stop_id !== row.stop || bus.stationary !== true
    || ![bus.lat, bus.lon, coord.lat, coord.lon, bus.observed_at, input.receivedAt].every(Number.isFinite)
    || Math.abs(input.receivedAt - bus.observed_at) > 30000 || haversineM(bus, coord) > 75)
    return null;
  return { observedAt: bus.observed_at, receivedAt: input.receivedAt };
}

/** Rebuild the full seed -> input chain from retained HTTP receipts, not from
 * row annotations. Only small digests and requested sample cursors are kept. */
function exactReceiptVerifier(state: any, rows: any[], seed: any) {
  const seedSha256 = digest(JSON.stringify(seed));
  if (seedSha256 !== state.source?.seedSha256 || seed.build !== state.productionBuild || seed.epoch !== state.source.epoch
    || seed.cursor !== state.source.seedCursor || seed.at !== state.source.seedAt || state.source.seedReceivedAt > state.startedAt
    || modelKey(seed.modelParams) !== modelKey(state.champion)) throw Error('Original source seed identity is missing or changed');
  let cursor = seed.cursor, at = seed.at, version = seed.observationVersion, chain = initialSourceChain(seed, seedSha256, state.sourceKey);
  if (chain !== state.source.initialChain) throw Error('Original source chain changed');
  const qualification=state.contextQualification;
  if(state.trial&&(Boolean(state.contextQualifiedAt)!==Boolean(qualification)
    ||qualification&&(!Number.isSafeInteger(qualification.at)||qualification.at!==state.contextQualifiedAt||qualification.at<state.startedAt)))
    throw Error('Context qualification clock/receipt is inconsistent');
  if(state.trial&&rows.length&&!qualification)throw Error('Forecast context lacks positive served-control qualification');
  const needed = new Set(rows.map(r => r.champion?.control?.source?.cursor)), chains = new Map<number, any>();
  if(qualification)needed.add(qualification.source?.cursor);
  const recent = new Map<number, string>(), controls = new Map<string, any[]>(), inputs = new Set<string>();
  const curbs = new Map<string, { row: any; kind: 'arrival' | 'outcome' }[]>();
  const evidence = new Map<any, Partial<Record<'arrival' | 'outcome', CurbEvidence>>>();
  let qualificationInput=false;
  if(qualification){
    if(!qualification.inputHash)throw Error('Missing context qualification input');
    inputs.add(qualification.inputHash);
  }
  for (const row of rows) {
    if (!row.inputHash) throw Error('Missing exact forecast input receipt');
    const group = controls.get(row.inputHash) ?? []; group.push(row); controls.set(row.inputHash, group); inputs.add(row.inputHash);
    if (row.det !== null) {
      if (!row.arrivalInputHash || !row.outcomeInputHash) throw Error('Missing exact curb outcome receipts');
      inputs.add(row.arrivalInputHash); inputs.add(row.outcomeInputHash);
      for (const [kind, hash] of [['arrival', row.arrivalInputHash], ['outcome', row.outcomeInputHash]] as const) {
        const group = curbs.get(hash) ?? []; group.push({ row, kind }); curbs.set(hash, group);
      }
    }
  }
  function accept({ raw, input }: any) {
    const hash = digest(raw);
    if(qualification&&hash===qualification.inputHash){
      const packet=input.source,control=qualification.productionControl;
      if(input.receivedAt!==qualification.at||state.contextQualifiedAt!==qualification.at||qualification.at<state.startedAt
        ||packet?.frames?.length!==0||packet.hasMore!==false||packet.cursor!==packet.latest
        ||packet.cursor!==qualification.source.cursor||packet.feed?.server_eta?.at!==qualification.source.at
        ||!Array.isArray(packet.feed?.server_eta?.rows)||!packet.feed.server_eta.rows.length
        ||!Number.isSafeInteger(control?.compared)||control.compared<=0||control.matched!==control.compared
        ||control.missing!==0||control.mismatched!==0||control.modelAt!==qualification.source.at)
        throw Error('Context qualification differs from its positive caught-up served control');
      qualificationInput=true;
    }
    if (controls.has(hash)) {
      for (const row of controls.get(hash)!) {
        if (!productionControlInputValid(row, input)) throw Error('Exact control differs from its retained HTTP input');
        if (input.source?.frames?.length !== 0) throw Error('Forecast must come from a caught-up live response');
        if (curbEvidence(row, input)) throw Error('Forecast already contains curb evidence for its target visit');
      }
      controls.delete(hash);
    }
    inputs.delete(hash);
    const packet = input.source;
    if (!packet || packet.v !== 1 || packet.epoch !== seed.epoch || packet.build !== seed.build
      || !Number.isSafeInteger(packet.cursor) || !Number.isSafeInteger(packet.latest) || packet.latest < packet.cursor
      || packet.hasMore !== (packet.cursor < packet.latest) || !Array.isArray(packet.frames) || packet.frames.length > 16
      || !Number.isSafeInteger(packet.responseAt) || packet.responseAt < at || packet.responseAt > input.receivedAt + 5000
      || (packet.hasMore ? packet.feed !== null : !packet.feed)) throw Error('Invalid retained exact source packet');
    let within = packet.cursor - packet.frames.length;
    for (const frame of packet.frames) {
      if (frame.seq !== ++within || frame.seq <= seed.cursor) throw Error('Invalid retained source sequence');
      validateExactFrame(frame, state.champion);
      if(frame.at>packet.responseAt)throw Error('Retained source frame is newer than its response');
      const fingerprint = digest(JSON.stringify([frame.seq, frame.at, frame.observationVersion, frame.sha256, frame.contextSha256]));
      if (frame.seq <= cursor) {
        if (recent.get(frame.seq) !== fingerprint) throw Error('Conflicting or unretained duplicate source frame');
        continue;
      }
      if (frame.seq !== cursor + 1 || frame.at <= at || frame.observationVersion <= version) throw Error('A required exact source observation is missing');
      cursor = frame.seq; at = frame.at; version = frame.observationVersion; chain = nextSourceChain(chain, frame); recent.set(cursor, fingerprint);
      while (recent.size > 256) recent.delete(recent.keys().next().value!);
      if (needed.has(cursor)) chains.set(cursor, { at, chain, sha256: frame.sha256, contextSha256: frame.contextSha256, observationVersion: frame.observationVersion });
    }
    if (packet.cursor > cursor) throw Error('HTTP cursor advanced without retained model input');
    for (const { row, kind } of curbs.get(hash) ?? []) {
      const curb = curbEvidence(row, input);
      if (!curb) throw Error('Retained curb receipt does not show the named bus stationary at the target stop');
      const pair = evidence.get(row) ?? {}; pair[kind] = curb; evidence.set(row, pair);
    }
    curbs.delete(hash);
  }
  function finish() {
    if (inputs.size || controls.size) throw Error('Required exact forecast/outcome HTTP inputs are missing');
    if(qualification){
      const s=qualification.source,recorded=chains.get(s.cursor);
      const final=qualificationUsesFinalIntervals(state,qualification);
      const candidate={version:state.trial?.id??state.id,params:{...state.candidate.params,CONFORMAL:final?state.candidate.params.CONFORMAL:UNIT}};
      if(!qualificationInput||!recorded||s.seedSha256!==seedSha256||s.epoch!==seed.epoch||s.build!==seed.build||s.sourceKey!==state.sourceKey
        ||Object.entries(recorded).some(([key,value])=>s[key]!==value)||s.championModel!==modelKey(state.champion)
        ||s.challengerModel!==modelKey(candidate))throw Error('Context qualification is not bound to its original exact source chain/models');
    }
    for (const row of rows) {
      if (row.det !== null) {
        const { arrival, outcome } = evidence.get(row) ?? {};
        if (!arrival || !outcome || ![row.at, row.arrivedAt, row.availableAt, row.det].every(Number.isFinite)
          || arrival.receivedAt < row.at || outcome.receivedAt < arrival.receivedAt
          || outcome.observedAt - arrival.observedAt < 9000 || row.arrivedAt !== arrival.observedAt
          || row.availableAt !== outcome.receivedAt || row.det !== (arrival.observedAt - row.at) / 1000
          || row.det < 0 || row.det * 1000 > MATCH_MS)
          throw Error('Scored curb outcome differs from its two prospective retained observations');
      }
      const s = row.champion?.control?.source, recorded = s && chains.get(s.cursor);
      const candidate = { version: state.trial?.id ?? state.id, params: { ...state.candidate.params, CONFORMAL: row.phase === 'calibration' ? UNIT : state.candidate.params.CONFORMAL } };
      if (!recorded || s.seedSha256 !== seedSha256 || s.epoch !== seed.epoch || s.build !== seed.build || s.sourceKey !== state.sourceKey
        || Object.entries(recorded).some(([key, value]) => s[key] !== value)
        || s.championModel !== modelKey(state.champion) || s.challengerModel !== modelKey(candidate)
        || row.champion.runtimeIntervals !== true || (!row.challenger?.missing && row.challenger?.runtimeIntervals !== true))
        throw Error('Sample is not bound to the frozen seed, complete source chain and actual runtime models');
    }
    return { framesVerified: cursor - seed.cursor, lastCursor: cursor, sampledCursorsVerified: chains.size };
  }
  return { accept, finish };
}

export function verifyExactReceipts(state: any, rows: any[], records: Iterable<any>, seed: any) {
  const verifier = exactReceiptVerifier(state, rows, seed);
  for (const record of records) verifier.accept(record);
  return verifier.finish();
}

export async function verifyExactReceiptsAsync(state: any, rows: any[], records: AsyncIterable<any> | Iterable<any>, seed: any) {
  const verifier = exactReceiptVerifier(state, rows, seed);
  for await (const record of records) verifier.accept(record);
  return verifier.finish();
}
