import { performance } from 'node:perf_hooks';
import { canonicalJSON, sha256 } from '../encounter-proxy/canonical.js';
import { strictCycleOrder } from './order.js';
import { canonicalInputHash, effectiveCaps, PROTOCOL_SHA256, R3_PROTOCOL_SHA256 } from './protocol.js';
import { evidenceAccepted, scopeRefusals, validateInput } from './schema.js';
import { buildUniverse, orientedInterval } from './universe.js';
import { LimitRefusal, type ArtifactChannel, type AuditRecord, type CatalogInput, type Choice,
  type Component, type Embedding, type EnumerationResult, type EnumeratorOptions,
  type Interpretation, type Invariance, type SearchFrame, type UnknownRegion } from './types.js';

/** Analyzer only: no catalog/admission/runtime mutation is exposed. */
export function enumerateCatalog(input: CatalogInput, options: EnumeratorOptions = {}): EnumerationResult {
  const caps = effectiveCaps(options.caps), inputHash = canonicalInputHash(input);
  validateInput(input, caps);
  const result: EnumerationResult = {
    schema: 'independent-catalog-embedding-result/v1', inputHash, protocolHash: PROTOCOL_SHA256,
    r3ProtocolHash: R3_PROTOCOL_SHA256, mode: input.mode, effectiveCaps: caps,
    verdict: 'refused-source-scope', complete: false, searchExhausted: false, refusals: scopeRefusals(input),
    counts: { expandedStates: 0, interpretations: 0, feasibleAssignments: 0, rejectedPrefixes: 0, unresolvedPrefixes: 0 },
    variantSolutions: Object.fromEntries(input.variants.map(v => [v.id, 0])),
    components: [], invariance: [], unknownRegions: [], frontier: [], liveQualified: false, publicationCapability: false,
  };
  if (result.refusals.length) return result;
  const now = options.now ?? (() => performance.now());
  const frontier: SearchFrame[] = [];
  let started = 0, previousClock = 0;
  const emit = (channel: ArtifactChannel, record: AuditRecord) => {
    options.emit?.(channel, record);
    if (channel === 'component-universe' && record.kind === 'component') result.components.push(record.data as Component);
  };
  const step = () => {
    if (result.counts.expandedStates >= caps.maxExpandedStates) throw new LimitRefusal('expanded-state-cap');
    const actual = now();
    if (!Number.isFinite(actual) || actual < previousClock) throw new LimitRefusal('invalid-monotonic-clock');
    previousClock = actual;
    if (actual - started > caps.internalMonotonicBudgetMs) throw new LimitRefusal('monotonic-time-cap');
    result.counts.expandedStates++;
  };
  const allCalls = [...input.published.map(c => ({ ...c, kind: 'published' as const })),
    ...input.spurs.map(c => ({ ...c, kind: 'spur' as const }))];
  const callIndex = new Map(allCalls.map((call, index) => [call.id, index]));
  const calls = new Map(allCalls.map(call => [call.id, call]));
  const stats = new Map(allCalls.map(call => [call.id, {
    mappings: new Map<string, { componentId: string; orientation: Interpretation['orientation'] }>(),
    present: 0, inseparable: false,
  }]));
  const prefixHash = (context: string, prefix: unknown) => sha256(canonicalJSON({ context, prefix }));
  try {
    started = previousClock = now();
    if (!Number.isFinite(started)) throw new LimitRefusal('invalid-monotonic-clock');
    const universe = buildUniverse(input, caps, emit, step);
    const componentIndex = new Map(universe.components.map((component, index) => [component.id, index]));
    const componentsFor = new Map(input.curbs.map(curb => [curb.stopId,
      universe.components.filter(component => component.stopId === curb.stopId)]));

    const searchEmbedding = (interpretation: Interpretation, variantIndex: number) => {
      if (result.counts.interpretations >= caps.maxTypedInterpretations) throw new LimitRefusal('interpretation-cap');
      result.counts.interpretations++;
      emit('interpretations', { kind: 'interpretation', data: interpretation });
      const order = [...interpretation.crosswalk.slice(interpretation.rotation), ...interpretation.crosswalk.slice(0, interpretation.rotation)];
      const chosen: Choice[] = [], next = Array(order.length + 1).fill(0) as number[];
      const frame: SearchFrame = { phase: 'embedding', variantIndex, tokenIndex: 0,
        interpretationId: interpretation.id, nextCandidateIndices: next, prefix: [] };
      frontier.push(frame);
      let depth = 0;
      while (depth >= 0) {
        frame.tokenIndex = depth;
        frame.prefix = chosen.map((choice, index) => ({ tokenIndex: (interpretation.rotation + index) % order.length,
          occurrenceIndex: callIndex.get(choice.occurrenceId)!, componentIndex: componentIndex.get(choice.componentId)!, lift: choice.lift }));
        if (depth === order.length) {
          step();
          if (result.counts.feasibleAssignments >= caps.maxFeasibleAssignments) throw new LimitRefusal('solution-cap');
          const overlaps: { occurrenceIds: string[]; stopIds: number[]; sameNamedCurb: boolean }[] = [];
          for (let i = 0; i < chosen.length; i++) for (let j = i + 1; j < chosen.length; j++) {
            const first = chosen[i]!, second = chosen[j]!;
            if (first.componentId === second.componentId || [-1, 0, 1].some(lift =>
              first.interval.lo + lift * universe.loopM <= second.interval.hi
              && first.interval.hi + lift * universe.loopM >= second.interval.lo)) {
              const stopIds = [calls.get(first.occurrenceId)!.stopId, calls.get(second.occurrenceId)!.stopId];
              overlaps.push({ occurrenceIds: [first.occurrenceId, second.occurrenceId], stopIds, sameNamedCurb: stopIds[0] === stopIds[1] });
            }
          }
          // R3 queries the currently named stop and also requires the raw
          // atStopId +75m curb gate. Distinct named curbs can remain
          // representable despite overlapping150m phase allowances.
          const repeated = chosen.filter(choice => overlaps.some(pair => pair.sameNamedCurb && pair.occurrenceIds.includes(choice.occurrenceId)));
          const inseparable = chosen.filter(choice => repeated.includes(choice)
            || universe.components[componentIndex.get(choice.componentId)!]!.degenerate).map(choice => choice.occurrenceId);
          const embedding: Embedding = { id: prefixHash(interpretation.id, chosen), interpretation,
            choices: chosen.map(choice => ({ ...choice, interval: { ...choice.interval } })),
            physicalAssignmentKey: sha256(canonicalJSON({ orientation: interpretation.orientation,
              assignments: chosen.map(c => [c.occurrenceId, c.componentId]).sort((a, b) => a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0) })),
            inseparableOccurrences: inseparable };
          emit('feasible-embeddings', { kind: 'embedding', data: embedding });
          result.counts.feasibleAssignments++;
          next[depth] = 1; // The leaf is committed before optional ambiguity diagnostics.
          Object.defineProperty(result.variantSolutions, interpretation.variantId, {
            value: result.variantSolutions[interpretation.variantId]! + 1, enumerable: true, configurable: true, writable: true,
          });
          if (overlaps.length) emit('ambiguous-and-unknown-regions', { kind: 'overlap-embedding', data: {
            embeddingId: embedding.id, pairs: overlaps, distinctNamedCurbRule: 'R3-atStopId-and75m-witness-gate-remains-required' } });
          if (inseparable.length) {
            result.counts.unresolvedPrefixes++;
            emit('ambiguous-and-unknown-regions', { kind: 'inseparable-embedding', data: {
              embeddingId: embedding.id, occurrenceIds: inseparable, reason: 'same-curb-repeated-overlapping-or-degenerate-region' } });
          }
          for (const choice of chosen) {
            const value = stats.get(choice.occurrenceId)!;
            value.present++;
            value.inseparable ||= inseparable.includes(choice.occurrenceId);
            value.mappings.set(canonicalJSON([choice.componentId, interpretation.orientation]), {
              componentId: choice.componentId, orientation: interpretation.orientation,
            });
          }
          depth--; chosen.pop();
          continue;
        }
        const entry = order[depth]!, domain = componentsFor.get(calls.get(entry.occurrenceId)!.stopId) ?? [];
        // Generate one candidate at a time rather than allocating the
        // token x component x lift product ahead of the resource checks.
        const lifts = depth ? [-1, 0, 1, 2] : [0], domainLength = domain.length * lifts.length;
        if (!domainLength && next[depth] === 0) {
          step(); result.counts.rejectedPrefixes++;
          emit('search-trace-rejections', { kind: 'reject', data: { phase: 'embedding', interpretationId: interpretation.id,
            tokenIndex: depth, parentPrefixHash: prefixHash(interpretation.id, chosen), reason: 'no-curb-component' } });
        }
        if (next[depth]! >= domainLength) {
          next[depth] = 0; depth--; chosen.pop(); continue;
        }
        step();
        const candidateIndex = next[depth]!, component = domain[Math.floor(candidateIndex / lifts.length)]!;
        const lift = lifts[candidateIndex % lifts.length]!, interval = orientedInterval(component, interpretation.orientation, universe.loopM);
        // These are all possible lifts under 0<=lo<L, hi<=lo+L and
        // x0<xi<x0+L. Exact order rejects endpoint-only aliases.
        const candidate: Choice = { tokenId: entry.tokenId, occurrenceId: entry.occurrenceId, componentId: component.id, lift,
          interval: { lo: interval.lo + lift * universe.loopM, hi: interval.hi + lift * universe.loopM } };
        const prefix = [...chosen, candidate], proof = strictCycleOrder(prefix.map(choice => choice.interval), universe.loopM);
        emit('search-trace-rejections', { kind: proof.feasible ? 'accept-prefix' : 'reject', data: {
          phase: 'embedding', interpretationId: interpretation.id, tokenIndex: depth,
          parentPrefixHash: prefixHash(interpretation.id, chosen), prefixHash: prefixHash(interpretation.id, prefix), candidate, proof,
        } });
        next[depth]++;
        if (!proof.feasible) { result.counts.rejectedPrefixes++; continue; }
        chosen.push(candidate); depth++; next[depth] = 0;
      }
      frontier.pop();
    };

    for (const [variantIndex, variant] of input.variants.entries()) {
      const chosen: { tokenId: string; occurrenceId: string }[] = [];
      const next = Array(variant.tokens.length + 1).fill(0) as number[];
      const frame: SearchFrame = { phase: 'crosswalk', variantIndex, tokenIndex: 0,
        interpretationId: null, nextCandidateIndices: next, prefix: [] };
      frontier.push(frame);
      emit('interpretations', { kind: 'variant-root', data: { variantIndex, variant } });
      let depth = 0;
      while (depth >= 0) {
        frame.tokenIndex = depth;
        frame.prefix = chosen.map((choice, tokenIndex) => ({ tokenIndex, occurrenceIndex: callIndex.get(choice.occurrenceId)! }));
        if (depth === variant.tokens.length) {
          step();
          const missing = input.published.filter(call => !chosen.some(value => value.occurrenceId === call.id)).map(call => call.id);
          if (missing.length) {
            result.counts.rejectedPrefixes++;
            emit('search-trace-rejections', { kind: 'reject', data: { phase: 'crosswalk', variantId: variant.id,
              parentPrefixHash: prefixHash(variant.id, chosen), reason: 'missing-published-occurrences', missing } });
          } else for (const orientation of input.scope.orientations) for (let rotation = 0; rotation < chosen.length; rotation++) {
            const crosswalk = chosen.map(choice => ({ ...choice }));
            const core = { variantId: variant.id, orientation, rotation, crosswalk };
            searchEmbedding({ id: sha256(canonicalJSON(core)), ...core }, variantIndex);
          }
          depth--; chosen.pop(); continue;
        }
        const token = variant.tokens[depth]!;
        if (next[depth]! >= token.occurrenceOptions.length) {
          next[depth] = 0; depth--; chosen.pop(); continue;
        }
        step();
        const occurrenceId = token.occurrenceOptions[next[depth]!]!;
        const candidate = { tokenId: token.id, occurrenceId }, prefix = [...chosen, candidate];
        const duplicate = chosen.some(choice => choice.occurrenceId === occurrenceId);
        emit('search-trace-rejections', { kind: duplicate ? 'reject' : 'accept-prefix', data: {
          phase: 'crosswalk', variantId: variant.id, tokenIndex: depth,
          parentPrefixHash: prefixHash(variant.id, chosen), prefixHash: prefixHash(variant.id, prefix), candidate,
          reason: duplicate ? 'duplicate-original-occurrence' : 'injective-prefix',
        } });
        next[depth]++;
        if (duplicate) { result.counts.rejectedPrefixes++; continue; }
        chosen.push(candidate); depth++; next[depth] = 0;
      }
      frontier.pop();
    }
    result.searchExhausted = true;
    const infeasible = input.variants.filter(variant => result.variantSolutions[variant.id] === 0).map(variant => variant.id);
    if (infeasible.length) {
      result.refusals = infeasible.map(id => 'infeasible-admitted-variant:' + id);
      for (const component of universe.components) {
        step();
        const unknown: UnknownRegion = { stopId: component.stopId, componentId: component.id,
          reason: 'admitted-variant-infeasible', possibleOccurrences: allCalls.filter(call => call.stopId === component.stopId).map(call => call.id),
          service: 'unknown' };
        emit('ambiguous-and-unknown-regions', { kind: 'unknown-region', data: unknown });
        result.unknownRegions.push(unknown);
      }
      return result;
    }
    result.invariance = allCalls.map(call => {
      const value = stats.get(call.id)!, mappings = [...value.mappings.values()];
      const reasons = [];
      if (value.present !== result.counts.feasibleAssignments) reasons.push('absent-in-some-interpretation');
      if (mappings.length !== 1) reasons.push('multiple-or-no-region-orientation-mappings');
      if (value.inseparable) reasons.push('inseparable-same-curb-repeated-overlapping-or-degenerate-region');
      if (call.kind === 'spur' && !evidenceAccepted(call.evidence, input.mode)) reasons.push('SPUR-evidence-unqualified');
      return { occurrenceId: call.id, stopId: call.stopId, kind: call.kind, mappings,
        status: reasons.length ? 'unknown' : 'candidate-invariant-pending-admission', reasons } as Invariance;
    });
    for (const component of universe.components) {
      step();
      const possible = result.invariance.filter(call => call.mappings.some(mapping => mapping.componentId === component.id));
      const unknown: UnknownRegion = { stopId: component.stopId, componentId: component.id,
        reason: !possible.length ? 'unassigned-curb-counterpass' : possible.every(call => call.status === 'candidate-invariant-pending-admission')
          ? 'candidate-only-admission-pending' : 'variant-dependent-or-unqualified-service',
        possibleOccurrences: possible.map(call => call.occurrenceId), service: 'unknown' };
      emit('ambiguous-and-unknown-regions', { kind: 'unknown-region', data: unknown });
      result.unknownRegions.push(unknown);
    }
    result.complete = true;
    result.verdict = result.invariance.some(call => call.status === 'candidate-invariant-pending-admission')
      ? 'complete-exhaustive-invariant-subset-pending-admission' : 'complete-exhaustive-but-ambiguous';
  } catch (error) {
    result.complete = false; result.verdict = 'refused-incomplete'; result.invariance = [];
    result.refusals.push(error instanceof LimitRefusal ? error.reason : 'unhandled-analysis-error:' + String(error));
    result.frontier = frontier.map(frame => ({ ...frame, nextCandidateIndices: [...frame.nextCandidateIndices],
      prefix: frame.prefix.map(choice => ({ ...choice })) }));
  }
  return result;
}
