// Probe: what the synthetic fixture in arrival.test.ts ACTUALLY does, per poll,
// in both arms. Written to rewrite the three failing tests against the truth.
import { stepBelief, LEAD_SWITCH_MASS, type Belief } from "../../../../web/src/eta/filter";
import { buildRing, type Ring } from "../../../../web/src/eta/ring";
import { buildTables, type RouteTables } from "../../../../web/src/eta/tables";
import { priceRoute, setCeilingArmsOnStanding, setClampTrace, type ClampEvent, type Floors } from "../../../../web/src/eta/arrival";
import type { LatLon } from "../../../../web/src/geo";
// The same rectangular loop as filter.test.ts.
const LAT0 = 41.31, LON0 = -72.93;
const mLat = 1 / 111_195, mLon = 1 / 83_500;
function at(xm: number, ym: number): LatLon { return { lat: LAT0 + ym * mLat, lon: LON0 + xm * mLon }; }
const corners = [at(0, 0), at(900, 0), at(900, 450), at(0, 450)];
const STOPS = [1, 2, 3, 4];
const COORDS: Record<number, LatLon> = { 1: corners[0]!, 2: corners[1]!, 3: corners[2]!, 4: corners[3]! };
const PATH: [number, number][] = [...corners, corners[0]!].map((c) => [c.lat, c.lon]);

// Red-like tables: stop 1 is a layover (344 Winchester's real table), the
// others ordinary; drives from leg lengths at ~7 m/s.
const Q11 = [83, 129, 145, 191, 288, 333, 437, 473, 543, 674];
const ORD = [0, 12, 15, 18, 22, 26, 31, 40, 55, 90];
function dq(sec: number): number[] { return [0.8, 0.85, 0.9, 0.95, 1, 1.05, 1.1, 1.2, 1.35, 1.6].map((f) => Math.round(sec * f)); }
const SEGS = {
  "1-2": { avg: 140, sd: 20, n: 50, drive: 128, driveN: 50, dq: dq(128), dqn: 50 },
  "2-3": { avg: 70, sd: 10, n: 50, drive: 64, driveN: 50, dq: dq(64), dqn: 50 },
  "3-4": { avg: 140, sd: 20, n: 50, drive: 128, driveN: 50, dq: dq(128), dqn: 50 },
  "4-1": { avg: 70, sd: 10, n: 50, drive: 64, driveN: 50, dq: dq(64), dqn: 50 },
};
const DWELLS = {
  "1": { med: 400, sd: 200, n: 50, q: Q11, qn: 50 },
  "2": { med: 30, sd: 20, n: 50, q: ORD, qn: 50 },
  "3": { med: 30, sd: 20, n: 50, q: ORD, qn: 50 },
  "4": { med: 30, sd: 20, n: 50, q: ORD, qn: 50 },
};

function setup(): { ring: Ring; tables: RouteTables } {
  const ring = buildRing("t", PATH, STOPS, COORDS)!;
  return { ring, tables: buildTables(STOPS, COORDS, SEGS, DWELLS) };
}
const since = new Date(0).toISOString().replace("Z", "");
function standAt1(t: number) { return { lat: corners[0]!.lat, lon: corners[0]!.lon, stationary_since: since }; }

function arrive(ring: Ring, tables: RouteTables, standPolls: number) {
  const floors: Floors = { map: new Map() };
  const evs: ClampEvent[] = [];
  setClampTrace((e) => { if (e.occurrence === 0 && e.stopIdx === 1) evs.push(e); });
  const shown: number[] = [];
  let b: Belief | undefined; let now = 0;
  const STEP = Number(process.env.STEP ?? 35);
  for (let y = 9 * STEP; y >= 0; y -= STEP) {
    now += 5000;
    b = stepBelief(b, ring, { lat: at(0, y).lat, lon: at(0, y).lon }, now, STOPS);
    const row = priceRoute(b, ring, tables, STOPS, new Set([2]), now, 0.5, floors).find((x) => x.stopId === 2 && x.occurrence === 0);
    if (row) shown.push(row.eta);
  }
  const approachPolls = shown.length;
  for (let i = 0; i < standPolls; i++) {
    now += 5000;
    b = stepBelief(b, ring, { lat: at(0, 0).lat, lon: at(0, 0).lon }, now, STOPS);
    const row = priceRoute(b, ring, tables, STOPS, new Set([2]), now, 0.5, floors).find((x) => x.stopId === 2 && x.occurrence === 0)!;
    shown.push(row.eta);
  }
  setClampTrace(null);
  return { shown, evs, approachPolls };
}
const { ring, tables } = setup();
for (const arm of [false, true]) {
  setCeilingArmsOnStanding(arm);
  const { shown, evs, approachPolls } = arrive(ring, tables, 20);
  console.log(`\n=== ARM=${arm ? "on" : "off"}  (LEAD_SWITCH_MASS=${LEAD_SWITCH_MASS}, approach polls with a row: ${approachPolls}, total shown ${shown.length})`);
  console.log(`clamp events at stop idx 1 (the layover), one per line: i | action | standMass | mixture | standing`);
  evs.forEach((e, i) => console.log(`  ${String(i).padStart(2)} ${e.action.padEnd(11)} mass=${e.standMass.toFixed(3)} mix=${e.mixture.toFixed(1)} stand=${e.standing.toFixed(1)}`));
  console.log(`shown: ${shown.map((x) => x.toFixed(0)).join(" ")}`);
  const rises = shown.slice(1).filter((x, i) => x > shown[i]! + 1e-6).length;
  console.log(`rises in the whole series: ${rises}`);
}
