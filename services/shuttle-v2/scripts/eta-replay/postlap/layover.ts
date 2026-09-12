/**
 * THE LAYOVER DEFICIT, per route and per fitted CELL, on the current client.
 *
 * A generalisation of `scripts/eta-replay/trough/decompose.ts` (2026-09-11),
 * which answered the same question for Red only and before the lap covariate
 * was served on Blue Night. It replays the REAL client (`web/src`) over one
 * archived route-day, traces every priced row (`setPriceTrace`, inert in
 * production) and reports, for the rests a rider actually waits through:
 *
 *   - median signed error and median |error| of the number SHOWN;
 *   - the share of rows where the rider waits >= 120 s longer than told;
 *   - the deficit split — of the seconds the bus came LATER than shown, how
 *     many the #119 ratchet holds (shown below the poll's own mixture) and how
 *     many the ESTIMATE is low by (the mixture below the truth). Exactly the
 *     arithmetic behind the 40.5% / 59.5% figure in trough/README.md.
 *
 * The rider is the stop THREE hops past the resting cell, the way Red's
 * 344 Winchester (index 14) was read from Division / Prospect (index 17), so
 * every cell is measured through a chain of the same shape.
 *
 * ARMS are a payload patch, never a code change: `STRIP=13` serves the tables
 * with route 13's `lapB`/`lapM`/`lapN` removed, i.e. production as it was
 * before 2026-09-12, and `STRIP=3,13` removes the covariate altogether.
 *
 *   DATA=../../.eta-replay/postlap FILE=arch-r13-2026-09-10.tsv ROUTE=13 \
 *     STRIP=13 TAG=off13 npx tsx layover.ts
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeUpcomingArrivals } from "../../../web/src/arrivals";
import { registerRoutePaths } from "../../../web/src/anchor";
import { applyModelParams } from "../../../web/src/eta/params";
import { setPriceTrace, type PriceEvent } from "../../../web/src/eta/arrival";
import type { AnchorStore } from "../../../web/src/eta/index";

const HERE = process.env.DATA ?? path.dirname(fileURLToPath(import.meta.url));
const ROUTE = String(process.env.ROUTE ?? "3");
const FILE = process.env.FILE ?? `arch-r${ROUTE}-2026-09-10.tsv`;
const STRIP = (process.env.STRIP ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const TAG = process.env.TAG ?? (STRIP.length ? `strip${STRIP.join("+")}` : "on");
const REST_MIN = Number(process.env.REST_MIN ?? 300);
const RIDER_HOPS = Number(process.env.RIDER_HOPS ?? 3);

const data = JSON.parse(fs.readFileSync(path.join(HERE, "buses_now.json"), "utf8"));
registerRoutePaths(data.route_paths);
applyModelParams(data.model_params);

/** The cells this route has a served lap fit for, before any arm strips one. */
const seq: number[] = data.routes[ROUTE];
const N = seq.length;
const fittedStops = Object.entries(data.dwells[ROUTE] ?? {})
  .filter(([, d]: [string, any]) => d && d.lapB != null && d.lapM != null && d.lapN != null)
  .map(([s]) => Number(s));
// The arm: withhold the fit from these routes' tables. The per-bus lap ages are
// left alone — with no fit, `priceRoute` never asks for them.
let stripped = 0;
for (const r of STRIP) {
  for (const d of Object.values(data.dwells[r] ?? {}) as any[]) {
    if (d && (d.lapB != null || d.lapM != null || d.lapN != null)) { delete d.lapB; delete d.lapM; delete d.lapN; stripped++; }
  }
}
/** One rider per cell: the stop RIDER_HOPS past it on the ring. */
const cellIdx = fittedStops.map((s) => seq.indexOf(s)).filter((i) => i >= 0);
const riderOf = new Map<number, number>(); // rest index -> rider stop id
for (const i of cellIdx) riderOf.set(i, seq[(i + RIDER_HOPS) % N]!);
// A rider stop may also be named outright — the fidelity check has to price the
// stops riders were actually watching, which are not the cells' own riders.
const TARGET_OVERRIDE = (process.env.TARGETS ?? "").split(",").map((x) => Number(x.trim())).filter(Boolean);
const TARGETS = TARGET_OVERRIDE.length ? TARGET_OVERRIDE : [...new Set([...riderOf.values()])];
console.error(`${FILE} route ${ROUTE} TAG=${TAG}: fitted cells ${fittedStops.join(",")} (stripped ${stripped} keys), riders ${TARGETS.join(",")}`);

const A: any[] = [], V: any[] = [], R: any[] = [];
for (const l of fs.readFileSync(path.join(HERE, FILE), "utf8").split("\n")) {
  if (!l || l[1] !== "\t") continue;
  const t = l[0]; const r = JSON.parse(l.slice(2));
  if (t === "A") A.push(r); else if (t === "V") V.push(r); else if (t === "R") R.push(r);
}
const byT = new Map<number, any[]>();
for (const r of R) { const k = Math.round(r.collected_at / 5000); if (!byT.has(k)) byT.set(k, []); byT.get(k)!.push(r); }
const polls = [...byT.entries()].sort((a, b) => a[0] - b[0]).map(([, rows]) => ({ t: Math.max(...rows.map((r) => r.collected_at)), rows }));
console.error(`polls ${polls.length}`);

const visits = new Map<string, any[]>();
for (const v of V) { if (!visits.has(v.bus_name)) visits.set(v.bus_name, []); visits.get(v.bus_name)!.push(v); }
for (const l of visits.values()) l.sort((a, b) => a.pinned_at - b.pinned_at);
const truth = new Map<string, { t: number; d: number | null }[]>();
for (const a of [...A].sort((x, y) => x.arrived_at - y.arrived_at)) { const k = a.bus_name + ":" + a.stop_id; if (!truth.has(k)) truth.set(k, []); truth.get(k)!.push({ t: a.arrived_at, d: a.departed_at }); }
/** `truthAt` in src/server/predictions.ts: the first arrival within 45 min, and never a bus already standing there. */
function truthAt(vs: { t: number; d: number | null }[] | undefined, at: number) {
  if (!vs || !vs.length) return { kind: "missing" as const };
  let lo = 0, hi = vs.length; while (lo < hi) { const m = (lo + hi) >> 1; if (vs[m]!.t < at) lo = m + 1; else hi = m; }
  if (lo > 0) { const p = vs[lo - 1]!; if ((p.d === null || p.d >= at) && at - p.t <= 7200e3) return { kind: "standing" as const }; }
  if (lo < vs.length && vs[lo]!.t - at <= 45 * 60e3) return { kind: "arrived" as const, at: vs[lo]!.t };
  return { kind: "missing" as const };
}
/** The stand the bus is actually taking at `at`, from the detector: arrival -> departure. */
function standTruth(bus: string, stopId: number, at: number): { start: number; end: number } | null {
  const vs = truth.get(bus + ":" + stopId); if (!vs) return null;
  for (const v of vs) if (v.t <= at && (v.d === null || v.d >= at) && at - v.t <= 7200e3) return { start: v.t, end: v.d ?? at };
  return null;
}
// `buses[].lap`: seconds since this bus last departed each FITTED stop.
const deps = new Map<string, { stop: number; at: number }[]>();
for (const a of A) { if (a.departed_at && fittedStops.includes(a.stop_id)) { if (!deps.has(a.bus_name)) deps.set(a.bus_name, []); deps.get(a.bus_name)!.push({ stop: a.stop_id, at: a.departed_at }); } }
function lapFor(bus: string, t: number): Record<string, number> | undefined {
  const l = deps.get(bus); if (!l) return undefined; const out: Record<string, number> = {}; let any = false;
  for (const s of fittedStops) { let best = -1; for (const d of l) if (d.stop === s && d.at <= t && d.at > best) best = d.at; if (best > 0 && t - best <= 7200e3) { out[String(s)] = Math.round((t - best) / 1000); any = true; } }
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
  const b: any = { bus_id: r.bus_id, bus_name: r.bus_name, route_id: Number(ROUTE), lat: r.lat, lon: r.lon, heading: r.heading, last_stop_id: r.last_stop_id, stationary: !!v };
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
      const st = row.clampAt >= 0 ? standTruth("#" + nb(row.bus), seq[row.clampAt]!, t) : null;
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
const name = (sid: number) => String(data.stop_names?.[sid] ?? sid);
/** The rows a rider at the cell's own rider stop sees while the bus rests at that cell. */
const kept = rows.filter((r) => r.clampAt >= 0 && r.occurrence === 0 && r.actual !== undefined
  && (TARGET_OVERRIDE.length ? TARGET_OVERRIDE.includes(seq[r.stopIdx]!) : riderOf.get(r.clampAt) === seq[r.stopIdx]));
function summarise(label: string, rs: Row[]) {
  if (!rs.length) { console.log(`${label.padEnd(34)} | n 0`); return null; }
  const errs = rs.map((r) => r.shown - r.actual!);
  const pos = rs.filter((r) => r.actual! > r.shown);
  const sumR = pos.reduce((a, r) => a + Math.max(0, r.mixture - r.shown), 0);
  const sumT = pos.reduce((a, r) => a + (r.actual! - r.shown), 0);
  const rests = new Set(rs.map((r) => `${r.bus}|${r.clampAt}|${r.since}`)).size;
  const o = {
    label, n: rs.length, rests,
    medSigned: q(errs, 0.5), medAbs: q(errs.map(Math.abs), 0.5),
    wait120: 100 * errs.filter((e) => e <= -120).length / rs.length,
    early120: 100 * errs.filter((e) => e >= 120).length / rs.length,
    ratchetShare: 100 * sumR / Math.max(1, sumT), estShare: 100 * (sumT - sumR) / Math.max(1, sumT),
    medDeficit: q(pos.map((r) => r.actual! - r.shown), 0.5),
    medRatchet: q(pos.map((r) => Math.max(0, r.mixture - r.shown)), 0.5),
    medEst: q(pos.map((r) => Math.max(0, r.actual! - r.mixture)), 0.5),
    medMixture: q(rs.map((r) => r.mixture), 0.5), medShown: q(rs.map((r) => r.shown), 0.5),
    medResidual: q(rs.map((r) => r.residualMed), 0.5), medStandMed: q(rs.map((r) => r.standMed), 0.5),
    medLapF: q(rs.map((r) => r.lapF), 0.5),
  };
  console.log(`${label.padEnd(34)} | n ${String(o.n).padStart(5)} rests ${String(o.rests).padStart(3)} | signed ${f0(o.medSigned).padStart(5)} |err| ${f0(o.medAbs).padStart(4)} | wait>=120 ${o.wait120.toFixed(1).padStart(5)}% early>=120 ${o.early120.toFixed(1).padStart(4)}% | split ratchet ${o.ratchetShare.toFixed(1).padStart(5)}% / est ${o.estShare.toFixed(1).padStart(5)}% | medDef ${f0(o.medDeficit).padStart(4)} | mix ${f0(o.medMixture).padStart(4)} resid ${f0(o.medResidual).padStart(4)} standMed ${f0(o.medStandMed).padStart(4)} lapF ${o.medLapF.toFixed(2)}`);
  return o;
}
const longRest = (r: Row) => r.standEnd !== undefined && r.standStart !== undefined && (r.standEnd - r.standStart) / 1000 >= REST_MIN;
console.log(`\n#### route ${ROUTE} ${FILE} ${TAG}: ${kept.length} priced rows at the cells' riders\n`);
const out: any[] = [];
out.push(summarise(`route ${ROUTE} ALL standing rows`, kept));
out.push(summarise(`route ${ROUTE} rests >= ${REST_MIN}s`, kept.filter(longRest)));
for (const i of cellIdx) {
  const cell = `${ROUTE}:${seq[i]}`;
  const rs = kept.filter((r) => r.clampAt === i);
  out.push(summarise(`  ${cell} ${name(seq[i]!).slice(0, 18)} all`, rs));
  out.push(summarise(`  ${cell} ${name(seq[i]!).slice(0, 18)} >=${REST_MIN}s`, rs.filter(longRest)));
}
fs.writeFileSync(path.join(HERE, `lay-${FILE.replace(/\.tsv$/, "")}-${TAG}.json`), JSON.stringify({
  route: ROUTE, file: FILE, tag: TAG, stripped, fittedStops, riders: [...riderOf], summary: out,
  rows: kept.map((r) => ({ t: r.t, bus: r.bus, stopIdx: r.stopIdx, clampAt: r.clampAt, since: r.since, r: r.r, shown: r.shown, mixture: r.mixture, standing: r.standing, actual: r.actual, standStart: r.standStart, standEnd: r.standEnd, residualMed: r.residualMed, standMed: r.standMed, lapF: r.lapF, standMass: r.standMass, leadMass: r.leadMass, prevCeiling: r.prevCeiling })),
}));
