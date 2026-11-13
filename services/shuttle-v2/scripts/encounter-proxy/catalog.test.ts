import { describe, expect, it } from 'vitest';
import { canonicalJSON } from './canonical.js';
import { compileCatalog, compatibleIntervals, distanceMeters } from './catalog.js';
import { DEFAULT_PROTOCOL, PROTOCOL_SHA256 } from './protocol.js';
import { APEX, FOLD_STOP, foldSpec, squareSpec } from './test-fixtures.js';

describe('independent raw catalog', () => {
  it('pins R3 and rejects an unfrozen engineering limit', () => {
    expect(DEFAULT_PROTOCOL.revision).toBe(3);
    expect(PROTOCOL_SHA256).toBe('fc773c29e476375a115a7e885a966eed53a1c94246da86af8b0b46d0d319aa20');
    expect(() => compileCatalog(squareSpec(), { ...DEFAULT_PROTOCOL, maxForwardSpeedMps: 41 })).toThrow('frozen R3');
  });

  it('preserves two original same-ID calls as distinct directional occurrences', () => {
    const spec = foldSpec(), before = canonicalJSON(spec), catalog = compileCatalog(spec);
    expect(catalog.publishedStops).toEqual([100, 200, 100]);
    expect(catalog.calls.filter(c => c.stopId === 100).map(c => [c.id, c.publishedIndex, c.service]))
      .toEqual([['south', 0, 'published-qualified'], ['north', 2, 'published-qualified']]);
    expect(catalog.calls.find(c => c.id === 'south')!.regions[0]!.hi)
      .toBeLessThan(catalog.calls.find(c => c.id === 'north')!.regions[0]!.lo);
    expect(canonicalJSON(spec)).toBe(before);
    expect(Object.isFrozen(catalog.calls)).toBe(true);
  });

  it('retains every raw geometric branch instead of selecting nearest or heading', () => {
    const catalog = compileCatalog(foldSpec());
    expect(compatibleIntervals(catalog, FOLD_STOP, 75)).toHaveLength(2);
    expect(compatibleIntervals(catalog, APEX, 75)).toHaveLength(1);
  });

  it('keeps a separately attested SPUR and marks an omitted counterpass unknown', () => {
    const spur = compileCatalog(foldSpec('spur-qualified'));
    expect(spur.calls.find(c => c.id === 'north')).toMatchObject({ service: 'spur-qualified', publishedIndex: null });
    const omitted = compileCatalog(foldSpec('omitted'));
    const unknown = omitted.calls.filter(c => c.stopId === 100 && c.automatic);
    expect(unknown).toHaveLength(1);
    expect(unknown[0]!.service).toBe('unknown');
    expect(unknown[0]!.regions[0]!.lo).toBeGreaterThan(omitted.loopM / 2);
  });

  it('requires evidence for a traversal-only declaration instead of borrowing application TWIN tags', () => {
    const spec = foldSpec('traversal-only');
    spec.calls = spec.calls.map(c => c.id === 'north' ? { ...c, evidenceHashes: [] } : c);
    expect(() => compileCatalog(spec)).toThrow('independent evidence');
  });

  it('rejects deduplicated published repeats and missing/raw-open geometry', () => {
    const spec = foldSpec();
    expect(() => compileCatalog({ ...spec, calls: spec.calls.filter(c => c.id !== 'north') })).toThrow('Every original');
    expect(() => compileCatalog({ ...spec, path: spec.path.slice(0, -1) })).toThrow('explicitly closed');
    expect(() => compileCatalog({ ...spec, stopCoords: {} })).toThrow('mapping');
  });

  it('uses the150m directional phase region while the actual curb remains75m', () => {
    const catalog = compileCatalog(squareSpec());
    const point = { lat: 41, lon: -72.9892 }; // about67m from the named curb
    expect(distanceMeters(point, { lat: 41, lon: -72.99 })).toBeLessThan(75);
    const candidates = compatibleIntervals(catalog, point, 75);
    const region = catalog.calls.find(c => c.id === 'bottom')!.regions[0]!;
    expect(candidates.every(i => i.lo >= region.lo && i.hi <= region.hi)).toBe(true);
    expect(DEFAULT_PROTOCOL.curbProxyRadiusM).toBe(75);
    expect(DEFAULT_PROTOCOL.departureRearmM).toBe(150);
  });
});
