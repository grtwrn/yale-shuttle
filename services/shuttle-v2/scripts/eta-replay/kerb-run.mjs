/**
 * Does an outward RUN discriminate a departure from a kerb shuffle, and HOW
 * FAST? The record is docs/eta-ring-posterior.md, "An outward run: measured".
 *
 * Four single-poll discriminators have been measured and refused (#246 the flat
 * in-rest rate, #247 the second-fix form, #248 direction along the ring, #249
 * forbidding the departure walk out of the rest mask). Their common conclusion
 * is that no SINGLE-POLL discriminator exists: the only real difference is that
 * a shuffle comes back and a departure does not, which is visible one or two
 * polls later. This asks what that costs in latency, because the gate #249 died
 * on is a departure collapse arriving 45 s late.
 *
 * Population, truth and the in-rest split are `kerb-direction.mjs`'s, verbatim
 * (a fresh fix while the detector still says standing is a SHUFFLE; the first
 * fresh fix after `stop_visits.departed_at` — equal to `last_at_rest_at` — is
 * the DEPARTURE), so its 33.5% / n=7,116 reproduces as a self-check. What is
 * added is the SEQUENCE: every fresh fix of a rest carries its distance from
 * the rest point, so a run of consecutive outward steps can be scored both for
 * what it implies (precision) and for when it fires (latency).
 *
 * Two labels, and the distinction is the whole measurement:
 *   `dep`  the FIRST fresh fix after the departure instant — kerb-direction's
 *          label, kept so its tables reproduce;
 *   `gone` ANY fix after it. A rule that fires on a bus's SECOND post-departure
 *          fix is right about the bus and late about the poll, which is a
 *          latency cost, not a false alarm.
 *
 *   TZ=America/New_York REPLAY_DB=./store/snap.db ROUTES=3,1 \
 *     node scripts/eta-replay/kerb-run.mjs 2026-09-03 2026-09-04 2026-09-08 2026-09-09
 */
import fs from "node:fs"; import zlib from "node:zlib"; import os from "node:os"; import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const ARCH = process.env.ARCHIVE_DIR ?? path.join(os.homedir(), "shuttle-archive");
const DB = process.env.REPLAY_DB;
const days = process.argv.slice(2).filter((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
const ROUTES = (process.env.ROUTES ?? "3,1").split(",").map(Number);
/** filter.ts REST_RADIUS_M — the rest's extent, and master's own hard evidence. */
const REST = 125;
/**
 * Where the rest point IS. `belief` is faithful to filter.ts: the point is the
 * fix at which the rest was established — a REPEATED coordinate — it is frozen
 * while the bus stays inside the radius, and a fix beyond the radius ends the
 * rest (`leftRest`), which re-anchors the point at the next repeat. `arrival`
 * is kerb-direction's choice (the fix at `pinned_at`), kept because #246's
 * split is quoted against it; on a stop with a berth the two differ by 155 m
 * (the recorded 344 Winchester pass), which is why this switch exists.
 */
const RP_MODE = process.env.REST_POINT ?? "belief";
/** A poll, not a feed gap. */
const MAX_DT = 15_000;
/** How long past the departure instant the sequence is followed. */
const TAIL_MS = 180_000;
if (!DB || !days.length) {
  console.error("REPLAY_DB=<snapshot.db> node scripts/eta-replay/kerb-run.mjs <day> [day …]");
  process.exit(2);
}

const hav = (a, b) => { const R = 6371000, k = Math.PI / 180; const dLa = (b.lat - a.lat) * k, dLo = (b.lon - a.lon) * k;
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(a.lat * k) * Math.cos(b.lat * k) * Math.sin(dLo / 2) ** 2; return 2 * R * Math.asin(Math.min(1, Math.sqrt(h))); };
const rows = (d, t) => { const f = path.join(ARCH, d, `${t}.jsonl.gz`); return fs.existsSync(f) ? zlib.gunzipSync(fs.readFileSync(f)).toString().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []; };

const db = new Database(DB, { readonly: true });
const NAME = new Map(), HASPATH = new Set();
for (const r of db.prepare("SELECT id, short_name, path_json FROM routes").all()) {
  NAME.set(r.id, r.short_name ?? String(r.id));
  try { if (Array.isArray(JSON.parse(r.path_json))) HASPATH.add(r.id); } catch { /* parity with kerb-direction, which skips a route with no line */ }
}
const COORD = new Map();
for (const s of db.prepare("SELECT id, lat, lon FROM stops").all()) COORD.set(s.id, { lat: s.lat, lon: s.lon });
db.close();

/** One rest: its fresh fixes in order, each with its distance from the rest point. */
const rests = []; const standSecs = new Map(); const sampleDt = [];
let visits = 0, standPolls = 0;
for (const day of days) {
  const V = rows(day, "stop_visits").filter((v) => ROUTES.includes(v.route_id));
  const byBus = new Map();
  for (const r of rows(day, "raw_positions").filter((r) => ROUTES.includes(r.route_id))) {
    if (!byBus.has(r.bus_name)) byBus.set(r.bus_name, []); byBus.get(r.bus_name).push(r);
  }
  for (const l of byBus.values()) l.sort((a, b) => a.collected_at - b.collected_at);
  for (const v of V) {
    if (v.outcome !== "stopped" || !v.departed_at || !v.pinned_at) continue;
    const key = `${v.route_id}:${v.stop_id}`;
    if (!standSecs.has(key)) standSecs.set(key, []);
    standSecs.get(key).push(v.stand_sec ?? (v.departed_at - v.pinned_at) / 1000);
    const stop = COORD.get(v.stop_id), track = byBus.get(v.bus_name);
    if (!stop || !track || !HASPATH.has(v.route_id) || !(v.departed_at > v.pinned_at)) continue;
    const seg = track.filter((r) => r.collected_at >= v.pinned_at - 1000 && r.collected_at <= v.departed_at + TAIL_MS);
    if (seg.length < 3) continue;
    visits++;
    let rest = { lat: seg[0].lat, lon: seg[0].lon }, established = RP_MODE === "arrival";
    const fixes = []; let prev = seg[0], nth = 0, pollsAfterDep = 0, sawFirstDep = false, kdOpen = true, ends = 0;
    for (let i = 1; i < seg.length; i++) {
      const r = seg[i], dt = r.collected_at - prev.collected_at;
      const fresh = r.lat !== prev.lat || r.lon !== prev.lon;
      if (dt <= MAX_DT) sampleDt.push(dt);
      if (r.collected_at <= v.departed_at && dt <= MAX_DT) standPolls++;
      if (r.collected_at > v.departed_at && dt <= MAX_DT) pollsAfterDep++;
      // The rest is established by a repeated fix, at the coordinate repeated.
      if (!established && !fresh) { rest = { lat: r.lat, lon: r.lon }; established = true; }
      if (dt <= MAX_DT && fresh && established) {
        const gone = r.collected_at > v.departed_at, d = hav(rest, r);
        fixes.push({
          nth: ++nth, t: r.collected_at, d, step: hav(prev, r),
          gone, dep: gone && !sawFirstDep, inRest: d <= REST,
          sinceDep: (r.collected_at - v.departed_at) / 1000,
          pollsSinceDep: gone ? pollsAfterDep : 0,
          gapS: dt / 1000, kd: kdOpen, seg: ends,
        });
        if (gone) sawFirstDep = true;
        // A fix beyond the radius ends the rest; the next repeat re-anchors it,
        // and the run starts again with it.
        if (d > REST && RP_MODE === "belief") { established = false; ends++; }
      }
      // kerb-direction's window closes on the first fresh fix past the
      // departure instant, recorded or dropped for a feed gap.
      if (fresh && r.collected_at > v.departed_at) kdOpen = false;
      prev = r;
    }
    if (fixes.length) rests.push({ route: v.route_id, stop: v.stop_id, bus: v.bus_name, day, fixes,
      standSec: (v.departed_at - v.pinned_at) / 1000, departedAt: v.departed_at });
  }
}
/** A layover by the archive's own stands, so no served payload is needed. */
const medOf = (xs) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1]; };
const qOf = (xs, p) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const isLayover = (r) => medOf(standSecs.get(`${r.route}:${r.stop}`) ?? []) >= 120;

/**
 * The run length at each fresh fix: consecutive outward steps, the rest point
 * itself (distance 0) anchoring the first, so the earliest a run of two can
 * fire is the rest's SECOND fresh fix. `minInc` is the increment that counts as
 * outward — 0 m is "increased at all", and the feed's ~30 m deadband is why the
 * larger cuts are reported beside it.
 */
function runLens(fixes, minInc) {
  const out = []; let prevD = 0, run = 0, seg = fixes.length ? fixes[0].seg : 0;
  for (const f of fixes) {
    if (f.seg !== seg) { seg = f.seg; prevD = 0; run = 0; }
    run = f.d - prevD > minInc ? run + 1 : 0;
    out.push(run); prevD = f.d;
  }
  return out;
}
for (const r of rests) for (const m of [0, 10, 20]) r[`run${m}`] = runLens(r.fixes, m);

const pct = (a, b) => (b ? ((a / b) * 100).toFixed(1) + "%" : "  —  ");
const cell3 = (n, k) => `${String(n).padStart(5)} / ${String(k).padStart(4)} / ${pct(k, n).padStart(7)}`;
const ARMS = [...ROUTES.map((r) => [NAME.get(r) ?? String(r), (x) => x.route === r]), ["pooled", () => true]];

/** Every fresh fix, flattened, with its rest attached. */
const allFix = [];
for (const r of rests) r.fixes.forEach((f, i) => allFix.push({ ...f, route: r.route, rest: r, i }));
const inRest = allFix.filter((f) => f.inRest);

console.log(`rest point: ${RP_MODE}`);
console.log(`days ${days.join(",")}  routes ${ROUTES.map((r) => `${r} (${NAME.get(r) ?? "?"})`).join(", ")}`);
console.log(`visits ${visits}  standing polls ${standPolls}  fresh fixes ${allFix.length}  rests with a fix ${rests.length}`);
console.log(`sample cadence: p50 ${(medOf(sampleDt) / 1000).toFixed(1)} s  p90 ${(qOf(sampleDt, 0.9) / 1000).toFixed(1)} s (n=${sampleDt.length})`);

console.log(`\n=== 1. BASELINE — kerb-direction's split, reproduced (n / dep / P(dep)) ===`);
for (const [n, sel] of ARMS) {
  const p = allFix.filter(sel);
  const k = p.filter((f) => f.kd);
  console.log(`  ${n.padEnd(8)} in-rest ${cell3(k.filter((f) => f.inRest).length, k.filter((f) => f.inRest && f.dep).length)}`
    + `   beyond ${cell3(k.filter((f) => !f.inRest).length, k.filter((f) => !f.inRest && f.dep).length)}`
    + `   [every fix, incl. the drive away: in-rest ${p.filter((f) => f.inRest).length}]`);
}

console.log(`\n=== 2. P(departure | an in-rest fresh fix, conditioned on an outward RUN) ===`);
/**
 * Two populations, and the first is the one #246's 33.5% is a statement about:
 * the fixes a STANDING bus publishes plus the one fix that reveals the
 * departure (kerb-direction's window), so `dep` and `gone` coincide. The second
 * adds every later fix of the drive away, which is what a runtime rule also
 * sees — it is dominated by the drive and is reported only so the difference
 * cannot be mistaken for a disagreement.
 */
for (const [popLbl, popSel, lab] of [
  ["a standing bus's fixes + the fix that reveals the departure", (f) => f.kd, "dep"],
  ["every in-rest fresh fix, incl. the drive away", () => true, "gone"],
]) {
  console.log(`\n  -- ${popLbl}`);
  for (const m of [0, 20]) {
    console.log(`  outward step > ${m} m`);
    console.log(`  ${"condition".padEnd(24)} | ` + ARMS.map(([n]) => `${n}: n / ${lab} / P`).join("  |  "));
    for (const [lbl, need] of [["no condition (master)", 1], ["run >= 2", 2], ["run >= 3", 3], ["run >= 4", 4]]) {
      const line = ARMS.map(([, sel]) => {
        const p = inRest.filter((f) => popSel(f) && sel(f) && f.rest[`run${m}`][f.i] >= need);
        return cell3(p.length, p.filter((f) => (lab === "dep" ? f.dep : f.gone)).length);
      }).join("  |  ");
      console.log(`  ${lbl.padEnd(24)} | ${line}`);
    }
  }
}

/** When does each rule first fire at or after the true departure instant? */
const RULES = [
  ["master: first fresh fix", (r) => r.fixes.find((f) => f.gone)],
  ["run >= 2 (> 0 m)", (r) => r.fixes.find((f, i) => f.gone && r.run0[i] >= 2)],
  ["run >= 3 (> 0 m)", (r) => r.fixes.find((f, i) => f.gone && r.run0[i] >= 3)],
  ["run >= 4 (> 0 m)", (r) => r.fixes.find((f, i) => f.gone && r.run0[i] >= 4)],
  ["run >= 2 (> 20 m)", (r) => r.fixes.find((f, i) => f.gone && r.run20[i] >= 2)],
  ["run >= 3 (> 20 m)", (r) => r.fixes.find((f, i) => f.gone && r.run20[i] >= 3)],
  ["beyond 125 m (leftRest)", (r) => r.fixes.find((f) => f.gone && !f.inRest)],
];
function latency(pop, label) {
  console.log(`\n  ${label}  (rests with a post-departure fix: ${pop.length})`);
  console.log(`  ${"rule".padEnd(24)} | fires | p50 s | p90 s | p50 polls | p90 polls | p50 fix# | never | later than master`);
  const mFirst = new Map(pop.map((r) => [r, r.fixes.find((f) => f.gone)]));
  for (const [lbl, find] of RULES) {
    const hits = pop.map(find).filter(Boolean);
    const later = pop.filter((r) => { const a = find(r), b = mFirst.get(r); return !a || (b && a.t > b.t); }).length;
    const s = hits.map((f) => f.sinceDep), pl = hits.map((f) => f.pollsSinceDep);
    console.log(`  ${lbl.padEnd(24)} | ${String(hits.length).padStart(5)} | ${qOf(s, 0.5).toFixed(0).padStart(5)} | ${qOf(s, 0.9).toFixed(0).padStart(5)} | `
      + `${String(qOf(pl, 0.5)).padStart(9)} | ${String(qOf(pl, 0.9)).padStart(9)} | ${String(medOf(hits.map((f) => f.nth))).padStart(8)} | `
      + `${pct(pop.length - hits.length, pop.length).padStart(6)} | ${pct(later, pop.length)}`);
  }
}
console.log(`\n=== 3. LATENCY — the first firing at or after the true departure instant ===`);
const withDep = rests.filter((r) => r.fixes.some((f) => f.gone));
for (const [n, sel] of ARMS) latency(withDep.filter(sel), n);
latency(withDep.filter(isLayover), "layover rests only (stand median >= 120 s)");

console.log(`\n=== 4. FALSE FIRES — a run that completes while the bus is still standing ===`);
console.log(`  a rest is counted once if ANY standing fresh fix completes the run — #119's ratchet keeps one trough for the whole stand.`);
console.log(`  ${"population".padEnd(26)} | rests | master | run>=2 | run>=3 | run>=4 | run>=2 (>20 m) | run>=3 (>20 m) | 1st false fire: p50 fix# / p50 s into the stand | master`);
function falseFires(pop, label) {
  const fires = (r, need, m = 0) => r.fixes.some((f, i) => !f.gone && r[`run${m}`][i] >= need);
  const firstFF = pop.map((r) => { const i = r.fixes.findIndex((f, j) => !f.gone && r.run0[j] >= 2); return i < 0 ? null : { nth: r.fixes[i].nth, s: (r.fixes[i].t - (r.departedAt - r.standSec * 1000)) / 1000 }; }).filter(Boolean);
  // Master's own exposure: it charges full departure evidence to the FIRST
  // standing fresh fix, so a rest with any is a rest it can trough.
  const exposed = pop.filter((r) => r.fixes.some((f) => !f.gone)).length;
  console.log(`  ${label.padEnd(26)} | ${String(pop.length).padStart(5)} | ${pct(exposed, pop.length).padStart(6)} | ${pct(pop.filter((r) => fires(r, 2)).length, pop.length).padStart(6)} | `
    + `${pct(pop.filter((r) => fires(r, 3)).length, pop.length).padStart(6)} | ${pct(pop.filter((r) => fires(r, 4)).length, pop.length).padStart(6)} | `
    + `${pct(pop.filter((r) => fires(r, 2, 20)).length, pop.length).padStart(14)} | ${pct(pop.filter((r) => fires(r, 3, 20)).length, pop.length).padStart(14)} | `
    + `${String(medOf(firstFF.map((x) => x.nth))).padStart(3)} / ${qOf(firstFF.map((x) => x.s), 0.5)?.toFixed(0)} s`
    + `  | master's own leftRest fires standing in ${pct(pop.filter((r) => r.fixes.some((f) => !f.gone && f.d > REST)).length, pop.length)}`);
}
for (const [n, sel] of ARMS) falseFires(rests.filter(sel), n);
falseFires(rests.filter((r) => r.standSec >= 60), "rests >= 60 s");
falseFires(rests.filter(isLayover), "layover rests");
falseFires(rests.filter((r) => r.standSec >= 150), "rests >= 150 s");

console.log(`\n=== 5. Distance from the rest point — could any RADIUS be faster than 125 m? ===`);
console.log(`  ${"population".padEnd(26)} | p50 | p75 | p90 | p95 | max`);
for (const [n, sel] of ARMS) {
  const dep1 = withDep.filter(sel).map((r) => r.fixes.find((f) => f.gone)?.d).filter((x) => x != null);
  const dep2 = withDep.filter(sel).map((r) => r.fixes.filter((f) => f.gone)[1]?.d).filter((x) => x != null);
  const shMax = rests.filter(sel).map((r) => Math.max(0, ...r.fixes.filter((f) => !f.gone).map((f) => f.d)));
  for (const [lbl, xs] of [[`${n} departure, 1st fix`, dep1], [`${n} departure, 2nd fix`, dep2], [`${n} shuffle, max over a rest`, shMax]]) {
    console.log(`  ${lbl.padEnd(26)} | ${qOf(xs, 0.5)?.toFixed(0).padStart(3)} | ${qOf(xs, 0.75)?.toFixed(0).padStart(3)} | ${qOf(xs, 0.9)?.toFixed(0).padStart(3)} | ${qOf(xs, 0.95)?.toFixed(0).padStart(3)} | ${Math.max(...xs).toFixed(0)}  (n=${xs.length})`);
  }
}
if (process.env.REST_OUT) {
  fs.writeFileSync(process.env.REST_OUT, rests.map((r) => JSON.stringify({ route: r.route, stop: r.stop, bus: r.bus, day: r.day, standSec: r.standSec, layover: isLayover(r),
    fixes: r.fixes.map((f, i) => ({ ...f, run0: r.run0[i], run20: r.run20[i] })) })).join("\n") + "\n");
  console.log(`\nwrote ${process.env.REST_OUT} (${rests.length} rests)`);
}
