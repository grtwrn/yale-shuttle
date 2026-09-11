/**
 * DOES `heading` PICK THE RIGHT BRANCH OF A FOLD?
 *
 * Where a route FOLDS — one road carrying two legs of the loop in opposite
 * directions — the cell nearest a fix can be on the wrong branch, and the bus
 * is then anchored to a pass that serves the opposite direction. Nothing in
 * the estimator reads `heading`. This measures whether it would help, against
 * the trajectory itself.
 *
 * TRUTH IS THE TRAJECTORY'S OWN CONTINUATION, not any anchor the app computes.
 * Each bus's whole series is decoded by a sparse Viterbi over ring cells with
 * a forward-biased transition (a bus drives the loop in order; a backward step
 * is paid for). The decode sees the future as well as the past, so at a fold
 * it is settled by where the bus went NEXT — which is precisely the evidence
 * one frame does not have. Frames are then classified from that decode.
 *
 * A FOLD FRAME is one where a second local minimum of distance-to-fix lies
 * within FOLD_SLACK_M of the nearest and at least FOLD_SEP_CELLS away along
 * the ring: two branches are geometrically plausible. A WRONG-BRANCH frame is
 * a fold frame whose decoded cell is on the other branch from the nearest.
 *
 * The findings, and why the change it suggested was refused, are in
 * `docs/route-bias.md` § 10.
 *
 *   TZ=America/New_York PAYLOAD=store/buses.json REPLAY_DB=./store/snap.db \
 *     POSITIONS=~/shuttle-captures/positions-20260904.jsonl \
 *     npx tsx scripts/eta-replay/heading-fold.ts
 *
 * Env: ROUTES (comma-separated route ids, default all), REPLAY_DB (a snapshot,
 * only to name the routes), FOLD_SLACK_M (40), FOLD_SEP_CELLS (10), CAND_M
 * (150), MOVED_M (8), TOP_STOPS (12).
 */
import fs from "node:fs";
import zlib from "node:zlib";

import { registerRoutePaths } from "../../web/src/anchor";
import { ringForBus } from "../../web/src/eta";
import { forwardCells, type Ring } from "../../web/src/eta/ring";
import type { LatLon } from "../../web/src/geo";

const FOLD_SLACK_M = Number(process.env.FOLD_SLACK_M ?? 40);
const FOLD_SEP_CELLS = Number(process.env.FOLD_SEP_CELLS ?? 10);
const MOVED_M = Number(process.env.MOVED_M ?? 8);
const CAND_M = Number(process.env.CAND_M ?? 150);
const GAP_MS = 180_000;
const TOP_STOPS = Number(process.env.TOP_STOPS ?? 12);

const payload = JSON.parse(fs.readFileSync(process.env.PAYLOAD ?? "store/buses.json", "utf8"));
const stopCoords: Record<number, LatLon> = {};
for (const [k, v] of Object.entries(payload.stop_coords)) stopCoords[Number(k)] = v as LatLon;
const stopName: Record<number, string> = payload.stop_names ?? {};
const routeStops: Record<string, number[]> = {};
for (const [rid, o] of Object.entries<Record<string, number>>(payload.routes)) {
  routeStops[rid] = Object.keys(o).sort((a, b) => Number(a) - Number(b)).map((k) => o[k]!);
}
registerRoutePaths(payload.route_paths);
const routeName: Record<string, string> = {};
for (const b of payload.buses ?? []) routeName[String(b.route_id)] = b.route_short_name ?? b.route ?? "";
// The payload's `buses` is one live poll and names only the lines running then.
// A snapshot names them all; without one a route is printed by its id.
if (process.env.REPLAY_DB) {
  const { default: Database } = await import("better-sqlite3");
  const db = new Database(process.env.REPLAY_DB, { readonly: true });
  for (const r of db.prepare("SELECT id, name FROM routes").all() as { id: number; name: string }[]) {
    routeName[String(r.id)] = r.name.replace(/ - Weekday Daytime$/, " Day").replace(/ - /, " ");
  }
  db.close();
}
const wanted = new Set((process.env.ROUTES ?? "").split(",").map((s) => s.trim()).filter(Boolean));

// ── local metric: equirectangular, exact enough over a 12 km loop ───────────
const R = 6371000, toRad = Math.PI / 180;
const LAT0 = 41.31 * toRad;
const MX = R * Math.cos(LAT0) * toRad, MY = R * toRad;
const bearing = (a: LatLon, b: LatLon): number => {
  const y = Math.sin((b.lon - a.lon) * toRad) * Math.cos(b.lat * toRad);
  const x = Math.cos(a.lat * toRad) * Math.sin(b.lat * toRad)
    - Math.sin(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.cos((b.lon - a.lon) * toRad);
  return (Math.atan2(y, x) * (180 / Math.PI) + 360) % 360;
};
const angle = (a: number, b: number): number => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

const rows: any[] = [];
for (const f of (process.env.POSITIONS ?? "").split(",").filter(Boolean)) {
  const path = f.replace(/^~/, process.env.HOME ?? "~");
  const raw = path.endsWith(".gz") ? zlib.gunzipSync(fs.readFileSync(path)).toString("utf8") : fs.readFileSync(path, "utf8");
  let torn = 0;
  for (const l of raw.split("\n")) {
    if (!l.trim()) continue;
    try { rows.push(JSON.parse(l)); } catch { torn++; }
  }
  if (torn) console.error(`${path}: skipped ${torn} torn lines`);
}
const byBus = new Map<string, any[]>();
for (const p of rows) {
  if (wanted.size && !wanted.has(String(p.route_id))) continue;
  const k = `${p.bus_name}|${p.route_id}`;
  if (!byBus.has(k)) byBus.set(k, []);
  byBus.get(k)!.push(p);
}
console.error(`${rows.length} frames, ${byBus.size} bus-route series`);

interface Score { n: number; near45: number; near90: number; near135: number }
const blank = (): Score => ({ n: 0, near45: 0, near90: 0, near135: 0 });
const add = (s: Score, a: number) => { s.n++; if (a <= 45) s.near45++; if (a <= 90) s.near90++; if (a >= 135) s.near135++; };

// Heading scored at the TRUE branch's cell and at the FALSE branch's cell, on
// the frames where the two branches disagree.
const trueBr = { moved: blank(), still: blank() };
const falseBr = { moved: blank(), still: blank() };
// Every frame the decode calls unambiguous: the calibration for the emission.
const plain = { moved: blank(), still: blank() };
// The reversed tail at the NEAREST cell, split by what the decode says.
let revWrong = 0, revRight = 0, revWrongStill = 0, revRightStill = 0;
let nFold = 0, nWrong = 0, nFrames = 0, nMoved = 0;
/** Angular error at the decoded cell on unambiguous frames — the emission's calibration. */
const calMovedArr: number[] = [], calStillArr: number[] = [], calMovedDep: number[] = [];
const calAllArr: number[] = [], calAllStill: number[] = [];
/**
 * The filter's own notion of a fresh fix is "the coordinate changed", which is
 * not the same as "the bus moved": a jiggle of a metre is fresh, and the
 * heading it carries is the bearing of that jiggle (or, frozen, of a move
 * made before a layover). So the calibration is binned by the displacement
 * the bearing was actually computed from.
 */
const DISP_BINS = [0.5, 2, 5, 10, 20, 40, 80, 1e9];
const byDisp: number[][] = DISP_BINS.map(() => []);
const byDispWrong: { t: number[]; f: number[] }[] = DISP_BINS.map(() => ({ t: [], f: [] }));
const perRoute = new Map<string, { frames: number; fold: number; wrong: number; wrongMoved: number; cal: number[]; bridged: boolean; repaired: boolean; t45: number; f45: number; wn: number; sep: number[] }>();
const perStop = new Map<string, number>();
const wrongExamples: string[] = [];

/** Sparse Viterbi over ring cells: emission Gaussian, transition forward-biased. */
function decode(ring: Ring, series: any[], cellM: number): Int32Array {
  const C = ring.C;
  const cx = new Float64Array(C), cy = new Float64Array(C);
  for (let c = 0; c < C; c++) { cx[c] = ring.lon[c]! * MX; cy[c] = ring.lat[c]! * MY; }
  const out = new Int32Array(series.length).fill(-1);
  // candidates per frame
  const cand: Int32Array[] = [], cost: Float64Array[] = [];
  for (let j = 0; j < series.length; j++) {
    const px = series[j]!.lon * MX, py = series[j]!.lat * MY;
    const ids: number[] = [], cs: number[] = [];
    for (let c = 0; c < C; c++) {
      const dx = cx[c]! - px, dy = cy[c]! - py;
      const d2 = dx * dx + dy * dy;
      if (d2 <= CAND_M * CAND_M) { ids.push(c); cs.push(d2 / (2 * 25 * 25)); }
    }
    cand.push(Int32Array.from(ids)); cost.push(Float64Array.from(cs));
  }
  let s = 0;
  while (s < series.length) {
    // a segment of frames that all have candidates and no long gap
    let e = s;
    if (cand[s]!.length === 0) { s++; continue; }
    while (e + 1 < series.length && cand[e + 1]!.length > 0
      && series[e + 1]!.collected_at - series[e]!.collected_at <= GAP_MS) e++;
    // forward pass
    const bt: Int32Array[] = [];
    let prevCost = Float64Array.from(cost[s]!);
    for (let j = s + 1; j <= e; j++) {
      const dt = Math.max(1, (series[j]!.collected_at - series[j - 1]!.collected_at) / 1000);
      const expect = 7 * dt;                       // metres a bus typically covers
      const scale = Math.max(40, 0.9 * expect);    // Laplace width, metres
      const prev = cand[j - 1]!, here = cand[j]!;
      const nc = new Float64Array(here.length).fill(Infinity);
      const b = new Int32Array(here.length).fill(-1);
      for (let a = 0; a < prev.length; a++) {
        const pc = prevCost[a]!;
        if (!Number.isFinite(pc)) continue;
        for (let z = 0; z < here.length; z++) {
          const k = forwardCells(ring, prev[a]!, here[z]!);
          const back = k > ring.C / 2;
          const dm = back ? (k - ring.C) * cellM : k * cellM;
          // forward moves cost |travelled - expected| / scale; a backward move
          // pays 6 nats on top (a yard reverse happens; a lap backwards does not)
          let t = Math.abs(dm - expect) / scale + (back ? 6 + Math.abs(dm) / 100 : 0);
          if (dm > expect + 25 * dt) t += 20;      // faster than any bus drives
          const v = pc + t;
          if (v < nc[z]!) { nc[z] = v; b[z] = a; }
        }
      }
      for (let z = 0; z < here.length; z++) nc[z] = nc[z]! + cost[j]![z]!;
      bt.push(b); prevCost = nc;
    }
    // backtrace
    let best = 0;
    for (let z = 1; z < prevCost.length; z++) if (prevCost[z]! < prevCost[best]!) best = z;
    out[e] = cand[e]![best]!;
    for (let j = e; j > s; j--) {
      const b = bt[j - 1 - s]!;
      best = b[best]!;
      if (best < 0) break;
      out[j - 1] = cand[j - 1]![best]!;
    }
    s = e + 1;
  }
  return out;
}

for (const [key, series] of byBus) {
  const [busName, rid] = key.split("|") as [string, string];
  const stops = routeStops[rid];
  if (!stops || stops.length < 2) continue;
  const ring = ringForBus({ route_id: Number(rid) }, stops, stopCoords);
  if (!ring) continue;
  series.sort((a, b) => a.collected_at - b.collected_at);
  const cellM = ring.loopM / ring.C;
  const truth = decode(ring, series, cellM);
  const C = ring.C;
  const cx = new Float64Array(C), cy = new Float64Array(C);
  for (let c = 0; c < C; c++) { cx[c] = ring.lon[c]! * MX; cy[c] = ring.lat[c]! * MY; }
  // bearing ARRIVING at each cell (heading is the bearing of the last leg driven)
  const cellBear = new Float64Array(C);
  for (let c = 0; c < C; c++) {
    const p = (c - 1 + C) % C;
    cellBear[c] = bearing({ lat: ring.lat[p]!, lon: ring.lon[p]! }, { lat: ring.lat[c]!, lon: ring.lon[c]! });
  }
  let acc = perRoute.get(rid);
  if (!acc) perRoute.set(rid, (acc = { frames: 0, fold: 0, wrong: 0, wrongMoved: 0, cal: [], bridged: ring.bridged, repaired: ring.repaired, t45: 0, f45: 0, wn: 0, sep: [] }));

  for (let j = 0; j < series.length; j++) {
    const o = series[j]!;
    if (truth[j]! < 0) continue;
    const px = o.lon * MX, py = o.lat * MY;
    let near = -1, nd = Infinity;
    const d = new Float64Array(C);
    for (let c = 0; c < C; c++) {
      const dx = cx[c]! - px, dy = cy[c]! - py;
      const dd = Math.sqrt(dx * dx + dy * dy);
      d[c] = dd;
      if (dd < nd) { nd = dd; near = c; }
    }
    if (nd > 60) continue;                       // clearly off the published line
    nFrames++; acc.frames++;
    const moved = j > 0 && Math.hypot((o.lon - series[j - 1]!.lon) * MX, (o.lat - series[j - 1]!.lat) * MY) > MOVED_M;
    if (moved) nMoved++;
    const bucket = moved ? "moved" : "still";
    const h = Number(o.heading);
    const hOk = Number.isFinite(h);

    // Is there a rival branch? The best cell at least FOLD_SEP_CELLS away.
    let rival = -1, rd = Infinity;
    for (let c = 0; c < C; c++) {
      const sep = Math.min(forwardCells(ring, near, c), forwardCells(ring, c, near));
      if (sep < FOLD_SEP_CELLS) continue;
      if (d[c]! < rd) { rd = d[c]!; rival = c; }
    }
    const isFold = rival >= 0 && rd <= nd + FOLD_SLACK_M;
    const tSep = Math.min(forwardCells(ring, near, truth[j]!), forwardCells(ring, truth[j]!, near));
    const wrong = tSep >= FOLD_SEP_CELLS;
    if (isFold) { nFold++; acc.fold++; }
    if (wrong) {
      nWrong++; acc.wrong++;
      if (moved) acc.wrongMoved++;
      const st = ring.stops[ring.leg[truth[j]!]!]!;
      const sk = `${rid}|${st}`;
      perStop.set(sk, (perStop.get(sk) ?? 0) + 1);
    }
    if (!hOk) continue;
    const aNear = angle(h, cellBear[near]!);
    // The emission must hold on EVERY frame, not only the easy ones, so the
    // calibration below pools the wrong-branch frames (scored at the decoded
    // cell) with the unambiguous ones.
    const disp = j > 0 ? Math.hypot((o.lon - series[j - 1]!.lon) * MX, (o.lat - series[j - 1]!.lat) * MY) : Infinity;
    let db = 0; while (db < DISP_BINS.length - 1 && disp > DISP_BINS[db]!) db++;
    const aDec = angle(h, cellBear[truth[j]!]!);
    if (disp > 0) {
      byDisp[db]!.push(aDec);
      if (wrong) { byDispWrong[db]!.t.push(aDec); byDispWrong[db]!.f.push(angle(h, cellBear[near]!)); }
    }
    (moved ? calAllArr : calAllStill).push(aDec);
    if (moved) acc.cal.push(aDec);
    if (wrong) {
      const aTrue = angle(h, cellBear[truth[j]!]!);
      add(trueBr[bucket], aTrue);
      add(falseBr[bucket], aNear);
      if (moved) {
        acc.wn++;
        if (aTrue <= 45) acc.t45++;
        if (aNear <= 45) acc.f45++;
        acc.sep.push(angle(cellBear[truth[j]!]!, cellBear[near]!));
      }
      if (aNear >= 135) { if (moved) revWrong++; else revWrongStill++; }
      if (wrongExamples.length < 12 && moved && aNear >= 135) {
        wrongExamples.push(`${routeName[rid] ?? rid} ${busName} ${new Date(o.collected_at).toISOString().slice(11, 19)}`
          + ` nearest cell ${near} (${cellBear[near]!.toFixed(0)}deg, ${nd.toFixed(0)} m) heading ${h.toFixed(0)}deg`
          + ` -> decoded cell ${truth[j]} (${cellBear[truth[j]!]!.toFixed(0)}deg, ${d[truth[j]!]!.toFixed(0)} m), ${tSep} cells apart`);
      }
    } else {
      add(plain[bucket], aNear);
      if (aNear >= 135) { if (moved) revRight++; else revRightStill++; }
      // The emission's own calibration: the angle between the reported heading
      // and the DECODED cell's bearing, arriving and departing, on the frames
      // where there is no branch to get wrong.
      const t = truth[j]!;
      const nx = (t + 1) % C;
      const dep = bearing({ lat: ring.lat[t]!, lon: ring.lon[t]! }, { lat: ring.lat[nx]!, lon: ring.lon[nx]! });
      (moved ? calMovedArr : calStillArr).push(angle(h, cellBear[t]!));
      if (moved) calMovedDep.push(angle(h, dep));
    }
  }
}

const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : "-");
const line = (name: string, s: Score) =>
  `  ${name.padEnd(28)} n=${String(s.n).padStart(7)}   <=45deg ${pct(s.near45, s.n).padStart(7)}`
  + `   <=90deg ${pct(s.near90, s.n).padStart(7)}   >=135deg ${pct(s.near135, s.n).padStart(7)}`;

console.log(`\nframes on the line ${nFrames} (${pct(nMoved, nFrames)} with a moved fix)`);
console.log(`fold frames (a rival branch within ${FOLD_SLACK_M} m and >= ${FOLD_SEP_CELLS} cells away): ${nFold} = ${pct(nFold, nFrames)}`);
console.log(`WRONG-BRANCH frames (the decode is >= ${FOLD_SEP_CELLS} cells from the nearest cell): ${nWrong} = ${pct(nWrong, nFrames)}\n`);

console.log("HEADING vs the cell's own arriving bearing");
console.log(" on WRONG-BRANCH frames, scored at each of the two candidate cells:");
console.log(line("TRUE branch, fix moved", trueBr.moved));
console.log(line("FALSE branch (nearest), moved", falseBr.moved));
console.log(line("TRUE branch, fix repeated", trueBr.still));
console.log(line("FALSE branch, fix repeated", falseBr.still));
console.log(" on every other frame, at the nearest cell (the calibration):");
console.log(line("unambiguous, fix moved", plain.moved));
console.log(line("unambiguous, fix repeated", plain.still));

const lr = (t: Score, f: Score, k: keyof Score) => {
  const pt = t.n ? (t[k] as number) / t.n : 0, pf = f.n ? (f[k] as number) / f.n : 0;
  return pf > 0 ? (pt / pf).toFixed(1) : "inf";
};
console.log(`\nLIKELIHOOD RATIO on a wrong-branch frame, moved fix:`);
console.log(`  P(heading within 45deg | true branch) / P(.. | false branch) = ${lr(trueBr.moved, falseBr.moved, "near45")}`);
console.log(`  P(within 90deg | true) / P(.. | false)                       = ${lr(trueBr.moved, falseBr.moved, "near90")}`);
console.log(`  repeated fix, within 45deg                                   = ${lr(trueBr.still, falseBr.still, "near45")}`);

console.log(`\nThe reversed tail (heading >= 135deg from the NEAREST cell's bearing):`);
console.log(`  fix moved:    ${revWrong} on a wrong branch, ${revRight} where the nearest cell is right`
  + `  -> ${pct(revWrong, revWrong + revRight)} of it is a genuine wrong branch`);
console.log(`  fix repeated: ${revWrongStill} wrong branch, ${revRightStill} right`
  + `  -> ${pct(revWrongStill, revWrongStill + revRightStill)}`);

console.log("\nTHE HEADING BY THE DISPLACEMENT IT WAS COMPUTED FROM (every route, fresh fixes only:");
console.log("a fix that did not move at all is not one the emission ever sees)");
console.log("  displacement       n     <=45deg   >=135deg      on a wrong-branch frame: LR(45deg)  n");
for (let i = 0; i < DISP_BINS.length; i++) {
  const a = byDisp[i]!;
  if (a.length < 30) continue;
  const lo = i === 0 ? 0 : DISP_BINS[i - 1]!;
  const hi = DISP_BINS[i]! > 1e8 ? Infinity : DISP_BINS[i]!;
  const w = byDispWrong[i]!;
  const pt = w.t.length ? w.t.filter((x) => x <= 45).length / w.t.length : 0;
  const pf = w.f.length ? w.f.filter((x) => x <= 45).length / w.f.length : 0;
  console.log(`  ${`${lo}-${hi === Infinity ? "" : hi} m`.padEnd(12)}${String(a.length).padStart(8)}`
    + `${pct(a.filter((x) => x <= 45).length, a.length).padStart(11)}${pct(a.filter((x) => x >= 135).length, a.length).padStart(11)}`
    + `${(pf > 0 ? (pt / pf).toFixed(1) : pt > 0 ? "inf" : "-").padStart(35)}${String(w.t.length).padStart(7)}`);
}

console.log("\nBY ROUTE  (`bad` = the heading is >= 135deg from the DECODED cell's own bearing on a moved");
console.log("           fix — the emission penalising the truth, which is where it can only hurt)");
console.log("  route            frames    fold%   wrong-branch%   wrong & moved   <=45deg    bad   ring");
for (const rid of [...perRoute.keys()].sort((a, b) => (perRoute.get(b)!.wrong / Math.max(1, perRoute.get(b)!.frames)) - (perRoute.get(a)!.wrong / Math.max(1, perRoute.get(a)!.frames)))) {
  const a = perRoute.get(rid)!;
  const good = a.cal.filter((x) => x <= 45).length, bad = a.cal.filter((x) => x >= 135).length;
  console.log(`  ${(routeName[rid] ?? rid).slice(0, 15).padEnd(16)}${String(a.frames).padStart(7)}${pct(a.fold, a.frames).padStart(9)}`
    + `${pct(a.wrong, a.frames).padStart(16)}${String(a.wrongMoved).padStart(16)}`
    + `${pct(good, a.cal.length).padStart(10)}${pct(bad, a.cal.length).padStart(7)}`
    + `${(a.wn && a.f45 ? (a.t45 / a.f45).toFixed(1) : a.wn ? "inf" : "-").padStart(7)}`
    + `${(a.sep.length ? `${[...a.sep].sort((x, y) => x - y)[a.sep.length >> 1]!.toFixed(0)}deg` : "-").padStart(21)}`
    + `   ${a.bridged ? "bridged " : ""}${a.repaired ? "repaired" : ""}`);
}

console.log(`\nTOP ${TOP_STOPS} LEGS BY WRONG-BRANCH FRAMES (named by the leg's start stop)`);
for (const [k, n] of [...perStop.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_STOPS)) {
  const [rid, sid] = k.split("|") as [string, string];
  console.log(`  ${String(n).padStart(6)}  ${(routeName[rid] ?? rid).padEnd(14)} ${sid.padStart(4)} ${stopName[Number(sid)] ?? ""}`);
}

if (wrongExamples.length) {
  console.log("\nEXAMPLES (moved fix, heading reversed against the nearest cell)");
  for (const e of wrongExamples) console.log(`  ${e}`);
}


// ── the emission's shape, fitted ────────────────────────────────────────────
//
// The factor this measurement earns is a per-cell likelihood, so what it needs
// is p(heading | the bus is on this cell) — the distribution above. Two
// components, the same idiom the position emission uses: a concentrated one
// (the heading IS the bearing of the 30 m the bus just drove, and a cell is
// 30 m of the same road) and a FLAT floor for the frames where the heading
// says nothing — a turn taken between two polls, a fix pair too short to bear
// an angle, a heading frozen from before a layover.
//
// Maximum likelihood is DEGENERATE here: the core is a spike (p50 1.4deg,
// because on a straight road the two chords are the same chord) and the
// likelihood climbs with kappa without bound while the floor absorbs the
// shoulder. So the two constants are moment-matched instead, on the two
// features that decide anything: the reversed tail sets the floor, and the
// 45deg shoulder sets kappa. Both are read off the pooled population — EVERY
// decoded frame, not only the ones with no branch to get wrong.
const i0 = (k: number) => { let s2 = 1, t = 1; for (let m = 1; m < 200; m++) { t *= (k * k) / (4 * m * m); s2 += t; if (t < 1e-15 * s2) break; } return s2; };
/** P(|angle| <= x) for a von Mises of concentration k, by quadrature. */
function vmWithin(k: number, xDeg: number): number {
  const n = 4000, hi = (xDeg * Math.PI) / 180;
  let acc = 0;
  for (let i = 0; i < n; i++) acc += Math.exp(k * Math.cos((hi * (i + 0.5)) / n));
  return (acc * (hi / n)) / (Math.PI * i0(k));
}
const q = (a: number[], p2: number) => { const s2 = [...a].sort((x, y) => x - y); return s2[Math.floor(p2 * (s2.length - 1))] ?? NaN; };
const shareLe = (a: number[], x: number) => a.filter((v) => v <= x).length / Math.max(1, a.length);
const shareGe = (a: number[], x: number) => a.filter((v) => v >= x).length / Math.max(1, a.length);

console.log("\nTHE EMISSION'S CALIBRATION — angle(heading, the cell's own arriving bearing) at the");
console.log("DECODED cell. `every decoded frame` is the population the emission must hold on.");
for (const [name, a] of [["unambiguous, moved", calMovedArr],
  ["unambiguous, moved (DEPARTING bearing)", calMovedDep],
  ["unambiguous, repeated", calStillArr],
  ["every decoded frame, moved", calAllArr],
  ["every decoded frame, repeated", calAllStill]] as [string, number[]][]) {
  if (!a.length) continue;
  console.log(`  ${name.padEnd(40)} n=${String(a.length).padStart(7)}  p50 ${q(a, 0.5).toFixed(1)}  p90 ${q(a, 0.9).toFixed(1)}`
    + `  <=45deg ${(100 * shareLe(a, 45)).toFixed(1)}%  <=90deg ${(100 * shareLe(a, 90)).toFixed(1)}%  >=135deg ${(100 * shareGe(a, 135)).toFixed(2)}%`);
}
for (const [name, a] of [["MOVED fix", calAllArr], ["repeated fix", calAllStill]] as [string, number[]][]) {
  if (a.length < 500) continue;
  // the reversed quarter of the circle carries w/4 of a flat component
  const w = Math.min(0.5, 4 * shareGe(a, 135));
  const target = (shareLe(a, 45) - w * 0.25) / (1 - w);
  let k = 0.5;
  for (let t = 0.5; t <= 400; t *= 1.002) { if (vmWithin(t, 45) >= target) { k = t; break; } k = t; }
  const floor = (w / (1 - w)) * (i0(k) / Math.exp(k));
  console.log(`  fit (${name}): kappa ${k.toFixed(1)}   flat weight ${(100 * w).toFixed(1)}%`
    + `   ->  factor = exp(kappa*(cos d - 1)) + ${floor.toExponential(2)}`
    + `   worst penalty ${(((1 + floor) / (Math.exp(-2 * k) + floor))).toFixed(0)}:1`
    + `   (= a rival cell ${(Math.sqrt(2 * 20 * 20 * Math.log((1 + floor) / (Math.exp(-2 * k) + floor)))).toFixed(0)} m nearer)`);
}
