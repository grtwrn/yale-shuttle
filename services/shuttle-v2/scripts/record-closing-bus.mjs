#!/usr/bin/env node
// Record one real bus CLOSING on a board stop, and write it as the fixture
// `web/src/accuracy-closing-bus.test.ts` replays
// (`web/src/__fixtures__/red-closing-bus.json`).
//
// The third of the recorders, and the one that carries a RIDER: the other two
// (`record-layover-pass.mjs`, `record-approach-rest.mjs`) ask what the board
// said about a bus, and both are scored from the stop itself. This one asks
// which bus the row FOLLOWS while somebody walks toward the stop, because that
// is where the canary's 2026-09-04 finding lives — a rider a short walk away
// watched the bus that was 97 m out and closing leave the card, replaced by
// one 26 minutes away, seven seconds before it pulled in.
//
// So the fixture carries the rider's own origin as well as the bus: the
// approach positions, the at-stop flags exactly as `/api/buses` publishes
// them, the visit that ends the approach, and the calibration as served.
//
//   node scripts/record-closing-bus.mjs
//   ROUTE_ID=3 BOARD_STOP=48 BUS='#304' WINDOW_H=6 ORIGIN_STOP=100 \
//   OUT=web/src/__fixtures__/red-closing-bus.json \
//     node scripts/record-closing-bus.mjs
//
// `raw_positions` is retention-swept to a few hours, so run it soon after the
// pass you want. Reads production READ-ONLY over `flyctl ssh`; writes only the
// fixture.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");

const ROUTE_ID = Number(process.env.ROUTE_ID ?? 3);
const BOARD_STOP = Number(process.env.BOARD_STOP ?? 48);
// Where the rider is standing. A stop id is the convenient spelling of "a
// real place a short walk from the board stop"; ORIGIN_LAT/ORIGIN_LON override.
const ORIGIN_STOP = Number(process.env.ORIGIN_STOP ?? 100);
const ONLY_BUS = process.env.BUS ?? null;
const WINDOW_H = Number(process.env.WINDOW_H ?? 6);
const BASE = process.env.BOT_BASE_URL ?? "https://yale-shuttle.fly.dev";
const FLYCTL = process.env.FLYCTL ?? `${process.env.HOME}/.fly/bin/flyctl`;
const OUT = process.env.OUT ?? path.join(APP, "web/src/__fixtures__/red-closing-bus.json");
const LEAD_MS = 4 * 60_000;
const TRAIL_MS = 3 * 60_000;

// Mirrors collector.ts / detector.ts. Literals rather than imports because
// this script runs as plain node against production.
const AT_STOP_MAX_M = 75;
const AT_STOP_MIN_DWELL_MS = 15_000;
const STATIONARY_RADIUS_M = 125;
/** How far out the approach has to start for this to be an approach at all. */
const APPROACH_FROM_M = Number(process.env.APPROACH_FROM_M ?? 250);

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
const { pos, stops } = onProd(
  `const pos=db.prepare("SELECT bus_id,bus_name,lat,lon,heading,last_stop_id,collected_at ` +
    `FROM raw_positions WHERE route_id=${ROUTE_ID} AND collected_at>=${since} ORDER BY collected_at").all();` +
    `const stops=db.prepare("SELECT id,name,lat,lon FROM stops").all();` +
    `console.log(JSON.stringify({pos,stops}));`,
);
const stopById = new Map(stops.map((s) => [s.id, s]));
const board = stopById.get(BOARD_STOP);
if (!board) throw new Error(`stop ${BOARD_STOP} not found`);

const payload = await (await fetch(`${BASE}/api/buses`)).json();
const seqIds = payload.routes[String(ROUTE_ID)];
if (!seqIds) throw new Error(`route ${ROUTE_ID} is not in the payload`);
const routeStopList = seqIds.map((id) => stopById.get(id)).filter(Boolean);

// The arrivals are the ground truth for "when did it really get there", and
// also supply the at_stop_since the payload publishes.
const { arr } = onProd(
  `const arr=db.prepare("SELECT bus_name,stop_id,arrived_at,departed_at FROM arrivals ` +
    `WHERE route_id=${ROUTE_ID} AND arrived_at>=${since - 900000} ORDER BY arrived_at").all();` +
    `console.log(JSON.stringify({arr}));`,
);

const byTrack = new Map();
for (const p of pos) {
  const k = `${p.bus_name}`;
  if (!byTrack.has(k)) byTrack.set(k, []);
  byTrack.get(k).push(p);
}
for (const rows of byTrack.values()) rows.sort((a, b) => a.collected_at - b.collected_at);

/** The published `at_stop_id` / `at_stop_since` for this bus at this instant. */
function publishedAtStop(busName, row) {
  let best = null;
  for (const v of arr) {
    if (v.bus_name !== busName) continue;
    if (v.arrived_at > row.collected_at) break;
    if (v.departed_at !== null && v.departed_at <= row.collected_at) continue;
    best = v;
  }
  if (!best) return null;
  const sc = stopById.get(best.stop_id);
  if (!sc) return null;
  if (row.collected_at - best.arrived_at < AT_STOP_MIN_DWELL_MS) return null;
  if (hav(row, sc) > AT_STOP_MAX_M) return null;
  return best;
}

// Find the approach: a bus that comes from APPROACH_FROM_M+ to the board stop
// and is then recorded arriving there.
let best = null;
for (const [busName, rows] of byTrack) {
  if (ONLY_BUS && busName !== ONLY_BUS) continue;
  const visits = arr.filter((v) => v.bus_name === busName && v.stop_id === BOARD_STOP);
  for (const v of visits) {
    const approach = rows.filter((r) => r.collected_at <= v.arrived_at
      && r.collected_at >= v.arrived_at - 6 * 60_000);
    if (approach.length === 0) continue;
    const farthest = Math.max(...approach.map((r) => hav(r, board)));
    if (farthest < APPROACH_FROM_M) continue;
    if (!best || v.arrived_at > best.arrivedAt) {
      best = { busName, arrivedAt: v.arrived_at, departedAt: v.departed_at, farthest };
    }
  }
}
if (!best) {
  console.error(
    `no approach from ${APPROACH_FROM_M} m+ into stop ${BOARD_STOP} on route ${ROUTE_ID} ` +
      `in the last ${WINDOW_H} h${ONLY_BUS ? ` for ${ONLY_BUS}` : ""}`,
  );
  process.exit(1);
}
console.error(
  `recording ${best.busName} closing on ${board.name} from ${best.farthest.toFixed(0)} m, ` +
    `arriving ${new Date(best.arrivedAt).toISOString()}`,
);

const from = best.arrivedAt - LEAD_MS;
const to = best.arrivedAt + TRAIL_MS;

/** stationary_since, as `stationaryFields` computes it. */
function stationaryTrack(rows) {
  const out = new Map();
  let st = null;
  let nearestId = null;
  for (const o of rows) {
    let near = null, nd = Infinity;
    for (const s of routeStopList) { const d = hav(o, s); if (d < nd) { nd = d; near = s; } }
    if (!near || near.id !== nearestId) nearestId = near ? near.id : null;
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
    out.set(o.collected_at, st.since);
  }
  return out;
}

// EVERY bus on the line, not just the one closing: the whole point of the
// finding is which vehicle the row follows, and that is a comparison.
const buses = {};
for (const [busName, rows] of byTrack) {
  const stat = stationaryTrack(rows);
  const track = rows.filter((r) => r.collected_at >= from && r.collected_at <= to);
  if (track.length === 0) continue;
  buses[busName] = track.map((r) => {
    const v = publishedAtStop(busName, r);
    return {
      t: r.collected_at,
      lat: r.lat,
      lon: r.lon,
      heading: r.heading,
      last_stop_id: r.last_stop_id,
      at_stop_id: v ? v.stop_id : null,
      at_stop_since: v ? new Date(v.arrived_at).toISOString().replace(/Z$/, "") : null,
      stationary_since: new Date(stat.get(r.collected_at)).toISOString().replace(/Z$/, ""),
    };
  });
}

const stopCoords = {}, stopNames = {};
for (const id of new Set([...seqIds, ORIGIN_STOP])) {
  if (payload.stop_coords[id]) stopCoords[id] = payload.stop_coords[id];
  if (payload.stop_names[id]) stopNames[id] = payload.stop_names[id];
}
const origin = process.env.ORIGIN_LAT
  ? { lat: Number(process.env.ORIGIN_LAT), lon: Number(process.env.ORIGIN_LON) }
  : stopCoords[ORIGIN_STOP];
if (!origin) throw new Error(`no coordinate for the rider's origin (${ORIGIN_STOP})`);

const fixture = {
  capturedAt: new Date(from).toISOString(),
  note:
    `Route ${ROUTE_ID} bus ${best.busName} closing on ${board.name} (stop ${BOARD_STOP}) and ` +
    `arriving at ${new Date(best.arrivedAt).toISOString()}, with every other bus on the line ` +
    `over the same window. The rider is at ${stopNames[ORIGIN_STOP] ?? "the recorded origin"}, ` +
    `${Math.round(hav(origin, board))} m from the board stop — a short walk, which is the whole ` +
    `point: it is what makes canCatch() reachable at all. Positions carry at_stop_id / ` +
    `at_stop_since / stationary_since exactly as /api/buses publishes them. Segments and dwells ` +
    `are the payload as served. Generated by scripts/record-closing-bus.mjs; do not hand-edit.`,
  routeId: String(ROUTE_ID),
  routeLabel: process.env.ROUTE_LABEL ?? "Red",
  busRouteId: ROUTE_ID,
  closingBus: best.busName,
  boardStopId: BOARD_STOP,
  origin,
  originStopId: ORIGIN_STOP,
  /** When the bus really reached the board stop, from `arrivals`. */
  arrivedAt: best.arrivedAt,
  departedAt: best.departedAt,
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
  `wrote ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB, ` +
    `${Object.keys(buses).length} buses, ${Object.values(buses).reduce((n, b) => n + b.length, 0)} positions)`,
);
