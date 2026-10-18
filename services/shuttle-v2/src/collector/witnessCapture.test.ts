import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type DbBundle } from '../db/client';
import { TransitNetwork } from '../network/TransitNetwork';
import { CollectorWitnessCapture, type SourceMutation } from './witnessCapture';
import { CollectorWitnessJournal } from './witnessJournal';
import { witnessJSON } from './witnessCodec';

const network = () => TransitNetwork.build([
  { id: 1, name: 'A', lat: 41.3, lon: -72.9 }, { id: 2, name: 'B', lat: 41.31, lon: -72.9 },
], [{ id: 4, name: 'Loop', shortName: 'L', color: '#123', stops: [1, 2, 1] }]);
let bundle: DbBundle;
beforeEach(() => { bundle = openDb(':memory:'); migrate(bundle.db, { migrationsFolder: './drizzle' }); });
afterEach(() => { bundle.sqlite.close(); vi.restoreAllMocks(); });
function insert() {
  const r = bundle.sqlite.prepare("INSERT INTO arrivals(bus_id,bus_name,route_id,stop_id,arrived_at,dow,hour) VALUES(7,'#7',4,1,1000,0,0)").run();
  const after = bundle.sqlite.prepare('SELECT * FROM arrivals WHERE id=?').get(r.lastInsertRowid) as Record<string, unknown>;
  return { value: Number(r.lastInsertRowid), mutations: [{ table: 'arrivals', operation: 'insert', before: null, after }] as SourceMutation[] };
}

describe('collector capture independent of live output', () => {
  it('binds returned source rows to the input revisions committed by the same write transaction', () => {
    const journal = new CollectorWitnessJournal({ epoch: 'test' }), append = vi.spyOn(journal, 'append');
    const c = new CollectorWitnessCapture(bundle.sqlite, journal), before = { states: new Map([['#7', { at: 1 }]]) };
    c.begin(1000, [{ busId: 7, collectedAt: 1000 }], network(), 3, before);
    before.states.get('#7')!.at = 2;
    expect(c.write(insert)).toBe(1); c.complete(1000, 4, before);
    const payload = append.mock.calls[0]![1] as { stateBeforeJSON: string; stateAfterJSON: string; pollResult: string;
      sourceWriteEvidence: string; sourceWrites: { before: { revision: number }; after: { revision: number }; mutations: { afterJSON: string }[] }[] };
    expect(payload.stateBeforeJSON).toBe(witnessJSON({ states: new Map([['#7', { at: 1 }]]) }));
    expect(payload.stateAfterJSON).toBe(witnessJSON(before)); expect(payload.pollResult).toBe('completed');
    expect(payload.sourceWriteEvidence).toBe('recorded');
    expect(payload.sourceWrites[0]).toMatchObject({ before: { revision: 0 }, after: { revision: 1 } });
    expect(payload.sourceWrites[0]!.mutations[0]!.afterJSON).toContain('arrived_at');
    expect(c.reference()).toMatchObject({ epoch: 'test', seq: 1, at: 1000, status: 'recorded' });
    expect(journal.read('test', 0, { now: 1000 }).topologies).toHaveLength(1);
  });

  it('propagates a real source failure once, rolling back its row and counter without a retry', () => {
    const c = new CollectorWitnessCapture(bundle.sqlite), action = vi.fn(() => { insert(); throw Error('source write failed'); });
    c.begin(1000, [], network(), 1, {});
    expect(() => c.write(action)).toThrow('source write failed'); expect(action).toHaveBeenCalledTimes(1);
    expect(bundle.sqlite.prepare('SELECT COUNT(*) n FROM arrivals').get()).toEqual({ n: 0 });
    expect(bundle.sqlite.prepare('SELECT revision FROM calibration_input_revision').get()).toEqual({ revision: 0 });
    c.complete(1000, 1, {}, 'source write failed');
    expect(c.journal.read(c.journal.epoch, 0, { now: 1000 }).frames[0]!.json).toContain('failed');
  });

  it('keeps the source write when its provenance schema is unavailable and marks that evidence unknown', () => {
    const journal = new CollectorWitnessJournal(), append = vi.spyOn(journal, 'append');
    const c = new CollectorWitnessCapture(bundle.sqlite, journal);
    bundle.sqlite.exec('DROP TRIGGER calibration_revision_arrivals_insert');
    c.begin(1000, [], network(), 1, {}); expect(c.write(insert)).toBe(1); c.complete(1000, 2, {});
    expect(bundle.sqlite.prepare('SELECT COUNT(*) n FROM arrivals').get()).toEqual({ n: 1 });
    expect(append.mock.calls[0]![1]).toMatchObject({ sourceWriteEvidence: 'unavailable' });
  });

  it('continues the source write when an input cannot be captured, retaining an explicit gap', () => {
    const c = new CollectorWitnessCapture(bundle.sqlite);
    c.begin(1000, [], network(), 1, { unsupported: () => {} });
    expect(c.write(insert)).toBe(1); c.complete(1000, 2, {});
    expect(c.reference()).toMatchObject({ status: 'unavailable', seq: 1 });
    expect(c.journal.read(c.journal.epoch, 0, { now: 1000 }).frames[0]!.status).toBe('unavailable');
    c.begin(2000, [], network(), 2, {}); c.complete(2000, 2, {});
    expect(c.journal.read(c.journal.epoch, 0, { now: 2000 }).frames.map(f => f.status)).toEqual(['unavailable', 'recorded']);
  });

  it('captures empty polls and snapshots a new network generation after a static refresh', () => {
    const c = new CollectorWitnessCapture(bundle.sqlite), first = network();
    c.begin(1000, [], first, 1, {}); c.complete(1000, 1, {});
    const rebuilt = TransitNetwork.build([...first.stops.values()], [
      { ...first.routes.get(4)!, stops: [1, 1, 2] },
    ]);
    c.begin(2000, [], rebuilt, 2, {}); c.complete(2000, 2, {});
    const page = c.journal.read(c.journal.epoch, 0, { now: 2000 });
    expect(page.topologies).toHaveLength(2);
    expect(page.frames[0]!.topologySha256).not.toBe(page.frames[1]!.topologySha256);
  });
  it('does not reuse a topology receipt after an in-place geometry change', () => {
    const c = new CollectorWitnessCapture(bundle.sqlite), net = network();
    c.begin(1000, [], net, 1, {}); c.complete(1000, 1, {});
    net.stops.get(1)!.lat += 0.00001;
    c.begin(2000, [], net, 1, {}); c.complete(2000, 1, {});
    expect(c.journal.read(c.journal.epoch, 0, { now: 2000 }).topologies).toHaveLength(2);
  });
  it('marks an input revision change outside its captured statements as unknown source evidence', () => {
    const journal = new CollectorWitnessJournal(), append = vi.spyOn(journal, 'append');
    const c = new CollectorWitnessCapture(bundle.sqlite, journal);
    c.begin(1000, [], network(), 1, {}); insert(); c.complete(1000, 1, {});
    expect(append.mock.calls[0]![1]).toMatchObject({ sourceWriteEvidence: 'unavailable',
      inputBefore: { revision: 0 }, inputAfter: { revision: 1 }, captureErrors: ['intervening-source-writes'] });
    expect(bundle.sqlite.prepare('SELECT COUNT(*) n FROM arrivals').get()).toEqual({ n: 1 });
  });
});
