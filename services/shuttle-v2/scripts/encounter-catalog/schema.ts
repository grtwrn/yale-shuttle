import { canonicalJSON } from '../encounter-proxy/canonical.js';
import { isHash, isPoint } from '../encounter-proxy/catalog.js';
import type { Caps, CatalogInput, Evidence } from './types.js';

const keys = (value: unknown, expected: string[]): value is Record<string, unknown> => !!value && typeof value === 'object'
  && !Array.isArray(value) && Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const array = (value: unknown): value is unknown[] => Array.isArray(value)
  && Object.keys(value).length === value.length && Array.from({ length: value.length }, (_, i) => Object.hasOwn(value, i)).every(Boolean);
const unique = (values: readonly unknown[]) => new Set(values).size === values.length;
const fail = (message: string): never => { throw new Error('Invalid catalog input: ' + message); };

/** Structural validation only; no projection/search, and no predictor fields. */
export function validateInput(value: unknown, caps: Caps): asserts value is CatalogInput {
  canonicalJSON(value);
  if (!keys(value, ['schema', 'mode', 'routeId', 'sources', 'path', 'curbs', 'published', 'spurs', 'variants', 'scope'])
    || value.schema !== 'independent-catalog-embedding-input/v1' || !['fixture', 'reference-analysis'].includes(value.mode as string)
    || !Number.isSafeInteger(value.routeId)) fail('schema/mode/route');
  const input = value as unknown as CatalogInput;
  if (!array(input.sources) || !input.sources.length || input.sources.length > caps.maxSourceFiles) fail('source count');
  const sources = new Set<string>(), files = new Set<string>();
  let bytes = 0;
  for (const source of input.sources) {
    if (!keys(source, ['id', 'file', 'bytes', 'sha256']) || !id(source.id) || sources.has(source.id)
      || typeof source.file !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(source.file) || files.has(source.file)
      || !isHash(source.sha256) || !Number.isSafeInteger(source.bytes) || source.bytes <= 0 || source.bytes > caps.maxSourceFileBytes)
      fail('source identity/bytes');
    sources.add(source.id); files.add(source.file); bytes += source.bytes;
  }
  if (bytes > caps.maxAggregateSourceBytes) fail('aggregate source bytes');
  const refs = (items: unknown, allowEmpty = false) => array(items) && (allowEmpty || items.length > 0)
    && unique(items) && items.every(item => id(item) && sources.has(item));
  const evidence = (item: unknown): item is Evidence => keys(item, ['status', 'sourceIds'])
    && ['reviewed', 'fixture-assumption', 'unqualified'].includes(item.status as string)
    && refs(item.sourceIds, item.status === 'unqualified');
  if (!array(input.path) || input.path.length < 3 || input.path.length > caps.maxVertices
    || !input.path.every(p => keys(p, ['lat', 'lon']) && isPoint(p))) fail('raw path');
  const first = input.path[0]!, last = input.path.at(-1)!;
  if (first.lat !== last.lat || first.lon !== last.lon) fail('raw path must be explicitly closed');
  if (!array(input.curbs) || !input.curbs.length || input.curbs.length > caps.maxCalls) fail('curbs');
  const curbs = new Set<number>();
  for (const curb of input.curbs) {
    if (!keys(curb, ['stopId', 'coord', 'sourceIds']) || !Number.isSafeInteger(curb.stopId) || curbs.has(curb.stopId)
      || !keys(curb.coord, ['lat', 'lon']) || !isPoint(curb.coord) || !refs(curb.sourceIds)) fail('curb identity');
    curbs.add(curb.stopId);
  }
  if (!array(input.published) || !input.published.length || !array(input.spurs)
    || input.published.length + input.spurs.length > caps.maxCalls) fail('occurrence count');
  const occurrences = new Set<string>();
  for (const [index, call] of input.published.entries()) {
    if (!keys(call, ['id', 'publishedIndex', 'stopId']) || !id(call.id) || occurrences.has(call.id)
      || call.publishedIndex !== index || !curbs.has(call.stopId)) fail('original published occurrence');
    occurrences.add(call.id);
  }
  for (const call of input.spurs) {
    if (!keys(call, ['id', 'stopId', 'evidence']) || !id(call.id) || occurrences.has(call.id)
      || !curbs.has(call.stopId) || !evidence(call.evidence)) fail('supplemental SPUR occurrence');
    occurrences.add(call.id);
  }
  if (!array(input.variants) || !input.variants.length || input.variants.length > caps.maxAdmittedSourceVariants) fail('plan variants');
  const variants = new Set<string>();
  for (const variant of input.variants) {
    if (!keys(variant, ['id', 'sourceIds', 'tokens']) || !id(variant.id) || variants.has(variant.id)
      || !refs(variant.sourceIds) || !array(variant.tokens) || !variant.tokens.length || variant.tokens.length > caps.maxCalls) fail('plan variant');
    variants.add(variant.id);
    const tokens = new Set<string>(), mentioned = new Set<string>();
    for (const token of variant.tokens) {
      if (!keys(token, ['id', 'occurrenceOptions']) || !id(token.id) || tokens.has(token.id)
        || !array(token.occurrenceOptions) || !token.occurrenceOptions.length || !unique(token.occurrenceOptions)
        || !token.occurrenceOptions.every(option => id(option) && occurrences.has(option))) fail('token crosswalk');
      tokens.add(token.id); for (const option of token.occurrenceOptions) mentioned.add(option);
    }
    if (input.published.some(call => !mentioned.has(call.id))) fail('variant omits an original published occurrence');
  }
  if (!keys(input.scope, ['onePlanCycleOneRawLoop', 'orientations', 'orientationExclusions', 'qualificationPending'])
    || !evidence(input.scope.onePlanCycleOneRawLoop) || input.scope.qualificationPending !== true
    || !array(input.scope.orientations) || !input.scope.orientations.length || !unique(input.scope.orientations)
    || !input.scope.orientations.every(o => ['forward', 'reverse'].includes(o)) || !array(input.scope.orientationExclusions)) fail('admission scope');
  const excluded = new Set<string>();
  for (const exclusion of input.scope.orientationExclusions) {
    if (!keys(exclusion, ['orientation', 'evidence']) || !['forward', 'reverse'].includes(exclusion.orientation)
      || excluded.has(exclusion.orientation) || input.scope.orientations.includes(exclusion.orientation) || !evidence(exclusion.evidence)) fail('orientation exclusion');
    excluded.add(exclusion.orientation);
  }
  if (['forward', 'reverse'].some(o => !input.scope.orientations.includes(o as 'forward' | 'reverse') && !excluded.has(o))) fail('unaccounted orientation');
}

export function evidenceAccepted(evidence: Evidence, mode: CatalogInput['mode']): boolean {
  return evidence.status === 'reviewed' || (mode === 'fixture' && evidence.status === 'fixture-assumption');
}

export function scopeRefusals(input: CatalogInput): string[] {
  const reasons: string[] = [];
  if (!evidenceAccepted(input.scope.onePlanCycleOneRawLoop, input.mode)) reasons.push('one-plan-cycle-one-raw-loop-unqualified');
  for (const item of input.scope.orientationExclusions)
    if (!evidenceAccepted(item.evidence, input.mode)) reasons.push('orientation-exclusion-unqualified:' + item.orientation);
  return reasons;
}
