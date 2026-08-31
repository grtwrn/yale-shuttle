// Route roster: which upstream route ids make up each named shuttle line, and
// the colours/labels the whole app keys off. Extracted from TransitMap.tsx so
// the planner, the schedule logic and their tests can share one source.

export interface RouteListConfig {
  /** Route IDs to pull stops from (first one is primary, rest are merged) */
  routeIds: string[];
  /** Route IDs to match buses against */
  busRouteIds: number[];
  label: string;
  /**
   * THE route colour. This field is the single source of truth — every legend
   * chip, polyline, station dot and loop diagram in the app resolves colour
   * from here (directly, or via one of the derived maps below). Nothing may
   * hard-code a route colour anywhere else; see the note above ROUTE_LISTS.
   */
  color: string;
  /** Dashes the route's loop-diagram rule (TransitMap `RouteLoop`). */
  dashed?: boolean;
  sliceStart?: number;
  sliceEnd?: number;
  /** Short name for the map legend chip. Defaults to `label`. */
  chipLabel?: string;
  /** Key the map's route show/hide filter groups this line under. Defaults to `label`. */
  toggleLabel?: string;
  /** Draws the legend chip's swatch dashed. Presentation only. */
  chipDashed?: boolean;
}

// Verified against `routes_routes.php?inactive=true` on 2026-08-31: upstream
// serves exactly these 15 ids, and every label below matches the upstream name
// for its id. `routes.test.ts` pins that snapshot so a future upstream
// add/remove/renumber fails a test instead of silently mislabelling a line.
//
// ── Colour policy ──────────────────────────────────────────────────────────
//
// Colours deliberately DISAGREE with upstream, which paints whole families one
// shade (routes 1/4/13 are all `4472C4`, 2/14 are both `ED7D31`) and would be
// unreadable on a map that draws several at once.
//
// The invariant `routes.test.ts` enforces: **two lines whose ROUTE_HOURS
// windows overlap must never share a colour**, and every derived colour map in
// the app must agree with this table.
//
// Fixed 2026-08-31: Orange Day, Orange Night and Orange East all sat on
// #E65100 while Orange Night and Orange East BOTH run 18:00–01:00 daily, so
// the two lines a rider actually has to choose between every evening were
// pixel-identical on the map and in the legend. The three now split as:
//
//   Orange Day    #E65100  unchanged. Never overlaps either night orange
//                          (its window ends exactly where theirs begin).
//   Orange Night  #ED7D31  upstream's own colour for route 14.
//   Orange East   #E8836A  upstream says `FFB668` for route 17, and upstream
//                          is the authority on identity — but not at the cost
//                          of legibility. FFB668 sits ΔE2000 7.3 from Gold
//                          (#F9A825), and Gold's last M–F loops are still on
//                          screen beside Orange East's first ones inside the
//                          90-min SERVICE_GRACE_MS; it also scores only
//                          1.73:1 against white, the worst in the palette, and
//                          the route-jump chips render cfg.color as TEXT on
//                          white. #E8836A keeps upstream's intent — 17 is the
//                          lighter, softer orange — rotated toward red until
//                          it clears Gold (ΔE 24.7) and reads at 2.66:1.
//
// Resulting worst case among simultaneously-running lines: ΔE2000 12.2
// (Orange Night vs Orange East; 8.8 deuteranopic, 10.5 protanopic), up from
// 0.0. No two lines in the whole 15-row legend are now within ΔE2000 12.
export const ROUTE_LISTS: RouteListConfig[] = [
  { routeIds: ["3"],  busRouteIds: [3],        label: "Red",           color: "#C62828" },
  { routeIds: ["1"],  busRouteIds: [1],        label: "Blue Day",      color: "#1565C0", chipLabel: "Blue Day",    toggleLabel: "Blue" },
  { routeIds: ["4"],  busRouteIds: [4],        label: "Blue Weekend",  color: "#42A5F5", chipLabel: "Blue Wknd" },
  { routeIds: ["13"], busRouteIds: [13],       label: "Blue Night",    color: "#1E88E5" },
  { routeIds: ["16"], busRouteIds: [16],       label: "Blue West",     color: "#00838F" },
  { routeIds: ["2"],  busRouteIds: [2],        label: "Orange Day",    color: "#E65100", chipLabel: "Orange",      toggleLabel: "Orange" },
  { routeIds: ["14"], busRouteIds: [14],       label: "Orange Night",  color: "#ED7D31", chipLabel: "Org Night",   chipDashed: true },
  { routeIds: ["17"], busRouteIds: [17],       label: "Orange East",   color: "#E8836A", chipLabel: "Org East" },
  { routeIds: ["19"], busRouteIds: [19],       label: "Brown",         color: "#795548" },
  { routeIds: ["8"],  busRouteIds: [8],        label: "Pink",          color: "#AD1457" },
  { routeIds: ["9"],  busRouteIds: [9],        label: "Green",         color: "#43A047" },
  { routeIds: ["10"], busRouteIds: [10],       label: "Purple",        color: "#7B1FA2" },
  { routeIds: ["15"], busRouteIds: [15],       label: "Gold",          color: "#F9A825" },
  { routeIds: ["6"],  busRouteIds: [6],        label: "Grocery TJ",    color: "#5D4037" },
  { routeIds: ["18"], busRouteIds: [18],       label: "Grocery Ham",   color: "#8D6E63" },
];

/** upstream route_id → ROUTE_LISTS label. */
export const ROUTE_ID_LABEL: Record<number, string> = {};
for (const cfg of ROUTE_LISTS) {
  for (const rid of cfg.busRouteIds) ROUTE_ID_LABEL[rid] = cfg.label;
}

/**
 * ROUTE_LISTS label → colour. Use this (or `routeColorForId`) instead of
 * writing a hex literal next to a route name — every table that repeated the
 * palette by hand ended up disagreeing with it.
 */
export const ROUTE_COLOR: Record<string, string> = {};
for (const cfg of ROUTE_LISTS) ROUTE_COLOR[cfg.label] = cfg.color;

/** upstream route_id → colour. */
export const ROUTE_COLOR_BY_BUS_ID: Record<number, string> = {};
for (const cfg of ROUTE_LISTS) {
  for (const rid of cfg.busRouteIds) ROUTE_COLOR_BY_BUS_ID[rid] = cfg.color;
}

/**
 * Legend / route-toggle chip presentation, derived so a chip can never show a
 * colour its own polyline doesn't use. The short label and the toggle grouping
 * key are the only legend-specific bits; the colour is ROUTE_LISTS'.
 */
export const LEGEND_ROUTES: {
  label: string; toggleLabel: string; color: string; dashed?: boolean;
}[] = ROUTE_LISTS.map((cfg) => ({
  label: cfg.chipLabel ?? cfg.label,
  toggleLabel: cfg.toggleLabel ?? cfg.label,
  color: cfg.color,
  ...(cfg.chipDashed ? { dashed: true } : {}),
}));

/**
 * Merge a route config's stop lists into one sequence, preserving travel order.
 * Several ROUTE_LISTS entries can stitch multiple upstream route ids together,
 * and every consumer needs the same merged list.
 *
 * The PRIMARY route id's sequence is kept verbatim, repeats included. Only
 * stops contributed by a *later* route id are de-duplicated, which is the only
 * case the stitching was ever meant to cover.
 *
 * De-duplicating within a single route silently destroyed the West Campus
 * out-and-back. Upstream lists route 9 (Green) as
 *   … 26, 25, 23, 22, 23, 24, 25, 127, 26, 80 …
 * and route 10 (Purple) as
 *   10, 9, 1, 122, 127, 26, 25, 24, 23, 22, 23, 24, 25, 26, 72
 * — the bus runs down the West Campus spur and back up it. A blanket `seen`
 * set collapsed Green from 23 stops to 20 and Purple from 15 to 11, and then
 * invented hops that no bus has ever made: 90 days of `segments` (2026-06-02 →
 * 2026-08-31) contain 0 observations of `22-24`, `24-127` (Green) or `22-72`
 * (Purple), against 3,648 for the real `23-22` and 3,683 for `127-26`. Every
 * ETA and trip plan across the collapsed return leg was therefore priced off a
 * fallback instead of measured data — on Purple, `22-72` skipped four real
 * stops and ~10 min of riding. The backend keys the same routes by index and
 * keeps the repeats (`src/network/TransitNetwork.ts`); this now matches.
 *
 * Downstream is repeat-safe: `planTrip` reduces to one option per route label,
 * `computeUpcomingArrivals` caps entries per stop, and `findRouteAnchor`
 * disambiguates revisited vicinities by forward distance from `last_stop_id`.
 */
export function mergedRouteStops(
  cfg: RouteListConfig,
  routeStops: Record<string, number[]>,
): number[] {
  const stops: number[] = [];
  const seen = new Set<number>();
  for (const rid of cfg.routeIds) {
    const seq = routeStops[rid] ?? [];
    if (stops.length === 0) {
      // Primary (first non-empty) route: verbatim, repeats and all.
      for (const sid of seq) { seen.add(sid); stops.push(sid); }
      continue;
    }
    for (const sid of seq) {
      if (!seen.has(sid)) { seen.add(sid); stops.push(sid); }
    }
  }
  return stops;
}

/** Fallback bus speed when segment-time data is missing. */
export const BUS_SPEED_M_S = 6;
