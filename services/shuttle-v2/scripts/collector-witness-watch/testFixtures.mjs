import { CollectorWitnessJournal } from '../../src/collector/witnessJournal.ts';
import { witnessJSON, witnessSHA } from '../../src/collector/witnessCodec.ts';

export function fixture({ epoch = 'collector-test', maxFrames = 720 } = {}) {
  const journal = new CollectorWitnessJournal({ epoch, maxFrames });
  const topology = CollectorWitnessJournal.topology({
    stops: new Map([[1, { id: 1, lat: 41.3, lon: -72.9 }], [2, { id: 2, lat: 41.304, lon: -72.9 }]]),
    routes: new Map(), segmentEdges: new Map(), walkTransfers: new Map(), routeStopIndex: new Map(), routeStopPositions: new Map(), legMeters: new Map(),
  });
  const state = witnessJSON({ visits: new Map(), detector: new Map() });
  let at = 10000000;
  function add(extra = {}) {
    at += 5000;
    return journal.append(at, { v: 1, origin: 'live-collector', at, pollResult: 'completed', observations: [],
      stateBeforeJSON: state, stateBeforeSHA256: witnessSHA(state), stateAfterJSON: state, stateAfterSHA256: witnessSHA(state),
      sourceWriteEvidence: 'recorded', sourceWrites: [], ...extra }, topology);
  }
  const head = () => ({ ...journal.head(at), build: 'test-build', evaluationEpoch: 'model-test', evaluationCursor: 0 });
  const page = (after = 0, limit = 16) => ({ ...journal.read(epoch, after, { now: at, limit }), build: 'test-build', evaluations: [] });
  return { journal, topology, add, head, page, get at() { return at; } };
}
export function association(frame) {
  return { collectorEpoch: 'collector-test', collectorSeq: frame.seq, collectorSHA256: frame.sha256,
    evaluation: { epoch: 'model-test', cursor: frame.seq, at: frame.at, sha256: 'a'.repeat(64), contextSha256: 'b'.repeat(64) } };
}
