// Route roster: which upstream route ids make up each named shuttle line, and
// the colours/labels the whole app keys off. Extracted from TransitMap.tsx so
// the planner, the schedule logic and their tests can share one source.

export interface RouteListConfig {
  /** Route IDs to pull stops from (first one is primary, rest are merged) */
  routeIds: string[];
  /** Route IDs to match buses against */
  busRouteIds: number[];
  label: string;
  color: string;
  dashed?: boolean;
  sliceStart?: number;
  sliceEnd?: number;
}

export const ROUTE_LISTS: RouteListConfig[] = [
  { routeIds: ["3"],  busRouteIds: [3],        label: "Red",           color: "#C62828" },
  { routeIds: ["1"],  busRouteIds: [1],        label: "Blue Day",      color: "#1565C0" },
  { routeIds: ["4"],  busRouteIds: [4],        label: "Blue Weekend",  color: "#42A5F5" },
  { routeIds: ["13"], busRouteIds: [13],       label: "Blue Night",    color: "#1E88E5" },
  { routeIds: ["16"], busRouteIds: [16],       label: "Blue West",     color: "#00838F" },
  { routeIds: ["2"],  busRouteIds: [2],        label: "Orange Day",    color: "#E65100" },
  { routeIds: ["14"], busRouteIds: [14],       label: "Orange Night",  color: "#E65100" },
  { routeIds: ["17"], busRouteIds: [17],       label: "Orange East",   color: "#E65100" },
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
 * Merge a route config's stop lists into one de-duplicated sequence, preserving
 * travel order. Several ROUTE_LISTS entries stitch multiple upstream route ids
 * together, and every consumer needs the same merged list.
 */
export function mergedRouteStops(
  cfg: RouteListConfig,
  routeStops: Record<string, number[]>,
): number[] {
  const stops: number[] = [];
  const seen = new Set<number>();
  for (const rid of cfg.routeIds) {
    for (const sid of (routeStops[rid] ?? [])) {
      if (!seen.has(sid)) { seen.add(sid); stops.push(sid); }
    }
  }
  return stops;
}

/** Fallback bus speed when segment-time data is missing. */
export const BUS_SPEED_M_S = 6;
