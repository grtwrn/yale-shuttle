/**
 * Q3 — does upstream's ETA SET say which leg of a fold the bus is on?
 *
 * Green (9) and Purple (10) run out to West Campus and back on the same road,
 * so one coordinate belongs to two legs at once; the ring estimator carries
 * both and can only separate them while the bus moves (docs/eta-ring-posterior.md
 * §1, the "Purple detour"). Upstream lists an ETA per (bus, stop) — and a
 * stop on the far side of the fold is minutes away on one leg and most of a
 * lap on the other — so the SET of stops it lists, and their horizons, is a
 * direction observation the filter does not have.
 *
 * For every capture fix of a bus on a fold route (one per 15 s):
 *   - candidate legs = the route legs whose ROAD (traceStopLegs) passes within
 *     FOLD_M of the fix; the moment is ambiguous when there are two or more;
 *   - truth leg = the detector's own record: the `stop_visits` before and
 *     after the moment must be consecutive in the sequence, and the leg is
 *     the one between them (moments the detector cannot settle are skipped);
 *   - upstream's leg = the candidate under which the horizons upstream listed
 *     in its latest cycle (the rows for this bus in the 45 s up to the fix)
 *     fit best: Σ_S |U(S) − T_i(S)|, T_i(S) being the time from mid-leg i to
 *     the next occurrence of S along the sequence, priced from the snapshot's
 *     own `legs` (median leg_sec per hop) and `stop_visits` (median stand per
 *     stop index). A FOCUS stop (polled every cycle) that upstream did NOT
 *     list is evidence too: it is more than 30 min away, cost max(0, 1800 −
 *     T_i(S)).
 *   Baselines: the nearer leg by road distance, and the leg whose bearing
 *   agrees with the feed's heading.
 *
 *   cd services/shuttle-v2
 *   TZ=America/New_York REPLAY_DB=./store/snap-0906-1230.db npx tsx scripts/eta-replay/upstream-eta-fold.ts
 *
 * Env: REPLAY_DB, CAPTURES, FROM/TO, FOLD_ROUTES (default 9,10), FOLD_M (150).
 */
import { distanceToSegmentM, haversineMeters, traceStopLegs } from "../../web/src/geo";
import { FOCUS_STOP_NAMES } from "../../src/collector/upstreamEta.js";
import {
  OUT_DIR, etDay, fmtEt, loadCaptures, loadUpstream, mdTable, openDb, parseWindow, quantile, r1, routeNames, tracksByBus,
  writeJson, writeText, type Pos, type UpstreamRow,
} from "./upstream-eta-common.js";

const T0 = Date.now();
const log = (...a: unknown[]) => console.error(`[${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a);

const FOLD_ROUTES = (process.env.FOLD_ROUTES ?? "9,10").split(",").map(Number);
const FOLD_M = Number(process.env.FOLD_M ?? 150);
const STRIDE_MS = 15_000;
const CYCLE_LOOKBACK_MS = 37_500; // the poller's 30 s cycle + half a bucket
const CYCLE_LOOKAHEAD_MS = 7_500;

const db = openDb();
const { from, to } = parseWindow();
const up = loadUpstream(db, from, to).filter((u) => FOLD_ROUTES.includes(u.routeId));
if (up.length === 0) throw new Error("no upstream rows for the fold routes");
const winFrom = up[0]!.at, winTo = up[up.length - 1]!.at;
log(`upstream rows ${up.length} on routes ${FOLD_ROUTES.join(",")}, ${fmtEt(winFrom)} .. ${fmtEt(winTo)} ET`);
const names = routeNames(db);
const stopName = new Map<number, string>((db.prepare("SELECT id, name FROM stops").all() as any[]).map((s) => [s.id, s.name]));
const stopCoords = new Map<number, { lat: number; lon: number }>((db.prepare("SELECT id, lat, lon FROM stops").all() as any[]).map((s) => [s.id, { lat: s.lat, lon: s.lon }]));
const focusIds = new Set<number>([...stopName].filter(([, n]) => FOCUS_STOP_NAMES.includes(n)).map(([id]) => id));

// Poller activity: minutes in which ANY upstream row (any route) was written.
const activeMinutes = new Set<number>((db.prepare(`SELECT DISTINCT predicted_at / 60000 AS m FROM predictions_log WHERE surface = 'upstream' AND predicted_at BETWEEN ? AND ?`).all(winFrom - 120_000, winTo + 120_000) as any[]).map((r) => r.m));
const pollerActive = (t: number): boolean => activeMinutes.has(Math.floor(t / 60_000)) || activeMinutes.has(Math.floor(t / 60_000) - 1);

interface RouteGeom { id: number; seq: number[]; N: number; legs: Array<{ pts: [number, number][]; bearing: number[] }>; hop: number[]; stand: number[] }
const geoms = new Map<number, RouteGeom>();
for (const rid of FOLD_ROUTES) {
  const r = db.prepare("SELECT stops_json, path_json FROM routes WHERE id = ?").get(rid) as any;
  const seq = JSON.parse(r.stops_json) as number[];
  const path = JSON.parse(r.path_json) as [number, number][];
  const N = seq.length;
  const traced = traceStopLegs(path, [...seq, seq[0]!].map((s) => stopCoords.get(s)!));
  const legs = traced.map((tl) => ({
    pts: tl.slice,
    bearing: tl.slice.slice(1).map((p, i) => bearingDeg({ lat: tl.slice[i]![0], lon: tl.slice[i]![1] }, { lat: p[0], lon: p[1] })),
  }));
  // Hop times: median kerb-to-kerb leg_sec per (from_index → to_index) over the snapshot; fallback 6 m/s road + 20 s.
  const hop = new Array<number>(N).fill(0);
  for (let i = 0; i < N; i++) {
    const rows = db.prepare(`SELECT leg_sec s FROM legs WHERE route_id = ? AND from_index = ? AND to_index = ? AND hops = 1 AND leg_sec > 0`).all(rid, i, (i + 1) % N) as any[];
    const secs = rows.map((x) => x.s).sort((a: number, b: number) => a - b);
    const roadM = legs[i] ? legs[i]!.pts.slice(1).reduce((m, p, j) => m + haversineMeters({ lat: legs[i]!.pts[j]![0], lon: legs[i]!.pts[j]![1] }, { lat: p[0], lon: p[1] }), 0) : haversineMeters(stopCoords.get(seq[i]!)!, stopCoords.get(seq[(i + 1) % N]!)!);
    hop[i] = secs.length >= 5 ? quantile(secs, 0.5) : roadM / 6 + 20;
  }
  const stand = new Array<number>(N).fill(0);
  for (let i = 0; i < N; i++) {
    const rows = db.prepare(`SELECT COALESCE(stand_sec, 0) s FROM stop_visits WHERE route_id = ? AND stop_index = ? AND outcome IN ('stopped','passed')`).all(rid, i) as any[];
    const secs = rows.map((x) => x.s).sort((a: number, b: number) => a - b);
    stand[i] = secs.length >= 5 ? quantile(secs, 0.5) : 0;
  }
  geoms.set(rid, { id: rid, seq, N, legs, hop, stand });
  log(`route ${rid}: ${N} stops, hops(s) ${hop.map(Math.round).join(" ")}, stands(s) ${stand.map(Math.round).join(" ")}`);
}
function bearingDeg(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const φ1 = (a.lat * Math.PI) / 180, φ2 = (b.lat * Math.PI) / 180, Δλ = ((b.lon - a.lon) * Math.PI) / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}
/** Distance from the fix to leg i's road, and the road bearing at the nearest point. */
function legDistance(g: RouteGeom, i: number, p: { lat: number; lon: number }): { d: number; bearing: number } {
  const leg = g.legs[i];
  if (!leg || leg.pts.length < 2) return { d: Infinity, bearing: 0 };
  let best = Infinity, bearing = 0;
  for (let j = 0; j + 1 < leg.pts.length; j++) {
    const d = distanceToSegmentM(p, { lat: leg.pts[j]![0], lon: leg.pts[j]![1] }, { lat: leg.pts[j + 1]![0], lon: leg.pts[j + 1]![1] });
    if (d < best) { best = d; bearing = leg.bearing[j]!; }
  }
  return { d: best, bearing };
}
/** Seconds from the middle of leg i to the next occurrence of stop S along the sequence. */
function timeTo(g: RouteGeom, i: number, S: number): number {
  let t = 0.5 * g.hop[i]!;
  for (let k = 1; k <= g.N; k++) {
    const idx = (i + k) % g.N;
    if (g.seq[idx] === S) return t;
    t += g.stand[idx]! + g.hop[idx]!;
  }
  return Infinity;
}

// Truth: consecutive stop_visits around the moment.
interface Visit { idx: number; at: number }
const visits = new Map<string, Visit[]>();
for (const v of db.prepare(`SELECT bus_name b, route_id r, stop_index i, anchored_at t FROM stop_visits WHERE anchored_at BETWEEN ? AND ? AND route_id IN (${FOLD_ROUTES.join(",")}) ORDER BY anchored_at`).all(winFrom - 3_600_000, winTo + 3_600_000) as any[]) {
  const k = `${String(v.b).replace(/^#/, "")}:${v.r}`;
  (visits.get(k) ?? visits.set(k, []).get(k)!).push({ idx: v.i, at: v.t });
}
/**
 * The legs the bus can be on at t: from the visit before to the visit after,
 * which must be at most MAX_SKIP stops apart in the sequence (the detector
 * skips a pass now and then, on the return through West Campus especially —
 * with the strict "consecutive" rule the return highway leg had no truth at
 * all). The caller collapses the legs to a branch and requires it to be unique.
 */
const MAX_SKIP = 2;
function truthLegs(bus: string, rid: number, N: number, t: number): { legs: number[]; resolvesAt: number; startedAt: number } | null {
  const vs = visits.get(`${bus}:${rid}`);
  if (!vs) return null;
  let lo = 0, hi = vs.length;
  while (lo < hi) { const m = (lo + hi) >>> 1; if (vs[m]!.at <= t) lo = m + 1; else hi = m; }
  const prev = vs[lo - 1], next = vs[lo];
  if (!prev || !next) return null;
  const ahead = (next.idx - prev.idx + N) % N;
  if (ahead < 1 || ahead > 1 + MAX_SKIP) return null;
  if (next.at - t > 45 * 60_000) return null;
  const legs: number[] = [];
  for (let k = 0; k < ahead; k++) legs.push((prev.idx + k) % N);
  return { legs, resolvesAt: next.at, startedAt: prev.at };
}

// Upstream rows per bus, time-sorted.
const upByBus = new Map<string, UpstreamRow[]>();
for (const u of up) (upByBus.get(u.bus) ?? upByBus.set(u.bus, []).get(u.bus)!).push(u);
function latestCycle(bus: string, rid: number, t: number): UpstreamRow[] {
  const rows = upByBus.get(bus);
  if (!rows) return [];
  const out: UpstreamRow[] = [];
  let lo = 0, hi = rows.length;
  while (lo < hi) { const m = (lo + hi) >>> 1; if (rows[m]!.at < t - CYCLE_LOOKBACK_MS) lo = m + 1; else hi = m; }
  const seen = new Set<number>();
  for (let i = lo; i < rows.length && rows[i]!.at <= t + CYCLE_LOOKAHEAD_MS; i++) {
    const r = rows[i]!;
    if (r.routeId !== rid || seen.has(r.stopId)) continue;
    seen.add(r.stopId);
    out.push(r);
  }
  return out;
}

const pos = loadCaptures(winFrom - 600_000, winTo + 600_000).filter((p) => FOLD_ROUTES.includes(p.r));
log(`capture rows on fold routes ${pos.length}`);
const tracks = tracksByBus(pos);

interface Moment {
  day: string; bus: string; rid: number; t: number; moved: boolean; truth: number; truthBranch: number; cands: number[]; branches: number; nearest: number;
  headingLeg: number | null; upLeg: number | null; upBranch: number | null; evidence: number; absent: number; resolvesAt: number; startedAt: number; upMargin: number;
  listed: Record<string, number>; nearestBranch: number; headingBranch: number | null;
}
/** Candidate legs → branch id (runs of sequence-consecutive legs share one). */
function branches(cands: readonly number[], N: number): Map<number, number> {
  const set = new Set(cands);
  const out = new Map<number, number>();
  let id = 0;
  for (const c of [...cands].sort((a, b) => a - b)) {
    if (out.has(c)) continue;
    // walk backwards to the run's start, then forwards
    let start = c;
    while (set.has((start - 1 + N) % N) && (start - 1 + N) % N !== c) start = (start - 1 + N) % N;
    let cur = start;
    do { out.set(cur, id); cur = (cur + 1) % N; } while (set.has(cur) && !out.has(cur));
    id++;
  }
  return out;
}
const moments: Moment[] = [];
let polls = 0, ambiguous = 0, noTruth = 0;
for (const [bus, track] of tracks) {
  let lastT = -Infinity;
  let prev: Pos | null = null;
  for (const p of track) {
    const moved = !prev || prev.lat !== p.lat || prev.lon !== p.lon;
    prev = p;
    if (p.t - lastT < STRIDE_MS) continue;
    lastT = p.t;
    polls++;
    const g = geoms.get(p.r)!;
    const dists = g.legs.map((_, i) => legDistance(g, i, p));
    const cands = dists.map((d, i) => (d.d <= FOLD_M ? i : -1)).filter((i) => i >= 0);
    // A fold needs two candidate legs that are NOT neighbours in the sequence:
    // a bus 100 m short of a stop is within FOLD_M of the leg into it and the
    // leg out of it, and that is adjacency, not ambiguity. Candidates are
    // grouped into BRANCHES (runs of consecutive legs); the question is which
    // branch, so agreement is scored on the branch.
    const branchOf = branches(cands, g.N);
    if (new Set(branchOf.values()).size < 2) continue;
    ambiguous++;
    const tr0 = truthLegs(bus, p.r, g.N, p.t);
    const truthBranches = tr0 ? new Set(tr0.legs.filter((l) => branchOf.has(l)).map((l) => branchOf.get(l)!)) : new Set<number>();
    if (!tr0 || truthBranches.size !== 1) { noTruth++; continue; }
    const tr = { leg: tr0.legs.find((l) => branchOf.has(l))!, resolvesAt: tr0.resolvesAt, startedAt: tr0.startedAt };
    const nearest = cands.reduce((a, b) => (dists[a]!.d <= dists[b]!.d ? a : b));
    // Heading baseline: the candidate whose road bearing is within 90° of the feed's heading; null when 0 or 2+ qualify.
    const withHeading = cands.filter((i) => { const d = Math.abs(((dists[i]!.bearing - p.h + 540) % 360) - 180); return d < 90; });
    const headingBranches = new Set(withHeading.map((i) => branchOf.get(i)!));
    const headingLeg = headingBranches.size === 1 ? withHeading[0]! : null;
    // Upstream evidence.
    const rows = latestCycle(bus, p.r, p.t);
    const listed = new Set(rows.map((r) => r.stopId));
    const absent = pollerActive(p.t) ? [...focusIds].filter((s) => g.seq.includes(s) && !listed.has(s)) : [];
    let upLeg: number | null = null, upMargin = 0;
    if (rows.length + absent.length > 0) {
      const cost = cands.map((i) => {
        let c = 0;
        for (const r of rows) { const T = timeTo(g, i, r.stopId); c += Number.isFinite(T) ? Math.abs(r.sec - T) : 1800; }
        for (const s of absent) { const T = timeTo(g, i, s); c += Number.isFinite(T) ? Math.max(0, 1800 - T) : 0; }
        return c;
      });
      const order = cands.map((_, k) => k).sort((a, b) => cost[a]! - cost[b]!);
      upLeg = cands[order[0]!]!;
      upMargin = cost[order[1]!]! - cost[order[0]!]!;
    }
    const listedSec: Record<string, number> = {};
    for (const r of rows) listedSec[String(r.stopId)] = r.sec;
    moments.push({
      day: etDay(p.t), bus, rid: p.r, t: p.t, moved, truth: tr.leg, truthBranch: branchOf.get(tr.leg)!, cands, branches: new Set(branchOf.values()).size, nearest, nearestBranch: branchOf.get(nearest)!,
      headingLeg, headingBranch: headingLeg === null ? null : branchOf.get(headingLeg)!, upLeg, upBranch: upLeg === null ? null : branchOf.get(upLeg)!,
      evidence: rows.length, absent: absent.length, resolvesAt: tr.resolvesAt, startedAt: tr.startedAt, upMargin, listed: listedSec,
    });
  }
}
log(`polls (15 s) ${polls}, ambiguous ${ambiguous}, with detector truth ${moments.length} (no settled truth ${noTruth})`);

// -- Tables ---------------------------------------------------------------------
const pct = (a: number, b: number) => (b ? `${r1((100 * a) / b)}%` : "–");
function score(sel: readonly Moment[]) {
  const n = sel.length;
  const withEv = sel.filter((m) => m.upLeg !== null);
  const upRight = withEv.filter((m) => m.upBranch === m.truthBranch).length;
  const confident = withEv.filter((m) => m.upMargin >= 300);
  const confRight = confident.filter((m) => m.upBranch === m.truthBranch).length;
  const nearRight = sel.filter((m) => m.nearestBranch === m.truthBranch).length;
  const hd = sel.filter((m) => m.headingBranch !== null);
  const hdRight = hd.filter((m) => m.headingBranch === m.truthBranch).length;
  const avgCands = n ? sel.reduce((s, m) => s + m.branches, 0) / n : NaN;
  return { n, avgCands, withEv: withEv.length, upRight, confident: confident.length, confRight, nearRight, hd: hd.length, hdRight };
}
const header = ["slice", "ambiguous moments", "mean branches", "upstream has evidence", "upstream right", "…of which margin ≥5 min", "right when confident", "nearest-road right", "heading decides", "heading right"];
function row(label: string, sel: readonly Moment[]): (string | number)[] {
  const s = score(sel);
  return [label, s.n, r1(s.avgCands), pct(s.withEv, s.n), pct(s.upRight, s.withEv), pct(s.confident, s.withEv), pct(s.confRight, s.confident), pct(s.nearRight, s.n), pct(s.hd, s.n), pct(s.hdRight, s.hd)];
}
const rows: (string | number)[][] = [];
for (const rid of FOLD_ROUTES) {
  const sel = moments.filter((m) => m.rid === rid);
  rows.push(row(`${names.get(rid)} (${rid})`, sel));
  rows.push(row(`  moving`, sel.filter((m) => m.moved)));
  rows.push(row(`  standing (repeated fix)`, sel.filter((m) => !m.moved)));
  for (const d of [...new Set(sel.map((m) => m.day))].sort()) rows.push(row(`  ${d}`, sel.filter((m) => m.day === d)));
}
rows.push(row("all", moments));

// Spells: contiguous ambiguous moments of one bus with one truth leg; how early upstream is right.
interface Spell { rid: number; bus: string; start: number; end: number; resolvesAt: number; firstEvidence: number | null; firstRight: number | null; everWrongAfterRight: boolean; n: number }
const spells: Spell[] = [];
{
  const byBus = new Map<string, Moment[]>();
  for (const m of moments) (byBus.get(`${m.bus}:${m.rid}`) ?? byBus.set(`${m.bus}:${m.rid}`, []).get(`${m.bus}:${m.rid}`)!).push(m);
  for (const list of byBus.values()) {
    list.sort((a, b) => a.t - b.t);
    let cur: Spell | null = null;
    let lastTruth = -1, lastT = -Infinity;
    for (const m of list) {
      if (!cur || m.truthBranch !== lastTruth || m.t - lastT > 60_000) {
        if (cur) spells.push(cur);
        cur = { rid: m.rid, bus: m.bus, start: m.t, end: m.t, resolvesAt: m.resolvesAt, firstEvidence: null, firstRight: null, everWrongAfterRight: false, n: 0 };
      }
      cur.end = m.t; cur.n++;
      if (m.upLeg !== null) {
        if (cur.firstEvidence === null) cur.firstEvidence = m.t;
        if (m.upBranch === m.truthBranch) { if (cur.firstRight === null) cur.firstRight = m.t; }
        else if (cur.firstRight !== null) cur.everWrongAfterRight = true;
      }
      lastTruth = m.truthBranch; lastT = m.t;
    }
    if (cur) spells.push(cur);
  }
}
const spellHeader = ["slice", "spells", "median length", "with evidence", "right at first evidence", "ever right", "lead before the detector settles it (median, right spells)", "right then wrong later"];
function spellRow(label: string, sel: readonly Spell[]): (string | number)[] {
  const n = sel.length;
  const withEv = sel.filter((s) => s.firstEvidence !== null);
  const rightFirst = withEv.filter((s) => s.firstRight !== null && s.firstRight === s.firstEvidence).length;
  const everRight = withEv.filter((s) => s.firstRight !== null);
  const lead = everRight.map((s) => (s.resolvesAt - s.firstRight!) / 60_000).sort((a, b) => a - b);
  const len = sel.map((s) => (s.end - s.start) / 60_000).sort((a, b) => a - b);
  return [label, n, `${r1(quantile(len, 0.5))} min`, pct(withEv.length, n), pct(rightFirst, withEv.length), pct(everRight.length, withEv.length), lead.length ? `${r1(quantile(lead, 0.5))} min (p10 ${r1(quantile(lead, 0.1))}, p90 ${r1(quantile(lead, 0.9))})` : "–", pct(everRight.filter((s) => s.everWrongAfterRight).length, everRight.length)];
}
const spellRows = FOLD_ROUTES.map((rid) => spellRow(`${names.get(rid)} (${rid})`, spells.filter((s) => s.rid === rid && s.n >= 2)));
spellRows.push(spellRow("all", spells.filter((s) => s.n >= 2)));

// Which stops carried the evidence — the focus stops on Purple are polled every cycle.
const evidenceStops = new Map<string, number>();
for (const m of moments) if (m.upLeg !== null) for (const r of latestCycle(m.bus, m.rid, m.t)) evidenceStops.set(`${m.rid}:${r.stopId}`, (evidenceStops.get(`${m.rid}:${r.stopId}`) ?? 0) + 1);
const evRows = [...evidenceStops].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, n]) => { const [rid, sid] = k.split(":").map(Number); return [`${names.get(rid!)}`, `${stopName.get(sid!)} (${sid})${focusIds.has(sid!) ? " — focus" : ""}`, n]; });

const md = [
  `# Q3 — direction on a fold from upstream's ETA set (${fmtEt(winFrom)} .. ${fmtEt(winTo)} ET)`,
  ``,
  `Routes ${FOLD_ROUTES.map((r) => `${names.get(r)} (${r})`).join(", ")}. A moment (one capture fix per 15 s) is AMBIGUOUS when the legs whose roads pass within ${FOLD_M} m of the fix fall into two or more BRANCHES (runs of sequence-consecutive legs — the leg into a stop and the leg out of it are one branch, not a fold); the truth branch is the detector's, from the \`stop_visits\` before and after the moment (at most ${MAX_SKIP} stops skipped between them, and every leg between them on one branch). Upstream's leg is the candidate whose hop-table times best fit the horizons upstream listed for the bus in its latest 30 s cycle (a focus stop it did not list counts as "> 30 min"). "confident" = the best candidate beats the runner-up by ≥ 5 min of total misfit. Baselines: the nearer road, and the feed's heading (decides only when exactly one candidate's road bearing is within 90°).`,
  ``,
  `${polls} fixes on the fold routes, ${ambiguous} ambiguous (${r1((100 * ambiguous) / Math.max(1, polls))}%), ${moments.length} with a settled detector truth.`,
  ``,
  mdTable(header, rows),
  ``,
  `**Spells** — a run of ambiguous moments of one bus on one truth leg (≥ 2 moments). "lead" = how long before the detector's next visit settles the leg upstream had already named it.`,
  ``,
  mdTable(spellHeader, spellRows),
  ``,
  `**Stops that carried the evidence** (rows in the cycles scored)`,
  ``,
  mdTable(["route", "stop", "rows"], evRows),
  ``,
].join("\n");
writeText("fold.md", md);
import("node:fs").then((fs) => fs.writeFileSync(`${OUT_DIR}/fold-moments.jsonl`, moments.map((m) => JSON.stringify(m)).join("\n") + "\n"));
writeJson("fold.json", { polls, ambiguous, moments: moments.length, byRoute: Object.fromEntries(FOLD_ROUTES.map((rid) => [names.get(rid), { all: score(moments.filter((m) => m.rid === rid)), moving: score(moments.filter((m) => m.rid === rid && m.moved)), standing: score(moments.filter((m) => m.rid === rid && !m.moved)) }])), all: score(moments) });
console.log(md);
log("done");
