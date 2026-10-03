/**
 * STOPS THE BUSES ARE SKIPPING RIGHT NOW (unionskip20261003).
 *
 * Purple lists Union Station (S) and serves it all morning: from 06 to 11 ET
 * over the 30 archived days (2026-09-03 → 10-02), 412 of 414 judged passes
 * came within 75 m of the pole. From about 12:20 ET most buses stop turning
 * into the station loop and drive straight on toward West Haven, 175 m from
 * the pole: 12–23 ET, 353 of 450 judged passes skipped it (weekends 93 of
 * 98). The card still counted each bus down to the stop until it had gone
 * by, so a rider sent there in the afternoon watched it pass. Our own rider
 * harness waited out its 45-minute cap there on 2026-10-03 while two Purple
 * buses drove by.
 *
 * This reads what the collector already wrote, never a timetable: the last few
 * passes of a line by a stop, each one judged SERVED or SKIPPED, and
 * `/api/buses` names a (line, stop) only while the latest pass skipped it and
 * at least {@link MIN_SKIPPED} of the last {@link RECENT_PASSES} did. So the
 * notice starts on its own after the second skip and ends at the first bus
 * that serves the stop again. Overnight it goes quiet because passes older
 * than {@link LOOKBACK_MS} no longer count.
 *
 * A pass counts only when it is evidence. Every guard below exists because
 * the obvious version misfires:
 *
 *  - FORWARD ONLY. The detector also anchors a stop the bus merely drives near
 *    on another leg. Purple's return leg goes by Union Station (S) about 385 m
 *    away and writes a `passed` row there on every lap. A pass counts only if
 *    the bus's previous visit was one or two places before it in the route's
 *    order, and a skip also needs its next visit one or two places after,
 *    each within {@link MAX_HOP_MS}. That also drops deadheads and a bus
 *    leaving service mid-route, because they have no next visit on the line.
 *    (A served pass does not wait for the next visit: it can only take a
 *    notice down.)
 *  - THE WHOLE APPROACH, NOT ONE ANCHOR. `closest_m` is measured only while
 *    the detector anchors that stop. At some stops a bus serves the pole while
 *    the detector still anchors a neighbour: Green's Orange / Bradley (N) reads
 *    "passed at 430 m" on 700 of 702 rows, yet its buses go within 4 m of it.
 *    So a skip is confirmed against the bus's raw positions from its previous
 *    visit to just past its next one, and any fix within {@link SERVED_M}
 *    makes the pass served.
 *  - NO GUESSING THROUGH A HOLE. Any gap over {@link MAX_FIX_GAP_MS} in those
 *    positions makes the pass unknown, because the bus could have served the
 *    stop while the feed was quiet.
 *  - A KERB IS NOT A SKIP. Only a bus that never came within
 *    {@link SKIPPED_M} counts as a skip. A bus that pulls in 80–140 m away, at
 *    a different berth or in a shuffle, is unknown and counts neither way.
 *    150 m is the detector's own departure distance, which no parked bus
 *    reaches.
 *
 * Replayed over the same 30 days, with the rule judged 5 minutes before each
 * pass, the notice would have been up for 614 passes, and that bus really
 * skipped the stop 529 times (86%). At Union Station (S) it was 238 of 280
 * (85%), and never between 06 and 11 ET. The other stops it named were real
 * detours, e.g. Blue Day missing Whitney / Cold Spring (S) by 190 m all day on
 * 09-10, 09-29 and 09-30, and five lines missing College / Wall (S) by 162 m
 * on 09-25.
 *
 * Non-throwing: a failure costs the field, never `/api/buses`.
 */
import type Database from "better-sqlite3";

import { AT_STOP_PIN_M } from "../collector/detector.js";
import { DEPART_FAR_M } from "../collector/departure.js";
import { distanceMeters } from "../network/geo.js";
import type { TransitNetwork } from "../network/TransitNetwork.js";

/** Closer than this, at any point of the approach, and the pass served the stop (the detector's pin radius). */
export const SERVED_M = AT_STOP_PIN_M;
/** Never this close, on the whole approach, and the pass skipped it. */
export const SKIPPED_M = DEPART_FAR_M;
/** Only passes this recent count, so last night's skips are gone by morning. */
export const LOOKBACK_MS = 120 * 60_000;
/** The previous and next visit must be this close in time, or the pass is not one forward run along the line. */
export const MAX_HOP_MS = 20 * 60_000;
/** A longer hole in the positions makes the pass unknown. */
export const MAX_FIX_GAP_MS = 60_000;
/** Positions this long after the next visit opened still count toward serving. */
export const WINDOW_TAIL_MS = 120_000;
/** The notice reads the last this-many judged passes ... */
export const RECENT_PASSES = 3;
/** ... and needs at least this many of them skipped, the latest included. */
export const MIN_SKIPPED = 2;
/** Furthest an alternative stop may be from the skipped one (straight line). */
export const ALT_MAX_M = 500;
/** How often the summary is re-read. Every rider poll shares it. */
const REFRESH_MS = 60_000;

/** One `stop_visits` row, the columns this reads. */
export interface VisitRow {
  busId: number;
  routeId: number;
  stopId: number;
  stopIndex: number;
  anchoredAt: number;
  closestM: number;
}

/** One raw position. */
export interface Fix { at: number; lat: number; lon: number }

export type PassVerdict = "served" | "skipped" | "unknown";

export interface StopPass {
  routeId: number;
  stopId: number;
  /** When the detector anchored the stop: the time of the pass. */
  at: number;
  verdict: PassVerdict;
}

/** `/api/buses` `stop_skips[route][stop]`. */
export interface StopSkip {
  /** Skipped passes among the last `of` judged ones. */
  skipped: number;
  of: number;
  /** The latest skipped pass. */
  last_at: number;
  /** A stop just before this one on the line, within walking distance, whose latest pass was served. */
  alt?: number;
}
export type StopSkipsWire = Record<string, Record<string, StopSkip>>;

const mod = (a: number, n: number): number => ((a % n) + n) % n;

/**
 * Judge every forward pass in `visits` (any order). `track` returns one bus's
 * raw positions in `[from, to]`, oldest first.
 */
export function classifyPasses(
  visits: readonly VisitRow[],
  net: TransitNetwork,
  track: (busId: number, from: number, to: number) => readonly Fix[],
): StopPass[] {
  const byBus = new Map<string, VisitRow[]>();
  for (const v of visits) {
    const key = `${v.busId}:${v.routeId}`;
    const list = byBus.get(key);
    if (list) list.push(v);
    else byBus.set(key, [v]);
  }
  const out: StopPass[] = [];
  for (const list of byBus.values()) {
    list.sort((a, b) => a.anchoredAt - b.anchoredAt);
    for (let j = 1; j < list.length; j++) {
      const p = list[j - 1]!, v = list[j]!, q = list[j + 1];
      const route = net.routes.get(v.routeId);
      const stop = net.stops.get(v.stopId);
      if (!route || !stop || route.stops[v.stopIndex] !== v.stopId) continue;
      const n = route.stops.length;
      const back = mod(v.stopIndex - p.stopIndex, n);
      if (back < 1 || back > 2 || v.anchoredAt - p.anchoredAt > MAX_HOP_MS) continue;
      // A served pass is certain at once and only ever takes a notice down,
      // so it does not wait for the next stop. A skip does.
      if (v.closestM <= SERVED_M) {
        out.push({ routeId: v.routeId, stopId: v.stopId, at: v.anchoredAt, verdict: "served" });
        continue;
      }
      if (!q) continue;
      const ahead = mod(q.stopIndex - v.stopIndex, n);
      if (ahead < 1 || ahead > 2 || q.anchoredAt - v.anchoredAt > MAX_HOP_MS) continue;
      out.push({ routeId: v.routeId, stopId: v.stopId, at: v.anchoredAt, verdict: judge(v, p, q, stop, track) });
    }
  }
  return out;
}

function judge(
  v: VisitRow, p: VisitRow, q: VisitRow,
  stop: { lat: number; lon: number },
  track: (busId: number, from: number, to: number) => readonly Fix[],
): PassVerdict {
  const fixes = track(v.busId, p.anchoredAt, q.anchoredAt + WINDOW_TAIL_MS);
  let closest = Infinity, covered = 0, gap = 0, prev = p.anchoredAt;
  for (const f of fixes) {
    closest = Math.min(closest, distanceMeters(f, stop));
    if (f.at <= q.anchoredAt) {
      gap = Math.max(gap, f.at - prev);
      prev = f.at;
      covered++;
    }
  }
  if (closest <= SERVED_M) return "served";
  gap = Math.max(gap, q.anchoredAt - prev);
  if (covered < 2 || gap > MAX_FIX_GAP_MS) return "unknown";
  return v.closestM >= SKIPPED_M && closest >= SKIPPED_M ? "skipped" : "unknown";
}

/** The (line, stop) pairs to warn about at `nowMs`, or null when there are none. */
export function stopSkipsOf(passes: readonly StopPass[], net: TransitNetwork, nowMs: number): StopSkipsWire | null {
  const recent = new Map<string, StopPass[]>();
  for (const p of passes) {
    if (p.verdict === "unknown" || p.at < nowMs - LOOKBACK_MS || p.at > nowMs) continue;
    const key = `${p.routeId}:${p.stopId}`;
    const list = recent.get(key);
    if (list) list.push(p);
    else recent.set(key, [p]);
  }
  const flagged = new Map<string, StopSkip>();
  for (const [key, list] of recent) {
    list.sort((a, b) => a.at - b.at);
    const last = list.slice(-RECENT_PASSES);
    const skips = last.filter((p) => p.verdict === "skipped");
    if (last.length < 2 || last.at(-1)!.verdict !== "skipped" || skips.length < MIN_SKIPPED) continue;
    flagged.set(key, { skipped: skips.length, of: last.length, last_at: skips.at(-1)!.at });
  }
  if (flagged.size === 0) return null;
  const out: StopSkipsWire = {};
  for (const [key, skip] of flagged) {
    const [routeId, stopId] = key.split(":").map(Number) as [number, number];
    const alt = alternativeStop(net, routeId, stopId, recent, flagged);
    (out[String(routeId)] ??= {})[String(stopId)] = alt === null ? skip : { ...skip, alt };
  }
  return out;
}

/**
 * The stop just BEFORE the skipped one on the line: the same bus reaches it
 * first, so boarding there is the same trip. Only within {@link ALT_MAX_M},
 * and only when its own latest recent pass was served.
 */
function alternativeStop(
  net: TransitNetwork, routeId: number, stopId: number,
  recent: ReadonlyMap<string, readonly StopPass[]>, flagged: ReadonlyMap<string, StopSkip>,
): number | null {
  const route = net.routes.get(routeId), stop = net.stops.get(stopId);
  if (!route || !stop) return null;
  let best: { id: number; m: number } | null = null;
  for (let i = 0; i < route.stops.length; i++) {
    if (route.stops[i] !== stopId) continue;
    const id = route.stops[mod(i - 1, route.stops.length)]!;
    const cand = net.stops.get(id);
    if (!cand || id === stopId || flagged.has(`${routeId}:${id}`)) continue;
    if (recent.get(`${routeId}:${id}`)?.at(-1)?.verdict !== "served") continue;
    const m = distanceMeters(stop, cand);
    if (m <= ALT_MAX_M && (!best || m < best.m)) best = { id, m };
  }
  return best?.id ?? null;
}

/**
 * The live summary for `/api/buses`, re-read from the database at most once
 * a minute. `stop_visits` and `raw_positions` both survive a restart, so a
 * deploy in the afternoon does not reset the evidence.
 */
export function createStopSkips(db: Database.Database): (net: TransitNetwork, nowMs: number) => StopSkipsWire | null {
  let visitsStmt: Database.Statement | null = null;
  let trackStmt: Database.Statement | null = null;
  let cached: { at: number; net: TransitNetwork; value: StopSkipsWire | null } | null = null;
  return (net, nowMs) => {
    if (cached && cached.net === net && nowMs >= cached.at && nowMs - cached.at < REFRESH_MS) return cached.value;
    let value: StopSkipsWire | null = null;
    try {
      visitsStmt ??= db.prepare(`SELECT bus_id AS busId, route_id AS routeId, stop_id AS stopId,
          stop_index AS stopIndex, anchored_at AS anchoredAt, closest_m AS closestM
        FROM stop_visits WHERE anchored_at >= ? AND anchored_at <= ?`);
      trackStmt ??= db.prepare(`SELECT collected_at AS at, lat, lon FROM raw_positions
        WHERE bus_id = ? AND collected_at >= ? AND collected_at <= ? ORDER BY collected_at`);
      const visits = visitsStmt.all(nowMs - LOOKBACK_MS - MAX_HOP_MS, nowMs) as VisitRow[];
      const track = trackStmt;
      const passes = classifyPasses(visits, net, (busId, from, to) => track.all(busId, from, to) as Fix[]);
      value = stopSkipsOf(passes, net, nowMs);
    } catch {
      value = null;
    }
    cached = { at: nowMs, net, value };
    return value;
  };
}
