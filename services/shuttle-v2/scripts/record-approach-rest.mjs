#!/usr/bin/env node
// Record one real bus taking its layover SHORT of the stop marker, and write
// it as the fixture `web/src/accuracy-approach-rest.test.ts` replays
// (`web/src/__fixtures__/red-approach-rest.json`).
//
// The sibling of `record-layover-pass.mjs`, and the same rider's-eye idea: a
// real bus, the positions the feed really published, the calibration really
// being served. The difference is which pass it goes looking for. That script
// wants a long dwell AT a stop; this one wants the failure the operator caught
// live on 2026-09-04 — a bus that comes to rest in the APPROACH ZONE of a
// layover stop, sits out most of the layover there, then rolls the last
// hundred-odd metres and barely pauses on the marker at all.
//
// Because the rest happens where `at_stop_id` is not published, the fixture
// also carries `stationary_since` per position: the detector's own stationary
// clock, replayed here exactly as `stationaryFields` computes it, so the test
// feeds the client precisely what `/api/buses` puts on the wire.
//
//   node scripts/record-approach-rest.mjs
//   ROUTE_ID=3 LAYOVER_STOP=11 MIN_REST_SEC=240 WINDOW_H=6 \
//   OUT=web/src/__fixtures__/red-approach-rest.json \
//     node scripts/record-approach-rest.mjs
//
// `raw_positions` is retention-swept to a few hours, so run it soon after a
// pass you want. Reads production READ-ONLY over `flyctl ssh`; writes only the
// fixture.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");

const ROUTE_ID = Number(process.env.ROUTE_ID ?? 3);
const LAYOVER_STOP = Number(process.env.LAYOVER_STOP ?? 11);
const MIN_REST_SEC = Number(process.env.MIN_REST_SEC ?? 240);
const WINDOW_H = Number(process.env.WINDOW_H ?? 6);
const BASE = process.env.BOT_BASE_URL ?? "https://yale-shuttle.fly.dev";
const FLYCTL = process.env.FLYCTL ?? `${process.env.HOME}/.fly/bin/flyctl`;
const OUT = process.env.OUT ?? path.join(APP, "web/src/__fixtures__/red-approach-rest.json");
const LEAD_MS = 6 * 60_000;
const TRAIL_MS = 8 * 60_000;

// Mirrors detector.ts. Kept as literals rather than imported because this
// script runs as plain node against a production snapshot.
const AT_STOP_PIN_M = 75;
const STATIONARY_RADIUS_M = 125;
// The zone the client prices in (hopPricing.ts APPROACH_ZONE_M); a rest
// farther out than this is not the case under test.
const ZONE_M = 200;

function onProd(js) {
  const wrapped =
    `const D=require("/app/node_modules/better-sqlite3");` +
    `const db=new D("/data/shuttle-v2.db",{readonly:true});` + js;
  const out = execFileSync(FLYCTL, ["ssh", "console", "-a", "yale-shuttle", "-C", "node -"], {
    input: wrapped, encoding: "utf8", maxBuffer: 128 * 1024 * 1024,
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

const since = Date.now() - WINDOW_H * 3600_000;

// 1. Every position on the route in the window, plus the stops, so the rest
//    can be found and the stationary clock replayed.
const { pos, stops } = onProd(
  `const pos=db.prepare("SELECT bus_id,bus_name,lat,lon,heading,last_stop_id,collected_at ` +
    `FROM raw_positions WHERE route_id=${ROUTE_ID} AND collected_at>=${since} ORDER BY collected_at").all();` +
    `const stops=db.prepare("SELECT id,name,lat,lon FROM stops").all();` +
    `console.log(JSON.stringify({pos,stops}));`,
);
const stopById = new Map(stops.map((s) => [s.id, s]));
const marker = stopById.get(LAYOVER_STOP);
if (!marker) throw new Error(`stop ${LAYOVER_STOP} not found`);

// 2. Replay the detector's stationary clock per track, and look for a rest
//    that is off-marker but inside the approach zone of the layover stop.
const seqIds = (await (await fetch(`${BASE}/api/buses`)).json()).routes[String(ROUTE_ID)];
if (!seqIds) throw new Error(`route ${ROUTE_ID} is not in the payload`);
const routeStopList = seqIds.map((id) => stopById.get(id)).filter(Boolean);

const byTrack = new Map();
for (const p of pos) {
  const k = `${p.bus_id}`;
  if (!byTrack.has(k)) byTrack.set(k, []);
  byTrack.get(k).push(p);
}

let best = null;
for (const rows of byTrack.values()) {
  rows.sort((a, b) => a.collected_at - b.collected_at);
  let st = null;
  // Mirrors collector.ts `updateLivePositions`: at_stop_id is published only
  // for the NEAREST stop, within AT_STOP_MAX_M, and only once the bus has been
  // there long enough not to be merely passing through.
  let nearestId = null, nearestSince = 0;
  for (const o of rows) {
    let near = null, nd = Infinity;
    for (const s of routeStopList) { const d = hav(o, s); if (d < nd) { nd = d; near = s; } }
    if (!near || near.id !== nearestId) { nearestId = near ? near.id : null; nearestSince = o.collected_at; }
    const anchorStop = near && nd <= AT_STOP_PIN_M ? near : null;
    if (anchorStop) {
      st = st && st.stopId === anchorStop.id
        ? st
        : { since: o.collected_at, lat: anchorStop.lat, lon: anchorStop.lon, stopId: anchorStop.id };
    } else if (st && hav(o, st) <= STATIONARY_RADIUS_M) {
      /* carried */
    } else {
      st = { since: o.collected_at, lat: o.lat, lon: o.lon, stopId: null };
    }
    o._since = st.since;
    // The PUBLISHED flag, not the pinned one: the pin survives out to
    // STATIONARY_RADIUS_M (125 m), the publication does not.
    o._stopId = anchorStop && o.collected_at - nearestSince >= 15_000 ? anchorStop.id : null;
    const restSec = (o.collected_at - st.since) / 1000;
    const dMarker = hav(o, marker);
    if (st.stopId === null && restSec >= MIN_REST_SEC && dMarker <= ZONE_M && dMarker > AT_STOP_PIN_M) {
      if (!best || restSec > best.restSec) {
        best = { busName: o.bus_name, busId: o.bus_id, restStart: st.since, restSec, dMarker, at: o.collected_at };
      }
    }
  }
}
if (!best) {
  console.error(
    `no off-marker rest of ${MIN_REST_SEC}s+ within ${ZONE_M} m of stop ${LAYOVER_STOP} ` +
      `on route ${ROUTE_ID} in the last ${WINDOW_H} h`,
  );
  process.exit(1);
}
console.error(
  `recording ${best.busName}: ${(best.restSec / 60).toFixed(1)} min at rest ` +
    `${best.dMarker.toFixed(0)} m short of ${marker.name}, from ${new Date(best.restStart).toISOString()}`,
);

const from = best.restStart - LEAD_MS;
const to = best.at + TRAIL_MS;
const track = byTrack.get(String(best.busId))
  .filter((p) => p.collected_at >= from && p.collected_at <= to);

// 3. The visits it made — the ground truth for "when did it really get there".
const { arr } = onProd(
  `const arr=db.prepare("SELECT stop_id,arrived_at,departed_at,stand_sec,outcome FROM stop_visits ` +
    `WHERE bus_name='${best.busName}' AND route_id=${ROUTE_ID} ` +
    `AND anchored_at BETWEEN ${from - 900000} AND ${to + 900000} ORDER BY anchored_at").all();` +
    `console.log(JSON.stringify({arr}));`,
);

// 4. The calibration as served.
const payload = await (await fetch(`${BASE}/api/buses`)).json();
const stopCoords = {}, stopNames = {};
for (const id of new Set(seqIds)) {
  stopCoords[id] = payload.stop_coords[id];
  stopNames[id] = payload.stop_names[id];
}

const fixture = {
  capturedAt: new Date(track[0].collected_at).toISOString(),
  note:
    `Red (route ${ROUTE_ID}) bus ${best.busName} taking its ${stopNames[LAYOVER_STOP]} layover ` +
    `${best.dMarker.toFixed(0)} m SHORT of the marker: ${(best.restSec / 60).toFixed(1)} min at rest ` +
    `between Canal / Munson and the stop, then the roll-in and the brief touch on the marker itself. ` +
    `The operator watched this live on 2026-09-04 — the card read "11 min" with the stop's chip at ` +
    `"~6 min", i.e. driving toward a layover it was already taking. positions carry the ` +
    `stationary_since the collector publishes. Segments and dwells are the payload as served.`,
  routeId: String(ROUTE_ID),
  routeLabel: process.env.ROUTE_LABEL ?? "Red",
  busName: best.busName,
  busRouteId: ROUTE_ID,
  layoverStopId: LAYOVER_STOP,
  // The rest itself, so the test can assert against it without re-deriving.
  approachRest: {
    startedAt: best.restStart,
    endedAt: best.at,
    metresShort: Math.round(best.dMarker),
  },
  stopNames,
  routeStops: { [String(ROUTE_ID)]: seqIds },
  stopCoords,
  segments: { [String(ROUTE_ID)]: payload.segments[String(ROUTE_ID)] },
  dwells: { [String(ROUTE_ID)]: payload.dwells[String(ROUTE_ID)] },
  positions: track.map((r) => ({
    t: r.collected_at,
    lat: r.lat,
    lon: r.lon,
    heading: r.heading,
    last_stop_id: r.last_stop_id,
    // What /api/buses publishes: at_stop_* only inside AT_STOP_PIN_M,
    // stationary_since always.
    stationary_since: r._since,
    at_stop_id: r._stopId,
  })),
  visits: arr.map((a) => ({
    stopId: a.stop_id,
    arrivedAt: a.arrived_at,
    departedAt: a.departed_at,
    standSec: a.stand_sec,
    outcome: a.outcome,
  })),
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(fixture, null, 1));
console.error(
  `wrote ${OUT}: ${fixture.positions.length} positions, ${fixture.visits.length} visits, ` +
    `${(fs.statSync(OUT).size / 1024).toFixed(0)} KB`,
);
