/**
 * The "buses are skipping this stop" notice (unionskip20261003).
 *
 * The server names a (line, stop) in `/api/buses` `stop_skips` only while the
 * latest pass of that line skipped the stop and at least 2 of its last 3 did,
 * judged from the buses' own positions (src/server/stopSkips.ts). Afternoon
 * Purple buses mostly drive past Union Station (S) 175 m from the pole, and
 * the card still counted each one down to it. This says so on the card, and
 * names the stop just before it on the line when the last bus served that one.
 * The countdown itself is unchanged.
 */
import { haversineMeters, type LatLon } from "./geo";
import { fmtWalk } from "./format";
import { walkSecFromMeters } from "./walk";

export interface StopSkip { skipped: number; of: number; last_at: number; alt?: number }
/** `stop_skips[routeId][stopId]`. */
export type StopSkips = Record<string, Record<string, StopSkip>>;

const isCount = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x) && x >= 1;

/** The payload field, validated; anything malformed is dropped, an absent field is `{}`. */
export function parseStopSkips(raw: unknown): StopSkips {
  const out: StopSkips = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [rid, stops] of Object.entries(raw as Record<string, unknown>)) {
    if (!stops || typeof stops !== "object" || Array.isArray(stops)) continue;
    for (const [sid, v] of Object.entries(stops as Record<string, unknown>)) {
      const s = v as Partial<StopSkip> | null;
      if (!s || !isCount(s.skipped) || !isCount(s.of) || s.skipped > s.of || typeof s.last_at !== "number") continue;
      (out[rid] ??= {})[sid] = {
        skipped: s.skipped, of: s.of, last_at: s.last_at,
        ...(isCount(s.alt) ? { alt: s.alt } : {}),
      };
    }
  }
  return out;
}

/**
 * The notice for boarding `routeLabel` (any of `busRouteIds`) at `stopId`, or
 * null when its buses are not skipping it.
 */
export function skipNotice(
  skips: StopSkips,
  routeLabel: string,
  busRouteIds: readonly number[],
  stopId: number,
  stopNames: Record<number, string>,
  stopCoords: Record<number, LatLon>,
): string | null {
  let skip: StopSkip | undefined;
  for (const rid of busRouteIds) {
    skip = skips[String(rid)]?.[String(stopId)];
    if (skip) break;
  }
  if (!skip) return null;
  const name = stopNames[stopId] ?? "this stop";
  const count = skip.skipped === skip.of ? `The last ${skip.of}` : `${skip.skipped} of the last ${skip.of}`;
  let text = `⚠️ ${count} ${routeLabel} buses skipped ${name}.`;
  const alt = skip.alt;
  const from = stopCoords[stopId], to = alt !== undefined ? stopCoords[alt] : undefined;
  if (alt !== undefined && alt !== stopId && stopNames[alt] && from && to) {
    text += ` Try ${stopNames[alt]} (${fmtWalk(walkSecFromMeters(haversineMeters(from, to)))} walk).`;
  }
  return text;
}
