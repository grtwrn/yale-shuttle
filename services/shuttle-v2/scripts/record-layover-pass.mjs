#!/usr/bin/env node
// Record one real bus pass through a layover and write it as the fixture the
// accuracy gate replays (`web/src/__fixtures__/red-layover-pass.json`).
//
// The fixture is a rider's-eye recording: every position the feed published as
// a bus approached a layover stop, sat through the dwell and drove on, plus
// the arrival times the collector actually recorded downstream, plus the
// segment and dwell calibration exactly as it was being served at the time.
// `web/src/accuracy-layover.test.ts` replays it against the real client
// functions, so a change to the ETA maths is scored against a bus that really
// did this, not against a hand-made scenario.
//
// Regenerate when the route changes shape (a new stop, a moved layover) or
// when the recorded pass no longer resembles the service. Commit the new file
// and say in the PR what moved — a fixture edited to make a failing change
// pass is the one way this gate is worthless.
//
//   node scripts/record-layover-pass.mjs                 # defaults: Red, 344 Winchester
//   ROUTE_ID=3 LAYOVER_STOP=11 MIN_DWELL_SEC=300 \
//   WINDOW_H=6 OUT=web/src/__fixtures__/red-layover-pass.json \
//     node scripts/record-layover-pass.mjs
//
// `raw_positions` is retention-swept to a few hours, so run this soon after a
// pass you want. It reads production READ-ONLY over `flyctl ssh` and writes
// only the fixture file.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");

const ROUTE_ID = Number(process.env.ROUTE_ID ?? 3);
const LAYOVER_STOP = Number(process.env.LAYOVER_STOP ?? 11);
const MIN_DWELL_SEC = Number(process.env.MIN_DWELL_SEC ?? 300);
const WINDOW_H = Number(process.env.WINDOW_H ?? 6);
const BASE = process.env.BOT_BASE_URL ?? "https://yale-shuttle.fly.dev";
const FLYCTL = process.env.FLYCTL ?? `${process.env.HOME}/.fly/bin/flyctl`;
const OUT = process.env.OUT ?? path.join(APP, "web/src/__fixtures__/red-layover-pass.json");
// How much of the approach and the onward run to keep around the dwell.
const LEAD_MS = 8 * 60_000;
const TRAIL_MS = 12 * 60_000;
// The feed repeats a position rather than interpolating, so a sample every
// 15 s loses nothing and keeps the fixture readable in a diff.
const SAMPLE_EVERY = 3;

/** Run a snippet inside the production machine against a READ-ONLY handle. */
function onProd(js) {
  const wrapped =
    `const D=require("/app/node_modules/better-sqlite3");` +
    `const db=new D("/data/shuttle-v2.db",{readonly:true});` +
    js;
  const out = execFileSync(FLYCTL, ["ssh", "console", "-a", "yale-shuttle", "-C", "node -"], {
    input: wrapped,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const line = out.split("\n").find((l) => l.trim().startsWith("{") || l.trim().startsWith("["));
  if (!line) throw new Error(`no JSON from production:\n${out.slice(0, 400)}`);
  return JSON.parse(line);
}

const since = Date.now() - WINDOW_H * 3600_000;

// 1. The most recent long dwell at the layover stop that we still have
//    positions for on both sides.
const { pass } = onProd(
  `const rows=db.prepare("SELECT bus_name,arrived_at,departed_at,dwell_sec FROM arrivals ` +
    `WHERE route_id=${ROUTE_ID} AND stop_id=${LAYOVER_STOP} AND dwell_sec>=${MIN_DWELL_SEC} ` +
    `AND arrived_at>=${since} ORDER BY arrived_at DESC").all();` +
    `console.log(JSON.stringify({pass: rows[0] ?? null}));`,
);
if (!pass) {
  console.error(
    `no dwell of ${MIN_DWELL_SEC}s+ at stop ${LAYOVER_STOP} on route ${ROUTE_ID} in the last ${WINDOW_H} h`,
  );
  process.exit(1);
}
const from = pass.arrived_at - LEAD_MS;
const to = (pass.departed_at ?? pass.arrived_at) + TRAIL_MS;
console.error(
  `recording ${pass.bus_name}: dwell ${(pass.dwell_sec / 60).toFixed(1)} min at ` +
    `${new Date(pass.arrived_at).toISOString()}`,
);

// 2. Its positions across the whole pass, and every arrival it made.
const { pos, arr } = onProd(
  `const pos=db.prepare("SELECT lat,lon,heading,last_stop_id,collected_at FROM raw_positions ` +
    `WHERE bus_name='${pass.bus_name}' AND route_id=${ROUTE_ID} AND collected_at BETWEEN ${from} AND ${to} ` +
    `ORDER BY collected_at").all();` +
    `const arr=db.prepare("SELECT stop_id,arrived_at,departed_at FROM arrivals ` +
    `WHERE bus_name='${pass.bus_name}' AND route_id=${ROUTE_ID} AND arrived_at BETWEEN ${from - 900000} AND ${to + 900000} ` +
    `ORDER BY arrived_at").all();` +
    `console.log(JSON.stringify({pos,arr}));`,
);
if (pos.length < 40) throw new Error(`only ${pos.length} positions recorded — widen the window`);

// 3. The calibration as it was being served during the pass.
const payload = await (await fetch(`${BASE}/api/buses`)).json();
const seq = payload.routes[String(ROUTE_ID)];
if (!seq) throw new Error(`route ${ROUTE_ID} is not in the payload`);
const stopCoords = {};
const stopNames = {};
for (const id of new Set(seq)) {
  stopCoords[id] = payload.stop_coords[id];
  stopNames[id] = payload.stop_names[id];
}
const label = payload.routes && ROUTE_ID === 3 ? "Red" : (process.env.ROUTE_LABEL ?? "Red");

const fixture = {
  capturedAt: new Date(pos[0].collected_at).toISOString(),
  note:
    `${label} (route ${ROUTE_ID}) bus ${pass.bus_name}: the approach to the ` +
    `${stopNames[LAYOVER_STOP]} layover, the ${(pass.dwell_sec / 60).toFixed(1)} min dwell ` +
    `itself, and the run onward. Segments and dwells are the payload as served during the pass.`,
  routeId: String(ROUTE_ID),
  routeLabel: label,
  busName: pass.bus_name,
  busRouteId: ROUTE_ID,
  layoverStopId: LAYOVER_STOP,
  stopNames,
  routeStops: { [String(ROUTE_ID)]: seq },
  stopCoords,
  segments: { [String(ROUTE_ID)]: payload.segments[String(ROUTE_ID)] },
  dwells: { [String(ROUTE_ID)]: payload.dwells[String(ROUTE_ID)] },
  positions: pos
    .filter((_, i) => i % SAMPLE_EVERY === 0)
    .map((r) => ({
      t: r.collected_at,
      lat: r.lat,
      lon: r.lon,
      heading: r.heading,
      last_stop_id: r.last_stop_id,
    })),
  arrivals: arr.map((a) => ({
    stopId: a.stop_id,
    arrivedAt: a.arrived_at,
    departedAt: a.departed_at,
  })),
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(fixture, null, 1));
console.error(
  `wrote ${OUT}: ${fixture.positions.length} positions, ${fixture.arrivals.length} arrivals, ` +
    `${(fs.statSync(OUT).size / 1024).toFixed(0)} KB`,
);
