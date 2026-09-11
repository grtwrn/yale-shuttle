/**
 * Q1 — upstream's accuracy on its own.
 *
 * Every `surface = "upstream"` row (bus, stop, predicted arrival) is paired
 * with the bus's first detected arrival at that stop after the prediction,
 * within 45 min (`arrivals`, the detector truth); a row with none is
 * "did not arrive" and is counted, not dropped — those rows are the material
 * for the out-of-service question (Q4). A proximity truth (first capture fix
 * within 50 m of the stop, nearest the detector event, as gps-replay.ts
 * defines it) is scored beside it where the captures cover the moment.
 *
 *   cd services/shuttle-v2
 *   TZ=America/New_York REPLAY_DB=./store/snap-0906-1230.db \
 *     npx tsx scripts/eta-replay/upstream-eta-score.ts
 *
 * Writes upstream-scored.jsonl (one row per upstream prediction, with both
 * truths) and upstream-score.md / .json (the tables) under REPLAY_OUT.
 */
import {
  HORIZONS, MATCH_MS, errStats, etDay, fmtEt, horizonOf, loadArrivals, loadCaptures, loadUpstream, makeLastSeen,
  makeProximity, mdTable, openDb, parseWindow, r0, r1, routeNames, tracksByBus, truthFor, writeJson, writeText, ensureOut,
  type ErrStats,
} from "./upstream-eta-common.js";
import fs from "node:fs";
import path from "node:path";

const T0 = Date.now();
const log = (...a: unknown[]) => console.error(`[${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a);

const db = openDb();
const { from, to } = parseWindow();
const up = loadUpstream(db, from, to);
if (up.length === 0) throw new Error("no upstream rows in window");
const winFrom = up[0]!.at;
const winTo = up[up.length - 1]!.at;
log(`upstream rows ${up.length}, ${fmtEt(winFrom)} .. ${fmtEt(winTo)} ET`);
const names = routeNames(db);
const arr = loadArrivals(db, winFrom - 3_600_000, winTo + MATCH_MS + 60_000);
const stopCoords = new Map<number, { lat: number; lon: number }>(
  (db.prepare("SELECT id, lat, lon FROM stops").all() as any[]).map((s) => [s.id, { lat: s.lat, lon: s.lon }]),
);
const pos = loadCaptures(winFrom - 3_600_000, winTo + MATCH_MS + 600_000);
log(`capture rows ${pos.length}`);
const tracks = tracksByBus(pos);
const proximityArrival = makeProximity(tracks, stopCoords);
const lastSeenAfter = makeLastSeen(tracks);

interface Scored { id: number; day: string; bus: string; routeId: number; stopId: number; at: number; sec: number; horizon: string; kind: string; det: number | null; prox: number | null; errDet: number | null; errProx: number | null; vanishedAt: number | null }
const scored: Scored[] = [];
for (const u of up) {
  const tr = truthFor(arr, u.bus, u.routeId, u.stopId, u.at);
  const det = tr.det;
  const prox = det === null ? null : proximityArrival(u.bus, u.stopId, det);
  let vanishedAt: number | null = null;
  if (tr.kind === "missing") {
    const last = lastSeenAfter(u.bus, u.at);
    vanishedAt = last !== null && last < u.at + MATCH_MS ? last : null;
  }
  scored.push({
    id: u.id, day: etDay(u.at), bus: u.bus, routeId: u.routeId, stopId: u.stopId, at: u.at, sec: u.sec, horizon: horizonOf(u.sec), kind: tr.kind,
    det, prox,
    errDet: det === null ? null : u.sec - (det - u.at) / 1000,
    errProx: prox === null ? null : u.sec - (prox - u.at) / 1000,
    vanishedAt,
  });
}
log(`scored ${scored.length}`);
fs.writeFileSync(path.join(ensureOut(), "upstream-scored.jsonl"), scored.map((s) => JSON.stringify(s)).join("\n") + "\n");

// -- Tables -------------------------------------------------------------------
function cell(sel: readonly Scored[], truth: "errDet" | "errProx"): { stats: ErrStats; n: number; paired: number; already: number; missing: number; vanished: number } {
  const errs: number[] = [];
  let missing = 0, vanished = 0, already = 0;
  for (const s of sel) {
    if (s.kind === "already") already++;
    if (s.kind === "missing") { missing++; if (s.vanishedAt !== null) vanished++; }
    const e = s[truth];
    if (e !== null) errs.push(e);
  }
  return { stats: errStats(errs), n: sel.length, paired: errs.length, already, missing, vanished };
}
const header = ["slice", "rows", "paired", "bus already there", "did not arrive (vanished)", "signed p10", "signed p50", "signed p90", "|err| p50", "|err| p90", "≤60 s", "≤120 s", "opt ≥120 s", "pes ≥120 s"];
function row(label: string, sel: readonly Scored[], truth: "errDet" | "errProx"): (string | number)[] {
  const c = cell(sel, truth);
  const st = c.stats;
  const pct = (x: number) => (c.n ? Math.round((1000 * x) / c.n) / 10 : 0);
  return [label, c.n, c.paired, `${c.already} = ${pct(c.already)}%`, `${c.missing} = ${pct(c.missing)}% (${c.vanished})`, r0(st.p10), r0(st.p50), r0(st.p90), r0(st.absP50), r0(st.absP90), `${r1(st.within60)}%`, `${r1(st.within120)}%`, `${r1(st.opt120)}%`, `${r1(st.pes120)}%`];
}
function block(truth: "errDet" | "errProx"): string {
  const days = [...new Set(scored.map((s) => s.day))].sort();
  const routes = [...new Set(scored.map((s) => s.routeId))].sort((a, b) => a - b);
  const out: string[] = [];
  out.push(`**By horizon (upstream's promised minutes)** — truth: ${truth === "errDet" ? "detector (`arrivals`)" : "proximity (50 m on the capture track)"}\n`);
  out.push(mdTable(header, [...HORIZONS.map((h) => row(h.label, scored.filter((s) => s.horizon === h.label), truth)), row("all", scored, truth)]));
  out.push(`\n**By route**\n`);
  out.push(mdTable(header, routes.map((r) => row(`${names.get(r) ?? r} (${r})`, scored.filter((s) => s.routeId === r), truth))));
  out.push(`\n**By day (ET)**\n`);
  out.push(mdTable(header, days.map((d) => row(d, scored.filter((s) => s.day === d), truth))));
  out.push(`\n**By day × horizon**\n`);
  out.push(mdTable(header, days.flatMap((d) => HORIZONS.map((h) => row(`${d} ${h.label}`, scored.filter((s) => s.day === d && s.horizon === h.label), truth)))));
  return out.join("\n");
}
const md = [
  `# Q1 — upstream's own accuracy (${fmtEt(winFrom)} .. ${fmtEt(winTo)} ET)`,
  ``,
  `${up.length} upstream rows. Error = predicted − actual (s); negative = optimistic. Upstream serves WHOLE MINUTES (±30 s rounding). "bus already there" = the bus was standing at the predicted stop when the prediction was made (its latest detected arrival there had not departed) — not a forecast, counted and excluded from the error columns. "did not arrive" = no detected arrival of that bus at that stop within 45 min of the prediction; the bracketed count is how many of those buses left the feed (a gap > 10 min) before the 45 min ran out.`,
  ``,
  block("errDet"),
  ``,
  `## Proximity truth (only where the capture track has the pass)`,
  ``,
  block("errProx"),
  ``,
].join("\n");
writeText("upstream-score.md", md);
writeJson("upstream-score.json", {
  window: { from: fmtEt(winFrom), to: fmtEt(winTo) },
  n: up.length,
  byHorizon: Object.fromEntries(HORIZONS.map((h) => [h.label, cell(scored.filter((s) => s.horizon === h.label), "errDet")])),
  byRoute: Object.fromEntries([...new Set(scored.map((s) => s.routeId))].map((r) => [names.get(r) ?? r, cell(scored.filter((s) => s.routeId === r), "errDet")])),
  byDay: Object.fromEntries([...new Set(scored.map((s) => s.day))].map((d) => [d, cell(scored.filter((s) => s.day === d), "errDet")])),
  all: cell(scored, "errDet"),
  allProx: cell(scored, "errProx"),
});
console.log(md);
log("done");
