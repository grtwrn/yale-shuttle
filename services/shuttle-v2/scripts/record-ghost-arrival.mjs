#!/usr/bin/env node
// Record one real bus DRIVING PAST a board stop, and write it as the fixture
// `web/src/accuracy-ghost-arrival.test.ts` replays
// (`web/src/__fixtures__/red-ghost-arrival.json`).
//
// The fourth recorder, and the mirror image of `record-closing-bus.mjs`: that
// one asks which bus the row follows while somebody walks TOWARD the stop,
// this one asks what the row says about a bus that has already GONE.
//
// The canary's 2026-09-08 finding: Red, the operator's canonical trip
// Prospect / Canner -> the School of Public Health, board stop Division /
// Prospect (#48). At 10:35:20 ET a fresh page read "now, then 67 min" — and
// #307 had passed the stop fifteen seconds earlier and was 129 m south of it,
// accelerating away. The detector had it right in the same breath
// (`stop_visits`: outcome=passed, stand_sec=0); what the client read was
// `at_stop_since` / `stationary_since`, which start when a bus ENTERS the
// stop's zone whether or not it ever stands.
//
//   node scripts/record-ghost-arrival.mjs
//   ROUTE_ID=3 BOARD_STOP=48 BUS='#307' PASS_AT=2026-09-08T14:35:05Z \
//   OUT=web/src/__fixtures__/red-ghost-arrival.json \
//     node scripts/record-ghost-arrival.mjs
//
// `raw_positions` is retention-swept to a few hours, so run it soon after the
// pass you want — or point POSITIONS at a JSONL capture of the same rows
// (~/shuttle-captures/positions-YYYYMMDD.jsonl, or a dump taken in time), and
// VISITS at a JSON dump of `stop_visits`, and it reads no production at all.
// Reads production READ-ONLY over `flyctl ssh`; writes only the fixture.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");

const ROUTE_ID = Number(process.env.ROUTE_ID ?? 3);
const BOARD_STOP = Number(process.env.BOARD_STOP ?? 48);
const ONLY_BUS = process.env.BUS ?? null;
// The instant the bus drew level with the board stop. Without it the recorder
// picks the most recent pass-through (a visit the detector scored `passed`).
const PASS_AT = process.env.PASS_AT ? Date.parse(process.env.PASS_AT) : null;
/**
 * Which kind of ghost to record. `passed` is a bus that drove straight through
 * and never stood (the 2026-09-08 Red incident). `stopped` is the other half of
 * the same error and the one riders write in about: the bus DID stand, and has
 * pulled away — the served clock is pinned to the stop until the bus is 125 m
 * off, so a cold page load still reads it as standing there.
 */
const OUTCOME = process.env.OUTCOME ?? "passed";
const WINDOW_H = Number(process.env.WINDOW_H ?? 6);
const BASE = process.env.BOT_BASE_URL ?? "https://yale-shuttle.fly.dev";
const FLYCTL = process.env.FLYCTL ?? `${process.env.HOME}/.fly/bin/flyctl`;
const OUT = process.env.OUT ?? path.join(APP, "web/src/__fixtures__/red-ghost-arrival.json");
const LEAD_MS = 3 * 60_000;
/**
 * The window runs past the pass to the next arrival at the board stop by a
 * DIFFERENT bus — the one the rider was actually waiting for. Without it the
 * fixture can only show the wrong answer, and a test cannot check that the
 * right one is still given.
 */
const TRAIL_PAD_MS = 90_000;

// Mirrors collector.ts / detector.ts. Literals rather than imports because
// this script runs as plain node against production.
const AT_STOP_MAX_M = 75;
const AT_STOP_MIN_DWELL_MS = 15_000;
const STATIONARY_RADIUS_M = 125;
const MOVED_M = 8; // detector.ts

function onProd(js) {
  const wrapped =
    `const D=require("/app/node_modules/better-sqlite3");` +
    `const db=new D("/data/shuttle-v2.db",{readonly:true});` + js;
  const out = execFileSync(FLYCTL, ["ssh", "console", "-a", "yale-shuttle", "-C", "node -"], {
    input: wrapped, encoding: "utf8", maxBuffer: 256 * 1024 * 1024,
  });
  const line = out.split("\n").find((l) => l.trim().startsWith("{") || l.trim().startsWith("["));
  if (!line) throw new Error(`no JSON from production:\n${out.slice(0, 400)}`);
  return JSON.parse(line);
}

const R = 6371000, toRad = Math.PI / 180;
function hav(a, b) {
  const dLat = (b.lat - a.lat) * toRad, dLon = (b.lon - a.lon) * toRad;
  const x = Math.sin(dLat / 2) ** 2
    + Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

const since = PASS_AT ? PASS_AT - WINDOW_H * 3600_000 : Date.now() - WINDOW_H * 3600_000;
const until = PASS_AT ? PASS_AT + 3600_000 : Date.now();

const payload = await (await fetch(`${BASE}/api/buses`)).json();

let pos, stops;
if (process.env.POSITIONS) {
  pos = [];
  for (const line of fs.readFileSync(process.env.POSITIONS, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (Number(r.route_id) !== ROUTE_ID) continue;
    if (r.collected_at < since || r.collected_at > until) continue;
    pos.push(r);
  }
  pos.sort((a, b) => a.collected_at - b.collected_at);
  // The payload carries every stop's coordinate and name, so a run from an
  // archived day (`~/shuttle-archive/<day>/`) touches no production at all.
  stops = Object.entries(payload.stop_coords).map(([id, c]) => (
    { id: Number(id), name: payload.stop_names[id] ?? String(id), lat: c.lat, lon: c.lon }));
} else {
  ({ pos, stops } = onProd(
    `const pos=db.prepare("SELECT bus_id,bus_name,lat,lon,heading,last_stop_id,collected_at ` +
      `FROM raw_positions WHERE route_id=${ROUTE_ID} AND collected_at>=${since} AND collected_at<=${until} ` +
      `ORDER BY collected_at").all();` +
      `const stops=db.prepare("SELECT id,name,lat,lon FROM stops").all();` +
      `console.log(JSON.stringify({pos,stops}));`,
  ));
}
const stopById = new Map(stops.map((s) => [s.id, s]));
const board = stopById.get(BOARD_STOP);
if (!board) throw new Error(`stop ${BOARD_STOP} not found`);

const seqIds = payload.routes[String(ROUTE_ID)];
if (!seqIds) throw new Error(`route ${ROUTE_ID} is not in the payload`);
const routeStopList = seqIds.map((id) => stopById.get(id)).filter(Boolean);

// `stop_visits` is the detector's own verdict — `outcome` and `stand_sec` say
// whether the bus STOOD or merely passed, and `pinned_at` is exactly the
// `at_stop_since` the payload publishes. It is the ground truth the fixture
// is anchored on, and the reason this incident is provable rather than argued.
const visits = process.env.VISITS
  // A dumped table carries every route; the production query filters by route
  // and so must this, or a stop several lines share (Phelps Gate) hands the
  // fixture "the next bus" from a line the rider is not waiting for.
  ? JSON.parse(fs.readFileSync(process.env.VISITS, "utf8"))
    .filter((v) => Number(v.route_id) === ROUTE_ID
      && v.anchored_at >= since && v.anchored_at <= until)
  : onProd(
    `console.log(JSON.stringify(db.prepare("SELECT bus_name,stop_id,anchored_at,pinned_at,arrived_at,` +
      `departed_at,outcome,stand_sec,closest_m FROM stop_visits WHERE route_id=${ROUTE_ID} ` +
      `AND anchored_at>=${since} AND anchored_at<=${until} ORDER BY anchored_at").all()));`,
  );

// The pass-through being recorded: the detector scored it `passed` at the
// board stop, so the bus never stood there — and yet it has a `pinned_at`.
let pass = null;
for (const v of visits) {
  if (v.stop_id !== BOARD_STOP) continue;
  if (ONLY_BUS && v.bus_name !== ONLY_BUS) continue;
  if (v.outcome !== OUTCOME) continue;
  if (v.pinned_at === null) continue;
  if (PASS_AT !== null && Math.abs((v.departed_at ?? v.arrived_at) - PASS_AT) > 120_000) continue;
  if (!pass || v.arrived_at > pass.arrived_at) pass = v;
}
if (!pass) {
  console.error(`no scored-'passed' visit with an at_stop_since at stop ${BOARD_STOP} on route ${ROUTE_ID}`
    + `${ONLY_BUS ? ` for ${ONLY_BUS}` : ""}${PASS_AT ? ` near ${new Date(PASS_AT).toISOString()}` : ""}`);
  process.exit(1);
}
console.error(
  `recording ${pass.bus_name} ${OUTCOME === "passed" ? "PASSING" : "LEAVING"} ${board.name} at `
  + `${new Date(pass.departed_at ?? pass.arrived_at).toISOString()} `
  + `(stand_sec=${pass.stand_sec}, closest ${Number(pass.closest_m).toFixed(1)} m, `
  + `at_stop_since ${new Date(pass.pinned_at).toISOString()})`,
);

const byTrack = new Map();
for (const p of pos) {
  if (!byTrack.has(p.bus_name)) byTrack.set(p.bus_name, []);
  byTrack.get(p.bus_name).push(p);
}
for (const rows of byTrack.values()) rows.sort((a, b) => a.collected_at - b.collected_at);

/**
 * What `/api/buses` published for this bus, poll by poll: `stationary_since`
 * from the detector's `stationaryFields`, and `at_stop_id` / `at_stop_since`
 * from the collector's publication gate. Both are transcribed from the source
 * (detector.ts `stationaryFields`, collector.ts around `atStopCandidate`)
 * rather than inferred from `arrivals` / `stop_visits`.
 *
 * Reading the at-stop flags off the visit rows instead — which is what an
 * earlier draft of this recorder did — gets THIS incident exactly backwards.
 * The detector scored #307's pass `outcome=passed`, so a visit-derived
 * reconstruction publishes no `at_stop_id`; the collector, whose gate is
 * "this stop has been the nearest one for 15 s and the bus is within 75 m",
 * published `at_stop_id=48` for the whole drive-through. The fixture has to
 * carry what the CLIENT was given, not what the detector concluded.
 */
function publishedTrack(rows) {
  const out = new Map();
  let st = null, nearestId = null, enteredAt = null, lastMovedAt = null, prevFix = null;
  for (const o of rows) {
    // detector.ts: when the reported fix last changed.
    if (prevFix === null || hav(prevFix, o) > MOVED_M) lastMovedAt = o.collected_at;
    prevFix = o;
    let near = null, nd = Infinity;
    for (const s of routeStopList) { const d = hav(o, s); if (d < nd) { nd = d; near = s; } }
    // `enteredAt` restarts whenever a different stop becomes nearest.
    if (near && near.id !== nearestId) { nearestId = near.id; enteredAt = o.collected_at; }
    // detector.ts `stationaryFields`: pinned to the stop inside AT_STOP_PIN_M,
    // else carried while within STATIONARY_RADIUS_M of the anchor, else reset.
    const anchorStop = near && nd <= AT_STOP_MAX_M ? near : null;
    if (anchorStop) {
      st = st && st.stopId === anchorStop.id
        ? st
        : { since: o.collected_at, lat: anchorStop.lat, lon: anchorStop.lon, stopId: anchorStop.id };
    } else if (st && hav(o, st) <= STATIONARY_RADIUS_M) {
      /* carried */
    } else {
      st = { since: o.collected_at, lat: o.lat, lon: o.lon, stopId: null };
    }
    // collector.ts: at_stop_id is published once the nearest stop has been
    // nearest for MIN_DWELL and the bus is inside AT_STOP_MAX_M of it; the
    // clock it publishes is `stationarySince`, the same one as above.
    const atStop = near !== null && enteredAt !== null
      && o.collected_at - enteredAt >= AT_STOP_MIN_DWELL_MS && nd <= AT_STOP_MAX_M;
    out.set(o.collected_at, {
      stationarySince: st.since,
      atStopId: atStop ? near.id : null,
      atStopSince: atStop ? st.since : null,
      lastMovedAt,
    });
  }
  return out;
}

const nextOther = visits
  .filter((v) => v.stop_id === BOARD_STOP && v.arrived_at !== null
    && v.arrived_at > pass.arrived_at && v.bus_name !== pass.bus_name)
  .sort((a, b) => a.arrived_at - b.arrived_at)[0] ?? null;
const REF = pass.departed_at ?? pass.arrived_at;
const from = REF - LEAD_MS;
const to = (nextOther ? nextOther.departed_at ?? nextOther.arrived_at : REF) + TRAIL_PAD_MS;
if (nextOther) {
  console.error(
    `...and on to ${nextOther.bus_name}, which really reached ${board.name} at `
    + `${new Date(nextOther.arrived_at).toISOString()} `
    + `(${((nextOther.arrived_at - pass.arrived_at) / 60_000).toFixed(1)} min later)`,
  );
}

// EVERY bus on the line: what the row should have said instead of "now" is the
// next vehicle actually on its way, and that is a comparison.
const buses = {};
for (const [busName, rows] of byTrack) {
  const pub = publishedTrack(rows);
  const track = rows.filter((r) => r.collected_at >= from && r.collected_at <= to);
  if (track.length === 0) continue;
  buses[busName] = track.map((r) => {
    const v = pub.get(r.collected_at);
    return {
      t: r.collected_at,
      lat: r.lat,
      lon: r.lon,
      heading: r.heading,
      last_stop_id: r.last_stop_id,
      at_stop_id: v.atStopId,
      at_stop_since: v.atStopSince === null ? null : new Date(v.atStopSince).toISOString().replace(/Z$/, ""),
      stationary_since: new Date(v.stationarySince).toISOString().replace(/Z$/, ""),
      last_moved_at: new Date(v.lastMovedAt).toISOString().replace(/Z$/, ""),
      // The poll this fix was reported on. With `last_moved_at` beside it the
      // pair says how many POLLS ago the bus moved, on the server's own clock
      // — which is what separates the bus that has just pulled in (one repeat)
      // from the one still driving through (a fresh fix).
      seen_at: new Date(r.collected_at).toISOString().replace(/Z$/, ""),
    };
  });
}

// When each bus really did reach the board stop next, from `stop_visits`:
// the honest answer the row owed the rider.
const nextArrivals = visits
  .filter((v) => v.stop_id === BOARD_STOP && v.arrived_at !== null && v.arrived_at >= pass.arrived_at)
  .sort((a, b) => a.arrived_at - b.arrived_at)
  .map((v) => ({ busName: v.bus_name, arrivedAt: v.arrived_at, outcome: v.outcome, standSec: v.stand_sec }));

const stopCoords = {}, stopNames = {};
for (const id of new Set(seqIds)) {
  if (payload.stop_coords[id]) stopCoords[id] = payload.stop_coords[id];
  if (payload.stop_names[id]) stopNames[id] = payload.stop_names[id];
}

const fixture = {
  capturedAt: new Date(from).toISOString(),
  note:
    `Route ${ROUTE_ID} bus ${pass.bus_name} ${OUTCOME === "passed" ? "DRIVING PAST" : "LEAVING"} `
    + `${board.name} (stop ${BOARD_STOP}) at `
    + `${new Date(pass.arrived_at).toISOString()}, with every other bus on the line over the same `
    + `window. The detector scored this visit outcome=${pass.outcome}, stand_sec=${pass.stand_sec}: `
    + `the bus never stood. It was nonetheless pinned at `
    + `${new Date(pass.pinned_at).toISOString()}, which is the at_stop_since /api/buses publishes, `
    + `so a client reading that clock as "standing since" believes it is at the kerb. Positions `
    + `carry at_stop_id / at_stop_since / stationary_since exactly as /api/buses publishes them. `
    + `Segments and dwells are the payload as served. Generated by `
    + `scripts/record-ghost-arrival.mjs; do not hand-edit.`,
  routeId: String(ROUTE_ID),
  routeLabel: process.env.ROUTE_LABEL ?? "Red",
  busRouteId: ROUTE_ID,
  passingBus: pass.bus_name,
  boardStopId: BOARD_STOP,
  /** The detector's verdict on the pass: this is why "now" is provably wrong. */
  pass: {
    anchoredAt: pass.anchored_at,
    pinnedAt: pass.pinned_at,
    arrivedAt: pass.arrived_at,
    departedAt: pass.departed_at,
    outcome: pass.outcome,
    standSec: pass.stand_sec,
    closestM: pass.closest_m,
  },
  /** Who really reached the board stop next, and when. */
  nextArrivals,
  stopNames,
  routeStops: { [String(ROUTE_ID)]: seqIds },
  stopCoords,
  routePath: { [String(ROUTE_ID)]: payload.route_paths[String(ROUTE_ID)] },
  segments: { [String(ROUTE_ID)]: payload.segments[String(ROUTE_ID)] },
  dwells: { [String(ROUTE_ID)]: payload.dwells[String(ROUTE_ID)] },
  buses,
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(fixture, null, 1) + "\n");
console.error(
  `wrote ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB, `
  + `${Object.keys(buses).length} buses, ${Object.values(buses).reduce((n, b) => n + b.length, 0)} positions)`,
);
