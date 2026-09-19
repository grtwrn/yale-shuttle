export type ScreenPoint = { x: number; y: number };

/** Distinct, nonnegative distances keep opposite-direction shared paths apart
 * too. Order follows route identity, never an ETA ranking. Cap the spread when
 * many routes are enabled, and keep a single selected route on its real path. */
export function routeLanes(labels: string[]) {
  const sorted = [...new Set(labels)].sort();
  const gap = Math.min(5, 24 / Math.max(1, sorted.length - 1));
  return new Map(sorted.map((label, i) => [label, {
    offset: i * gap,
    weight: sorted.length === 1 ? 5 : Math.max(1, Math.min(4, gap - 0.8)),
  }]));
}

/** Offset display geometry in screen pixels. Bounded joins avoid spikes at
 * hairpins; repeated vertices are harmless. Input geography is never changed. */
export function offsetRoute(points: readonly ScreenPoint[], distance: number): ScreenPoint[] {
  const clean = points.filter((p, i) => i === 0 || Math.hypot(p.x - points[i - 1].x, p.y - points[i - 1].y) > 0.001);
  if (!distance || clean.length < 2) return clean.map(p => ({ ...p }));
  const normals = clean.slice(1).map((p, i) => {
    const dx = p.x - clean[i].x, dy = p.y - clean[i].y;
    const length = Math.hypot(dx, dy);
    return { x: -dy / length, y: dx / length };
  });
  return clean.map((p, i) => {
    const a = normals[Math.max(0, i - 1)], b = normals[Math.min(i, normals.length - 1)];
    const length = Math.hypot(a.x + b.x, a.y + b.y);
    const normal = length < 0.001 ? b : { x: (a.x + b.x) / length, y: (a.y + b.y) / length };
    const projection = Math.max(0.5, normal.x * b.x + normal.y * b.y);
    const scale = distance / projection;
    return { x: p.x + normal.x * scale, y: p.y + normal.y * scale };
  });
}
