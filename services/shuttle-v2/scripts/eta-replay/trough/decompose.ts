/**
 * DECOMPOSE — what the card is priced FROM, poll by poll, while a Red bus
 * stands at a layover, and how much of the frozen error is the #119 ratchet
 * holding a trough rather than the estimate being low at that poll.
 *
 * Red only, the real client from THIS worktree (web/src). The payload is
 * rebuilt the way the ceiling harness did it (fidelity: median -2 s against
 * the logged predictions on 9/11) — see ../ceiling/README.md for the input
 * schema; the inputs are shared, under scripts/.eta-replay/trough/.
 *
 *   FILE=arch-2026-09-11.tsv npx tsx decompose.ts
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeUpcomingArrivals } from "../../../web/src/arrivals";
import { registerRoutePaths } from "../../../web/src/anchor";
import { applyModelParams } from "../../../web/src/eta/params";
import { setCeilingHoldsUnderDeparture, setPriceTrace, type PriceEvent } from "../../../web/src/eta/arrival";
import type { AnchorStore } from "../../../web/src/eta/index";

const HERE = process.env.DATA ?? path.dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(fs.readFileSync(path.join(HERE, "buses_now.json"), "utf8"));
registerRoutePaths(data.route_paths);
applyModelParams(data.model_params);
const FILE = process.env.FILE ?? "arch-2026-09-11.tsv";
const ARM = process.env.TROUGH === "on";
setCeilingHoldsUnderDeparture(ARM);
const TAG = process.env.TAG ?? (ARM ? "on" : "off");
const A: any[] = [], V: any[] = [], R: any[] = [];
for (const l of fs.readFileSync(path.join(HERE, FILE), "utf8").split("\n")) {
  if (!l || l[1] !== "\t") continue;
  const t = l[0]; const r = JSON.parse(l.slice(2));
  if (t === "A") A.push(r); else if (t === "V") V.push(r); else if (t === "R") R.push(r);
}
const seq: number[] = data.routes["3"];
const TARGETS = [48, 72];
const byT = new Map<number, any[]>();
for (const r of R) { const k = Math.round(r.collected_at / 5000); if (!byT.has(k)) byT.set(k, []); byT.get(k)!.push(r); }
const polls = [...byT.entries()].sort((a, b) => a[0] - b[0]).map(([, rows]) => ({ t: Math.max(...rows.map((r) => r.collected_at)), rows }));
console.error(`${FILE} TAG=${TAG}: polls ${polls.length}`);
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
/** The stand the bus is actually taking at `clampAt`, from the detector: arrival -> departure. */
function standTruth(bus: string, stopId: number, at: number): { start: number; end: number } | null {
  const vs = truth.get(bus + ":" + stopId); if (!vs) return null;
  for (const v of vs) if (v.t <= at && (v.d === null || v.d >= at) && at - v.t <= 7200e3) return { start: v.t, end: v.d ?? at };
  return null;
}
const deps = new Map<string, { stop: number; at: number }[]>();
for (const a of A) { if (a.departed_at && (a.stop_id === 11 || a.stop_id === 121)) { if (!deps.has(a.bus_name)) deps.set(a.bus_name, []); deps.get(a.bus_name)!.push({ stop: a.stop_id, at: a.departed_at }); } }
function lapFor(bus: string, t: number): Record<string, number> | undefined {
  const l = deps.get(bus); if (!l) return undefined; const out: Record<string, number> = {}; let any = false;
  for (const s of [11, 121]) { let best = -1; for (const d of l) if (d.stop === s && d.at <= t && d.at > best) best = d.at; if (best > 0 && t - best <= 7200e3) { out[String(s)] = Math.round((t - best) / 1000); any = true; } }
  return any ? out : undefined;
}
const iso = (ms: number) => new Date(ms).toISOString().replace(/Z$/, "");
const et = (ms: number) => new Date(ms - 4 * 3600e3).toISOString().slice(11, 19);
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
type Row = PriceEvent & { t: number; bus: string; fresh: boolean; actual?: number; standEnd?: number; standStart?: number };
const rows: Row[] = [];
let curBus = "", curT = 0, curFresh = false;
setPriceTrace((ev) => { if (ev.stopIdx === undefined) return; rows.push({ ...ev, t: curT, bus: curBus, fresh: curFresh }); });
const store: AnchorStore = new Map();
const nb = (s: string) => String(s).replace(/^#/, "");
for (const poll of polls) {
  const t = poll.t; curT = t;
  for (const r of poll.rows) {
    curBus = r.bus_name;
    const lf0 = lastFix.get(r.bus_name);
    curFresh = !lf0 || lf0.lat !== r.lat || lf0.lon !== r.lon;
    const b = busData(r, t);
    const before = rows.length;
    computeUpcomingArrivals(TARGETS, [b], data.routes, data.stop_coords, data.segments, t, data.dwells, store);
    for (let i = before; i < rows.length; i++) {
      const row = rows[i]!;
      const sid = seq[row.stopIdx]!;
      const tr = truthAt(truth.get("#" + nb(row.bus) + ":" + sid), t);
      if (tr.kind === "arrived") row.actual = (tr.at - t) / 1000;
      const st = standTruth("#" + nb(row.bus), seq[row.clampAt]!, t);
      if (st) { row.standStart = st.start; row.standEnd = st.end; }
    }
  }
  for (const r of poll.rows) {
    const lf = lastFix.get(r.bus_name);
    const moved = !lf || lf.lat !== r.lat || lf.lon !== r.lon;
    lastFix.set(r.bus_name, { lat: r.lat, lon: r.lon, at: moved ? t : lf!.at, moved: moved ? t : lf!.moved });
  }
}
setPriceTrace(null);
const q = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : NaN; };
const f0 = (x: number) => Number.isFinite(x) ? x.toFixed(0) : "-";
const stopName = (idx: number) => { const sid = seq[idx]; return `${data.stop_names?.[sid] ?? sid}`; };
// -- rests: the rows a rider at Division / Prospect (48) sees, occurrence 0, while the bus rests
const mine = rows.filter((r) => seq[r.stopIdx] === 48 && r.occurrence === 0 && r.clampAt >= 0 && r.actual !== undefined);
const rests = new Map<string, Row[]>();
for (const r of mine) { const k = `${r.bus}|${r.clampAt}|${r.since}`; if (!rests.has(k)) rests.set(k, []); rests.get(k)!.push(r); }
type Rest = { key: string; bus: string; clampAt: number; rows: Row[]; durSec: number; standSec: number };
const all: Rest[] = [];
for (const [key, rs] of rests) {
  rs.sort((a, b) => a.t - b.t);
  const f = rs[0]!, l = rs[rs.length - 1]!;
  all.push({ key, bus: f.bus, clampAt: f.clampAt, rows: rs, durSec: (l.t - f.t) / 1000, standSec: f.standEnd && f.standStart ? (f.standEnd - f.standStart) / 1000 : NaN });
}
all.sort((a, b) => a.rows[0]!.t - b.rows[0]!.t);
const long = all.filter((x) => x.durSec >= 300 && seq[x.clampAt] === 11);
console.log(`\n#### ${FILE} ${TAG}: ${all.length} rests priced from stop 48; ${long.length} at 344 Winchester lasting >= 300 s\n`);
// -- the decomposition, per rest
console.log(`rest                          | stand | shown min (poll,r) | trough: mix at that poll | standMass | lapF | residual | deficit split (ratchet / estimate)`);
for (const x of long) {
  const rs = x.rows;
  let iMin = 0; for (let i = 0; i < rs.length; i++) if (rs[i]!.shown < rs[iMin]!.shown) iMin = i;
  // the first poll whose RAW mixture is within 10 s of the minimum shown: where the trough came from
  let iTr = 0; for (let i = 0; i < rs.length; i++) { if (rs[i]!.mixture <= rs[iMin]!.shown + 10) { iTr = i; break; } }
  const tr = rs[iTr]!;
  const defs = rs.filter((r) => r.actual! > r.shown).map((r) => ({ ratchet: Math.max(0, r.mixture - r.shown), est: Math.max(0, r.actual! - r.mixture), tot: r.actual! - r.shown }));
  const sumR = defs.reduce((a, d) => a + d.ratchet, 0), sumT = defs.reduce((a, d) => a + d.tot, 0);
  console.log(`${x.bus} ${et(rs[0]!.t)} ${stopName(x.clampAt).padEnd(16)}| ${f0(x.standSec).padStart(5)} | ${f0(rs[iMin]!.shown).padStart(5)} (${String(iMin).padStart(3)},${f0(rs[iMin]!.r).padStart(4)}) | ${f0(tr.mixture).padStart(5)} at poll ${String(iTr).padStart(3)} r=${f0(tr.r).padStart(4)} | ${tr.standMass.toFixed(2)} | ${tr.lapF.toFixed(2)} | ${f0(tr.residualMed).padStart(4)} | ${(100 * sumR / Math.max(1, sumT)).toFixed(0)}% / ${(100 * (sumT - sumR) / Math.max(1, sumT)).toFixed(0)}%`);
}
// -- pooled deficit split over every standing row
const st = mine.filter((r) => r.standMass > 0);
const pos = st.filter((r) => r.actual! > r.shown);
const sumR = pos.reduce((a, r) => a + Math.max(0, r.mixture - r.shown), 0);
const sumT = pos.reduce((a, r) => a + (r.actual! - r.shown), 0);
console.log(`\npooled over ${st.length} standing rows (${pos.length} where the bus came LATER than shown): total deficit ${f0(sumT)} s; ratchet ${f0(sumR)} s (${(100 * sumR / Math.max(1, sumT)).toFixed(1)}%), estimate ${f0(sumT - sumR)} s (${(100 * (sumT - sumR) / Math.max(1, sumT)).toFixed(1)}%)`);
console.log(`per-row medians: deficit ${f0(q(pos.map((r) => r.actual! - r.shown), .5))} s, ratchet part ${f0(q(pos.map((r) => Math.max(0, r.mixture - r.shown)), .5))} s, estimate part ${f0(q(pos.map((r) => Math.max(0, r.actual! - r.mixture)), .5))} s`);
const errs = st.map((r) => r.shown - r.actual!);
console.log(`standing rows: medSigned ${f0(q(errs, .5))} medAbs ${f0(q(errs.map(Math.abs), .5))} waits>=120 ${(100 * errs.filter((e) => e <= -120).length / errs.length).toFixed(1)}%`);
// -- the episode tables
const want = (process.env.EPISODES ?? "").split(",").filter(Boolean);
for (const x of long) {
  const lab = `${x.bus}@${et(x.rows[0]!.t).slice(0, 5)}`;
  if (want.length && !want.includes(lab)) continue;
  if (!want.length && x.durSec < 700) continue;
  const rs = x.rows;
  console.log(`\n### ${lab} ${stopName(x.clampAt)} stand ${f0(x.standSec)} s, ${rs.length} polls priced to Division / Prospect`);
  console.log(`   ET       r  fresh standM moveM | mixture standOwn moveOwn departNow resid lapF | ceil shown | truth  err`);
  const step = Math.max(1, Math.floor(rs.length / 26));
  for (let i = 0; i < rs.length; i += (i < 8 ? 1 : step)) {
    const r = rs[i]!;
    console.log(`   ${et(r.t)} ${f0(r.r).padStart(4)} ${r.fresh ? "  F  " : "     "} ${r.standMass.toFixed(2)}  ${r.moveMass.toFixed(2)} | ${f0(r.mixture).padStart(7)} ${f0(r.standing).padStart(8)} ${f0(r.moving).padStart(7)} ${f0(r.departNow).padStart(9)} ${f0(r.residualMed).padStart(5)} ${r.lapF.toFixed(2)} | ${f0(r.prevCeiling ?? NaN).padStart(4)} ${f0(r.shown).padStart(5)} | ${f0(r.actual!).padStart(5)} ${f0(r.shown - r.actual!).padStart(5)}`);
  }
}
fs.writeFileSync(path.join(HERE, `dec-${FILE.replace(/\.tsv$/, "")}-${TAG}.json`), JSON.stringify({ rows: mine }));
