/**
 * Why `/api/stats` → `etaVsOfficial` reads the way it does.
 *
 * On 2026-09-06 the live dashboard said ours n=91 paired=63 median |err| 450 s
 * within-120 3.2%, official n=20,662 paired=19,238 median 281 s within-120
 * 24.9% — while the replay on the same days puts our estimator AHEAD of
 * upstream on shared (bus, stop, moment) pairs. This script reproduces the
 * dashboard's arithmetic from a snapshot (`officialComparison` in
 * src/server/predictions.ts: every rider-surface row in the trailing window,
 * paired with the FIRST arrival at or after the prediction within 2 h, no
 * horizon cap), then takes it apart: what the rider rows are (surface, route,
 * horizon, how many were for a bus already standing at the stop), what the
 * same rule does to the official arm, and what both arms read on the SAME
 * horizon buckets, the same routes and — over the whole snapshot — the same
 * (bus, stop, minute) pairs under a standing-aware truth.
 *
 *   cd services/shuttle-v2
 *   TZ=America/New_York REPLAY_DB=./store/snap-0906-1230.db TO=2026-09-06T15:25:00Z \
 *     npx tsx scripts/eta-replay/upstream-eta-stats-check.ts
 */
import { HORIZONS, errStats, fmtEt, horizonOf, loadArrivals, mdTable, normBus, openDb, quantile, r0, r1, routeNames, truthFor, writeText } from "./upstream-eta-common.js";

const db = openDb();
const names = routeNames(db);
const to = process.env.TO ? Date.parse(process.env.TO) : (db.prepare("SELECT MAX(predicted_at) m FROM predictions_log").get() as any).m;
const from24 = to - 24 * 3_600_000;
interface Row { bus: string; routeId: number; stopId: number; sec: number; at: number; surface: string; ahead: number }
const load = (a: number, b: number): Row[] => (db.prepare(`SELECT bus_name, route_id, to_stop_id, predicted_sec, predicted_at, surface, stops_ahead FROM predictions_log WHERE predicted_at >= ? AND predicted_at <= ? ORDER BY predicted_at`).all(a, b) as any[]).map((r) => ({ bus: normBus(r.bus_name), routeId: r.route_id, stopId: r.to_stop_id, sec: r.predicted_sec, at: r.predicted_at, surface: r.surface, ahead: r.stops_ahead }));
const all = load((db.prepare("SELECT MIN(predicted_at) m FROM predictions_log WHERE surface = 'upstream'").get() as any).m, to);
const last24 = all.filter((r) => r.at >= from24);
const arr = loadArrivals(db, from24 - 4 * 24 * 3_600_000, to + 2 * 3_600_000);
// The server's rule, verbatim: first arrival at or after, within 2 h, no standing check.
const SERVER_WINDOW = 2 * 3_600_000;
function serverErr(r: Row): number | null {
  const list = arr.byKey.get(`${r.bus}:${r.routeId}:${r.stopId}`);
  if (!list) return null;
  let lo = 0, hi = list.length;
  while (lo < hi) { const m = (lo + hi) >>> 1; if (list[m]!.t < r.at) lo = m + 1; else hi = m; }
  if (lo >= list.length || list[lo]!.t - r.at > SERVER_WINDOW) return null;
  return r.sec - (list[lo]!.t - r.at) / 1000;
}
const isOurs = (r: Row) => r.surface !== "upstream";
const arm = (rows: Row[]) => { const e = rows.map(serverErr).filter((x): x is number => x !== null); const s = errStats(e); return { n: rows.length, paired: e.length, p50: s.absP50, w120: s.within120 }; };
const o24 = arm(last24.filter(isOurs)), u24 = arm(last24.filter((r) => !isOurs(r)));
const pct = (a: number, b: number) => (b ? `${r1((100 * a) / b)}%` : "–");
const hz = (s: number) => (s < 1800 ? horizonOf(s) : s < 3600 ? "30-60 min" : "60+ min");
const ours24 = last24.filter(isOurs);
const composition = mdTable(["rider rows", "by surface", "by route", "by horizon", "median stops ahead", "bus already standing at the stop"], [[
  ours24.length,
  Object.entries(Object.groupBy(ours24, (r) => r.surface)).map(([k, v]) => `${k} ${v!.length}`).join(", "),
  Object.entries(Object.groupBy(ours24, (r) => r.routeId)).map(([k, v]) => `${names.get(Number(k))} ${v!.length}`).join(", "),
  ["0-2 min", "2-5 min", "5-10 min", "10-30 min", "30-60 min", "60+ min"].map((h) => `${h} ${ours24.filter((r) => hz(r.sec) === h).length}`).join(", "),
  quantile(ours24.map((r) => r.ahead).sort((a, b) => a - b), 0.5),
  pct(ours24.filter((r) => truthFor(arr, r.bus, r.routeId, r.stopId, r.at).kind === "already").length, ours24.length),
]]);
// Both arms, both rules, by horizon, last 24 h.
function scored(rows: Row[], rule: "server" | "standing") {
  const out: Array<{ r: Row; err: number | null; kind: string }> = [];
  for (const r of rows) {
    if (rule === "server") { const e = serverErr(r); out.push({ r, err: e, kind: e === null ? "missing" : "arrived" }); }
    else { const t = truthFor(arr, r.bus, r.routeId, r.stopId, r.at); out.push({ r, err: t.det === null ? null : r.sec - (t.det - r.at) / 1000, kind: t.kind }); }
  }
  return out;
}
const byHHeader = ["horizon (promised)", "arm", "rows", "paired", "already there", "|err| p50", "≤120 s"];
function byHorizon(rows: Row[], rule: "server" | "standing"): (string | number)[][] {
  const out: (string | number)[][] = [];
  for (const h of [...HORIZONS.map((x) => x.label), "30-60 min", "60+ min", "all ≤ 30 min", "all"]) {
    for (const armName of ["ours", "official"]) {
      const sel = scored(rows.filter((r) => (armName === "ours") === isOurs(r) && (h === "all" || (h === "all ≤ 30 min" ? r.sec <= 1800 : hz(r.sec) === h))), rule);
      const e = sel.map((s) => s.err).filter((x): x is number => x !== null);
      const s = errStats(e);
      out.push([h, armName, sel.length, e.length, sel.filter((s) => s.kind === "already").length, e.length >= 5 ? r0(s.absP50) : `n<5`, e.length >= 5 ? `${r1(s.within120)}%` : "–"]);
    }
  }
  return out;
}
// Head-to-head on shared (bus, stop, minute) pairs, whole snapshot, standing-aware truth, same arrival.
interface Sc { r: Row; det: number; err: number }
function h2h(rows: Row[]): { n: number; byH: (string | number)[][]; byRoute: (string | number)[][] } {
  const key = (r: Row) => `${r.bus}:${r.stopId}:${Math.floor(r.at / 60_000)}`;
  const pick = (sel: Row[]) => { const m = new Map<string, Sc>(); for (const r of sel) { const t = truthFor(arr, r.bus, r.routeId, r.stopId, r.at); if (t.kind !== "arrived") continue; const k = key(r); const prev = m.get(k); if (!prev || r.at < prev.r.at) m.set(k, { r, det: t.det!, err: r.sec - (t.det! - r.at) / 1000 }); } return m; };
  const ours = pick(rows.filter(isOurs)), theirs = pick(rows.filter((r) => !isOurs(r)));
  const pairs: Array<{ o: Sc; u: Sc }> = [];
  for (const [k, o] of ours) { const u = theirs.get(k); if (u && u.det === o.det) pairs.push({ o, u }); }
  const line = (label: string, sel: typeof pairs) => { const so = errStats(sel.map((p) => p.o.err)), su = errStats(sel.map((p) => p.u.err)); return [label, sel.length, sel.length >= 20 ? r0(so.absP50) : "n<20", sel.length >= 20 ? r0(su.absP50) : "n<20", sel.length >= 20 ? `${r1(so.within120)}%` : "–", sel.length >= 20 ? `${r1(su.within120)}%` : "–", sel.length >= 20 ? pct(sel.filter((p) => Math.abs(p.u.err) < Math.abs(p.o.err)).length, sel.length) : "–"]; };
  const byH = [...HORIZONS.map((h) => line(h.label, pairs.filter((p) => hz(p.u.r.sec) === h.label))), line("all", pairs)];
  const routes = [...new Set(pairs.map((p) => p.o.r.routeId))].sort((a, b) => a - b);
  return { n: pairs.length, byH, byRoute: routes.map((r) => line(`${names.get(r)} (${r})`, pairs.filter((p) => p.o.r.routeId === r))) };
}
const hh = h2h(all);
const h2hHeader = ["slice", "shared pairs", "ours |err| p50", "official |err| p50", "ours ≤120 s", "official ≤120 s", "official closer"];
const riderByDay = mdTable(["ET day", "trip", "card", "ride", "≤ 30 min", "> 30 min"], [...new Set(all.filter(isOurs).map((r) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(r.at))))].sort().map((d) => { const sel = all.filter((r) => isOurs(r) && new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(r.at)) === d); return [d, sel.filter((r) => r.surface === "trip").length, sel.filter((r) => r.surface === "card").length, sel.filter((r) => r.surface === "ride").length, sel.filter((r) => r.sec <= 1800).length, sel.filter((r) => r.sec > 1800).length]; }));

const md = [
  `# The live \`etaVsOfficial\` number, taken apart (snapshot window ending ${fmtEt(to)} ET)`,
  ``,
  `**Reproduced from the snapshot with the server's own rule** (every rider-surface row in the last 24 h, first arrival at or after the prediction within 2 h, no horizon cap, no standing check): ours n=${o24.n} paired=${o24.paired} |err| p50 ${r0(o24.p50)} s ≤120 s ${r1(o24.w120)}%; official n=${u24.n} paired=${u24.paired} |err| p50 ${r0(u24.p50)} s ≤120 s ${r1(u24.w120)}%. (Live at 13:00 ET: ours 91 / 63 / 450 / 3.2%; official 20,662 / 19,238 / 281 / 24.9%.)`,
  ``,
  `## What the "ours" rows are (last 24 h)`,
  ``,
  composition,
  ``,
  `A rider row is what a sampled browser (25% of page loads) had on screen, deduplicated to one row per (bus, stop, 15 s). \`trip\` = the trip card's one stop; \`card\` = the route cards on the Map tab, which list EVERY stop of every visible line — so most rows are far-horizon and for stops nobody is waiting at. Upstream records nothing beyond 30 min, and the official app is asked about five focus stops every cycle plus a rotation.`,
  ``,
  `Rider rows over the whole snapshot, by day:`,
  ``,
  riderByDay,
  ``,
  `## Both arms, the server's rule vs a standing-aware one, by promised horizon (last 24 h)`,
  ``,
  `The server's rule pairs a prediction for a bus ALREADY STANDING at the stop (a card listing the terminus while the bus sits there; upstream saying "0 min" during a layover) with that bus's NEXT visit — a lap later — because the arrival it is standing on happened before \`predicted_at\`. "already there" below is how many rows that is. The standing-aware rule (upstream-eta-common.ts \`truthFor\`) excludes them and pairs within 45 min.`,
  ``,
  `**Server rule**`,
  ``,
  mdTable(byHHeader, byHorizon(last24, "server")),
  ``,
  `**Standing-aware, 45 min**`,
  ``,
  mdTable(byHHeader, byHorizon(last24, "standing")),
  ``,
  `## Same (bus, stop, minute), same arrival — whole snapshot (${fmtEt(all[0]!.at)} .. ${fmtEt(to)} ET), standing-aware truth`,
  ``,
  `${hh.n} shared pairs. This is the only controlled read the log can give; the replay (Q2) is the same comparison at 31,810 pairs.`,
  ``,
  mdTable(h2hHeader, hh.byH),
  ``,
  mdTable(h2hHeader, hh.byRoute),
  ``,
].join("\n");
writeText("stats-check.md", md);
console.log(md);
