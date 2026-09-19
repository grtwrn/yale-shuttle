import { describe, expect, it } from 'vitest';
import { offsetRoute, routeLanes } from './routeOffsets';

describe('parallel route traces', () => {
  it('keeps lane identity when ETA rankings change and centers a selected route', () => {
    expect(routeLanes(['Red', 'Blue', 'Brown'])).toEqual(routeLanes(['Brown', 'Red', 'Blue']));
    expect(routeLanes(['Red']).get('Red')).toEqual({ offset: 0, weight: 5 });
    const lanes = [...routeLanes(Array.from({ length: 15 }, (_, i) => String(i))).values()];
    expect(Math.max(...lanes.map(lane => lane.offset))).toBeLessThanOrEqual(24);
    expect(new Set(lanes.map(lane => lane.offset)).size).toBe(15);
  });
  it('separates identical and reversed shared paths without changing source points', () => {
    const path = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
    const copy = structuredClone(path);
    expect(offsetRoute(path, 5)).toEqual([{ x: 0, y: 5 }, { x: 100, y: 5 }]);
    expect(offsetRoute([...path].reverse(), 10)).toEqual([{ x: 100, y: -10 }, { x: 0, y: -10 }]);
    expect(path).toEqual(copy);
  });
  it('keeps duplicate points and hairpin joins finite and close to the source', () => {
    const path = [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 0.01 }];
    const result = offsetRoute(path, 5);
    expect(result).toHaveLength(3);
    for (const p of result) {
      expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
      expect(Math.min(...path.map(q => Math.hypot(p.x - q.x, p.y - q.y)))).toBeLessThanOrEqual(10.001);
    }
    expect(offsetRoute([{ x: 1, y: 2 }, { x: 1, y: 2 }], 5)).toEqual([{ x: 1, y: 2 }]);
  });
});
