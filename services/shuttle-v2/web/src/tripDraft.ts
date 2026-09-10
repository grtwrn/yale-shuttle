import type { LatLon } from "./geo";

export type TripDraft = {
  fromText: string;
  fromLL: LatLon | null;
  toText: string;
  toLL: LatLon;
  tripTime: string;
  tripTimeSetAt?: number;
  expandedKey: string | null;
};
type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const KEY = "shuttle-trip-draft";
const MAX_AGE_MS = 2 * 60 * 60_000;
const coords = (v: unknown): v is LatLon => {
  const p = v as LatLon | null;
  return !!p && Number.isFinite(p.lat) && Number.isFinite(p.lon)
    && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180;
};

export function loadTripDraft(store?: Store | null, now = Date.now()): TripDraft | null {
  try {
    const target = store === undefined ? window.sessionStorage : store;
    const raw = target?.getItem(KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    if (!Number.isFinite(d.savedAt) || now < d.savedAt || now - d.savedAt > MAX_AGE_MS
      || typeof d.fromText !== "string" || typeof d.toText !== "string" || !d.toText.trim()
      || !coords(d.toLL) || (d.fromLL !== null && !coords(d.fromLL))
      || typeof d.tripTime !== "string" || (d.tripTime && !Number.isFinite(Date.parse(d.tripTime)))
      || (d.expandedKey !== null && typeof d.expandedKey !== "string")) return null;
    return { fromText: d.fromText, fromLL: d.fromLL, toText: d.toText, toLL: d.toLL,
      tripTime: d.tripTime, ...(Number.isFinite(d.tripTimeSetAt) && d.tripTimeSetAt >= 0 && d.tripTimeSetAt <= d.savedAt
        ? { tripTimeSetAt: d.tripTimeSetAt } : {}), expandedKey: d.expandedKey };
  } catch { return null; }
}

export function saveTripDraft(draft: TripDraft | null, store?: Store | null, now = Date.now()): void {
  try {
    const target = store === undefined ? window.sessionStorage : store;
    if (draft) target?.setItem(KEY, JSON.stringify({ ...draft, savedAt: now }));
    else target?.removeItem(KEY);
  } catch { /* Storage is optional, including private browsing. */ }
}
