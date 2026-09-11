/**
 * A random, per-browser id used only to answer "how many people use this".
 *
 * It sits in localStorage next to the favourites and saved trips this app
 * already keeps there, and rides along as a header on the `/api/buses` poll the
 * app already makes — no extra request, no beacon, no third party.
 *
 * What it deliberately is not:
 *   - not derived from anything about the person (no IP, no fingerprinting)
 *   - never sent alongside a location or a route
 *   - sent with a submitted report SINCE 2026-09-01, by design: the Issues tab
 *     shows riders their own reports, which requires linking a report to the
 *     browser that sent it. The id remains random and maps to nothing else.
 *   - read back by the app in exactly one place: the Issues tab asks
 *     `hasAnonId()` so it can tell a rider whose browser keeps no id why
 *     their reports will never be listed there (see below)
 *
 * The server keeps one row per (day, id) and nothing else, so the data can
 * answer "how many distinct people rode this week" and cannot answer "what did
 * this person do". Clearing site data resets it, which is the correct
 * behaviour: a rider who clears their favourites is a new browser.
 */

const KEY = "shuttle-anon-id";

/** Matches the server's validation in src/server/actives.ts. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function newId(): string {
  // randomUUID needs a secure context; the fallback keeps the shape identical
  // so the server's validation accepts either.
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  const b = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * The browser's id, creating one on first call.
 *
 * Returns null when storage is unavailable — private mode, storage disabled, an
 * embedded webview. That rider simply is not counted; counting must never be a
 * reason the app fails to work, so every path here is non-throwing.
 */
export function getAnonId(): string | null {
  try {
    const existing = localStorage.getItem(KEY);
    if (existing && UUID.test(existing)) return existing;
    const id = newId();
    localStorage.setItem(KEY, id);
    return id;
  } catch {
    return null;
  }
}

/**
 * Whether this browser has an id to send at all.
 *
 * Two empty report lists look identical and mean opposite things: "you have
 * not sent us anything yet" and "this browser cannot be shown what you sent".
 * A report is matched to the browser that filed it, so a rider with no id gets
 * an empty Issues tab forever — and the old wording there, "No reports yet …
 * it will show up here", promised something that could not happen (report
 * #51). Nothing about the id changes; only whether the app admits it has none.
 */
export function hasAnonId(): boolean {
  return getAnonId() !== null;
}

/** Header carrying the id, or `{}` when there is none to send. */
export function anonIdHeader(): Record<string, string> {
  const id = getAnonId();
  return id ? { "x-anon-id": id } : {};
}
