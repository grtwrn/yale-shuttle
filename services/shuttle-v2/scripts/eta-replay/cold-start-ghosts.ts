/**
 * THE COLD START'S OWN ERROR RATE, both ways.
 *
 * Every rider's FIRST render is a cold start: one payload frame, no history.
 * `initBelief` decides "is this bus standing?" from the server's stationary
 * clock alone, and `priceRoute` turns a standing lead into `eta 0` — "now".
 *
 * The clock cannot carry that decision. The collector anchors it to a stop the
 * moment the bus comes within 75 m and carries it until the bus is 125 m away
 * (detector.ts `stationaryFields`), so it keeps running WHILE A BUS DRIVES
 * THROUGH the stop's zone. `at_stop_since` is the same clock behind a gate
 * ("this stop has been nearest for 15 s") that a drive-through also passes.
 *
 * This replays the real client code over a whole day of production frames and
 * counts both errors:
 *
 *   GHOST  the row says a bus is within `IMMINENT_S` and the bus has in fact
 *          already gone — no arrival at that stop for `GONE_S` afterwards.
 *          The rider walks out and it is not there.
 *   MISS   the bus is genuinely standing at the stop right now and the row
 *          does NOT say so. The rider is told to wait for the next one while
 *          this one is at the kerb.
 *
 * A fix is only a fix if it cuts GHOST without paying for it in MISS.
 *
 *   TZ=America/New_York POSITIONS=... VISITS=... PAYLOAD=... \
 *     npx tsx scripts/eta-replay/cold-start-ghosts.ts
 */
import fs from "node:fs";

import { registerRoutePaths } from "../../web/src/anchor";
import { arrivalsForBus, ringForBus, type AnchorStore } from "../../web/src/eta";
import type { LatLon } from "../../web/src/geo";

// collector.ts / detector.ts, transcribed (this script runs outside the server).
const AT_STOP_MAX_M = 75, MIN_DWELL_MS = 15_000, STATIONARY_RADIUS_M = 125;
const MOVED_M = Number(process.env.MOVED_M ?? 8);
/** Set to drop `still_since` from the frames, i.e. replay the OLD behaviour. */
const NO_MOVED = process.env.NO_MOVED === "1";
/** A row this close to zero is "now"/"in 1 min" to a rider. */
const IMMINENT_S = Number(process.env.IMMINENT_S ?? 60);
/** No arrival within this long afterwards means the bus really had gone. */
const GONE_S = Number(process.env.GONE_S ?? 180);
/** Sample every Nth poll; the frames are 5 s apart and highly correlated. */
const STRIDE = Number(process.env.STRIDE ?? 4);

const R = 6371000, toRad = Math.PI / 180;
const hav = (a: LatLon, b: LatLon): number => {
  const dLat = (b.lat - a.lat) * toRad, dLon = (b.lon - a.lon) * toRad;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
};

const payload = JSON.parse(fs.readFileSync(process.env.PAYLOAD!, "utf8"));
const visits = JSON.parse(fs.readFileSync(process.env.VISITS!, "utf8"));
const stopCoords: Record<number, LatLon> = {};
for (const [k, v] of Object.entries(payload.stop_coords)) stopCoords[Number(k)] = v as LatLon;
const routeStops: Record<string, number[]> = {};
for (const [rid, o] of Object.entries<Record<string, number>>(payload.routes)) {
  routeStops[rid] = Object.keys(o).sort((a, b) => Number(a) - Number(b)).map((k) => o[k]!);
}
registerRoutePaths(payload.route_paths);

const pos: any[] = [];
for (const l of fs.readFileSync(process.env.POSITIONS!, "utf8").split("\n")) if (l.trim()) pos.push(JSON.parse(l));
const byBus = new Map<string, any[]>();
for (const p of pos) {
  const k = `${p.bus_name}|${p.route_id}`;
  if (!byBus.has(k)) byBus.set(k, []);
  byBus.get(k)!.push(p);
}

/** Ground truth: when each bus really reached each stop. */
const arrivalsAt = new Map<string, number[]>();
for (const v of visits) {
  if (v.arrived_at === null) continue;
  const k = `${v.bus_name}|${v.stop_id}`;
  if (!arrivalsAt.has(k)) arrivalsAt.set(k, []);
  arrivalsAt.get(k)!.push(v.arrived_at);
}
for (const a of arrivalsAt.values()) a.sort((x, y) => x - y);
/** The visit this bus is INSIDE at this stop right now, if any. */
const visitsBy = new Map<string, any[]>();
for (const v of visits) {
  const k = `${v.bus_name}|${v.stop_id}`;
  if (!visitsBy.has(k)) visitsBy.set(k, []);
  visitsBy.get(k)!.push(v);
}
for (const a of visitsBy.values()) a.sort((x, y) => (x.arrived_at ?? 0) - (y.arrived_at ?? 0));
function visitAt(busName: string, stopId: number, t: number): any | null {
  for (const v of visitsBy.get(`${busName}|${stopId}`) ?? []) {
    if (v.arrived_at === null || v.arrived_at > t) continue;
    if (v.departed_at !== null && v.departed_at <= t) continue;
    return v;
  }
  return null;
}
/**
 * Is an "arriving within IMMINENT_S" row at this stop honest?
 *
 * Two ways it can be. The bus is AT the stop right now — a bus at the kerb IS
 * arriving now, and its next *arrival* is a lap away, so asking only "when does
 * it next arrive" scores every correct "now" as a ghost. Or it is not there yet
 * and really does turn up within GONE_S.
 */
function honestImminent(busName: string, stopId: number, t: number): boolean {
  if (visitAt(busName, stopId, t) !== null) return true;
  const a = arrivalsAt.get(`${busName}|${stopId}`);
  if (!a) return false;
  for (const x of a) if (x >= t) return (x - t) / 1000 <= GONE_S;
  return false;
}
/** Is the bus standing AT this stop right now (a visit where it really stood)? */
function standingNow(busName: string, stopId: number, t: number): boolean {
  const v = visitAt(busName, stopId, t);
  return v !== null && Number(v.stand_sec) >= 15;
}

let ghosts = 0, imminent = 0, misses = 0, standing = 0, frames = 0;
const missAge: number[] = [];
const missEta: number[] = [];
let zeroImminent = 0, zeroGhost = 0;
const ghostBy = new Map<string, number>(), immBy = new Map<string, number>();
const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

for (const [key, rows] of byBus) {
  const [busName, rid] = key.split("|") as [string, string];
  const stops = routeStops[rid];
  if (!stops || stops.length < 2) continue;
  const segs = payload.segments[rid], dwells = payload.dwells[rid];
  if (!segs || !dwells) continue;
  rows.sort((a, b) => a.collected_at - b.collected_at);

  // Reproduce what /api/buses published, poll by poll.
  let nearestId: number | null = null, enteredAt = 0;
  let lastMovedAt = rows[0]!.collected_at, prevFix: any = null;
  let st: { since: number; lat: number; lon: number; stopId: number | null } | null = null;
  const pts = stops.map((id) => ({ id, ...stopCoords[id]! })).filter((s) => s.lat != null);
  const pub: any[] = [];
  for (const o of rows) {
    if (prevFix === null || hav(prevFix, o) > MOVED_M) lastMovedAt = o.collected_at;
    prevFix = o;
    let near = pts[0]!, nd = Infinity;
    for (const s of pts) { const d = hav(o, s); if (d < nd) { nd = d; near = s; } }
    if (near.id !== nearestId) { nearestId = near.id; enteredAt = o.collected_at; }
    const anchor = nd <= AT_STOP_MAX_M ? near : null;
    if (anchor) st = st && st.stopId === anchor.id ? st : { since: o.collected_at, lat: anchor.lat, lon: anchor.lon, stopId: anchor.id };
    else if (st && hav(o, st) <= STATIONARY_RADIUS_M) { /* carried */ }
    else st = { since: o.collected_at, lat: o.lat, lon: o.lon, stopId: null };
    const atStop = o.collected_at - enteredAt >= MIN_DWELL_MS && nd <= AT_STOP_MAX_M;
    pub.push({
      bus_id: o.bus_id, bus_name: busName, route_id: Number(rid),
      lat: o.lat, lon: o.lon, heading: o.heading, last_stop_id: o.last_stop_id,
      ...(atStop ? { at_stop_id: near.id, at_stop_since: new Date(st!.since).toISOString().replace(/Z$/, "") } : {}),
      stationary_since: new Date(st!.since).toISOString().replace(/Z$/, ""),
      ...(NO_MOVED ? {} : { last_moved_at: new Date(lastMovedAt).toISOString().replace(/Z$/, "") }),
      t: o.collected_at,
    });
  }

  const targets = new Set(stops);
  for (let i = 0; i < pub.length; i += STRIDE) {
    const bus = pub[i]!, t = bus.t;
    const ring = ringForBus(bus, stops, stopCoords);
    if (!ring) continue;
    frames++;
    // COLD: what a page load renders from this one frame.
    const store: AnchorStore = new Map();
    let out;
    try {
      out = arrivalsForBus(store, `${rid}|${busName}`, bus as never, ring, stops, stopCoords,
        segs, dwells, targets, t, undefined, payload.dwells);
    } catch { continue; }
    for (const a of out) {
      if (a.eta > IMMINENT_S) continue;
      imminent++; bump(immBy, rid);
      const bad = !honestImminent(busName, a.stopId, t);
      if (bad) { ghosts++; bump(ghostBy, rid); }
      // The standing shortcut specifically: `eta 0`, the row that says "now".
      if (a.stopsAhead === 0) { zeroImminent++; if (bad) zeroGhost++; }
    }
    // The other direction: a bus genuinely at the kerb that the row does not show.
    const at = pub[i]!.at_stop_id;
    if (at != null && standingNow(busName, at, t)) {
      standing++;
      const shown = out.find((a) => a.stopId === at);
      if (!shown || shown.eta > IMMINENT_S) {
        misses++;
        const v = visitAt(busName, at, t);
        if (v) missAge.push((t - v.arrived_at) / 1000);
        // What the row said INSTEAD is what decides whether a miss matters: a
        // slightly larger number is a rider who waits a moment longer, the
        // next lap is a bus at the kerb made invisible.
        missEta.push(shown ? shown.eta : Infinity);
      }
    }
  }
}

const pct = (a: number, b: number) => b ? `${((100 * a) / b).toFixed(1)}%` : "-";
console.log(`frames priced (cold, stride ${STRIDE}): ${frames}`);
console.log("");
console.log(`GHOST  rows shown within ${IMMINENT_S} s : ${imminent}`);
console.log(`       of which the bus had GONE     : ${ghosts}  (${pct(ghosts, imminent)} of imminent rows)`);
console.log("");
console.log(`MISS   frames with the bus at the kerb: ${standing}`);
console.log(`       of which the row did not say so: ${misses}  (${pct(misses, standing)})`);
console.log("");
console.log(`  of the misses, seconds since the bus actually pulled in:`);
{
  const q = (p: number) => { const a = [...missAge].sort((x, y) => x - y); return a[Math.floor(p * (a.length - 1))] ?? NaN; };
  console.log(`     n=${missAge.length}  p50 ${q(0.5).toFixed(0)}s  p75 ${q(0.75).toFixed(0)}s  p90 ${q(0.9).toFixed(0)}s  p99 ${q(0.99).toFixed(0)}s  max ${missAge.length ? Math.max(...missAge).toFixed(0) : "-"}s`);
  console.log(`     within 30 s of pulling in: ${missAge.filter((x) => x <= 30).length} (${pct(missAge.filter((x) => x <= 30).length, missAge.length)})`);
}
{
  const under = (n: number) => missEta.filter((x) => x <= n).length;
  console.log(`  what the row said instead: <=2 min ${pct(under(120), missEta.length)}`
    + `  <=5 min ${pct(under(300), missEta.length)}  <=10 min ${pct(under(600), missEta.length)}`
    + `  no row at all ${pct(missEta.filter((x) => !Number.isFinite(x)).length, missEta.length)}`);
}
console.log("");
console.log(`"NOW" rows (the standing shortcut, eta 0): ${zeroImminent}`);
console.log(`       of which the bus had GONE         : ${zeroGhost}  (${pct(zeroGhost, zeroImminent)})`);
console.log("");
console.log("by route:  route   imminent   ghosts    rate");
for (const rid of [...immBy.keys()].sort((a, b) => (immBy.get(b)! - immBy.get(a)!))) {
  console.log(`           ${rid.padEnd(7)}${String(immBy.get(rid)).padStart(8)}${String(ghostBy.get(rid) ?? 0).padStart(9)}${pct(ghostBy.get(rid) ?? 0, immBy.get(rid)!).padStart(9)}`);
}
