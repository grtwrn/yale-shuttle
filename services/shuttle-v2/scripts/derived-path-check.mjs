#!/usr/bin/env node
/**
 * derived-path-check — is the GPS-derived route geometry better than upstream's,
 * and is it safe to serve?
 *
 * Upstream publishes a coarse `path` per route (Orange Night: 37 points for a
 * 9.5 km loop with 26 stops), which is why the trip map mis-drew the ride
 * segment. `src/network/derivePath.ts` rebuilds each loop out of stored bus
 * positions instead. This script grades that swap on REAL production data, for
 * all 15 routes, and is deliberately adversarial: a wrong route line is worse
 * than a coarse one, so every derived path that would be ACCEPTED is put
 * through checks designed to catch it being WRONG, not merely coarse.
 *
 *   node scripts/derived-path-check.mjs [--refresh] [--route=14] [--json] [-v]
 *                                       [--geojson=13]
 *
 * The shape checks (retracing, repeated stop visits, stop ordering) are
 * calibrated against the SAME statistic measured on upstream's own polyline,
 * because several routes legitimately double back — Pink runs out to the VA
 * Hospital and returns down the same corridor, and Green/Purple do the West
 * Campus out-and-back. An absolute threshold flags those as two laps; an
 * excess-over-upstream threshold does not.
 *
 * Exit codes
 *   0  nothing wrong: every ACCEPTED path passes every check. Routes that are
 *      simply not running (Green/Purple stop ~19:30, the day routes by
 *      18:00-19:00, Grocery is weekend-only) report "no data", which is the
 *      correct answer, not a failure.
 *   1  an ACCEPTED path failed an adversarial check — do not serve it.
 *   2  the harness itself broke (could not read production, could not import).
 *
 * Inputs come from the production SQLite READ-ONLY over `flyctl ssh console`
 * and are cached to scripts/.cache/derived-path-inputs.json, so repeat runs
 * cost nothing and do not touch production.
 */

import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "tsx/esm/api";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const CACHE = process.env.DPC_CACHE || resolve(HERE, ".cache/derived-path-inputs.json");
const CACHE_MAX_AGE_MIN = Number(process.env.DPC_CACHE_MAX_AGE_MIN ?? 45);
const FLYCTL = process.env.FLYCTL || `${process.env.HOME}/.fly/bin/flyctl`;
const APP = process.env.DPC_APP || "yale-shuttle";
const DB = process.env.DPC_DB || "/data/shuttle-v2.db";

const argv = process.argv.slice(2);
const val = (f) => (argv.find((a) => a.startsWith(f + "=")) || "").split("=")[1];
const OPT = {
  refresh: argv.includes("--refresh"),
  json: argv.includes("--json"),
  verbose: argv.includes("-v") || argv.includes("--verbose"),
  route: val("--route"),
  geojson: val("--geojson"),
};

// ── thresholds ────────────────────────────────────────────────────────────
// Mirrors of derivePath's own (unexported) constants. Used only to explain WHY
// a route produced nothing.
const COVERAGE_M = 60;
const MIN_SAMPLES = 60;

const T = {
  // A lap much longer than the route is two laps, or a lap plus a deadhead.
  lapRatioFail: 1.20, lapRatioWarn: 1.10,
  // A lap much shorter than the stop chain has skipped part of the route.
  shortRatioFail: 0.80, shortRatioWarn: 0.90,
  // How far a stop may sit from the finished line (measured to the polyline).
  stopCoverFailM: 150, stopCoverWarnM: 80,
  // A stop must not end up FURTHER from the derived line than from upstream's.
  regressM: 15,
  // Detour: derived road that is nowhere near any road upstream knows about.
  detourM: 200, detourRunFailM: 500, detourRunWarnM: 250,
  // The reverse: upstream road the derived lap never went near.
  missRunFailM: 900, missRunWarnM: 450,
  // A long straight chord that strays from every known road — the bug symptom.
  chordSegM: 150, chordDevFailM: 200, chordDevWarnM: 120,
  // A step the bus could not physically have driven.
  teleportMps: 33, // ~74 mph
  // Fraction of the drawn line that spans a poll gap, i.e. is interpolated.
  gapFracFail: 0.35, gapFracWarn: 0.20,
  // Support.
  minWindowSamples: 120, // a lap at the observed ~9 s/bus cadence is ~130-250
  crossBusMedianFailM: 100, crossBusP90WarnM: 90,
  // Shape, as EXCESS over the same statistic measured on upstream's polyline.
  excessRetraceFail: 0.25, excessRetraceWarn: 0.15,
  excessVisitFail: 0.40, excessVisitWarn: 0.25,
  excessInversions: 3,
  // The end-to-end test: how often buildStopSequencePolyline gives up on the
  // line and falls back to straight stop-to-stop segments.
  traceFallbackFail: 0.05, // derived must not give up on more rides than upstream by this much
  traceBridgeFail: 0.05,   // nor draw more cross-block diagonals (and at least 2 more legs)
};

// ── geometry, all in projected metres ─────────────────────────────────────
const CENTER = { lat: 41.31, lon: -72.93 };
const M_PER_DEG_LAT = 111_320;
const COS = Math.cos((CENTER.lat * Math.PI) / 180);
const px = (ll) => [(ll[1] - CENTER.lon) * M_PER_DEG_LAT * COS, (ll[0] - CENTER.lat) * M_PER_DEG_LAT];
const projAll = (pts) => pts.map(px);

function segDist(x, y, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  if (l2 < 1e-9) return Math.hypot(x - ax, y - ay);
  let t = ((x - ax) * dx + (y - ay) * dy) / l2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
}
/** Distance to the nearest point ON the polyline (segments, not just vertices). */
function distToPolyline(P, x, y) {
  let best = Infinity;
  for (let i = 1; i < P.length; i++) {
    const d = segDist(x, y, P[i - 1][0], P[i - 1][1], P[i][0], P[i][1]);
    if (d < best) best = d;
  }
  return best;
}
function polyLength(P) {
  let m = 0;
  for (let i = 1; i < P.length; i++) m += Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]);
  return m;
}
/** Close a loop for measurement — downstream treats a route path as circular. */
function closed(P) {
  if (P.length < 2) return P;
  const gap = Math.hypot(P[0][0] - P[P.length - 1][0], P[0][1] - P[P.length - 1][1]);
  return gap > 1 ? [...P, P[0]] : P;
}
/** Even resample, with each point's distance along the path. */
function resample(P, step) {
  const pts = [], along = [];
  if (P.length < 2) return { pts: P.slice(), along: P.map(() => 0) };
  let acc = 0, carry = 0;
  pts.push(P[0]); along.push(0);
  for (let i = 1; i < P.length; i++) {
    const ax = P[i - 1][0], ay = P[i - 1][1], bx = P[i][0], by = P[i][1];
    const seg = Math.hypot(bx - ax, by - ay);
    if (seg < 1e-9) continue;
    let d = step - carry;
    while (d <= seg) {
      const t = d / seg;
      pts.push([ax + t * (bx - ax), ay + t * (by - ay)]);
      along.push(acc + d);
      d += step;
    }
    carry = seg - (d - step);
    acc += seg;
  }
  return { pts, along };
}
function crosses(a, b, c, d) {
  const o = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  const o1 = o(a, b, c), o2 = o(a, b, d), o3 = o(c, d, a), o4 = o(c, d, b);
  return o1 !== o2 && o3 !== o4 && o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0;
}

// ── shape statistics, measured identically on any polyline ────────────────
/** How many separate times the line passes within 55 m of each stop. */
function visitCounts(P, S) {
  const R = resample(P, 10).pts;
  return S.map(([sx, sy]) => {
    let inside = false, n = 0;
    for (const p of R) {
      const d = Math.hypot(p[0] - sx, p[1] - sy);
      if (!inside && d <= 55) { inside = true; n++; }
      else if (inside && d > 90) inside = false;
    }
    return n;
  });
}
/** Fraction of the line that runs within 20 m of a far-away part of ITSELF. */
function retraceFraction(P) {
  const R = resample(P, 20);
  let over = 0;
  for (let i = 0; i < R.pts.length; i++) {
    const [x, y] = R.pts[i];
    for (let j = 0; j < R.pts.length; j++) {
      if (Math.abs(R.along[i] - R.along[j]) < 200) continue;
      if (Math.hypot(R.pts[j][0] - x, R.pts[j][1] - y) < 20) { over++; break; }
    }
  }
  return over / Math.max(1, R.pts.length);
}
/** How many stops the line reaches out of the published sequence's order. */
function orderInversions(P, S, order) {
  const R = resample(P, 10);
  const closest = S.map(([sx, sy]) => {
    let best = Infinity, at = 0;
    for (let k = 0; k < R.pts.length; k++) {
      const d = Math.hypot(R.pts[k][0] - sx, R.pts[k][1] - sy);
      if (d < best) { best = d; at = R.along[k]; }
    }
    return at;
  });
  const firstIdx = closest.indexOf(Math.min(...closest));
  const rot = order.indexOf(firstIdx);
  const wanted = rot >= 0 ? [...order.slice(rot), ...order.slice(0, rot)] : order;
  let inv = 0;
  for (let i = 1; i < wanted.length; i++) if (closest[wanted[i]] < closest[wanted[i - 1]]) inv++;
  return { inv, of: Math.max(1, wanted.length - 1) };
}
/** Near-U-turns between segments long enough not to be GPS jitter. */
function uturnCount(P) {
  let n = 0;
  for (let i = 1; i < P.length - 1; i++) {
    const ax = P[i][0] - P[i - 1][0], ay = P[i][1] - P[i - 1][1];
    const bx = P[i + 1][0] - P[i][0], by = P[i + 1][1] - P[i][1];
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
    if (la < 25 || lb < 25) continue;
    if ((ax * bx + ay * by) / (la * lb) < Math.cos((150 * Math.PI) / 180)) n++;
  }
  return n;
}

const median = (xs) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pct = (xs, p) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
};
const r0 = (n) => (Number.isFinite(n) ? Math.round(n) : n);
const km = (m) => (Number.isFinite(m) ? (m / 1000).toFixed(2) : "—");
const pctS = (f) => (Number.isFinite(f) ? Math.round(f * 100) + "%" : "—");

// ── production pull (READ-ONLY) ───────────────────────────────────────────
const REMOTE_JS = `
const D=require("/app/node_modules/better-sqlite3")(${JSON.stringify(DB)},{readonly:true});
const out={
 fetchedAt:Date.now(),
 stops:D.prepare("select id,name,lat,lon from stops").all(),
 routes:D.prepare("select id,name,short_name,color,stops_json,path_json from routes").all(),
 window:D.prepare("select min(collected_at) a,max(collected_at) b,count(*) c from raw_positions").get(),
 positions:D.prepare("select route_id,bus_id,bus_name,lat,lon,collected_at from raw_positions order by collected_at")
   .all().map(r=>[r.route_id,r.bus_id,r.bus_name,Math.round(r.lat*1e6)/1e6,Math.round(r.lon*1e6)/1e6,r.collected_at])
};
process.stdout.write("<<<DPC"+JSON.stringify(out)+"DPC>>>");
`;

function pullProduction() {
  return new Promise((res, rej) => {
    const child = execFile(
      FLYCTL, ["ssh", "console", "-a", APP, "-C", "node -"],
      { maxBuffer: 256 * 1024 * 1024, timeout: 180_000 },
      (err, stdout, stderr) => {
        const a = stdout.indexOf("<<<DPC"), b = stdout.lastIndexOf("DPC>>>");
        if (a === -1 || b === -1) {
          return rej(new Error(`no payload from ${APP}${err ? `: ${err.message}` : ""}\n${String(stderr).slice(0, 800)}`));
        }
        try { res(JSON.parse(stdout.slice(a + 6, b))); } catch (e) { rej(e); }
      },
    );
    child.stdin.end(REMOTE_JS);
  });
}

async function loadInputs() {
  const fresh = existsSync(CACHE) && (Date.now() - statSync(CACHE).mtimeMs) / 60000 < CACHE_MAX_AGE_MIN;
  if (!OPT.refresh && fresh) {
    const d = JSON.parse(readFileSync(CACHE, "utf8"));
    d._cached = true;
    return d;
  }
  const d = await pullProduction();
  mkdirSync(dirname(CACHE), { recursive: true });
  writeFileSync(CACHE, JSON.stringify(d));
  d._cached = false;
  return d;
}

/**
 * The end-to-end question, and the reason the geometry is being replaced at all.
 *
 * The rider-visible consumer is `buildStopSequencePolyline` in web/src/geo.ts:
 * it maps each stop to the NEAREST VERTEX of the route path and slices between
 * those indices. That is why the vertex metric — not the distance to the
 * polyline — is the operative one: when several stops collapse onto the same
 * vertex the mapping inverts, the wrap branch appends most of the loop, and the
 * function bails out to straight stop-to-stop segments. So the honest test of a
 * candidate path is to run every plausible board→alight ride through the real
 * function and count how often it gives up.
 */
function traceScore(path, seq, stopById, fns) {
  const coords = seq.map((id) => stopById.get(id)).filter(Boolean).map((s) => ({ lat: s.lat, lon: s.lon }));
  if (!path || path.length < 2 || coords.length < 2) return null;
  const same = (p, c) => p[0] === c.lat && p[1] === c.lon;

  // (a) Per leg: did the tracer follow the road, or bridge the two stops with a
  // straight line? A bridged leg is returned verbatim as the two stop
  // coordinates, so it is exactly identifiable — and it is the "straight
  // diagonals cutting across blocks" symptom.
  let legs = 0, bridged = 0, degenerate = 0, bridgedM = 0, totalM = 0;
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1], b = coords[i];
    legs++;
    const direct = fns.polylineMeters([[a.lat, a.lon], [b.lat, b.lon]]);
    totalM += direct;
    const t = fns.buildStopSequencePolyline(path, [a, b]);
    if (!t) { bridged++; bridgedM += direct; continue; }
    if (t.length === 2 && same(t[0], a) && same(t[1], b)) { bridged++; bridgedM += direct; continue; }
    if (fns.polylineMeters(t) < 1) degenerate++;
  }

  // (b) Whole rides: does the tracer give up entirely, and how far does the
  // line it draws run compared with the straight chain through the same stops?
  let tried = 0, fell = 0;
  const ratios = [];
  for (let i = 0; i < coords.length; i++) {
    for (const k of [2, 3, 5, 8]) {
      const j = i + k;
      if (j >= coords.length) continue;
      const ride = coords.slice(i, j + 1);
      tried++;
      const traced = fns.buildStopSequencePolyline(path, ride);
      if (!traced) { fell++; continue; }
      const direct = fns.polylineMeters(ride.map((c) => [c.lat, c.lon]));
      if (direct > 0) ratios.push(fns.polylineMeters(traced) / direct);
    }
  }
  return {
    legs, bridged, degenerate,
    bridgedFrac: legs ? bridged / legs : 0,
    bridgedMFrac: totalM ? bridgedM / totalM : 0,
    tried, fell, fallbackFrac: tried ? fell / tried : 0,
    medRatio: median(ratios),
  };
}

// ── analysis ──────────────────────────────────────────────────────────────
function analyseRoute(route, ctx) {
  const { derivePath, stopDistances, isBetterThanUpstream, buildStopSequencePolyline, polylineMeters, stopById, byRoute, label } = ctx;
  const out = { id: route.id, name: route.name, label, checks: [], notes: [] };
  const push = (level, key, msg) => out.checks.push({ level, key, msg });

  // -- inputs -------------------------------------------------------------
  const seq = JSON.parse(route.stops_json);
  const uniqIds = [...new Set(seq)];
  const stops = uniqIds.map((id) => stopById.get(id)).filter(Boolean);
  out.stopCount = stops.length;
  out.seqLength = seq.length;
  out.dupStopIds = uniqIds.filter((id) => seq.filter((s) => s === id).length > 1);
  if (stops.length !== uniqIds.length) {
    push("fail", "stops", `${uniqIds.length - stops.length} stop id(s) in stops_json are missing from the stops table`);
  }

  const upstream = route.path_json ? JSON.parse(route.path_json) : [];
  const hasUp = upstream.length >= 2;
  out.upPts = upstream.length;
  const UP = hasUp ? closed(projAll(upstream)) : [];
  out.upLengthM = hasUp ? polyLength(UP) : NaN;

  const S = stops.map((s) => px([s.lat, s.lon]));
  // Chain length along the PUBLISHED sequence, closed. Includes the West
  // Campus out-and-back, so a lap that cut the spur falls under it.
  const seqPts = seq.map((id) => stopById.get(id)).filter(Boolean).map((s) => px([s.lat, s.lon]));
  out.seqLengthM = polyLength(closed(seqPts));
  out.refM = Math.max(out.upLengthM || 0, out.seqLengthM || 0);

  // Upstream's own numbers, on both metrics and on every shape statistic.
  const order = [];
  for (const id of seq) { const i = uniqIds.indexOf(id); if (!order.includes(i)) order.push(i); }
  if (hasUp) {
    const v = stopDistances(upstream, stops);
    const g = S.map(([x, y]) => distToPolyline(UP, x, y));
    out.up = {
      medV: median(v), p90V: pct(v, 0.9), maxV: Math.max(...v),
      medS: median(g), p90S: pct(g, 0.9), maxS: Math.max(...g),
      stopSeg: g,
      maxSegM: Math.max(0, ...UP.slice(1).map((p, i) => Math.hypot(p[0] - UP[i][0], p[1] - UP[i][1]))),
      visits: visitCounts(UP, S),
      retrace: retraceFraction(UP),
      uturns: uturnCount(UP),
      ...orderInversions(UP, S, order),
    };
    out.upTrace = traceScore(upstream, seq, stopById, ctx);
  }

  // -- samples ------------------------------------------------------------
  const rows = byRoute.get(route.id) || [];
  out.samples = rows.length;
  out.buses = new Set(rows.map((r) => r[2])).size;
  const ids = new Set(rows.map((r) => r[1]));
  out.busIds = ids.size;
  out.lastSeen = rows.length ? rows[rows.length - 1][5] : null;
  const samples = rows.map((r) => ({ lat: r[3], lon: r[4], busId: r[1], collectedAt: r[5] }));
  const rowXY = rows.map((r) => px([r[3], r[4]]));

  // A stop no position ever came within COVERAGE_M of can never be covered, so
  // derivePath structurally cannot return a path for this route.
  if (rows.length) {
    const never = [];
    for (let i = 0; i < stops.length; i++) {
      const sx = S[i][0], sy = S[i][1];
      let best = Infinity;
      for (const p of rowXY) { const d = Math.hypot(p[0] - sx, p[1] - sy); if (d < best) best = d; }
      if (best > COVERAGE_M) never.push({ id: uniqIds[i], name: stops[i].name, m: r0(best) });
    }
    out.neverApproached = never;
    let bestCov = 0, bestBus = null;
    for (const busId of ids) {
      const idx = rows.map((r, i) => (r[1] === busId ? i : -1)).filter((i) => i >= 0);
      if (idx.length < 2) continue;
      let n = 0;
      for (let i = 0; i < stops.length; i++) {
        const sx = S[i][0], sy = S[i][1];
        if (idx.some((k) => Math.hypot(rowXY[k][0] - sx, rowXY[k][1] - sy) <= COVERAGE_M)) n++;
      }
      if (n > bestCov) { bestCov = n; bestBus = rows[idx[0]][2]; }
    }
    out.bestBusCoverage = bestCov;
    out.bestBusName = bestBus;
    out.longestTrace = Math.max(0, ...[...ids].map((b) => rows.filter((r) => r[1] === b).length));
  }

  // -- derive -------------------------------------------------------------
  const derived = derivePath(samples, stops);
  if (!derived) {
    out.derived = null;
    out.reason = !rows.length
      ? "no positions in the retention window"
      : (out.longestTrace ?? 0) < MIN_SAMPLES
        ? `longest single-bus trace is ${out.longestTrace} positions (derivePath needs >= ${MIN_SAMPLES})`
        : out.neverApproached?.length
          ? `${out.neverApproached.length} of ${stops.length} stops were never seen within ${COVERAGE_M} m of any position`
          : `no single bus covered all ${stops.length} stops in one contiguous window (best ${out.bestBusCoverage}/${stops.length}, bus ${out.bestBusName})`;
    return out;
  }
  out.derived = { ...derived, path: undefined };
  out.rawPath = derived.path;

  const P = projAll(derived.path);
  const PC = closed(P);
  out.drvPts = derived.path.length;
  out.busName = (rows.find((r) => r[1] === derived.busId) || [])[2] ?? `id ${derived.busId}`;
  // The stop SEQUENCE, not just the unique stops: acceptance is decided by how
  // many legs can be drawn, and on routes 9 and 10 the second visit to a West
  // Campus stop is a real leg. Omitting it here tested a branch the collector
  // never takes, and reported acceptances that production would not make.
  const sequence = seq.map((id) => stopById.get(id)).filter(Boolean);
  out.accept = isBetterThanUpstream(derived, hasUp ? upstream : undefined, stops, sequence);

  // -- 1. does every stop sit ON the line? --------------------------------
  const dv = stopDistances(derived.path, stops);
  const ds = S.map(([x, y]) => distToPolyline(PC, x, y));
  out.drv = {
    medV: median(dv), p90V: pct(dv, 0.9), maxV: Math.max(...dv),
    medS: median(ds), p90S: pct(ds, 0.9), maxS: Math.max(...ds),
  };
  if (out.drv.maxS > T.stopCoverFailM) push("fail", "coverage", `a stop sits ${r0(out.drv.maxS)} m off the derived line`);
  else if (out.drv.maxS > T.stopCoverWarnM) push("warn", "coverage", `worst stop is ${r0(out.drv.maxS)} m off the derived line`);
  if (hasUp) {
    // The whole point of the swap. A stop that moves FURTHER from its line is a
    // regression even if the median improved.
    const worse = ds.map((d, i) => ({ i, d, u: out.up.stopSeg[i] }))
      .filter((x) => x.d > x.u + T.regressM)
      .sort((a, b) => b.d - a.d);
    out.regressions = worse.length;
    if (worse.length) {
      const w = worse[0];
      const lvl = w.d > T.stopCoverWarnM ? "warn" : "info";
      push(lvl, "regress", `${worse.length} stop(s) end up further from the derived line than from upstream's; worst ${stops[w.i].name} ${r0(w.u)} m → ${r0(w.d)} m`);
    }
  }

  // -- 2. is this one lap? ------------------------------------------------
  out.simpleLengthM = polyLength(P); // derived.lengthM includes stationary jitter
  out.lapRatio = out.refM > 0 ? out.simpleLengthM / out.refM : NaN;
  const R = out.lapRatio;
  if (R > T.lapRatioFail) push("fail", "lap", `the lap is ${R.toFixed(2)}x the route's own length (${km(out.simpleLengthM)} km vs ${km(out.refM)} km) — more than one lap, or a lap plus a deadhead`);
  else if (R > T.lapRatioWarn) push("warn", "lap", `the lap is ${R.toFixed(2)}x the route's own length (${km(out.simpleLengthM)} km vs ${km(out.refM)} km)`);
  else if (R < T.shortRatioFail) push("fail", "lap", `the lap is only ${R.toFixed(2)}x the stop-chain length (${km(out.simpleLengthM)} km vs ${km(out.refM)} km) — part of the route is missing`);
  else if (R < T.shortRatioWarn) push("warn", "lap", `the lap is only ${R.toFixed(2)}x the stop-chain length`);

  // Repeated stop visits, and self-retracing — both judged as EXCESS over the
  // same measurement on upstream's line, because Pink (VA out-and-back) and
  // Green/Purple (West Campus spur) legitimately double back.
  out.visits = visitCounts(PC, S);
  out.retrace = retraceFraction(PC);
  const expected = uniqIds.map((id) => seq.filter((s) => s === id).length);
  out.medVisitRatio = median(out.visits.map((v, i) => v / expected[i]));
  if (hasUp) {
    const excess = out.visits.filter((v, i) => v >= Math.max(out.up.visits[i], expected[i]) + 1).length / out.visits.length;
    out.excessVisitFrac = excess;
    out.excessRetrace = out.retrace - out.up.retrace;
    if (excess > T.excessVisitFail) push("fail", "laps", `${pctS(excess)} of stops are passed more often than upstream's own line passes them — this is more than one lap`);
    else if (excess > T.excessVisitWarn) push("warn", "laps", `${pctS(excess)} of stops are passed more often than upstream's line passes them`);
    if (out.excessRetrace > T.excessRetraceFail) push("fail", "retrace", `the line retraces itself ${pctS(out.retrace)} of the time against upstream's ${pctS(out.up.retrace)} — consistent with a second partial lap`);
    else if (out.excessRetrace > T.excessRetraceWarn) push("warn", "retrace", `the line retraces itself ${pctS(out.retrace)} against upstream's ${pctS(out.up.retrace)}`);
  } else if (out.medVisitRatio >= 2) {
    push("fail", "laps", `no upstream line to calibrate against, and the median stop is passed ${out.medVisitRatio}x its scheduled number of times`);
  }

  // -- 3. the West Campus spur (routes 9 and 10 repeat stops) -------------
  if (out.dupStopIds.length) {
    const bad = [];
    for (const id of out.dupStopIds) {
      const i = uniqIds.indexOf(id);
      if (out.visits[i] < expected[i]) bad.push(`${stopById.get(id).name} (${out.visits[i]} of ${expected[i]})`);
    }
    out.spurOk = bad.length === 0;
    if (bad.length) push("fail", "spur", `out-and-back stops are not passed the scheduled number of times: ${bad.join("; ")} — the spur was cut`);
    else out.notes.push(`spur intact: all ${out.dupStopIds.length} repeated stops (${out.dupStopIds.map((i) => stopById.get(i).name).join(", ")}) are passed at least their scheduled number of times, and the lap is ${R.toFixed(2)}x the out-and-back stop chain`);
  }

  // -- 4. did it drive the route's roads? ---------------------------------
  if (hasUp) {
    const R25 = resample(PC, 25);
    const off = R25.pts.map(([x, y]) => distToPolyline(UP, x, y));
    out.offUp = { med: median(off), p90: pct(off, 0.9), max: Math.max(...off) };
    let run = 0, worstRun = 0, at = null;
    for (let i = 0; i < off.length; i++) {
      if (off[i] > T.detourM) { run += 25; if (run > worstRun) { worstRun = run; at = R25.pts[i]; } }
      else run = 0;
    }
    out.detourRunM = worstRun;
    out.detourAt = at;
    // How much of the route's own service is out there? A stretch upstream does
    // not know about, with no stops on it, is a layover or deadhead — real
    // driving, but not the route, and cross-bus agreement will NOT catch it
    // because every bus on the line does it.
    const offPts = R25.pts.filter((_, i) => off[i] > T.detourM);
    out.stopsOnDetour = S.filter(([sx, sy]) => offPts.some((p) => Math.hypot(p[0] - sx, p[1] - sy) < 100)).length;
    out.detourLengthM = offPts.length * 25;
    if (worstRun > T.detourRunFailM) push("fail", "detour", `${r0(worstRun)} m of unbroken derived road sits >${T.detourM} m from upstream's line (${r0(out.detourLengthM)} m in total, worst point ${r0(out.offUp.max)} m off) and only ${out.stopsOnDetour} of ${stops.length} stops lie on it — that is a different road, not a corner cut`);
    else if (worstRun > T.detourRunWarnM) push("warn", "detour", `${r0(worstRun)} m of unbroken derived road sits >${T.detourM} m from upstream's line`);

    const U25 = resample(UP, 25);
    const miss = U25.pts.map(([x, y]) => distToPolyline(PC, x, y));
    out.missUp = { med: median(miss), p90: pct(miss, 0.9), max: Math.max(...miss) };
    let mrun = 0, mworst = 0;
    for (const d of miss) { if (d > T.detourM) { mrun += 25; if (mrun > mworst) mworst = mrun; } else mrun = 0; }
    out.missRunM = mworst;
    if (mworst > T.missRunFailM) push("fail", "skipped", `${r0(mworst)} m of unbroken upstream road has no derived path within ${T.detourM} m — a leg of the route is missing from the line`);
    else if (mworst > T.missRunWarnM) push("warn", "skipped", `${r0(mworst)} m of unbroken upstream road has no derived path within ${T.detourM} m`);
  } else {
    out.notes.push("upstream publishes no path for this route — the road-agreement checks cannot run");
  }

  // -- 5. straight chords across blocks (the symptom being fixed) ---------
  out.maxSegM = Math.max(0, ...P.slice(1).map((p, i) => Math.hypot(p[0] - P[i][0], p[1] - P[i][1])));
  let worstChord = 0, worstChordSeg = 0;
  if (hasUp) {
    for (let i = 1; i < P.length; i++) {
      const seg = Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]);
      if (seg < T.chordSegM) continue;
      for (let t = 0.1; t <= 0.91; t += 0.1) {
        const x = P[i - 1][0] + t * (P[i][0] - P[i - 1][0]);
        const y = P[i - 1][1] + t * (P[i][1] - P[i - 1][1]);
        const d = distToPolyline(UP, x, y);
        if (d > worstChord) { worstChord = d; worstChordSeg = seg; }
      }
    }
  }
  out.worstChordM = worstChord;
  if (worstChord > T.chordDevFailM) push("fail", "chord", `a ${r0(worstChordSeg)} m straight segment strays ${r0(worstChord)} m from any road upstream knows — it is drawn across blocks`);
  else if (worstChord > T.chordDevWarnM) push("warn", "chord", `a ${r0(worstChordSeg)} m straight segment strays ${r0(worstChord)} m from upstream's line`);

  // -- 6. how much of the line is interpolated across missing polls? ------
  // Recover timestamps: derived vertices ARE the winning bus's stored
  // coordinates, so they match back exactly.
  const mine = rows.filter((r) => r[1] === derived.busId);
  const byCoord = new Map();
  for (const r of mine) {
    const k = `${r[3]},${r[4]}`;
    let l = byCoord.get(k); if (!l) byCoord.set(k, (l = []));
    l.push(r[5]);
  }
  let prevT = -Infinity, matched = 0, firstT = null;
  const times = [];
  for (const [la, lo] of derived.path) {
    const list = byCoord.get(`${la},${lo}`);
    let t = null;
    if (list) for (const c of list) if (c > prevT) { t = c; break; }
    if (t !== null) { prevT = t; matched++; if (firstT === null) firstT = t; }
    times.push(t);
  }
  out.timeMatched = matched / derived.path.length;
  out.windowSec = matched > 1 ? (prevT - firstT) / 1000 : NaN;
  // Raw positions the lap actually rests on (not the simplified vertex count).
  out.windowSamples = firstT === null ? 0 : mine.filter((r) => r[5] >= firstT && r[5] <= prevT).length;
  // Measured on the RAW trace inside the lap window, never on the simplified
  // path: consecutive simplified vertices are far apart because simplification
  // removed the points between them, which is not a poll gap.
  const lap = firstT === null ? [] : mine.filter((r) => r[5] >= firstT && r[5] <= prevT).sort((a, b) => a[5] - b[5]);
  let fastest = 0, fastestGap = 0, gapM = 0, rawM = 0, worstGapSec = 0, worstGapM = 0, maxRawGapM = 0;
  for (let i = 1; i < lap.length; i++) {
    const dt = (lap[i][5] - lap[i - 1][5]) / 1000;
    const a = px([lap[i - 1][3], lap[i - 1][4]]), b = px([lap[i][3], lap[i][4]]);
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    rawM += d;
    if (d > maxRawGapM) maxRawGapM = d;
    if (dt > 60) { gapM += d; if (dt > worstGapSec) { worstGapSec = dt; worstGapM = d; } }
    if (dt > 0 && d > 40 && d / dt > fastest) { fastest = d / dt; fastestGap = d; }
  }
  const polls = lap.slice(1).map((r, i) => (r[5] - lap[i][5]) / 1000);
  out.medPollSec = median(polls);
  out.maxPollSec = Math.max(0, ...polls);
  out.maxRawGapM = maxRawGapM;
  out.fastestMps = fastest;
  out.gapFrac = rawM > 0 ? gapM / rawM : 0;
  out.worstGapSec = worstGapSec; out.worstGapM = worstGapM;
  if (fastest > T.teleportMps) push("fail", "teleport", `a ${r0(fastestGap)} m step is drawn at ${fastest.toFixed(0)} m/s (${(fastest * 2.237).toFixed(0)} mph) — that is a feed gap drawn as a straight line, not driving`);
  if (out.gapFrac > T.gapFracFail) push("fail", "gaps", `${pctS(out.gapFrac)} of the drawn line spans polls more than 60 s apart — most of this geometry is interpolated, not observed`);
  else if (out.gapFrac > T.gapFracWarn) push("warn", "gaps", `${pctS(out.gapFrac)} of the drawn line spans polls more than 60 s apart (worst ${r0(worstGapM)} m across ${r0(worstGapSec)} s)`);

  // -- 7. support: enough samples, more than one bus, and do buses agree? --
  if (out.windowSamples < T.minWindowSamples) push("warn", "support", `the winning lap rests on only ${out.windowSamples} raw positions over ${r0(out.windowSec)} s`);
  const perBus = [];
  for (const busId of ids) {
    const sub = samples.filter((s) => s.busId === busId);
    if (sub.length < MIN_SAMPLES) continue;
    const d = derivePath(sub, stops);
    if (d) perBus.push({ busId, name: (rows.find((r) => r[1] === busId) || [])[2], d });
  }
  out.candidateBuses = new Set(perBus.map((c) => c.name)).size;
  out.candidateIds = perBus.length;
  if (out.candidateBuses <= 1) {
    push("warn", "support", `only one bus (${out.busName}) produced a full lap — nothing independently corroborates this geometry`);
  } else {
    let bestMed = Infinity, bestP90 = Infinity, bestName = null;
    const R25 = resample(PC, 25).pts;
    for (const o of perBus) {
      if (o.name === out.busName) continue;
      const OP = closed(projAll(o.d.path));
      const s = R25.map(([x, y]) => distToPolyline(OP, x, y));
      const m = median(s);
      if (m < bestMed) { bestMed = m; bestP90 = pct(s, 0.9); bestName = o.name; }
    }
    if (bestName) {
      out.crossBus = { med: bestMed, p90: bestP90, name: bestName };
      if (bestMed > T.crossBusMedianFailM) push("fail", "support", `the closest independent lap (bus ${bestName}) sits a median ${r0(bestMed)} m away — the buses disagree about where this route is`);
      else if (bestP90 > T.crossBusP90WarnM) push("warn", "support", `the closest independent lap (bus ${bestName}) diverges by ${r0(bestP90)} m at p90`);
    }
  }

  // -- 7b. does the real consumer draw a road, or a diagonal? -------------
  out.trace = traceScore(derived.path, seq, stopById, ctx);
  if (out.trace && out.upTrace) {
    const d = out.trace, u = out.upTrace;
    if (d.bridged - u.bridged >= 2 && d.bridgedFrac > u.bridgedFrac + T.traceBridgeFail) {
      push("fail", "trace", `buildStopSequencePolyline draws a straight cross-block diagonal on ${d.bridged}/${d.legs} legs against upstream's ${u.bridged}/${u.legs} — the derived line is HARDER for the map to trace, which is the bug this was meant to fix`);
    } else if (d.bridgedFrac > u.bridgedFrac) {
      push("warn", "trace", `${d.bridged}/${d.legs} legs draw as straight diagonals (upstream ${u.bridged}/${u.legs})`);
    } else if (u.bridged - d.bridged > 0) {
      out.notes.push(`straight-diagonal legs ${u.bridged}/${u.legs} → ${d.bridged}/${d.legs} (${pctS(u.bridgedMFrac)} → ${pctS(d.bridgedMFrac)} of ride distance); whole-ride give-ups ${u.fell}/${u.tried} → ${d.fell}/${d.tried}`);
    }
    if (d.fallbackFrac > u.fallbackFrac + T.traceFallbackFail) {
      push("fail", "trace", `the map gives up on ${pctS(d.fallbackFrac)} of multi-stop rides and draws straight lines, against upstream's ${pctS(u.fallbackFrac)}`);
    }
    if (d.degenerate > u.degenerate) push("warn", "trace", `${d.degenerate} legs collapse two stops onto one vertex (upstream ${u.degenerate}) — the ride line vanishes there`);
    if (d.medRatio > 1.8) push("warn", "trace", `traced rides run a median ${d.medRatio.toFixed(2)}x the straight-line distance through the same stops (upstream ${u.medRatio.toFixed(2)}x)`);
  }

  // -- 8. stop ordering and backtracking, vs upstream ---------------------
  const ord = orderInversions(PC, S, order);
  out.inversions = ord.inv; out.inversionOf = ord.of;
  out.uturns = uturnCount(P);
  if (hasUp) {
    if (ord.inv > out.up.inv + T.excessInversions) {
      push("fail", "order", `the line reaches ${ord.inv} of ${ord.of} stops out of the published sequence order (upstream's own line: ${out.up.inv}) — this is not this route's loop`);
    } else if (ord.inv > out.up.inv) {
      push("warn", "order", `${ord.inv} of ${ord.of} stops reached out of sequence order (upstream: ${out.up.inv})`);
    }
    if (out.uturns > out.up.uturns + 4) push("warn", "backtrack", `${out.uturns} near-U-turns against upstream's ${out.up.uturns} — the line doubles back on itself`);
  }
  // Self-intersections are normal on any loop that overlaps itself; reported only.
  let xs = 0;
  for (let i = 1; i < P.length && xs < 500; i++)
    for (let j = i + 2; j < P.length; j++)
      if (crosses(P[i - 1], P[i], P[j - 1], P[j])) { xs++; break; }
  out.selfCross = xs;

  return out;
}

// ── rendering ─────────────────────────────────────────────────────────────
const pad = (s, n, right = false) => (right ? String(s).padStart(n) : String(s).padEnd(n));
const worstLevel = (checks) =>
  checks.some((c) => c.level === "fail") ? "fail" : checks.some((c) => c.level === "warn") ? "warn" : "ok";

function main(inputs, mod) {
  const stopById = new Map(inputs.stops.map((s) => [s.id, s]));
  const byRoute = new Map();
  for (const p of inputs.positions) { const l = byRoute.get(p[0]); if (l) l.push(p); else byRoute.set(p[0], [p]); }
  const labelOf = new Map();
  for (const cfg of mod.ROUTE_LISTS) for (const id of cfg.busRouteIds) labelOf.set(id, cfg.label);

  const now = new Date();
  const routes = inputs.routes.filter((r) => !OPT.route || String(r.id) === OPT.route).sort((a, b) => a.id - b.id);

  const results = routes.map((r) => {
    const res = analyseRoute(r, { ...mod, stopById, byRoute, label: labelOf.get(r.id) || r.short_name });
    res.scheduled = mod.isRouteActiveAt(res.label, now);
    const next = mod.nextActiveWindow(res.label, now);
    res.nextRun = next ? next.toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" }) : null;
    res.verdict = res.derived ? worstLevel(res.checks) : "none";
    return res;
  });

  if (OPT.geojson) {
    const r = results.find((x) => String(x.id) === OPT.geojson);
    if (r?.rawPath) {
      const src = inputs.routes.find((x) => x.id === r.id);
      const up = src.path_json ? JSON.parse(src.path_json) : [];
      const uniq = [...new Set(JSON.parse(src.stops_json))].map((i) => stopById.get(i)).filter(Boolean);
      const fc = { type: "FeatureCollection", features: [
        { type: "Feature", properties: { what: "derived", stroke: "#e00" }, geometry: { type: "LineString", coordinates: r.rawPath.map(([a, b]) => [b, a]) } },
        { type: "Feature", properties: { what: "upstream", stroke: "#08f" }, geometry: { type: "LineString", coordinates: up.map(([a, b]) => [b, a]) } },
        ...uniq.map((s) => ({ type: "Feature", properties: { what: "stop", name: s.name }, geometry: { type: "Point", coordinates: [s.lon, s.lat] } })),
      ] };
      const f = resolve(dirname(CACHE), `route-${r.id}.geojson`);
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, JSON.stringify(fc));
      console.error(`wrote ${f}`);
    }
  }
  for (const r of results) delete r.rawPath;
  if (OPT.json) { console.log(JSON.stringify(results, null, 2)); return results; }

  const w = inputs.window;
  const et = (ms) => new Date(ms).toLocaleString("en-US", { timeZone: "America/New_York" });
  console.log(`\nderived-path-check — ${routes.length} route(s), ${inputs.positions.length.toLocaleString()} stored positions spanning ${((w.b - w.a) / 3.6e6).toFixed(1)} h`);
  console.log(`retention window ${et(w.a)} → ${et(w.b)} ET · now ${et(Date.now())} ET`);
  console.log(`inputs ${inputs._cached ? "from cache" : "pulled fresh from production (read-only)"} — ${CACHE}\n`);

  console.log("STOP → ROUTE LINE, metres. 'vtx' = distance to the nearest VERTEX, which is what");
  console.log("stopDistances()/isBetterThanUpstream() measure. 'seg' = distance to the nearest point ON");
  console.log("the polyline. The CONSUMER (buildStopSequencePolyline in web/src/geo.ts) snaps each stop to");
  console.log("the nearest VERTEX and slices between indices, so vtx is the metric that decides whether the");
  console.log("ride line draws correctly. 'diagonals' = legs of the stop sequence where that function");
  console.log("abandons the road and draws a straight stop-to-stop line across the blocks instead.\n");
  const head = pad("id", 3) + pad("route", 14) + "|" + pad("  pts", 6, 1) + pad("vtxMed", 7, 1) + pad("vtxMax", 7, 1) + pad("segMed", 7, 1) + pad("segMax", 7, 1) + "  |";
  console.log(pad("", 17) + "|" + pad("  ─── upstream ───", 34) + "  |" + pad("  ─── derived ───", 34) + "  |");
  console.log(head + pad("  pts", 6, 1) + pad("vtxMed", 7, 1) + pad("vtxMax", 7, 1) + pad("segMed", 7, 1) + pad("segMax", 7, 1) + "  | " + pad("diagonals d/u", 15, 1) + pad("serve?", 8, 1));
  console.log("-".repeat(120));
  for (const r of results) {
    const u = r.up, d = r.drv;
    const left = pad(r.id, 3) + pad(r.label, 14) + "|" +
      pad(r.upPts || "—", 6, 1) + pad(u ? r0(u.medV) : "—", 7, 1) + pad(u ? r0(u.maxV) : "—", 7, 1) +
      pad(u ? r0(u.medS) : "—", 7, 1) + pad(u ? r0(u.maxS) : "—", 7, 1) + "  |";
    if (!d) { console.log(left + pad("  — no derived path —", 34) + "  | " + pad(r.upTrace ? `—/${r.upTrace.bridged}of${r.upTrace.legs}` : "—", 15, 1) + pad("—", 8, 1)); continue; }
    console.log(left + pad(r.drvPts, 6, 1) + pad(r0(d.medV), 7, 1) + pad(r0(d.maxV), 7, 1) +
      pad(r0(d.medS), 7, 1) + pad(r0(d.maxS), 7, 1) + "  | " +
      pad(r.trace && r.upTrace ? `${r.trace.bridged}/${r.upTrace.bridged} of ${r.trace.legs}` : "—", 15, 1) +
      pad(r.accept ? "ACCEPT" : "reject", 8, 1));
  }

  console.log("\n\nGEOMETRY & SUPPORT   (d/u = derived vs the same statistic measured on upstream's own line)");
  console.log("'poll s' = median/max seconds between the winning bus's positions inside the lap window.");
  console.log("'maxGap' = longest hop between two consecutive observations — the longest stretch the line invents.\n");
  console.log(pad("id", 3) + pad("route", 14) + pad("samp", 6, 1) + pad("bus", 4, 1) + pad("lap km", 8, 1) +
    pad("ref km", 8, 1) + pad("ratio", 6, 1) + pad("poll s", 8, 1) + pad("maxGap", 8, 1) + pad("chord", 7, 1) +
    pad("offUp90", 8, 1) + pad("retr d/u", 10, 1) + pad("inv d/u", 9, 1) + "  " + pad("bus", 6) + pad("verdict", 8));
  console.log("-".repeat(120));
  for (const r of results) {
    const base = pad(r.id, 3) + pad(r.label, 14) + pad(r.samples ?? 0, 6, 1) + pad(r.buses ?? 0, 4, 1);
    if (!r.derived) { console.log(base + pad("— not derived —", 68, 1) + "  " + pad("", 6) + pad("none", 8)); continue; }
    console.log(base + pad(km(r.simpleLengthM), 8, 1) + pad(km(r.refM), 8, 1) + pad(r.lapRatio.toFixed(2), 6, 1) +
      pad(`${r0(r.medPollSec)}/${r0(r.maxPollSec)}`, 8, 1) + pad(r0(r.maxRawGapM) + "m", 8, 1) +
      pad(r.up ? r0(r.worstChordM) + "m" : "—", 7, 1) +
      pad(r.offUp ? r0(r.offUp.p90) + "m" : "—", 8, 1) +
      pad(r.up ? `${pctS(r.retrace)}/${pctS(r.up.retrace)}` : "—", 10, 1) +
      pad(r.up ? `${r.inversions}/${r.up.inv}` : "—", 9, 1) + "  " +
      pad(r.busName, 6) + pad(r.verdict.toUpperCase(), 8));
  }

  const flagged = results.filter((r) => r.derived && (r.checks.length || r.notes.length || OPT.verbose));
  console.log("\n\nFINDINGS\n");
  if (!flagged.length) console.log("  (every derived path passed every check cleanly)");
  for (const r of flagged) {
    console.log(`  ${r.id} ${r.label} — ${r.verdict.toUpperCase()}${r.accept ? "  ·  WOULD BE SERVED" : "  ·  would be rejected by isBetterThanUpstream"}`);
    for (const c of r.checks) console.log(`      [${c.level}] ${c.key}: ${c.msg}`);
    for (const n of r.notes) console.log(`      [info] ${n}`);
    if (OPT.verbose) {
      console.log(`      lap ${km(r.simpleLengthM)} km, bus ${r.busName}, ${r.windowSamples} raw positions over ${r0(r.windowSec)} s;` +
        ` ${r.candidateBuses}/${r.buses} buses produced a full lap;` +
        ` ${r.selfCross} self-crossings, ${r.uturns} U-turns (upstream ${r.up?.uturns ?? "—"});` +
        ` timestamps recovered for ${pctS(r.timeMatched)} of vertices; poll interval median ${r0(r.medPollSec)} s / max ${r0(r.maxPollSec)} s, ${pctS(r.gapFrac)} of the lap spans a >60 s gap, longest unobserved hop ${r0(r.maxRawGapM)} m` +
        (r.crossBus ? `; nearest independent lap ${r0(r.crossBus.med)} m median / ${r0(r.crossBus.p90)} m p90` : ""));
    }
    console.log("");
  }

  const none = results.filter((r) => !r.derived);
  console.log("\nNOT DERIVED — why, and whether that is expected\n");
  if (!none.length) console.log("  (every route produced a path)");
  for (const r of none) {
    const sched = r.scheduled ? "SHOULD be running right now" : `not scheduled now${r.nextRun ? `; next window ${r.nextRun} ET` : ""}`;
    console.log(`  ${pad(r.id, 3)}${pad(r.label, 15)}${r.reason}`);
    console.log(`  ${" ".repeat(18)}${sched}${r.scheduled ? "   <-- running but underivable, investigate" : "   <-- expected, not a failure"}`);
    if (r.samples && r.neverApproached?.length) {
      console.log(`  ${" ".repeat(18)}never within ${COVERAGE_M} m: ` +
        r.neverApproached.slice(0, 4).map((s) => `${s.name} (${s.m} m)`).join(", ") +
        (r.neverApproached.length > 4 ? ` +${r.neverApproached.length - 4} more` : ""));
    }
  }

  const accepted = results.filter((r) => r.accept);
  const bad = accepted.filter((r) => r.verdict === "fail");
  const warned = accepted.filter((r) => r.verdict === "warn");
  const derivedRejected = results.filter((r) => r.derived && !r.accept);
  const runningButNot = none.filter((r) => r.scheduled);
  console.log("\n" + "=".repeat(120));
  console.log(`${accepted.length} of ${results.length} routes would be served derived geometry.`);
  console.log(`  clean:              ${accepted.filter((r) => r.verdict === "ok").length}${accepted.filter((r) => r.verdict === "ok").length ? " — " + accepted.filter((r) => r.verdict === "ok").map((r) => r.label).join(", ") : ""}`);
  console.log(`  warnings:           ${warned.length}${warned.length ? " — " + warned.map((r) => r.label).join(", ") : ""}`);
  console.log(`  FAILURES (serving a wrong line): ${bad.length}${bad.length ? " — " + bad.map((r) => r.label).join(", ") : ""}`);
  console.log(`  derived but rejected (upstream already close enough): ${derivedRejected.length}${derivedRejected.length ? " — " + derivedRejected.map((r) => `${r.label}[${r.verdict}]`).join(", ") : ""}`);
  console.log(`  no data:            ${none.length}${none.length ? " — " + none.map((r) => r.label + (r.scheduled ? " (RUNNING!)" : "")).join(", ") : ""}`);
  if (runningButNot.length) console.log(`  !! ${runningButNot.length} route(s) are inside their service window yet produced nothing`);
  console.log(`\nexit ${bad.length ? 1 : 0}: ${bad.length ? "an accepted path failed an adversarial check — do not serve it" : "no accepted path failed an adversarial check"}`);
  console.log("=".repeat(120) + "\n");

  return results;
}

// ── entry ─────────────────────────────────────────────────────────────────
try {
  register();
  const dp = await import(resolve(ROOT, "src/network/derivePath.ts"));
  const rl = await import(resolve(ROOT, "web/src/routes.ts"));
  const sc = await import(resolve(ROOT, "web/src/schedule.ts"));
  const wg = await import(resolve(ROOT, "web/src/geo.ts"));
  const inputs = await loadInputs();
  const results = main(inputs, {
    derivePath: dp.derivePath,
    stopDistances: dp.stopDistances,
    isBetterThanUpstream: dp.isBetterThanUpstream,
    buildStopSequencePolyline: wg.buildStopSequencePolyline,
    polylineMeters: wg.polylineMeters,
    ROUTE_LISTS: rl.ROUTE_LISTS,
    isRouteActiveAt: sc.isRouteActiveAt,
    nextActiveWindow: sc.nextActiveWindow,
  });
  process.exit(results.some((r) => r.accept && r.verdict === "fail") ? 1 : 0);
} catch (e) {
  console.error(`derived-path-check: ${e?.stack || e}`);
  process.exit(2);
}
