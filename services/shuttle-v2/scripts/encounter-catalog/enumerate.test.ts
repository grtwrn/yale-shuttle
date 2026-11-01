import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { canonicalJSON } from '../encounter-proxy/canonical.js';
import { enumerateCatalog } from './enumerate.js';
import { DEFAULT_CAPS } from './protocol.js';
import { fixtureEvidence, fixtureSource, foldInput, squareInput } from './test-fixtures.js';
import { LimitRefusal, type AuditRecord, type CatalogInput, type Embedding, type Component } from './types.js';

function run(input: CatalogInput, options: Parameters<typeof enumerateCatalog>[1] = {}) {
  const records: { channel: string; record: AuditRecord }[] = [];
  const result = enumerateCatalog(input, { now: () => 0, ...options,
    emit(channel, record) { options?.emit?.(channel, record); records.push({ channel, record }); } });
  const embeddings = records.filter(r => r.channel === 'feasible-embeddings').map(r => r.record.data as Embedding);
  return { result, records, embeddings };
}

/** An independent difference-constraint graph, not the production bound
 * solver. A negative cycle or zero cycle containing a strict edge refuses.
 * Tiny controlled geometry is deliberately far from floating tangencies.
 */
function graphFeasible(intervals: { lo: number; hi: number }[], loop: number): boolean {
  const size = intervals.length + 1, anchor = size - 1;
  // Independent exact conversion via binary strings rather than the
  // production solver's IEEE bit fields or bound-intersection argument.
  const binary = (value: number) => {
    const [whole, fraction = ''] = Math.abs(value).toString(2).split('.');
    return { numerator: BigInt('0b' + whole! + fraction) * (value < 0 ? -1n : 1n), places: fraction.length };
  };
  const parts = [...intervals.flatMap(i => [i.lo, i.hi]), loop].map(binary);
  const places = Math.max(...parts.map(part => part.places));
  const exact = parts.map(part => part.numerator << BigInt(places - part.places));
  type Bound = { value: bigint; strict: boolean };
  const graph: (Bound | null)[][] = Array.from({ length: size }, (_, a) =>
    Array.from({ length: size }, (_, b) => a === b ? { value: 0n, strict: false } : null));
  const tighter = (a: Bound, b: Bound | null) => !b || a.value < b.value || (a.value === b.value && a.strict && !b.strict);
  const edge = (a: number, b: number, value: bigint, strict: boolean) => {
    const bound = { value, strict }; if (tighter(bound, graph[a]![b]!)) graph[a]![b] = bound;
  };
  intervals.forEach((_, index) => { edge(anchor, index, exact[2 * index + 1]!, false); edge(index, anchor, -exact[2 * index]!, false); });
  for (let i = 1; i < intervals.length; i++) edge(i, i - 1, 0n, true);
  edge(0, intervals.length - 1, exact.at(-1)!, true);
  for (let via = 0; via < size; via++) for (let a = 0; a < size; a++) for (let b = 0; b < size; b++) {
    const x = graph[a]![via], y = graph[via]![b];
    if (!x || !y) continue;
    const candidate = { value: x.value + y.value, strict: x.strict || y.strict };
    if (tighter(candidate, graph[a]![b]!)) graph[a]![b] = candidate;
  }
  return graph.every((row, index) => row[index]!.value > 0n || (row[index]!.value === 0n && !row[index]!.strict));
}

/** Cartesian oracle additionally considers excluded-by-proof lifts -2 and3.
 * Their absence among feasible solutions independently checks the finite lift
 * bound; no production order/enumeration helper is called by this oracle.
 */
function brute(input: CatalogInput, components: Component[], loop: number): string[] {
  const found: string[] = [], calls = [...input.published, ...input.spurs];
  const callById = new Map(calls.map(call => [call.id, call]));
  for (const variant of input.variants) {
    const crosswalk = (index: number, selected: { tokenId: string; occurrenceId: string }[]) => {
      if (index < variant.tokens.length) {
        const token = variant.tokens[index]!;
        for (const occurrenceId of token.occurrenceOptions) crosswalk(index + 1, [...selected, { tokenId: token.id, occurrenceId }]);
        return;
      }
      if (new Set(selected.map(s => s.occurrenceId)).size !== selected.length
        || input.published.some(call => !selected.some(s => s.occurrenceId === call.id))) return;
      for (const orientation of input.scope.orientations) for (let rotation = 0; rotation < selected.length; rotation++) {
        const order = selected.slice(rotation).concat(selected.slice(0, rotation));
        const choose = (depth: number, choices: { tokenId: string; occurrenceId: string; componentId: string; lift: number;
          interval: { lo: number; hi: number } }[]) => {
          if (depth === order.length) {
            if (graphFeasible(choices.map(c => c.interval), loop)) found.push(canonicalJSON({ variantId: variant.id,
              orientation, rotation, crosswalk: selected, choices }));
            return;
          }
          const entry = order[depth]!;
          for (const component of components.filter(c => c.stopId === callById.get(entry.occurrenceId)!.stopId)) {
            let lo = component.arc.lo, hi = component.arc.hi;
            if (orientation === 'reverse') {
              const reversedLow = loop - hi; hi = loop - lo; lo = reversedLow;
              while (lo < 0) { lo += loop; hi += loop; }
              while (lo >= loop) { lo -= loop; hi -= loop; }
            }
            for (const lift of depth ? [-2, -1, 0, 1, 2, 3] : [0]) choose(depth + 1, [...choices, { ...entry,
              componentId: component.id, lift, interval: { lo: lo + lift * loop, hi: hi + lift * loop } }]);
          }
        };
        choose(0, []);
      }
    };
    crosswalk(0, []);
  }
  return found.sort();
}

describe('all-source all-branch finite catalog enumeration', () => {
  it('matches a separate Cartesian graph oracle for full folds, repeated published slots and ambiguous crosswalks', () => {
    const input = foldInput();
    input.variants[0]!.tokens[1]!.occurrenceOptions = ['south', 'north'];
    input.variants[0]!.tokens[3]!.occurrenceOptions = ['south', 'north'];
    input.scope.orientations = ['forward', 'reverse']; input.scope.orientationExclusions = [];
    const { result, embeddings, records } = run(input);
    expect(result.complete).toBe(true); expect(result.searchExhausted).toBe(true);
    expect(embeddings.length).toBeGreaterThan(0);
    const segmentRecords = records.filter(r => r.record.kind === 'segment-region');
    expect(segmentRecords.length).toBe(input.curbs.length * (input.path.length - 1));
    const actual = embeddings.map(e => canonicalJSON({ variantId: e.interpretation.variantId, orientation: e.interpretation.orientation,
      rotation: e.interpretation.rotation, crosswalk: e.interpretation.crosswalk, choices: e.choices })).sort();
    // The universe audit contains an explicit loop record for this purpose.
    const header = records.find(r => r.record.kind === 'raw-loop')!.record.data as { loopM: number };
    expect(actual).toEqual(brute(input, result.components, header.loopM));
    expect(result.invariance.filter(c => c.stopId === 1).every(c => c.status === 'unknown')).toBe(true);
    expect(result.liveQualified).toBe(false);
  });

  it('preserves a fixed full-fold mapping while leaving every counterpass an unknown service barrier', () => {
    const { result, embeddings } = run(foldInput());
    expect(result.complete).toBe(true); expect(embeddings.length).toBeGreaterThan(0);
    expect(result.components.filter(c => c.stopId === 1)).toHaveLength(2);
    expect(result.invariance.map(c => c.status)).toEqual(Array(4).fill('candidate-invariant-pending-admission'));
    expect(new Set(result.invariance.filter(c => c.stopId === 1).map(c => c.mappings[0]!.componentId)).size).toBe(2);
    expect(result.unknownRegions).toHaveLength(result.components.length);
    expect(result.unknownRegions.every(c => c.service === 'unknown')).toBe(true);
  });

  it('retains qualified and unknown SPUR evidence without treating source silence as nonservice', () => {
    for (const qualified of [false, true]) {
      const input = foldInput(), north = input.published.pop()!;
      input.spurs.push({ id: north.id, stopId: north.stopId,
        evidence: qualified ? fixtureEvidence() : { status: 'unqualified', sourceIds: [] } });
      input.curbs.push({ stopId: 4, coord: { lat: 41, lon: -72.99 }, sourceIds: [fixtureSource.id] });
      const { result } = run(input);
      expect(result.complete).toBe(true);
      expect(result.invariance.find(c => c.occurrenceId === 'north')!.status)
        .toBe(qualified ? 'candidate-invariant-pending-admission' : 'unknown');
      expect(result.unknownRegions.some(c => c.stopId === 4 && c.reason === 'unassigned-curb-counterpass')).toBe(true);
    }
  });

  it('keeps repeated calls in one connected curb region non-identifiable', () => {
    const input = squareInput();
    input.published.push({ id: 'bottom-again', publishedIndex: 2, stopId: 1 });
    input.variants[0]!.tokens.push({ id: 'third', occurrenceOptions: ['bottom-again'] });
    const { result } = run(input);
    expect(result.complete).toBe(true);
    for (const call of result.invariance.filter(c => c.stopId === 1)) {
      expect(call.status).toBe('unknown'); expect(call.reasons).toContain('inseparable-same-curb-repeated-overlapping-or-degenerate-region');
    }
  });

  it('retains nearby distinct named curbs and their overlap diagnostics without adding an unneeded exclusion', () => {
    const input = squareInput();
    input.curbs[1]!.coord = { lat: 41, lon: -72.989 };
    const { result, embeddings, records } = run(input);
    expect(result.complete).toBe(true); expect(embeddings.length).toBeGreaterThan(0);
    expect(result.components).toHaveLength(2);
    expect(result.invariance.every(call => call.mappings.length === 1 && call.status === 'candidate-invariant-pending-admission')).toBe(true);
    const diagnostics = records.filter(item => item.record.kind === 'overlap-embedding');
    expect(diagnostics.length).toBeGreaterThan(0);
    expect((diagnostics[0]!.record.data as { pairs: { sameNamedCurb: boolean }[] }).pairs.every(pair => !pair.sameNamedCurb)).toBe(true);
    expect(result.liveQualified).toBe(false); // R3 current/name/75m witness gates still apply independently.
  });

  it('refuses an infeasible admitted source variant instead of selecting the convenient plan', () => {
    const input = squareInput();
    input.curbs.push({ stopId: 3, coord: { lat: 41.005, lon: -72.98 }, sourceIds: [fixtureSource.id] },
      { stopId: 4, coord: { lat: 41.005, lon: -73 }, sourceIds: [fixtureSource.id] });
    input.published = ['bottom', 'right', 'top', 'left'].map((id, publishedIndex) => ({ id, publishedIndex,
      stopId: [1, 3, 2, 4][publishedIndex]! }));
    input.variants = [['bottom', 'right', 'top', 'left'], ['bottom', 'top', 'right', 'left']].map((order, index) => ({
      id: index ? 'PDF-discrepancy' : 'API', sourceIds: [fixtureSource.id],
      tokens: order.map((id, i) => ({ id: 'token-' + i, occurrenceOptions: [id] })),
    }));
    const { result } = run(input);
    expect(result.searchExhausted).toBe(true); expect(result.complete).toBe(false);
    expect(result.variantSolutions.API).toBeGreaterThan(0); expect(result.variantSolutions['PDF-discrepancy']).toBe(0);
    expect(result.verdict).toBe('refused-source-scope'); expect(result.invariance).toEqual([]);
    expect(result.unknownRegions).toHaveLength(result.components.length);
    expect(result.unknownRegions.every(region => region.reason === 'admitted-variant-infeasible')).toBe(true);
    const capped = run(input, { caps: { maxExpandedStates: result.counts.expandedStates - 1 } }).result;
    expect(capped.verdict).toBe('refused-incomplete'); expect(capped.searchExhausted).toBe(true);
    expect(capped.refusals).toContain('infeasible-admitted-variant:PDF-discrepancy');
    expect(capped.refusals).toContain('expanded-state-cap');
    expect(capped.invariance).toEqual([]);
  });

  it('refuses unqualified real scope before clock, geometry or candidate evidence', () => {
    const input = squareInput(); input.mode = 'reference-analysis';
    input.scope.onePlanCycleOneRawLoop = { status: 'unqualified', sourceIds: [] };
    const result = enumerateCatalog(input, { now: () => { throw new Error('must not run clock/geometry'); },
      emit: () => { throw new Error('must not emit candidate evidence'); } });
    expect(result.verdict).toBe('refused-source-scope'); expect(result.counts.expandedStates).toBe(0);
    expect(result.components).toEqual([]); expect(result.searchExhausted).toBe(false);
  });

  it('keeps the retained official Pink API/PDF interpretations unqualified before any numerical search', () => {
    const input = JSON.parse(readFileSync(new URL('./__fixtures__/pink-reference-unqualified.v1.json', import.meta.url), 'utf8')) as CatalogInput;
    expect(input.variants.map(variant => variant.id)).toEqual(['API', 'PDF-Shuttle1', 'PDF-Shuttle2']);
    expect(input.published.map(call => call.stopId)).toEqual([149, 72, 43, 44, 60, 109, 123, 125, 124, 110, 59, 46]);
    const result = enumerateCatalog(input, { now: () => { throw new Error('unqualified primary reference cannot search'); },
      emit: () => { throw new Error('unqualified primary reference cannot emit inferred masks'); } });
    expect(result.verdict).toBe('refused-source-scope');
    expect(result.refusals).toContain('one-plan-cycle-one-raw-loop-unqualified');
    expect(result.counts.expandedStates).toBe(0); expect(result.components).toEqual([]);
    expect(result.invariance).toEqual([]); expect(result.liveQualified).toBe(false);
  });

  it('distinguishes exact bound completion from partial solutions, time or output refusals', () => {
    const baseline = run(squareInput()).result;
    expect(baseline.complete).toBe(true);
    expect(run(squareInput(), { caps: { maxExpandedStates: baseline.counts.expandedStates,
      maxFeasibleAssignments: baseline.counts.feasibleAssignments, maxTypedInterpretations: baseline.counts.interpretations } }).result.complete).toBe(true);
    const partial = run(squareInput(), { caps: { maxFeasibleAssignments: 1 } }).result;
    expect(partial.verdict).toBe('refused-incomplete'); expect(partial.searchExhausted).toBe(false);
    expect(partial.frontier.length).toBeGreaterThan(0); expect(partial.invariance).toEqual([]);
    expect(partial.counts.feasibleAssignments).toBe(1);
    let clock = 0;
    expect(run(squareInput(), { now: () => clock++, caps: { internalMonotonicBudgetMs: 1 } }).result.refusals).toEqual(['monotonic-time-cap']);
    let emitted = 0;
    const output = run(squareInput(), { emit: () => { if (++emitted > 5) throw new LimitRefusal('output-cap'); } }).result;
    expect(output.verdict).toBe('refused-incomplete'); expect(output.invariance).toEqual([]);
    expect(() => run(squareInput(), { caps: { maxExpandedStates: DEFAULT_CAPS.maxExpandedStates + 1 } })).toThrow('only be lowered');
  });

  it('supports prototype-named source/occurrence/variant identifiers without inherited dictionary values', () => {
    const input = squareInput(), rename = new Map([['bottom', '__proto__'], ['top', 'constructor']]);
    input.published = input.published.map(c => ({ ...c, id: rename.get(c.id)! }));
    input.variants[0]!.id = 'toString';
    input.variants[0]!.tokens.forEach(t => { t.occurrenceOptions = t.occurrenceOptions.map(id => rename.get(id)!); });
    const { result } = run(input);
    expect(result.complete).toBe(true); expect(Object.hasOwn(result.variantSolutions, 'toString')).toBe(true);
    expect(result.variantSolutions.toString).toBeGreaterThan(0);
    expect(result.invariance.map(c => c.occurrenceId)).toEqual(['__proto__', 'constructor']);
    expect(result.invariance.every(c => c.status === 'candidate-invariant-pending-admission')).toBe(true);
  });
});
