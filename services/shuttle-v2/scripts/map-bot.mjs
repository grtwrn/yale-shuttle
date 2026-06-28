#!/usr/bin/env node
// map-bot.mjs — acts like a rider: picks a random origin + destination inside
// the Yale shuttle service area, asks the live planner for a trip, sanity-checks
// the result, and (if a shuttle is involved) identifies the exact bus a visual
// bot should watch approach the board stop.
//
// This is the DETERMINISTIC, headless-friendly half of the end-to-end map test.
// It runs anywhere (no browser needed). The visual half — driving the real UI,
// screenshotting the Leaflet map, and judging whether it "looks good" — is done
// by the scheduled cloud agent that calls this script for its trip + ground truth.
//
// Output: a human-readable summary on stderr, and a single machine-readable JSON
// line on stdout between the markers <BOT_RESULT> ... </BOT_RESULT> so the agent
// can parse it without scraping logs.
//
// Env:
//   BOT_BASE_URL       override target (default https://yale-shuttle.fly.dev)
//   BOT_SEED           optional integer; makes the random trip reproducible
//   BOT_PREFER_SHUTTLE if "1", re-roll the random trip (up to ~20 tries) until
//                      one yields a shuttle plan with a live bus to watch, so the
//                      bus-approach feature gets exercised every run. Falls back
//                      to the last trip if none qualifies (still a valid test).
//
// Exit codes: 0 = planner produced a sane result (shuttle trip OR a legit
// walk-only / not-running-now answer). 1 = the planner output is malformed
// (the thing a map bug would actually look like).

const BASE = (process.env.BOT_BASE_URL || "https://yale-shuttle.fly.dev").replace(/\/$/, "");
const MIN_SEP_M = 700;     // far enough apart that a shuttle could plausibly help
const MAX_SEP_M = 6000;    // not so far that it's cross-county nonsense
const JITTER_M = 90;       // nudge off the exact stop so it reads like a real user

// --- tiny deterministic RNG so BOT_SEED reproduces a trip -------------------
function makeRng(seed) {
  // mulberry32
  let a = (seed >>> 0) || ((Date.now() >>> 0) ^ 0x9e3779b9);
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function haversineM(a, b) {
  const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const la1 = toRad(a.lat), la2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function jitter(p, meters, rng) {
  // meters -> rough degrees, random bearing
  const dLat = (meters / 111111) * (rng() * 2 - 1);
  const dLon = (meters / (111111 * Math.cos((p.lat * Math.PI) / 180))) * (rng() * 2 - 1);
  return { lat: +(p.lat + dLat).toFixed(6), lon: +(p.lon + dLon).toFixed(6) };
}

async function getJson(url, init) {
  const r = await fetch(url, init);
  if (!r.ok) throw new Error(`${init?.method || "GET"} ${url} -> ${r.status}`);
  return r.json();
}

function fmtMin(sec) { return `${Math.round(sec / 60)} min`; }

// One end-to-end attempt: pick a random trip, plan it, analyze the result.
// Returns the result object, or null if no trip could be picked. Pulls nothing
// from the network except the shared `buses` snapshot + a per-attempt /api/plan.
async function attempt(rng, ctx) {
  const { coords, names, stopIds, buses, seed } = ctx;

  // 2. Pick two random stops a sensible distance apart, then jitter off them
  //    so origin/destination read like a real rider standing near a stop.
  let from, to, fromStop, toStop, sep = 0;
  for (let tries = 0; tries < 200; tries++) {
    const a = stopIds[Math.floor(rng() * stopIds.length)];
    const b = stopIds[Math.floor(rng() * stopIds.length)];
    if (a === b) continue;
    const pa = coords[a], pb = coords[b];
    const d = haversineM(pa, pb);
    if (d < MIN_SEP_M || d > MAX_SEP_M) continue;
    fromStop = { id: a, name: names[a] || `stop ${a}` };
    toStop = { id: b, name: names[b] || `stop ${b}` };
    from = jitter(pa, JITTER_M, rng);
    to = jitter(pb, JITTER_M, rng);
    sep = d;
    break;
  }
  if (!from) return null;

  // 3. Ask the live planner — this is the ground truth the visual UI must match.
  const plan = await getJson(`${BASE}/api/plan`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ from, to, departAt: null }),
  });

  // 4. Sanity-check the planner output the way a map bug would manifest.
  const problems = [];
  if (!plan || !Array.isArray(plan.plans)) problems.push("response missing plans[]");
  const plans = plan.plans || [];
  for (const [i, p] of plans.entries()) {
    if (typeof p.totalSec !== "number" || p.totalSec < 0) problems.push(`plan ${i}: bad totalSec`);
    if (!Array.isArray(p.legs) || p.legs.length === 0) problems.push(`plan ${i}: no legs`);
    for (const [j, leg] of (p.legs || []).entries()) {
      if (leg.mode === "walk" && (leg.seconds < 0 || leg.meters < 0)) problems.push(`plan ${i} leg ${j}: bad walk`);
      if (leg.mode === "ride") {
        if (leg.rideSec < 0 || leg.waitSec < 0) problems.push(`plan ${i} leg ${j}: bad ride times`);
        if (!coords[leg.boardStopId]) problems.push(`plan ${i} leg ${j}: board stop ${leg.boardStopId} not on map`);
        if (!coords[leg.alightStopId]) problems.push(`plan ${i} leg ${j}: alight stop ${leg.alightStopId} not on map`);
      }
    }
  }

  // 5. Pick the recommended plan and find the specific bus to watch approach.
  const recommended = plans.find((p) => p.badge === "fastest") || plans[0] || null;
  let watch = null;
  if (recommended) {
    const rideLeg = recommended.legs.find((l) => l.mode === "ride" && l.busName);
    if (rideLeg) {
      const bus = (buses.buses || []).find((b) => b.bus_name === rideLeg.busName);
      const boardCoord = coords[rideLeg.boardStopId];
      watch = {
        busName: rideLeg.busName,
        boardStopId: rideLeg.boardStopId,
        boardStopName: names[rideLeg.boardStopId] || null,
        boardCoord,
        busSeenLive: !!bus,
        busPos: bus ? { lat: bus.lat, lon: bus.lon, route_id: bus.route_id } : null,
        busDistToBoardM: bus && boardCoord ? Math.round(haversineM(bus, boardCoord)) : null,
        waitSec: rideLeg.waitSec,
        rideSec: rideLeg.rideSec,
      };
    }
  }

  const status = problems.length ? "MALFORMED"
    : !recommended ? "NO_PLAN"
    : recommended.badge === "walk-only" || !recommended.legs.some((l) => l.mode === "ride") ? "WALK_ONLY"
    : "SHUTTLE";

  const result = {
    base: BASE, seed, status, problems,
    trip: {
      from, to, separationM: Math.round(sep),
      fromNear: fromStop.name, toNear: toStop.name,
    },
    // Search strings the visual bot types into the from/to boxes. The app's
    // geocoder accepts a raw "lat,lon" and reverse-geocodes it to a real
    // address there — far more reliable than typing a stop label (which can
    // return zero hits). This keeps the UI's pick within ~20 m of the coords
    // /api/plan used, so the on-screen plan should match the ground truth.
    uiSearch: { from: `${from.lat},${from.lon}`, to: `${to.lat},${to.lon}` },
    recommended: recommended && {
      badge: recommended.badge,
      totalSec: recommended.totalSec,
      legs: recommended.legs.map((l) =>
        l.mode === "walk"
          ? { mode: "walk", meters: Math.round(l.meters), min: Math.round(l.seconds / 60) }
          : { mode: "ride", bus: l.busName, board: names[l.boardStopId], alight: names[l.alightStopId], waitMin: Math.round(l.waitSec / 60), rideMin: Math.round(l.rideSec / 60) }),
    },
    nPlans: plans.length,
    potentialRoutes: (plan.potentialRoutes || []).length,
    watch,
  };
  return result;
}

async function main() {
  const seed = process.env.BOT_SEED ? parseInt(process.env.BOT_SEED, 10) : 0;
  const preferShuttle = process.env.BOT_PREFER_SHUTTLE === "1";
  const rng = makeRng(seed);

  // 1. Pull the live network once so we pick points the service actually covers.
  const buses = await getJson(`${BASE}/api/buses`);
  const coords = buses.stop_coords || {};
  const names = buses.stop_names || {};
  const stopIds = Object.keys(coords).filter(
    (id) => coords[id] && typeof coords[id].lat === "number" && typeof coords[id].lon === "number",
  );
  if (stopIds.length < 2) throw new Error("no usable stops in /api/buses");
  const ctx = { coords, names, stopIds, buses, seed };

  // Re-roll (sharing one advancing rng so each try differs) and keep the BEST
  // trip by preference rank. The ideal trip has the bus genuinely en route to
  // the board stop (wait in [WAIT_MIN, WAIT_MAX]): then the watch shows the bus
  // approaching (distance shrinks), and the ground-truth plan still matches what
  // the UI computes a few seconds later. A wait≈0 bus is already leaving the
  // stop — by the time the browser plans, walking often wins, which would look
  // like a mismatch but isn't a bug. Walk-only is still a valid fallback.
  const WAIT_MIN = 180, WAIT_MAX = 1200;
  const rank = (a) => {
    if (!a) return 0;
    const w = a.watch;
    if (a.status === "SHUTTLE" && w && w.busSeenLive) {
      return (w.waitSec >= WAIT_MIN && w.waitSec <= WAIT_MAX) ? 3 : 2;
    }
    return 1; // any sane result (walk-only / not-running-now)
  };
  const maxTries = preferShuttle ? 25 : 1;
  let result = null, best = 0;
  for (let i = 0; i < maxTries; i++) {
    const a = await attempt(rng, ctx);
    const r = rank(a);
    if (r > best) { best = r; result = a; }
    if (best >= 3) break;
  }
  if (!result) throw new Error("could not pick any trip within separation bounds");
  const { status, problems, trip, recommended, watch } = result;
  const from = trip.from, to = trip.to;

  // Human summary -> stderr.
  const log = (...a) => process.stderr.write(a.join(" ") + "\n");
  log(`\n🤖 map-bot  [${status}]  seed=${seed}  ${BASE}`);
  log(`   from  ${from.lat},${from.lon}  (near “${trip.fromNear}”)`);
  log(`   to    ${to.lat},${to.lon}  (near “${trip.toNear}”)   ${trip.separationM} m apart`);
  if (recommended) {
    log(`   plan  ${recommended.badge || "—"}  total ${fmtMin(recommended.totalSec)}  (${result.nPlans} option${result.nPlans === 1 ? "" : "s"})`);
    for (const l of result.recommended.legs) {
      log(l.mode === "walk" ? `     🚶 walk ${l.meters} m (${l.min} min)`
        : `     🚌 ride ${l.bus} : ${l.board} → ${l.alight}  (wait ${l.waitMin} / ride ${l.rideMin} min)`);
    }
  } else {
    log(`   plan  none; ${result.potentialRoutes} route(s) connect but aren't running now`);
  }
  if (watch) {
    log(`   watch bus “${watch.busName}” approach “${watch.boardStopName}”`);
    log(watch.busSeenLive
      ? `         live now ${watch.busDistToBoardM} m from board stop (route ${watch.busPos.route_id})`
      : `         ⚠️ planner named a bus not currently in /api/buses`);
  }
  if (problems.length) log(`   ❌ problems:\n     - ${problems.join("\n     - ")}`);
  log("");

  // Machine-readable -> stdout.
  process.stdout.write(`<BOT_RESULT>${JSON.stringify(result)}</BOT_RESULT>\n`);
  process.exit(status === "MALFORMED" ? 1 : 0);
}

main().catch((e) => {
  process.stderr.write(`map-bot fatal: ${e.stack || e}\n`);
  process.stdout.write(`<BOT_RESULT>${JSON.stringify({ status: "ERROR", error: String(e) })}</BOT_RESULT>\n`);
  process.exit(2);
});
