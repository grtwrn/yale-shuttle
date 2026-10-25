/** Additive diagnostics for replay labels. These are correlated GPS/feed
 * proxies under the supplied topology, never independent boarding evidence. */
import { haversineM } from "../../canary-metrics.mjs";
import type { LatLon, PosRow, StopVisit, WaitResult } from "./lib.js";

type Outcome = Pick<WaitResult, "label" | "boardStopId" | "outcome" | "arrivedAt" | "arrivedBus" | "busAtStopOnArrival">;
type VisitSource = StopVisit["source"] | "missing" | "ambiguous";
type RawMatch = "missing" | "unique" | "duplicate" | "ambiguous";
const BANDS = ["<=45m", "45–75m", "75–150m", "150–300m", "300–1000m", ">1000m", "unknown"] as const;
type Band = typeof BANDS[number];
export interface OutcomeEvidence {
  version: 1;
  scope: "correlated-gps-and-upstream-proxy-under-replay-topology";
  physicalArrivalVerified: false;
  busAtStopOnArrival: string | null;
  arrival: null | {
    allowedRouteIds: number[];
    visitSource: VisitSource;
    visits: Array<Pick<StopVisit, "source" | "routeId" | "exit">>;
    stopCoordinate: LatLon | null;
    rawMatch: RawMatch;
    rawRowCount: number;
    uniqueRawRowCount: number;
    witnesses: Array<PosRow & { distanceMeters: number | null }>;
    routeAgreement: "matched" | "mismatched" | "ambiguous" | "unknown";
    /** Only available for one unique raw row; never pick the nearest of conflicting fixes. */
    distanceMeters: number | null;
    distanceBand: Band;
  };
}
const name = (s: string) => s.replace(/^#/, "");
const rawKey = (t: number, bus: string) => JSON.stringify([t, name(bus)]);
const visitKey = (stop: number, t: number, bus: string) => JSON.stringify([stop, t, name(bus)]);
const band = (m: number | null): Band => m === null ? "unknown" : m <= 45 ? "<=45m" : m <= 75 ? "45–75m"
  : m <= 150 ? "75–150m" : m <= 300 ? "150–300m" : m <= 1000 ? "300–1000m" : ">1000m";
const validCoordinate = (p: LatLon | undefined): p is LatLon => !!p && Number.isFinite(p.lat) && Number.isFinite(p.lon)
  && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180;

/** Index once for the whole replay. Keep duplicate visits/rows and conflicting
 * bus identities visible, including other-route raw rows with the same name. */
export function createOutcomeEvidenceLookup(rows: readonly PosRow[], visits: ReadonlyMap<number, readonly StopVisit[]>,
  stopCoords: Readonly<Record<number, LatLon>>) {
  const raw = new Map<string, PosRow[]>(), labels = new Map<string, StopVisit[]>();
  for (const p of rows) {
    const key = rawKey(p.t, p.b), group = raw.get(key) ?? [];
    group.push(p); raw.set(key, group);
  }
  for (const [stop, vs] of visits) for (const v of vs) {
    const key = visitKey(stop, v.enter, v.busName), group = labels.get(key) ?? [];
    group.push(v); labels.set(key, group);
  }
  return (w: Outcome, allowedRouteIds: readonly number[]): OutcomeEvidence => {
    const evidence: OutcomeEvidence = { version: 1, scope: "correlated-gps-and-upstream-proxy-under-replay-topology",
      physicalArrivalVerified: false, busAtStopOnArrival: w.busAtStopOnArrival, arrival: null };
    if (w.outcome !== "arrived" || w.arrivedAt === null || w.arrivedBus === null) return evidence;
    const matches = (labels.get(visitKey(w.boardStopId, w.arrivedAt, w.arrivedBus)) ?? [])
      .filter(v => allowedRouteIds.includes(v.routeId));
    const candidates = raw.get(rawKey(w.arrivedAt, w.arrivedBus)) ?? [];
    // A repeated identical row is distinct from two conflicting observations.
    const unique = new Map<string, PosRow>();
    for (const p of candidates) unique.set(JSON.stringify([p.i, p.b, p.r, p.lat, p.lon, p.h, p.l, p.t]), p);
    const coord = stopCoords[w.boardStopId], stopCoordinate = validCoordinate(coord) ? { ...coord } : null;
    const witnesses = [...unique.values()].map(p => ({ ...p,
      distanceMeters: stopCoordinate && validCoordinate(p) ? haversineM(p, stopCoordinate) : null }));
    const distanceMeters = witnesses.length === 1 ? witnesses[0]!.distanceMeters : null;
    evidence.arrival = {
      allowedRouteIds: [...allowedRouteIds],
      visitSource: matches.length === 0 ? "missing" : matches.length === 1 ? matches[0]!.source : "ambiguous",
      visits: matches.map(({ source, routeId, exit }) => ({ source, routeId, exit })),
      stopCoordinate,
      rawMatch: candidates.length === 0 ? "missing" : unique.size > 1 ? "ambiguous" : candidates.length > 1 ? "duplicate" : "unique",
      rawRowCount: candidates.length, uniqueRawRowCount: unique.size, witnesses,
      routeAgreement: matches.length === 0 || witnesses.length === 0 ? "unknown" : matches.length > 1 || witnesses.length > 1 ? "ambiguous"
        : witnesses[0]!.r === matches[0]!.routeId ? "matched" : "mismatched",
      distanceMeters, distanceBand: band(distanceMeters),
    };
    return evidence;
  };
}

interface EvidenceCounts {
  total: number;
  missingMetadata: number;
  noClaimedArrival: number;
  conflictingEvidence: number;
  visitSources: Record<VisitSource, number>;
  rawMatches: Record<RawMatch, number>;
  distanceBands: Record<Band, number>;
  routeDisagreements: number;
}
const counts = (): EvidenceCounts => ({ total: 0, missingMetadata: 0, noClaimedArrival: 0, conflictingEvidence: 0,
  visitSources: { curb: 0, feed: 0, "curb-only": 0, missing: 0, ambiguous: 0 },
  rawMatches: { missing: 0, unique: 0, duplicate: 0, ambiguous: 0 },
  distanceBands: Object.fromEntries(BANDS.map(b => [b, 0])) as Record<Band, number>, routeDisagreements: 0 });
function add(c: EvidenceCounts, e: OutcomeEvidence | undefined) {
  c.total++;
  if (!e) { c.missingMetadata++; return; }
  if (!e.arrival) { c.noClaimedArrival++; return; }
  c.visitSources[e.arrival.visitSource]++;
  c.rawMatches[e.arrival.rawMatch]++;
  c.distanceBands[e.arrival.distanceBand]++;
  if (e.arrival.routeAgreement === "mismatched") c.routeDisagreements++;
}
type EvidencedOutcome = Outcome & { outcomeEvidence?: OutcomeEvidence };
function group(waits: readonly EvidencedOutcome[]) {
  const ws = counts(), events = new Map<string, Array<OutcomeEvidence | undefined>>();
  let unidentifiedArrivalWaits = 0;
  for (const w of waits) {
    add(ws, w.outcomeEvidence);
    if (w.outcome !== "arrived") continue;
    if (w.arrivedAt === null || w.arrivedBus === null) { unidentifiedArrivalWaits++; continue; }
    const key = visitKey(w.boardStopId, w.arrivedAt, w.arrivedBus), es = events.get(key) ?? [];
    es.push(w.outcomeEvidence); events.set(key, es);
  }
  const distinctArrivals = counts();
  for (const es of events.values()) {
    // Already-at-stop context belongs to a wait, not the shared arrival event.
    const signatures = es.map(e => e ? JSON.stringify({ version: e.version, scope: e.scope,
      physicalArrivalVerified: e.physicalArrivalVerified, arrival: e.arrival }) : undefined);
    if (new Set(signatures).size === 1) add(distinctArrivals, es[0]);
    else { distinctArrivals.total++; distinctArrivals.conflictingEvidence++; }
  }
  return { waits: ws, distinctArrivals, unidentifiedArrivalWaits };
}
/** Wait-level counts are correlated: many waits share a single outcome label. */
export function summarizeOutcomeEvidence(waits: readonly EvidencedOutcome[]) {
  const byRoute: Record<string, ReturnType<typeof group>> = {};
  for (const label of [...new Set(waits.map(w => w.label))].sort()) byRoute[label] = group(waits.filter(w => w.label === label));
  return { scope: "GPS/feed proxy labels; distances use supplied replay topology; physical boarding is unverified",
    ...group(waits), byRoute };
}
export type OutcomeEvidenceSummary = ReturnType<typeof summarizeOutcomeEvidence>;
