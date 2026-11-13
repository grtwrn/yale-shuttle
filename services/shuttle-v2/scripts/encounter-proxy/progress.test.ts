import { describe, expect, it } from 'vitest';
import { canonicalJSON } from './canonical.js';
import { compileCatalog } from './catalog.js';
import { advanceProgress, queryCurrentEncounter, queryNextEncounter, refreshProgressReceipt } from './progress.js';
import { APEX, FOLD_STOP, fix, foldCatalog, foldSpec, squareSpec } from './test-fixtures.js';
import type { CurrentEncounter, EncounterRef, NextEncounter, ProgressState, RawObservation } from './types.js';

const T = 1_000_000;

describe('all-branch raw phase without predictor state', () => {
  it('withholds a cold folded curb and resolves from an independent raw turn then forward motion', () => {
    const catalog = foldCatalog();
    const cold = advanceProgress(null, fix(FOLD_STOP, T, { stationary: true, atStopId: 100 }), catalog);
    expect(cold.status).toBe('unseeded');
    expect(cold.state!.intervals).toHaveLength(2);
    expect(queryCurrentEncounter(cold.state, catalog, 100).kind).toBe('unknown');
    expect(queryNextEncounter(cold.state, catalog, 100).kind).toBe('unknown');
    let state = advanceProgress(null, fix(APEX, T), catalog).state;
    expect(state!.generation).not.toBeNull();
    for (const [i, lon] of [-72.965, -72.97, -72.975, -72.98].entries())
      state = advanceProgress(state, fix({ lat: 41.0002, lon }, T + (i + 1) * 15000), catalog).state;
    expect(state).not.toBeNull();
    const current = queryCurrentEncounter(state, catalog, 100);
    expect(current).toMatchObject({ kind: 'current', service: 'published-qualified', encounter: { occurrenceId: 'north', ordinal: 0 } });
    expect(queryNextEncounter(state, catalog, 100)).toMatchObject({ kind: 'bound', encounter: current.kind === 'current' ? current.encounter : null });
  });

  it('treats an omitted or unresolved SPUR as a barrier, and preserves a separately qualified SPUR', () => {
    for (const status of ['omitted', 'unknown', 'spur-qualified'] as const) {
      const catalog = foldCatalog(status), state = advanceProgress(null, fix(APEX, T), catalog).state;
      const next = queryNextEncounter(state, catalog, 100);
      if (status === 'spur-qualified') expect(next).toMatchObject({ kind: 'bound', service: 'spur-qualified', encounter: { occurrenceId: 'north' } });
      else expect(next.kind).toBe('unknown');
    }
  });

  it('never uses the next eligible event as proof that an opposite pass is currently serving', () => {
    const catalog = foldCatalog('traversal-only');
    let state = advanceProgress(null, fix(APEX, T), catalog).state;
    for (const [i, lon] of [-72.965, -72.97, -72.975, -72.98].entries())
      state = advanceProgress(state, fix({ lat: 41.0002, lon }, T + (i + 1) * 15000), catalog).state;
    expect(queryCurrentEncounter(state, catalog, 100).kind).toBe('unknown');
    expect(queryNextEncounter(state, catalog, 100)).toMatchObject({ kind: 'bound', encounter: { occurrenceId: 'south', ordinal: 0 } });
  });

  it('advances a missed encounter on passage and never revives it on opposite-curb re-entry', () => {
    const catalog = foldCatalog('traversal-only');
    let state = advanceProgress(null, fix({ lat: 41.0001, lon: -73 }, T), catalog).state;
    let tick = 0;
    const events: { kind: string; encounter?: { occurrenceId: string; ordinal: number } }[] = [];
    for (const lon of [-72.995, -72.99, -72.985, -72.98, -72.975, -72.97, -72.965, -72.96]) {
      const result = advanceProgress(state, fix({ lat: 41, lon }, T + (++tick) * 15000), catalog);
      expect(result.state).not.toBeNull(); state = result.state; events.push(...result.events);
    }
    expect(events).toContainEqual(expect.objectContaining({ kind: 'passed', encounter: expect.objectContaining({ occurrenceId: 'south', ordinal: 0 }) }));
    expect(state!.passedThrough.south).toBe(0);
    for (const lon of [-72.965, -72.97, -72.975, -72.98]) {
      const result = advanceProgress(state, fix({ lat: 41.0002, lon }, T + (++tick) * 15000), catalog);
      expect(result.state).not.toBeNull(); state = result.state;
    }
    expect(state!.passedThrough.south).toBe(0);
    expect(queryCurrentEncounter(state, catalog, 100).kind).toBe('unknown');
    expect(queryNextEncounter(state, catalog, 100)).toMatchObject({ kind: 'bound', encounter: { occurrenceId: 'south', ordinal: 1 } });
  });

  it('preserves folded passage and encounter ordinals for every valid call ID, including Object prototype names', () => {
    const renames = new Map([['south', '__proto__'], ['apex', 'constructor'], ['north', 'toString']]);
    const originalNames = new Map([...renames].map(([ordinary, renamed]) => [renamed, ordinary] as const));
    const semanticId = (id: string) => originalNames.get(id) ?? id;
    const points = [APEX,
      ...[-72.965, -72.97, -72.975, -72.98, -72.985, -72.99, -72.995, -73]
        .map(lon => ({ lat: 41.0002, lon })),
      ...[-72.995, -72.99, -72.985, -72.98, -72.975, -72.97, -72.965, -72.96]
        .map(lon => ({ lat: 41, lon })),
      ...[-72.965, -72.97, -72.975, -72.98, -72.985]
        .map(lon => ({ lat: 41.0002, lon })),
    ];
    const run = (rename: boolean) => {
      const spec = foldSpec();
      const catalog = compileCatalog({ ...spec, calls: spec.calls.map(call => ({ ...call,
        id: rename ? renames.get(call.id)! : call.id })) });
      let state: ProgressState | null = null;
      let generationId: string | null = null;
      const evidenceChainHashes: string[] = [];
      const encounter = (value: EncounterRef) => {
        expect(value.generationId).toBe(generationId);
        return { occurrenceId: semanticId(value.occurrenceId), ordinal: value.ordinal };
      };
      const query = (value: CurrentEncounter | NextEncounter) => value.kind === 'unknown'
        ? { kind: value.kind, reason: value.reason, possible: value.possible.map(encounter), availableAt: value.availableAt }
        : { kind: value.kind, encounter: encounter(value.encounter), service: value.service,
          stopId: value.stopId, availableAt: value.availableAt };
      const dictionary = (values: Readonly<Record<string, number>>) =>
        Object.fromEntries(Object.entries(values).map(([id, value]) => [semanticId(id), value]));
      const trace = points.map((point, index) => {
        const result = advanceProgress(state, fix(point, T + index * 15000), catalog);
        expect(result.status).toBe('seeded');
        state = result.state!;
        generationId ??= state.generation!.id;
        expect(state.generation!.id).toBe(generationId);
        evidenceChainHashes.push(state.evidenceChainHash);
        for (const call of catalog.calls) {
          expect(Object.hasOwn(state.seedGateBaselines, call.id)).toBe(true);
          expect(Number.isFinite(state.seedGateBaselines[call.id])).toBe(true);
        }
        // Both maps remain ordinary canonical JSON objects. Even __proto__
        // must be an own enumerable numeric property across JSON custody.
        for (const values of [state.seedGateBaselines, state.passedThrough]) {
          expect(Object.getPrototypeOf(values)).toBe(Object.prototype);
          const restored = JSON.parse(JSON.stringify(values)) as Record<string, number>;
          expect(Object.keys(restored).sort()).toEqual(Object.keys(values).sort());
          for (const key of Object.keys(values)) expect(Object.hasOwn(restored, key)).toBe(true);
          expect(canonicalJSON(restored)).toBe(canonicalJSON(values));
        }
        return { status: result.status, intervals: state.intervals, seedIntervals: state.generation!.seedIntervals,
          lastRawPoint: state.lastRawPoint, lastObservedAt: state.lastObservedAt,
          lastAvailableAt: state.lastAvailableAt, lastObservationHash: state.lastObservationHash,
          lastEvidence: state.lastEvidence, availableAt: state.availableAt,
          baselines: dictionary(state.seedGateBaselines), passed: dictionary(state.passedThrough),
          events: result.events.map(event => {
            if (event.kind !== 'passed') throw new Error('Controlled continuous route must retain its generation');
            return { kind: event.kind, encounter: encounter(event.encounter), service: event.service,
              stopId: event.stopId, availableAt: event.availableAt };
          }),
          current: query(queryCurrentEncounter(state, catalog, 100)),
          next: query(queryNextEncounter(state, catalog, 100)),
          currentTurn: query(queryCurrentEncounter(state, catalog, 200)),
        };
      });
      return { catalogHash: catalog.catalogHash, generationId, evidenceChainHashes, trace };
    };
    const ordinary = run(false), reserved = run(true);
    // Catalog/generation/evidence-chain digests include literal call IDs and
    // must differ. Only explicit occurrence names are renamed in this raw
    // phase/encounter comparison; geometry, clocks and ordinal values are exact.
    expect(reserved.catalogHash).not.toBe(ordinary.catalogHash);
    expect(reserved.generationId).not.toBe(ordinary.generationId);
    reserved.evidenceChainHashes.forEach((hash, index) => expect(hash).not.toBe(ordinary.evidenceChainHashes[index]));
    expect(reserved.trace).toEqual(ordinary.trace);
    expect(ordinary.trace[0]!.currentTurn).toMatchObject({ kind: 'current', encounter: { occurrenceId: 'apex', ordinal: 0 } });
    expect(ordinary.trace[0]!.next).toMatchObject({ kind: 'bound', encounter: { occurrenceId: 'north', ordinal: 0 } });
    expect(ordinary.trace[4]!.current).toMatchObject({ kind: 'current', encounter: { occurrenceId: 'north', ordinal: 0 } });
    expect(ordinary.trace[5]!.passed).toMatchObject({ north: 0 });
    expect(ordinary.trace[12]!.current).toMatchObject({ kind: 'current', encounter: { occurrenceId: 'south', ordinal: 0 } });
    expect(ordinary.trace[13]!.passed).toMatchObject({ south: 0 });
    expect(ordinary.trace[20]!.current).toMatchObject({ kind: 'current', encounter: { occurrenceId: 'north', ordinal: 1 } });
    expect(ordinary.trace[21]!.passed).toMatchObject({ north: 1, south: 0 });
    expect(ordinary.trace[21]!.next).toMatchObject({ kind: 'bound', encounter: { occurrenceId: 'south', ordinal: 1 } });
    expect(ordinary.trace.flatMap(step => step.events)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'passed', encounter: { occurrenceId: 'north', ordinal: 0 } }),
      expect.objectContaining({ kind: 'passed', encounter: { occurrenceId: 'south', ordinal: 0 } }),
      expect.objectContaining({ kind: 'passed', encounter: { occurrenceId: 'north', ordinal: 1 } }),
    ]));
  });

  it('canonicalizes only initial seam aliases and keeps real post-seed lap alternatives distinct', () => {
    const catalog = compileCatalog(squareSpec());
    let state = advanceProgress(null, fix({ lat: 41, lon: -73 }, T), catalog).state!;
    expect(state.generation).not.toBeNull();
    expect(state.intervals).toHaveLength(1);
    expect(state.intervals[0]!.hi).toBeGreaterThan(catalog.loopM);
    state = advanceProgress(state, fix({ lat: 41, lon: -72.996 }, T + 15000), catalog).state!;
    expect(queryNextEncounter(state, catalog, 100)).toMatchObject({ kind: 'bound', encounter: { occurrenceId: 'bottom', ordinal: 0 } });
    const alternatives: ProgressState = { ...state, intervals: [...state.intervals,
      ...state.intervals.map(i => ({ lo: i.lo + catalog.loopM, hi: i.hi + catalog.loopM }))] };
    expect(queryNextEncounter(alternatives, catalog, 100)).toMatchObject({ kind: 'unknown', reason: 'ordinal-ambiguity' });
  });

  it('invalidates gaps, impossible movement and same-clock conflicting GPS without selecting a branch', () => {
    const catalog = compileCatalog(squareSpec()), first = fix({ lat: 41, lon: -72.995 }, T);
    const state = advanceProgress(null, first, catalog).state;
    expect(advanceProgress(state, fix({ lat: 41, lon: -72.995 }, T + 30000), catalog).status).not.toBe('invalid');
    expect(advanceProgress(state, fix({ lat: 41, lon: -72.995 }, T + 30001), catalog))
      .toMatchObject({ status: 'invalid', events: [{ kind: 'invalidate', reason: 'receipt-gap' }] });
    expect(advanceProgress(state, fix({ lat: 41.01, lon: -72.985 }, T + 1000), catalog))
      .toMatchObject({ status: 'invalid', events: [{ kind: 'invalidate', reason: 'unreachable' }] });
    expect(advanceProgress(state, fix({ lat: 41, lon: -72.994 }, T), catalog))
      .toMatchObject({ status: 'invalid', events: [{ kind: 'invalidate', reason: 'same-clock-conflict' }] });
  });

  it('preserves a valid near-edge75m curb despite the GPS compatibility uncertainty', () => {
    const catalog = compileCatalog(squareSpec());
    const nearCurb = fix({ lat: 41, lon: -72.9892 }, T, { stationary: true, atStopId: 100 });
    const state = advanceProgress(null, nearCurb, catalog).state;
    expect(queryCurrentEncounter(state, catalog, 100)).toMatchObject({ kind: 'current', encounter: { occurrenceId: 'bottom', ordinal: 0 } });
  });

  it('censors interval-cap overflow instead of trimming genuine lap alternatives', () => {
    const catalog = compileCatalog(squareSpec());
    const state = advanceProgress(null, fix({ lat: 41, lon: -72.995 }, T), catalog).state!;
    const interval = state.intervals[0]!;
    const many: ProgressState = { ...state, intervals: Array.from({ length: 4097 }, (_, i) =>
      ({ lo: interval.lo + i * catalog.loopM, hi: interval.hi + i * catalog.loopM })) };
    const result = advanceProgress(many, fix({ lat: 41, lon: -72.995 }, T + 1000), catalog);
    expect(result.state).toBeNull();
    expect(result.events).toEqual([expect.objectContaining({ kind: 'invalidate', reason: 'phase-capacity' })]);
  });

  it('rejects a future or changed-source observation before using it as phase evidence', () => {
    const catalog = compileCatalog(squareSpec());
    const point = { lat: 41, lon: -72.995 };
    const state = advanceProgress(null, fix(point, T), catalog).state;
    expect(advanceProgress(null, fix(point, T, { originalReceivedAt: T - 1 }), catalog))
      .toMatchObject({ status: 'invalid', events: [{ reason: 'malformed-observation' }] });
    expect(advanceProgress(state, fix(point, T + 1000, { sourceEpoch: 'new-source' }), catalog))
      .toMatchObject({ status: 'invalid', events: [{ reason: 'epoch-change' }] });
  });

  it('allows historical phase seed and one later provenance upgrade without another GPS movement', () => {
    const catalog = compileCatalog(squareSpec());
    const historical = fix({ lat: 41, lon: -72.995 }, T, { historical: true });
    const seeded = advanceProgress(null, historical, catalog);
    const live = fix({ lat: 41, lon: -72.995 }, T, { availableAt: T + 1000 });
    const upgrade = advanceProgress(seeded.state, live, catalog);
    expect(upgrade.state!.generation).toBe(seeded.state!.generation);
    expect(upgrade.state!.intervals).toBe(seeded.state!.intervals);
    expect(upgrade.state!.passedThrough).toBe(seeded.state!.passedThrough);
    expect(upgrade.state!.lastObservedAt).toBe(T);
    expect(upgrade.state!.lastAvailableAt).toBe(T + 1000);
    expect(upgrade.events).toEqual([]);
    expect(upgrade.availableAt).toBe(T + 1000);
  });

  it.each([false, true])('counts duplicate receipts (historical=%s) without another fix or witness', historical => {
    const catalog = compileCatalog(squareSpec()), point = { lat: 41, lon: -72.995 };
    const first = fix(point, T, { originalReceivedAt: T, availableAt: T });
    const initial = advanceProgress(null, first, catalog).state!;
    const copy = fix(point, T, { historical, originalReceivedAt: T + 29000, availableAt: T + 29000 });
    // A source receipt can maintain continuity before catching up. This is
    // not the live0 witness/enrollment gate and does not spend a witness.
    if (historical) { copy.evidence.hasMore = true; copy.evidence.latest = 2; }
    const refreshed = refreshProgressReceipt(initial, copy)!;
    expect(refreshed.lastAvailableAt).toBe(T + 29000);
    for (const key of ['generation', 'intervals', 'passedThrough', 'seedGateBaselines', 'lastRawPoint'] as const)
      expect(refreshed[key]).toBe(initial[key]);
    expect(refreshed.lastObservedAt).toBe(T);
    expect(refreshed.lastObservationHash).toBe(initial.lastObservationHash);
    // Distinct observed gap20s; actual receipt gap2s. No false31s gap.
    const next = fix(point, T + 20000, { originalReceivedAt: T + 31000, availableAt: T + 31000 });
    const result = advanceProgress(refreshed, next, catalog);
    expect(result.status).toBe('seeded');
    expect(result.state!.generation!.id).toBe(initial.generation!.id);
    expect(result.events.filter(e => e.kind === 'invalidate')).toEqual([]);
  });

  it('never refreshes from stale/future, older historical, conflicting, older or foreign copies', () => {
    const catalog = compileCatalog(squareSpec()), point = { lat: 41, lon: -72.995 };
    const initial = advanceProgress(null, fix(point, T), catalog).state!;
    const rejected = [
      fix(point, T, { availableAt: T + 30001 }),
      fix(point, T, { originalReceivedAt: T - 1 }),
      fix(point, T - 1, { historical: true, availableAt: T + 1000 }),
      fix({ ...point, lon: -72.994 }, T, { availableAt: T + 1000 }),
      fix(point, T - 1, { availableAt: T + 1000 }),
      fix(point, T, { sourceEpoch: 'foreign', availableAt: T + 1000 }),
      fix(point, T, { busId: 8, availableAt: T + 1000 }),
    ];
    for (const copy of rejected) expect(refreshProgressReceipt(initial, copy)).toBe(initial);
  });

  it('is unchanged by removed or adversarial predictor-only fields', () => {
    const catalog = compileCatalog(squareSpec()), raw = fix({ lat: 41, lon: -72.995 }, T);
    const augmented = { ...raw, belief: { lead: 999 }, travel: 500, ETA: -100,
      evidence: { ...raw.evidence, server_eta: { rows: [999] }, fullPacketSHA256: 'changed' } } as RawObservation;
    expect(advanceProgress(null, augmented, catalog)).toEqual(advanceProgress(null, raw, catalog));
  });
});
