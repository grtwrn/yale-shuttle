import { expect, it } from 'vitest';
import { minCrossingMatching } from './served-matching';

// Independent exhaustive oracle; no shortest paths or production match logic.
function verify(costs: number[][]): void {
  const choices = new Map(costs.map((row, f) => [f, row.map((cost, v) => ({ cost, v }))
    .filter(x => x.cost >= 0).sort((a,b) => a.cost - b.cost || a.v - b.v).map(x => x.v)]));
  const baseline = new Map<number, number>();
  const assign = (f: number, seen: Set<number>): boolean => {
    for (const v of choices.get(f)!) {
      if (seen.has(v)) continue; seen.add(v);
      const prev = baseline.get(v);
      if (prev === undefined || assign(prev, seen)) { baseline.set(v,f); return true; }
    }
    return false;
  };
  for (const f of choices.keys()) assign(f,new Set());
  let bestSize = -1, bestCost = Infinity;
  const walk = (f: number, used: Set<number>, cost: number) => {
    if (f === costs.length) {
      if (used.size > bestSize || (used.size === bestSize && cost < bestCost)) { bestSize = used.size; bestCost = cost; }
      return;
    }
    walk(f+1,used,cost);
    for (const v of choices.get(f)!) if (!used.has(v)) {
      used.add(v); walk(f+1,used,cost+costs[f]![v]!); used.delete(v);
    }
  };
  walk(0,new Set(),0);
  const before = [...baseline];
  const result = minCrossingMatching(choices,baseline,(v,f) => costs[f]![v] === 1);
  const total = (m: Map<number,number>) => [...m].reduce((n,[v,f]) => n+costs[f]![v]!,0);
  expect(result.size).toBe(bestSize);
  expect(new Set(result.values()).size).toBe(result.size);
  for (const [v,f] of result) expect(choices.get(f)).toContain(v);
  expect(total(result)).toBe(bestCost);
  expect([...baseline]).toEqual(before);
  // Stable preference is exact assignment, not just the same visit count.
  if (total(baseline) === bestCost) expect([...result].sort()).toEqual([...baseline].sort());
}

it('matches cardinality/cross-cost oracle on all 19,683 three-by-three edge/cost graphs', () => {
  for (let mask=0; mask<19683; mask++) {
    let n=mask;
    const costs = Array.from({length:3},() => Array.from({length:3},() => {const c=n%3-1;n=Math.floor(n/3);return c;}));
    verify(costs);
  }
}, 30000);

it('matches the oracle on 2,000 seeded four-by-five graphs with unmatched flips and disjoint components', () => {
  let seed=20261007;
  for(let run=0;run<2000;run++) {
    const costs=Array.from({length:4},() => Array.from({length:5},() => {seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%3-1;}));
    verify(costs);
  }
},30000);
