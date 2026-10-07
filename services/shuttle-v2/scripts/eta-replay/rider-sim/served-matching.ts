/** Offline corroboration only: preserve cardinality, then minimize crossed service. */
export function minCrossingMatching<F, V>(
  choices: ReadonlyMap<F, readonly V[]>,
  baseline: ReadonlyMap<V, F>,
  crosses: (v: V, f: F) => boolean,
): Map<V, F> {
  const result = new Map(baseline);
  const reverse = new Map<V, F[]>();
  for (const [f, vs] of choices) for (const v of vs) {
    let fs = reverse.get(v);
    if (!fs) reverse.set(v, (fs = []));
    fs.push(f);
  }
  const seen = new Set<F>();
  for (const first of choices.keys()) {
    if (seen.has(first)) continue;
    const fs: F[] = [first], vs: V[] = [];
    const visitSet = new Set<V>();
    seen.add(first);
    for (let i = 0; i < fs.length; i++) for (const v of choices.get(fs[i]!)!) {
      if (visitSet.has(v)) continue;
      visitSet.add(v); vs.push(v);
      for (const f of reverse.get(v)!) if (!seen.has(f)) { seen.add(f); fs.push(f); }
    }
    // Single-flip components are already sorted clean-first. Preserve every
    // existing assignment when no crossing can be removed (including ties).
    if (fs.length < 2 || !vs.some(v => baseline.has(v) && crosses(v, baseline.get(v)!))) continue;
    type Edge = { to: number; rev: number; capacity: number; cost: number };
    const source = fs.length + vs.length, sink = source + 1;
    const graph: Edge[][] = Array.from({ length: sink + 1 }, () => []);
    const add = (from: number, to: number, cost: number): Edge => {
      const edge = { to, rev: graph[to]!.length, capacity: 1, cost };
      graph[from]!.push(edge);
      graph[to]!.push({ to: from, rev: graph[from]!.length - 1, capacity: 0, cost: -cost });
      return edge;
    };
    const vi = new Map(vs.map((v, i) => [v, fs.length + i]));
    const pairs: Array<{ f: F; v: V; edge: Edge }> = [];
    fs.forEach((f, i) => {
      add(source, i, 0);
      for (const v of choices.get(f)!) {
        // One crossing outweighs ALL possible baseline-edge changes. A
        // cross-minimal baseline is therefore retained byte-for-byte.
        const cost = Number(crosses(v, f)) * (fs.length + 1) + Number(baseline.get(v) !== f);
        pairs.push({ f, v, edge: add(i, vi.get(v)!, cost) });
      }
    });
    vs.forEach(v => add(vi.get(v)!, sink, 0));
    // Successive shortest residual paths give minimum cost at each cardinality;
    // reverse edges allow earlier assignments to move without losing support.
    // Bellman-Ford handles their negative costs. Components are independent.
    while (true) {
      const dist = Array<number>(graph.length).fill(Infinity);
      const prev = Array<{ from: number; edge: Edge } | undefined>(graph.length);
      dist[source] = 0;
      for (let pass = 1; pass < graph.length; pass++) {
        let changed = false;
        for (let from = 0; from < graph.length; from++) for (const edge of graph[from]!) {
          if (edge.capacity && dist[from]! + edge.cost < dist[edge.to]!) {
            dist[edge.to] = dist[from]! + edge.cost; prev[edge.to] = { from, edge }; changed = true;
          }
        }
        if (!changed) break;
      }
      if (!prev[sink]) break;
      for (let at = sink; at !== source;) {
        const { from, edge } = prev[at]!;
        edge.capacity--; graph[at]![edge.rev]!.capacity++; at = from;
      }
    }
    for (const v of vs) result.delete(v);
    for (const { f, v, edge } of pairs) if (!edge.capacity) result.set(v, f);
  }
  return result;
}
