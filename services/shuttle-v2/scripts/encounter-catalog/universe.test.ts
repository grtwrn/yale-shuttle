import { describe, expect, it } from 'vitest';
import { enumerateCatalog } from './enumerate.js';
import { fixtureSource, squareInput } from './test-fixtures.js';
import type { AuditRecord } from './types.js';

describe('complete raw curb-component provenance', () => {
  it('keeps different raw segments at a geographic self-crossing as different phase components', () => {
    const input = squareInput();
    input.path = [{ lat: 40.99, lon: -73.01 }, { lat: 41.01, lon: -72.99 },
      { lat: 40.99, lon: -72.99 }, { lat: 41.01, lon: -73.01 }, { lat: 40.99, lon: -73.01 }];
    input.curbs = [{ stopId: 1, coord: { lat: 41, lon: -73 }, sourceIds: [fixtureSource.id] }];
    input.published = [{ id: 'crossing', publishedIndex: 0, stopId: 1 }];
    input.variants[0]!.tokens = [{ id: 'token', occurrenceOptions: ['crossing'] }];
    const result = enumerateCatalog(input, { now: () => 0 });
    expect(result.complete).toBe(true);
    expect(result.components).toHaveLength(2);
    expect(result.components.map(c => c.segments.map(s => s.segment))).toEqual([[0], [2]]);
    expect(result.invariance[0]!.status).toBe('unknown');
    expect(result.invariance[0]!.mappings).toHaveLength(2);
    expect(result.unknownRegions.every(region => region.service === 'unknown')).toBe(true);
  });

  it('preserves both original seam segments in one static circular component', () => {
    const input = squareInput();
    input.curbs.push({ stopId: 3, coord: { ...input.path[0]! }, sourceIds: [fixtureSource.id] });
    const records: AuditRecord[] = [];
    const result = enumerateCatalog(input, { now: () => 0,
      emit(channel, record) { if (channel === 'component-universe') records.push(record); } });
    expect(result.complete).toBe(true);
    const header = records.find(record => record.kind === 'raw-loop')!.data as { loopM: number };
    const seam = result.components.filter(c => c.stopId === 3);
    expect(seam).toHaveLength(1);
    expect(seam[0]!.arc.hi).toBeGreaterThan(header.loopM);
    expect(seam[0]!.segments.map(s => s.segment)).toEqual([0, 3]);
    expect(result.unknownRegions.find(c => c.stopId === 3)!.reason).toBe('unassigned-curb-counterpass');
  });

  it('refuses zero-travel raw geometry without inventing a chord or successful exhaustion', () => {
    const input = squareInput(); input.path = [{ lat: 41, lon: -73 }, { lat: 41, lon: -73 }, { lat: 41, lon: -73 }];
    const result = enumerateCatalog(input, { now: () => 0 });
    expect(result.verdict).toBe('refused-incomplete'); expect(result.searchExhausted).toBe(false);
    expect(result.refusals).toEqual(['unresolved-loop-geometry']);
    expect(result.invariance).toEqual([]); expect(result.liveQualified).toBe(false);
  });
});
