/**
 * COUNT — how often the #119 ceiling arms while the lead leg's standing mass
 * is below LEAD_SWITCH_MASS, and the gap between the armed ceiling and the
 * standing variant's own number at that poll; per rest identity, by stop.
 *
 * Red only, the real client from THIS worktree (web/src), master's arming
 * rule (`setCeilingArmsOnStanding(false)`) unless ARM=on. The payload is
 * rebuilt the way the previous investigation's minireplay.ts did it (fidelity
 * median -2 s against the logged predictions on 9/11): raw_positions polled
 * at 5 s, at_stop_since from stop_visits.pinned_at, stationary_since from a
 * repeated coordinate, lap ages from the arrivals' departures at 11 and 121.
 *
 *   FILE=arch-2026-09-10.tsv ARM=off npx tsx count.ts
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeUpcomingArrivals } from "../../../../web/src/arrivals";
import { registerRoutePaths } from "../../../../web/src/anchor";
import { applyModelParams } from "../../../../web/src/eta/params";
import { setCeilingArmsOnStanding, setClampTrace, type ClampEvent } from "../../../../web/src/eta/arrival";
import type { AnchorStore } from "../../../../web/src/eta/index";

const HERE = process.env.DATA ?? path.dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(fs.readFileSync(path.join(HERE, "buses_now.json"), "utf8"));
registerRoutePaths(data.route_paths);
applyModelParams(data.model_params);
const FILE = process.env.FILE ?? "arch-2026-09-11.tsv";
const ARM = process.env.ARM === "on";
setCeilingArmsOnStanding(ARM);
const A: any[] = [], V: any[] = [], R: any[] = [];
for (const l of fs.readFileSync(path.join(HERE, FILE), "utf8").split("\n")) { if (!l || l[1] !== "\t") continue; const t = l[0]; const r = JSON.parse(l.slice(2)); if (t === "A") A.push(r); else if (t === "V") V.push(r); else if (t === "R") R.push(r); }
const seq: number[] = data.routes["3"];
const TARGETS = [48, 72];
const byT = new Map<number, any[]>();
for (const r of R) { const k = Math.round(r.collected_at / 5000); if (!byT.has(k)) byT.set(k, []); byT.get(k)!.push(r); }
const polls = [...byT.entries()].sort((a, b) => a[0] - b[0]).map(([, rows]) => ({ t: Math.max(...rows.map((r) => r.collected_at)), rows }));
console.error(`${FILE} ARM=${ARM ? "on" : "off"}: polls ${polls.length}, first ${new Date(polls[0]!.t).toISOString()} last ${new Date(polls[polls.length - 1]!.t).toISOString()}`);
const visits = new Map<string, any[]>();
for (const v of V) { if (!visits.has(v.bus_name)) visits.set(v.bus_name, []); visits.get(v.bus_name)!.push(v); }
for (const l of visits.values()) l.sort((a, b) => a.pinned_at - b.pinned_at);
const truth = new Map<string, { t: number; d: number | null }[]>();
for (const a of [...A].sort((x, y) => x.arrived_at - y.arrived_at)) { const k = a.bus_name + ":" + a.stop_id; if (!truth.has(k)) truth.set(k, []); truth.get(k)!.push({ t: a.arrived_at, d: a.departed_at }); }
function truthAt(vs: { t: number; d: number | null }[] | undefined, at: number) {
  if (!vs || !vs.length) return { kind: "missing" as const };
  let lo = 0, hi = vs.length; while (lo < hi) { const m = (lo + hi) >> 1; if (vs[m]!.t < at) lo = m + 1; else hi = m; }
  if (lo > 0) { const p = vs[lo - 1]!; if ((p.d === null || p.d >= at) && at - p.t <= 7200e3) return { kind: "standing" as const }; }
  if (lo < vs.length && vs[lo]!.t - at <= 45 * 60e3) return { kind: "arrived" as const, at: vs[lo]!.t };
  return { kind: "missing" as const };
}
const deps = new Map<string, { stop: number; at: number }[]>();
for (const a of A) { if (a.departed_at && (a.stop_id === 11 || a.stop_id === 121)) { if (!deps.has(a.bus_name)) deps.set(a.bus_name, []); deps.get(a.bus_name)!.push({ stop: a.stop_id, at: a.departed_at }); } }
function lapFor(bus: string, t: number): Record<string, number> | undefined {
  const l = deps.get(bus); if (!l) return undefined; const out: Record<string, number> = {}; let any = false;
  for (const s of [11, 121]) { let best = -1; for (const d of l) if (d.stop === s && d.at <= t && d.at > best) best = d.at; if (best > 0 && t - best <= 7200e3) { out[String(s)] = Math.round((t - best) / 1000); any = true; } }
  return any ? out : undefined;
}
const iso = (ms: number) => new Date(ms).toISOString().replace(/Z$/, "");
const lastFix = new Map<string, { lat: number; lon: number; at: number; moved: number }>();
function busData(r: any, t: number) {
  const lf = lastFix.get(r.bus_name);
  const vis = visits.get(r.bus_name) ?? [];
  let v: any = null; for (const c of vis) { if (c.pinned_at <= t && t - c.pinned_at >= 15e3 && (c.departed_at === null || c.departed_at > t)) { if (!v || c.pinned_at > v.pinned_at) v = c; } }
  if (v && v.departed_at === null && t - v.pinned_at > 30 * 60e3) v = null;
  const stationarySince = lf && lf.lat === r.lat && lf.lon === r.lon ? lf.at : null;
  const b: any = { bus_id: r.bus_id, bus_name: r.bus_name, route_id: 3, lat: r.lat, lon: r.lon, heading: r.heading, last_stop_id: r.last_stop_id, stationary: !!v };
  if (v) { b.at_stop_id = v.stop_id; b.at_stop_since = iso(v.pinned_at); }
  if (stationarySince !== null && t - stationarySince >= 15e3) b.stationary_since = iso(stationarySince);
  if (lf && !(lf.lat === r.lat && lf.lon === r.lon)) b.last_moved_at = iso(t); else if (lf) b.last_moved_at = iso(lf.moved);
  const lap = lapFor(r.bus_name, t); if (lap) b.lap = lap;
  return b;
}
type Ev = ClampEvent & { t: number; bus: string; shown: number };
const events: Ev[] = [];
type Rec = { t: number; bus: string; stop: number; eta: number; ahead: number; err?: number; actual?: number; standingAt: number; s344: boolean };
const rows: Rec[] = [];
let curBus = "", curT = 0;
const perPollClamp = new Map<string, number>(); // bus -> clampAt this poll
setClampTrace((ev) => {
  const shown = ev.action === "hold" ? Math.min(ev.prevCeiling ?? Infinity, ev.mixture) : ev.action === "provisional" ? ev.mixture : ARM ? ev.standing : ev.mixture;
  events.push({ ...ev, t: curT, bus: curBus, shown });
  perPollClamp.set(curBus, ev.clampAt);
});
const store: AnchorStore = new Map();
const nb = (s: string) => String(s).replace(/^#/, "");
for (const poll of polls) {
  const t = poll.t; curT = t;
  perPollClamp.clear();
  for (const r of poll.rows) {
    curBus = r.bus_name;
    const b = busData(r, t);
    const res = computeUpcomingArrivals(TARGETS, [b], data.routes, data.stop_coords, data.segments, t, data.dwells, store);
    for (const a of res) {
      if (a.routeLabel !== "Red") continue;
      const sa = perPollClamp.get(r.bus_name) ?? -1;
      const rec: Rec = { t, bus: a.busName, stop: a.stopId, eta: a.eta, ahead: a.stopsAhead, standingAt: sa, s344: sa >= 0 && seq[sa] === 11 };
      const tr = truthAt(truth.get("#" + nb(a.busName) + ":" + a.stopId), t);
      if (tr.kind === "arrived" && a.eta <= 1800) { rec.actual = (tr.at - t) / 1000; rec.err = a.eta - rec.actual; }
      rows.push(rec);
    }
  }
  for (const r of poll.rows) {
    const lf = lastFix.get(r.bus_name);
    const moved = !lf || lf.lat !== r.lat || lf.lon !== r.lon;
    lastFix.set(r.bus_name, { lat: r.lat, lon: r.lon, at: moved ? t : lf!.at, moved: moved ? t : lf!.moved });
  }
}
setClampTrace(null);
const stopName = (idx: number) => { const sid = seq[idx]; return `${data.stop_names?.[sid] ?? sid} (${sid})`; };
const q = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : NaN; };
// -- per rest identity (bus, clampAt, since), target 48 rows only, occurrence 0
const rests = new Map<string, Ev[]>();
for (const e of events) { if (e.occurrence !== 0 || seq[e.stopIdx] !== 48) continue; const k = `${e.bus}|${e.clampAt}|${e.since}`; if (!rests.has(k)) rests.set(k, []); rests.get(k)!.push(e); }
type RestSum = { bus: string; clampAt: number; since: number; t0: number; durSec: number; firstAction: string; firstMass: number; gap: number; pollsToClear: number | null; maxMass: number; rises: number; maxRise: number; armedAt: number | null; armMass: number | null; armGap: number | null; polls: number };
const sums: RestSum[] = [];
for (const [, evs] of rests) {
  evs.sort((a, b) => a.t - b.t);
  const f = evs[0]!;
  let pollsToClear: number | null = null; let maxMass = 0; let rises = 0; let maxRise = 0; let prev = NaN;
  let armedAt: number | null = null, armMass: number | null = null, armGap: number | null = null;
  for (let i = 0; i < evs.length; i++) {
    const e = evs[i]!;
    maxMass = Math.max(maxMass, e.standMass);
    if (pollsToClear === null && e.standMass >= 0.8) pollsToClear = i;
    if (!Number.isNaN(prev) && e.shown > prev + 0.5) { rises++; maxRise = Math.max(maxRise, e.shown - prev); }
    prev = e.shown;
    if ((e.action === "arm" || e.action === "rearm") && armedAt === null && !(ARM && e.action === "arm" && e.standMass < 0.8)) { armedAt = i; armMass = e.standMass; armGap = e.standing - e.mixture; }
  }
  sums.push({ bus: f.bus, clampAt: f.clampAt, since: f.since, t0: f.t, durSec: (evs[evs.length - 1]!.t - f.t) / 1000, firstAction: f.action, firstMass: f.standMass, gap: f.standing - f.mixture, pollsToClear, maxMass, rises, maxRise, armedAt, armMass, armGap, polls: evs.length });
}
sums.sort((a, b) => a.t0 - b.t0);
const fmt = (x: number | null, d = 0) => x === null || Number.isNaN(x) ? "-" : x.toFixed(d);
console.log(`\n## ${FILE} ARM=${ARM ? "on" : "off"} — rest identities seen from the Division/Prospect (48) row (a rest = one (bus, stop, clock)); ${sums.length} rests, ${rows.length} rows`);
const long = sums.filter((s) => s.durSec >= 60);
console.log(`rests >= 60 s: ${long.length}; first-poll standing mass < 0.8 on ${long.filter((s) => s.firstMass < 0.8).length} (${(100 * long.filter((s) => s.firstMass < 0.8).length / Math.max(1, long.length)).toFixed(0)}%); never clears 0.8: ${long.filter((s) => s.pollsToClear === null).length}`);
console.log(`polls until standing mass >= 0.8 (rests >= 60 s that clear): median ${fmt(q(long.filter((s) => s.pollsToClear !== null).map((s) => s.pollsToClear!), .5))} p90 ${fmt(q(long.filter((s) => s.pollsToClear !== null).map((s) => s.pollsToClear!), .9))}`);
const gaps = long.filter((s) => s.firstMass < 0.8).map((s) => s.gap);
console.log(`gap (standing variant - mixture) at the FIRST clamp poll, rests >= 60 s armed below 0.8: n=${gaps.length} median ${fmt(q(gaps, .5))} p90 ${fmt(q(gaps, .9))} s`);
console.log(`rises of the shown number within a rest (rests >= 60 s): total ${long.reduce((a, s) => a + s.rises, 0)}; rests with >1 rise: ${long.filter((s) => s.rises > 1).length}; max single rise ${fmt(Math.max(0, ...long.map((s) => s.maxRise)))} s`);
console.log(`\nby stop (rests >= 60 s): n | armed<0.8 | gap median/p90 s | polls to 0.8 median | median dur s | rises/rest`);
const byStop = new Map<number, RestSum[]>();
for (const s of long) { if (!byStop.has(s.clampAt)) byStop.set(s.clampAt, []); byStop.get(s.clampAt)!.push(s); }
for (const [idx, ss] of [...byStop.entries()].sort((a, b) => b[1].length - a[1].length)) {
  const below = ss.filter((s) => s.firstMass < 0.8); const g = below.map((s) => s.gap); const pc = ss.filter((s) => s.pollsToClear !== null).map((s) => s.pollsToClear!);
  console.log(`  ${stopName(idx).padEnd(34)} ${String(ss.length).padStart(3)} | ${String(below.length).padStart(3)} | ${fmt(q(g, .5)).padStart(5)}/${fmt(q(g, .9)).padStart(5)} | ${fmt(q(pc, .5)).padStart(3)} | ${fmt(q(ss.map((s) => s.durSec), .5)).padStart(5)} | ${(ss.reduce((a, s) => a + s.rises, 0) / ss.length).toFixed(2)}`);
}
console.log(`\nlong rests (>= 180 s) one per line: ET time | bus | stop | dur | first mass | gap | polls to 0.8 | rises (max)`);
for (const s of sums.filter((s) => s.durSec >= 180)) console.log(`  ${new Date(s.t0 - 4 * 3600e3).toISOString().slice(11, 19)} ${s.bus.padEnd(5)} ${stopName(s.clampAt).padEnd(34)} ${fmt(s.durSec).padStart(5)} ${s.firstMass.toFixed(2)} ${fmt(s.gap).padStart(5)} ${fmt(s.pollsToClear).padStart(3)} ${s.rises} (${fmt(s.maxRise)})`);
// -- accuracy of the rows, standing vs moving (standingAt from the clamp trace)
function stats(errs: number[]) { const n = errs.length; if (!n) return "n=0"; return `n=${String(n).padStart(5)} medAbs=${q(errs.map(Math.abs), .5).toFixed(0).padStart(4)} medSigned=${q(errs, .5).toFixed(0).padStart(5)} p25=${q(errs, .25).toFixed(0).padStart(5)} p75=${q(errs, .75).toFixed(0).padStart(5)} bus-beat-promise>=120=${(100 * errs.filter((e) => e >= 120).length / n).toFixed(1)}% rider-waits-longer>=120=${(100 * errs.filter((e) => e <= -120).length / n).toFixed(1)}%`; }
console.log(`\n## accuracy (err = promised - actual; negative = the rider waits longer than told)`);
for (const [name, f] of [["all", () => true], ["standing", (r: Rec) => r.standingAt >= 0], ["moving", (r: Rec) => r.standingAt < 0], ["standing@344", (r: Rec) => r.standingAt >= 0 && seq[r.standingAt] === 11], ["stop 48", (r: Rec) => r.stop === 48], ["stop 72", (r: Rec) => r.stop === 72]] as [string, (r: Rec) => boolean][]) {
  console.log(`${name.padEnd(14)} ${stats(rows.filter((r) => r.err !== undefined && f(r)).map((r) => r.err!))}`);
}
fs.writeFileSync(path.join(HERE, `out-${FILE.replace(/\.tsv$/, "")}-${ARM ? "on" : "off"}.json`), JSON.stringify({ sums, rows: rows.filter((r) => r.err !== undefined) }));
