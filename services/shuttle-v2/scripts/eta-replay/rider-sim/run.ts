/**
 * RIDER SIM — a day of captured positions, thousands of synthetic riders, and
 * the exact countdown each one would have watched from reaching the stop to
 * the bus pulling in. Minutes of wall clock, not hours of browser.
 *
 * The operator's ask: "like the canary rider, but we should be able to do
 * expedited simulations given the days data we can create riders and then
 * simulate the algorithm results while 'waiting' at a stop".
 *
 * WHAT IT IS NOT. The offline replays (`eta-replay.ts`, `gps-replay.ts`,
 * `jitter-audit.ts`) score transitions — aggregates over (bus, stop) pairs.
 * The unit of output here is a WAIT: one person, one stop, one sequence of
 * numbers, from first sight to boarding. "Said 10 min then a few seconds
 * later 1 min" is a property of that sequence and of nothing else.
 *
 * FIDELITY. Nothing here re-implements the client. Every poll runs, in the
 * order the browser runs them and with the same arguments:
 *
 *   planTrip                    once, when the rider reaches the stop — the
 *                               option, its board stop and its pinned bus
 *   computeUpcomingArrivals     with the rider's own AnchorStore (PR #72),
 *                               opened when they opened the app
 *   the hereBus / departed / pickLiveArrival branch of the `options` memo,
 *                               judged against the PLAN-TIME pin every poll,
 *                               because that is what `stableOptions` holds
 *   shuttleCtx + remainingSec   which decide whether a countdown is rendered
 *   nextArrivalAfterPinned      (or the pre-#74 `eta > shown + 30` filter on
 *                               a tree that predates it)
 *   fmtBusPair                  the text on the row
 *
 * The payload comes from the real detector (`stepMany`) and the collector's
 * own at-stop rule — `stationarySince`, 15 s, 75 m — not a reconstruction,
 * and a bus that misses a poll stays on the payload for LIVE_BUS_TTL_MS as in
 * production. Calibration is time-travelled per ET hour from a DB snapshot.
 *
 * SCORING is the canary's (`canary-metrics.mjs`): display buckets, the
 * smallest movement two readings permit. Truth is the canary's 45 m curb rule
 * from the same positions; the detector's arrival event rides alongside.
 *
 * ANY TREE. `CLIENT_ROOT` points at another worktree's `services/shuttle-v2`;
 * the client modules and the detector are imported from there and its HEAD
 * (and whether it is dirty) is stamped into the output. Same capture, same
 * snapshot, same population — so two runs pair wait for wait (`--compare`).
 *
 *   cd services/shuttle-v2
 *   TZ=America/New_York REPLAY_DB=./store/snap2.db npx tsx scripts/eta-replay/rider-sim/run.ts
 *   ... --rider Red@48@2026-09-03T21:18:03Z          # a named rider (repeatable)
 *   ... --compare a.waits.jsonl b.waits.jsonl         # pair two runs
 *
 * Env: CAPTURE (comma-separated jsonl; default every ~/shuttle-captures/positions-*.jsonl),
 *      REPLAY_DB, CLIENT_ROOT, FROM/TO (ISO, riders only), DETECTOR_FROM (ISO),
 *      POP=both|uniform|targeted|none, EVERY_MIN=10, MAX_WAIT_MIN=45,
 *      SAMPLE_MS=5000, CANARY_MS=15000, OUT_NAME=rider-sim, REPLAY_OUT,
 *      ROUTES=Red (focus: uniform + targeted; "all" for every running line),
 *      HOLDOUT=Green,Purple (uniform riders always generated and reported
 *      per route beside the focus — the fold-back lines a Red-tuned fix must
 *      not silently regress), CHAIN=Red:11:6 (the 344 Winchester chain: riders
 *      at the six stops downstream while a Red bus is parked there or leaving;
 *      reported as its own section with the departure moment scored),
 *      CALIB_LAG_MIN, TRACE=1,
 *      PAYLOAD_PATCH=file.json — extra calibration fields a candidate tree
 *      reads that the snapshot's calibrator does not serve yet, merged into
 *      the time-travelled tables after they are built: e.g. PR #81's
 *      `segments[route]["A-B"].drive` and `dwells[route][stop].q`. Shape:
 *      {"segments": {"3": {"11-146": {"drive": 82}}}, "dwells": {"3": {"11": {"q": [120, 240, 420, 600]}}}}.
 *      A tree that ignores the fields is byte-identical with or without it.
 */
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  OUT_DIR,
  SEGMENT_WINDOW_MS,
  fmtEt,
  loadNet,
  loadSamples,
  makeCalibCache,
  makeDwellCache,
  routeAdjacency,
  segmentTimesFor,
  serveRoute,
  type AdjEntry,
} from "../common.js";
import { distanceMeters } from "../../../src/network/geo.js";
import {
  aggregate,
  chainSummary,
  chooseAlight,
  compareRuns,
  dedupeAndSort,
  groupPolls,
  parseCaptureLine,
  parseRiderArg,
  renderChain,
  renderCompare,
  renderSummary,
  riderId,
  scoreWait,
  stopVisits,
  truthFor,
  type PosRow,
  type RiderSpec,
  type Tick,
  type Truth,
  type WaitResult,
} from "./lib.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const T0 = Date.now();
const log = (...a: unknown[]) => console.error(`[${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a);

// -- args / env -----------------------------------------------------------------

const argv = process.argv.slice(2);
const namedArgs: string[] = [];
let compareArgs: string[] | null = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--rider") namedArgs.push(argv[++i]!);
  else if (argv[i] === "--compare") { compareArgs = [argv[++i]!, argv[++i]!]; }
}
if (process.env.RIDER) namedArgs.push(...process.env.RIDER.split(",").map((s) => s.trim()).filter(Boolean));

if (compareArgs) {
  const read = (f: string) => fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as WaitResult);
  const a = read(compareArgs[0]!);
  const b = read(compareArgs[1]!);
  console.log(renderCompare(compareRuns(a, b), path.basename(compareArgs[0]!), path.basename(compareArgs[1]!)));
  process.exit(0);
}

const CLIENT_ROOT = path.resolve(process.env.CLIENT_ROOT ?? path.resolve(HERE, "../../.."));
const POP = (process.env.POP ?? (namedArgs.length ? "none" : "both")) as "both" | "uniform" | "targeted" | "none";
const EVERY_MS = (Number(process.env.EVERY_MIN) || 10) * 60_000;
const MAX_WAIT_MS = (Number(process.env.MAX_WAIT_MIN) || 45) * 60_000;
const SAMPLE_MS = Number(process.env.SAMPLE_MS) || 5_000;
const CANARY_MS = Number(process.env.CANARY_MS) || 15_000;
const OUT_NAME = process.env.OUT_NAME ?? "rider-sim";
const FROM = process.env.FROM ? Date.parse(process.env.FROM) : -Infinity;
const TO = process.env.TO ? Date.parse(process.env.TO) : Infinity;
/**
 * Production recalibrates every 5 min from process start, so the served
 * segment/dwell tables lag the ET hour boundary by an unknown 0–5 min (and a
 * deploy restarts the phase). The replay rolls exactly on the hour unless
 * told to lag; CALIB_LAG_MIN is a sensitivity knob, not a calibration.
 */
const CALIB_LAG_MS = (Number(process.env.CALIB_LAG_MIN) || 0) * 60_000;
/** TRACE=1 prints every poll of every NAMED rider: the bus, the anchor, the live list, the text. */
const TRACE = process.env.TRACE === "1";
/** Production's own numbers (collector.ts). */
const AT_STOP_MAX_M = 75;
const AT_STOP_MIN_DWELL_MS = 15_000;
const LIVE_BUS_TTL_MS = 120_000;
/** Targeted population: where riders stand relative to an event. */
const TARGET_OFFSETS_MS = [8, 4, 1].map((m) => m * 60_000);
const TARGET_DOWNSTREAM_STOPS = 6;
const TARGET_DEPART_MIN_STAND_MS = 60_000;
const TARGET_LAST_BUS_MS = 30 * 60_000;
/** Focus and hold-out lines; the chain cohort. Red first, by the operator's decision. */
const ROUTES_ENV = process.env.ROUTES ?? "Red";
const HOLDOUT_ENV = process.env.HOLDOUT ?? "Green,Purple";
const CHAIN_ENV = process.env.CHAIN ?? "Red:11:6";
/** Chain riders arrive this long after the bus parked, then every CHAIN_EVERY_MS while it stays, plus CHAIN_BEFORE_DEPART_MS before it leaves. */
const CHAIN_FIRST_MS = 30_000;
const CHAIN_EVERY_MS = 120_000;
const CHAIN_BEFORE_DEPART_MS = 30_000;

// -- the tree under test ---------------------------------------------------------

async function fromClient<T>(rel: string): Promise<T> {
  return (await import(pathToFileURL(path.join(CLIENT_ROOT, rel)).href)) as T;
}
type ArrivalsMod = typeof import("../../../web/src/arrivals");
type AnchorMod = typeof import("../../../web/src/anchor");
type PlannerMod = typeof import("../../../web/src/planner");
type FormatMod = typeof import("../../../web/src/format");
type RoutesMod = typeof import("../../../web/src/routes");
type ScheduleMod = typeof import("../../../web/src/schedule");
type GateMod = typeof import("../../../web/src/anchorGate");
type WalkMod = typeof import("../../../web/src/walk");
type GeoMod = typeof import("../../../web/src/geo");
type DetMod = typeof import("../../../src/collector/detector.js");
type BusData = import("../../../web/src/map-data").BusData;
type UpcomingArrival = import("../../../web/src/arrivals").UpcomingArrival;
type TripOption = import("../../../web/src/planner").TripOption;

const arrivalsMod = await fromClient<ArrivalsMod>("web/src/arrivals.ts");
const anchorMod = await fromClient<AnchorMod>("web/src/anchor.ts");
const plannerMod = await fromClient<PlannerMod>("web/src/planner.ts");
const formatMod = await fromClient<FormatMod>("web/src/format.ts");
const routesMod = await fromClient<RoutesMod>("web/src/routes.ts");
const scheduleMod = await fromClient<ScheduleMod>("web/src/schedule.ts");
const walkMod = await fromClient<WalkMod>("web/src/walk.ts");
const geoMod = await fromClient<GeoMod>("web/src/geo.ts");
const det = await fromClient<DetMod>("src/collector/detector.ts");
let gateMod: GateMod | null = null;
try { gateMod = await fromClient<GateMod>("web/src/anchorGate.ts"); } catch { gateMod = null; }
const hasNextRule = typeof (arrivalsMod as any).nextArrivalAfterPinned === "function";

function treeInfo() {
  const git = (cmd: string) => { try { return execSync(`git -C "${CLIENT_ROOT}" ${cmd}`, { encoding: "utf8" }).trim(); } catch { return "?"; } };
  const head = git("rev-parse --short HEAD");
  const dirty = git("status --porcelain -- web/src src/collector") !== "";
  return { root: CLIENT_ROOT, head, dirty, branch: git("rev-parse --abbrev-ref HEAD"), anchorGate: !!gateMod, nextRule: hasNextRule ? "identity (#74)" : "eta > shown + 30" };
}
const tree = treeInfo();
log(`client tree ${tree.root} @ ${tree.head}${tree.dirty ? " (DIRTY)" : ""} [${tree.branch}]  anchorGate=${tree.anchorGate}  nextIn=${tree.nextRule}`);

// -- data ------------------------------------------------------------------------

const captureFiles = (process.env.CAPTURE
  ? process.env.CAPTURE.split(",")
  : fs.readdirSync(`${process.env.HOME}/shuttle-captures`).filter((f) => /^positions-\d{8}\.jsonl$/.test(f)).sort().map((f) => `${process.env.HOME}/shuttle-captures/${f}`)
).map((f) => f.trim()).filter(Boolean);
let raw: PosRow[] = [];
for (const f of captureFiles) {
  const before = raw.length;
  for (const line of fs.readFileSync(f, "utf8").split("\n")) {
    const r = parseCaptureLine(line);
    if (r) raw.push(r);
  }
  log(`${f}: ${raw.length - before} rows`);
}
const rows = dedupeAndSort(raw);
raw = [];
const polls = groupPolls(rows);
const dataStart = rows[0]!.t;
const dataEnd = rows[rows.length - 1]!.t;
log(`${rows.length} positions after de-dup, ${polls.length} polls, ${new Date(dataStart).toISOString()} .. ${new Date(dataEnd).toISOString()}`);
const DETECTOR_FROM = process.env.DETECTOR_FROM ? Date.parse(process.env.DETECTOR_FROM) : dataStart;

const net = loadNet();
const { network } = net;
anchorMod.registerRoutePaths(net.routePaths);
const { ROUTE_LISTS, mergedRouteStops } = routesMod;
const cfgByLabel = new Map(ROUTE_LISTS.map((c) => [c.label, c]));
const cfgByRouteId = new Map<number, (typeof ROUTE_LISTS)[number]>();
for (const c of ROUTE_LISTS) for (const rid of c.busRouteIds) cfgByRouteId.set(rid, c);
const stopsOf = (label: string) => mergedRouteStops(cfgByLabel.get(label)!, net.routeStops);
const resolveLabels = (spec: string): string[] => {
  if (spec.trim().toLowerCase() === "all") return ROUTE_LISTS.map((c) => c.label);
  return spec.split(",").map((x) => x.trim()).filter(Boolean).map((x) => {
    if (cfgByLabel.has(x)) return x;
    const byId = cfgByRouteId.get(Number(x));
    if (byId) return byId.label;
    throw new Error(`unknown route "${x}" (label or upstream route id)`);
  });
};
const FOCUS = new Set(resolveLabels(ROUTES_ENV));
const HOLDOUT = new Set(resolveLabels(HOLDOUT_ENV).filter((l) => !FOCUS.has(l)));
const chainParts = CHAIN_ENV.split(":");
const CHAIN = CHAIN_ENV.trim().toLowerCase() === "none" ? null : { label: resolveLabels(chainParts[0]!)[0]!, stopId: Number(chainParts[1]), hops: Number(chainParts[2] ?? 6) };
const chainStops: number[] = [];
if (CHAIN) {
  const seq = stopsOf(CHAIN.label);
  const i = seq.indexOf(CHAIN.stopId);
  if (i < 0) throw new Error(`CHAIN stop ${CHAIN.stopId} is not on ${CHAIN.label}`);
  for (let k = 1; k <= CHAIN.hops; k++) { const sid = seq[(i + k) % seq.length]!; if (!chainStops.includes(sid)) chainStops.push(sid); }
}
log(`focus ${[...FOCUS].join(",")}  holdout ${[...HOLDOUT].join(",")}  chain ${CHAIN ? `${CHAIN.label}@${CHAIN.stopId} -> ${chainStops.join(",")}` : "none"}`);
const norm = (s: string) => s.replace(/^#/, "");

// calibration, time-travelled
const samples = loadSamples(net, dataStart - SEGMENT_WINDOW_MS - 3_600_000, dataEnd + 3_600_000);
const calibCache = makeCalibCache(samples, network);
const adjByRoute = new Map<number, AdjEntry[]>();
for (const r of net.routes) adjByRoute.set(r.id, routeAdjacency(net, samples, r.id));
const segCache = new Map<number, ArrivalsMod extends { SegmentTimes: infer S } ? S : any>();
function segmentsAt(t: number) {
  const bs = calibCache.bucketStart(t);
  let p = segCache.get(bs);
  if (!p) {
    const bc = calibCache.get(bs);
    const st: Record<string, Record<string, { avg: number; sd: number; n: number }>> = {};
    for (const r of net.routes) st[String(r.id)] = segmentTimesFor(adjByRoute.get(r.id)!, serveRoute(adjByRoute.get(r.id)!, bc.byName.base));
    segCache.set(bs, (p = applyPatch(st, patch?.segments)));
  }
  return p;
}
const dwellCache = makeDwellCache(net, dataStart, dataEnd);
const dwellsAt0 = (t: number) => dwellCache.at(calibCache.bucketStart(t));
/** PAYLOAD_PATCH: fields the candidate reads that the snapshot cannot serve (see header). */
interface PayloadPatch { segments?: Record<string, Record<string, Record<string, unknown>>>; dwells?: Record<string, Record<string, Record<string, unknown>>> }
const patch: PayloadPatch | null = process.env.PAYLOAD_PATCH ? (JSON.parse(fs.readFileSync(process.env.PAYLOAD_PATCH, "utf8")) as PayloadPatch) : null;
const patched = new WeakSet<object>();
type PatchTable = Record<string, Record<string, Record<string, unknown>>>;
function applyPatch<T extends PatchTable>(table: T, extra: PayloadPatch["segments"] | undefined): T {
  if (!extra || patched.has(table)) return table;
  const t = table as PatchTable;
  for (const [rid, byKey] of Object.entries(extra)) {
    const r = (t[rid] ??= {});
    for (const [k, fields] of Object.entries(byKey)) Object.assign((r[k] ??= {}), fields);
  }
  patched.add(table);
  return table;
}
const dwellsAt = (t: number) => applyPatch(dwellsAt0(t), patch?.dwells);
if (patch) log(`payload patch ${process.env.PAYLOAD_PATCH}: segments ${Object.values(patch.segments ?? {}).reduce((n, r) => n + Object.keys(r).length, 0)} keys, dwells ${Object.values(patch.dwells ?? {}).reduce((n, r) => n + Object.keys(r).length, 0)} keys`);
{
  const segMax = (net.db.prepare("SELECT max(started_at) m FROM segments").get() as { m: number }).m;
  if (segMax < dataEnd - 3_600_000) log(`WARNING: snapshot segments end ${new Date(segMax).toISOString()}, ${((dataEnd - segMax) / 3_600_000).toFixed(1)} h before the capture ends — calibration for the tail is missing its newest samples; take a fresher snapshot`);
}

// truth
const visits = stopVisits(rows, (rid) => (cfgByRouteId.get(rid) ? stopsOf(cfgByRouteId.get(rid)!.label) : []), net.stopCoords);
log(`stop visits computed for ${visits.size} stops`);

// -- pass 1: the detector alone, for the targeted population ---------------------

interface DepartEvent { t: number; busName: string; routeId: number; stopId: number; stoodMs: number; since: number | null }
interface CountDrop { t: number; label: string; from: number; to: number }
const departEvents: DepartEvent[] = [];
const countDrops: CountDrop[] = [];
/** detector arrival events: `${busName}|${stopId}` -> times */
const detArrivals = new Map<string, number[]>();

type LivePos = { o: import("../../../src/collector/detector.js").BusObservation; atStopId: number | null; atStopSince: number | null };

function makeFeed() {
  const states = new Map<string, import("../../../src/collector/detector.js").BusState>();
  const livePositions = new Map<string, LivePos>();
  return {
    /** Run one poll through the detector and the collector's at-stop rule; return the payload as the client sees it. */
    step(poll: PosRow[], record: boolean): BusData[] {
      const obs = poll.map((p) => ({ busId: p.i, busName: p.b, routeId: p.r, lat: p.lat, lon: p.lon, heading: p.h, lastStopId: p.l, collectedAt: p.t }));
      const t = poll[0]!.t;
      const plan = det.planTracks(obs);
      const events = det.stepMany(network, states as any, obs, plan);
      if (record) {
        for (const e of events) {
          if (e.kind !== "arrival") continue;
          const k = `${e.busName}|${e.stopId}`;
          let l = detArrivals.get(k);
          if (!l) detArrivals.set(k, (l = []));
          l.push(e.arrivedAt);
        }
      }
      for (const o of obs) {
        const key = plan.keys.get(o.busId) ?? o.busName;
        const st = states.get(key);
        const dwellingForMs = st ? o.collectedAt - st.enteredAt : 0;
        const cand = st && dwellingForMs >= AT_STOP_MIN_DWELL_MS ? net.stopById.get(st.nearestStopId) : undefined;
        const at = st && cand && distanceMeters(o, cand) <= AT_STOP_MAX_M ? { id: st.nearestStopId, since: st.stationarySince } : null;
        const prev = livePositions.get(key);
        if (record && prev && prev.atStopId !== null && at === null) {
          departEvents.push({ t, busName: o.busName, routeId: o.routeId, stopId: prev.atStopId, stoodMs: prev.atStopSince !== null ? t - prev.atStopSince : 0, since: prev.atStopSince });
        }
        livePositions.set(key, { o, atStopId: at ? at.id : null, atStopSince: at ? at.since : null });
      }
      for (const [k, v] of livePositions) if (v.o.collectedAt < t - LIVE_BUS_TTL_MS) livePositions.delete(k);
      const all: BusData[] = [...livePositions.values()].map((v) => ({
        bus_id: v.o.busId, bus_name: v.o.busName, route_id: v.o.routeId, lat: v.o.lat, lon: v.o.lon, heading: v.o.heading,
        last_stop_id: v.o.lastStopId as number, stationary: v.atStopId != null,
        ...(v.atStopId != null ? { at_stop_id: v.atStopId } : {}),
        ...(v.atStopSince != null ? { at_stop_since: new Date(v.atStopSince).toISOString().replace(/Z$/, "") } : {}),
      }));
      // The client drops out-of-service ghosts before anything reads `buses`.
      return all.filter((b) => scheduleMod.isBusInService(b, t));
    },
  };
}

const onRouteBuses = (buses: BusData[], label: string) => {
  const cfg = cfgByLabel.get(label)!;
  const stops = stopsOf(label);
  return buses.filter((b) => cfg.busRouteIds.includes(b.route_id) && anchorMod.isBusOnRoute(b, stops, net.stopCoords));
};

const riders = new Map<string, RiderSpec>();
const addRider = (spec: RiderSpec) => {
  const cur = riders.get(spec.id);
  // A chain rider outranks a uniform/targeted one at the same instant: the
  // chain section must see every rider placed for it.
  if (!cur || (spec.source === "chain" && cur.source !== "chain")) riders.set(spec.id, spec);
};
const alightFor = (label: string, board: number): number | null => {
  const stops = stopsOf(label);
  const idx = stops.indexOf(board);
  return idx < 0 ? null : chooseAlight(stops, idx, net.stopCoords);
};
/**
 * WHERE THE RIDER STANDS, and why it is not always the kerb.
 *
 * The default population stands AT the board stop, which makes `walkToSec` 0
 * and `canCatch` (`walk <= eta + 60`) true for every arrival — so the whole
 * catchability half of `pickLiveArrival` is unreachable and the defects that
 * live there are invisible to the instrument. The canary's rider is not at
 * the kerb (its geolocation is ~200 m from Brown's board stop), and neither
 * is a real one: the app plans from wherever they are and walks them to a
 * stop.
 *
 * `ORIGIN_OFFSET_M` puts every generated rider that many metres from their
 * board stop, on the far side from the stop they are riding to — so the
 * walk is "backwards" along the route and the planner still chooses this
 * board stop rather than re-boarding them somewhere else (riders it re-boards
 * are reported as skipped, as always). 0, the default, is the old population
 * exactly.
 */
const ORIGIN_OFFSET_M = Number(process.env.ORIGIN_OFFSET_M) || 0;
const offsetOrigin = (board: number, alight: number): { lat: number; lon: number } | undefined => {
  if (ORIGIN_OFFSET_M <= 0) return undefined;
  const b = net.stopCoords[board], a = net.stopCoords[alight];
  if (!b || !a) return undefined;
  const mPerLat = 111_320, mPerLon = 111_320 * Math.cos((b.lat * Math.PI) / 180);
  let dx = (b.lon - a.lon) * mPerLon, dy = (b.lat - a.lat) * mPerLat;
  const len = Math.hypot(dx, dy);
  if (len < 1) { dx = 0; dy = 1; } else { dx /= len; dy /= len; }
  return { lat: b.lat + (dy * ORIGIN_OFFSET_M) / mPerLat, lon: b.lon + (dx * ORIGIN_OFFSET_M) / mPerLon };
};
const mkSpec = (label: string, board: number, t0: number, source: RiderSpec["source"], why?: string, origin?: { lat: number; lon: number }, event?: { t: number; bus: string }): RiderSpec | null => {
  if (t0 < FROM || t0 > TO || t0 < dataStart || t0 > dataEnd) return null;
  const alight = alightFor(label, board);
  if (alight === null) return null;
  origin = origin ?? offsetOrigin(board, alight);
  return { id: riderId(label, board, t0), label, boardStopId: board, alightStopId: alight, t0, source, ...(why ? { why } : {}), ...(origin ? { origin } : {}), ...(event ? { eventT: event.t, eventBus: event.bus } : {}) };
};
/**
 * The walk the app bills this rider, every poll — TransitMap's `options` memo:
 * inside AT_PLACE_M of the board stop the rider is "already there", else the
 * live distance at the walk model. A rider with no origin stands at the stop.
 */
const walkToSecFor = (spec: RiderSpec): number => {
  if (!spec.origin) return 0;
  const d = geoMod.haversineMeters(spec.origin, net.stopCoords[spec.boardStopId]!);
  return d < walkMod.AT_PLACE_M ? 0 : walkMod.walkSecFromMeters(d);
};

for (const s of namedArgs) {
  const { label, boardStopId, t0, origin } = parseRiderArg(s);
  if (!cfgByLabel.has(label)) throw new Error(`unknown route label "${label}"`);
  const spec = mkSpec(label, boardStopId, t0, "named", undefined, origin);
  if (!spec) throw new Error(`rider ${s}: stop not on route or outside the data`);
  addRider(spec);
}

{
  // Always: the detector's own arrival events are the secondary truth for
  // every rider, and the targeted population needs the departures.
  log("pass 1: detector only, for the detector's arrivals and the events the targeted riders witness");
  const feed = makeFeed();
  const startIdx = polls.findIndex((p) => p[0]!.t >= DETECTOR_FROM);
  let lastCount = new Map<string, number>();
  let nextUniformAt = Math.max(dataStart, Number.isFinite(FROM) ? FROM : dataStart);
  let lastGridAt = -Infinity;
  for (let pi = Math.max(0, startIdx); pi < polls.length; pi++) {
    const poll = polls[pi]!;
    const t = poll[0]!.t;
    const buses = feed.step(poll, true);
    const counts = new Map<string, number>();
    for (const cfg of ROUTE_LISTS) {
      const n = onRouteBuses(buses, cfg.label).length;
      counts.set(cfg.label, n);
      const was = lastCount.get(cfg.label) ?? 0;
      if (n < was) countDrops.push({ t, label: cfg.label, from: was, to: n });
    }
    lastCount = counts;
    if ((POP === "uniform" || POP === "both") && t >= nextUniformAt) {
      for (const cfg of ROUTE_LISTS) {
        if (!FOCUS.has(cfg.label) && !HOLDOUT.has(cfg.label)) continue;
        if ((counts.get(cfg.label) ?? 0) === 0) continue;
        for (const sid of new Set(stopsOf(cfg.label))) {
          const spec = mkSpec(cfg.label, sid, t, "uniform");
          if (spec) addRider(spec);
        }
      }
      while (nextUniformAt <= t) nextUniformAt += EVERY_MS;
    }
    if ((POP === "targeted" || POP === "both") && t - lastGridAt >= 10 * 60_000) {
      lastGridAt = t;
      for (const cfg of ROUTE_LISTS) {
        if (!FOCUS.has(cfg.label)) continue;
        if ((counts.get(cfg.label) ?? 0) === 0) continue;
        // last half hour before the published close
        if (scheduleMod.isRouteActiveAt(cfg.label, new Date(t)) && !scheduleMod.isRouteActiveAt(cfg.label, new Date(t + TARGET_LAST_BUS_MS))) {
          for (const sid of new Set(stopsOf(cfg.label))) {
            const spec = mkSpec(cfg.label, sid, t, "targeted", "lastBus");
            if (spec) addRider(spec);
          }
        }
      }
    }
  }
  if (POP === "targeted" || POP === "both") {
    for (const d of departEvents) {
      if (d.stoodMs < TARGET_DEPART_MIN_STAND_MS) continue;
      const cfg = cfgByRouteId.get(d.routeId);
      if (!cfg || !FOCUS.has(cfg.label)) continue;
      const stops = stopsOf(cfg.label);
      const i = stops.indexOf(d.stopId);
      if (i < 0) continue;
      const why = `depart ${d.busName} ${net.stopById.get(d.stopId)?.name ?? d.stopId} ${new Date(d.t).toISOString().slice(11, 19)} after ${Math.round(d.stoodMs / 1000)}s`;
      for (let k = 1; k <= TARGET_DOWNSTREAM_STOPS; k++) {
        const sid = stops[(i + k) % stops.length]!;
        for (const off of TARGET_OFFSETS_MS) {
          const spec = mkSpec(cfg.label, sid, d.t - off, "targeted", why);
          if (spec) addRider(spec);
        }
      }
    }
    for (const c of countDrops) {
      if (!FOCUS.has(c.label)) continue;
      for (const sid of new Set(stopsOf(c.label))) {
        const spec = mkSpec(c.label, sid, c.t - 5 * 60_000, "targeted", `busDrop ${c.label} ${c.from}->${c.to} ${new Date(c.t).toISOString().slice(11, 19)}`);
        if (spec) addRider(spec);
      }
    }
  }
  // The chain: every layover at the chain stop, riders at each downstream
  // stop from 30 s after the bus parked, every two minutes while it stays,
  // and 30 s before it leaves — each one tagged with the departure it is
  // downstream of, so the departure moment can be scored.
  if (CHAIN && POP !== "none") {
    const cfg = cfgByLabel.get(CHAIN.label)!;
    for (const d of departEvents) {
      if (d.stopId !== CHAIN.stopId || !cfg.busRouteIds.includes(d.routeId) || d.since === null || d.stoodMs < TARGET_DEPART_MIN_STAND_MS) continue;
      const why = `chain ${d.busName} parked ${new Date(d.since).toISOString().slice(11, 19)} left ${new Date(d.t).toISOString().slice(11, 19)} (${Math.round(d.stoodMs / 1000)}s)`;
      const times = new Set<number>();
      for (let x = d.since + CHAIN_FIRST_MS; x < d.t - CHAIN_BEFORE_DEPART_MS; x += CHAIN_EVERY_MS) times.add(x);
      times.add(d.t - CHAIN_BEFORE_DEPART_MS);
      for (const sid of chainStops) for (const x of times) {
        const spec = mkSpec(CHAIN.label, sid, x, "chain", why, undefined, { t: d.t, bus: d.busName });
        if (spec) addRider(spec);
      }
    }
  }
  log(`departures ${departEvents.length} (>=60 s: ${departEvents.filter((d) => d.stoodMs >= TARGET_DEPART_MIN_STAND_MS).length}), bus-count drops ${countDrops.length}`);
}
const specs = [...riders.values()].sort((a, b) => a.t0 - b.t0);
log(`riders: ${specs.length} (uniform ${specs.filter((s) => s.source === "uniform").length}, targeted ${specs.filter((s) => s.source === "targeted").length}, chain ${specs.filter((s) => s.source === "chain").length}, named ${specs.filter((s) => s.source === "named").length})`);

// -- pass 2: the riders ------------------------------------------------------------

interface Active {
  spec: RiderSpec;
  /** The plan-time option — `stableOptions` in the browser. */
  o: TripOption;
  cohort: number;
  ticks: Tick[];
  truth: Truth;
  busAtStopOnArrival: string | null;
  endAt: number;
}
interface Cohort { store: Map<string, any> | undefined; riders: Set<Active> }
const cohorts = new Map<number, Cohort>();
const results: WaitResult[] = [];
const skipped: Array<{ id: string; reason: string }> = [];
const active = new Set<Active>();
let pending = 0;

function detectorArrival(busName: string | null, stopId: number, t0: number): number | null {
  if (!busName) return null;
  const l = detArrivals.get(`${busName}|${stopId}`);
  if (!l) return null;
  for (const t of l) if (t > t0 - 60_000 && t <= t0 + MAX_WAIT_MS) return t;
  return null;
}

function finish(a: Active, outcome: WaitResult["outcome"]) {
  active.delete(a);
  cohorts.get(a.cohort)?.riders.delete(a);
  const bv = visits.get(a.spec.boardStopId) ?? [];
  const r = scoreWait(a.spec, a.ticks, a.truth, detectorArrival(a.truth.kind === "arrived" ? a.truth.busName : null, a.spec.boardStopId, a.spec.t0), outcome, { sampleMs: SAMPLE_MS }, a.busAtStopOnArrival, bv);
  const c = scoreWait(a.spec, a.ticks, a.truth, r.detectorArrivedAt, outcome, { sampleMs: CANARY_MS }, a.busAtStopOnArrival, bv);
  (r as any).canary = { readings: c.readings, worstDriftSec: c.worstDriftSec, catastrophic: c.catastrophic, reversals: c.reversals, strand: c.strand, sequence: c.sequence, droppedApproaching: c.droppedApproaching, droppedDeclined: c.droppedDeclined, droppedRepriced: c.droppedRepriced };
  results.push(r);
}

/** The trip card for one rider on one poll — the browser's `options` memo and row render, argument for argument. */
function tickFor(a: Active, arr: UpcomingArrival[], buses: BusData[], dw: any, t: number): Tick {
  const o = a.o;
  const cfg = cfgByLabel.get(o.routeLabel)!;
  const live = arr.filter((x) => x.stopId === o.boardStopId && x.routeLabel === o.routeLabel);
  // What the estimator still offers for the vehicle the row followed last
  // poll — the thing that says whether a drop was the card's choice or the
  // estimator's. Read BEFORE the pick, from the same list the pick sees.
  const prevBus = a.ticks.length ? a.ticks[a.ticks.length - 1]!.bus : null;
  let prevSoonest: number | null = null;
  if (prevBus) {
    for (const x of live) {
      if (norm(x.busName) !== norm(prevBus)) continue;
      if (prevSoonest === null || x.eta < prevSoonest) prevSoonest = x.eta;
    }
  }
  const effectiveWalkToSec = walkToSecFor(a.spec);
  const busesAtBoard = buses.filter((b) => cfg.busRouteIds.includes(b.route_id) && b.at_stop_id === o.boardStopId);
  const hereBus = busesAtBoard.find((b) => norm(b.bus_name) === norm(o.busName)) ?? busesAtBoard[0];
  let u: { busName: string; departed: boolean; missedBus?: string; busEtaSec?: number; computedAtMs?: number };
  if (hereBus && effectiveWalkToSec <= plannerMod.dwellBoardWindowSec(hereBus, cfg.routeIds[0]!, o.boardStopId, dw, t)) {
    u = { busName: norm(hereBus.bus_name), departed: false, busEtaSec: 0, computedAtMs: t };
  } else if (live.length === 0) {
    u = { busName: o.busName, departed: true, ...(o.busEtaSec !== undefined ? { busEtaSec: o.busEtaSec } : {}), ...(o.computedAtMs !== undefined ? { computedAtMs: o.computedAtMs } : {}) };
  } else {
    const picked = plannerMod.pickLiveArrival(live, o.busName, effectiveWalkToSec);
    if (!picked) u = { busName: o.busName, departed: true };
    else u = { busName: picked.match.busName, departed: picked.departed, ...(picked.missedBus ? { missedBus: picked.missedBus } : {}), busEtaSec: picked.match.eta, computedAtMs: t };
  }
  // shuttleCtx (row render): is there a pinned bus with a valid anchor?
  const allStops: number[] = [];
  const seen = new Set<number>();
  for (const rid of cfg.routeIds) for (const sid of net.routeStops[rid] ?? []) if (!seen.has(sid)) { seen.add(sid); allStops.push(sid); }
  const bi = allStops.indexOf(o.boardStopId);
  const busMatch = buses.find((b) => norm(b.bus_name) === norm(u.busName) && cfg.busRouteIds.includes(b.route_id) && anchorMod.isBusOnRoute(b, allStops, net.stopCoords)) ?? null;
  const stopsAway = bi >= 0 && busMatch && anchorMod.findRouteAnchor(busMatch, allStops, net.stopCoords) >= 0 ? 1 : null;
  const busEtaLive = busMatch && stopsAway !== null
    ? formatMod.remainingSec(u.busEtaSec ?? o.walkToSec + o.waitSec, u.computedAtMs, t)
    : null;
  if (u.departed) return { t, state: "departed", token: null, etaSec: null, nextSec: null, bus: u.busName, missedBus: null, prevSoonest };
  if (busEtaLive === null) return { t, state: "nopin", token: null, etaSec: null, nextSec: null, bus: u.busName, missedBus: u.missedBus ?? null, prevSoonest };
  const nextArr: UpcomingArrival | null = hasNextRule
    ? arrivalsMod.nextArrivalAfterPinned(live, u.busName, busEtaLive)
    : (live.filter((x) => x.eta > busEtaLive + 30).sort((x, y) => x.eta - y.eta)[0] ?? null);
  const token = formatMod.fmtBusPair(busEtaLive, nextArr?.eta);
  return { t, state: "countdown", token, etaSec: busEtaLive, nextSec: nextArr ? nextArr.eta : null, bus: u.busName, missedBus: u.missedBus ?? null, prevSoonest };
}

{
  log("pass 2: the riders");
  const feed = makeFeed();
  const startIdx = polls.findIndex((p) => p[0]!.t >= DETECTOR_FROM);
  let si = 0;
  for (let pi = Math.max(0, startIdx); pi < polls.length; pi++) {
    const poll = polls[pi]!;
    const t = poll[0]!.t;
    const buses = feed.step(poll, false);
    if (si >= specs.length && active.size === 0) { if (t > (specs[specs.length - 1]?.t0 ?? 0) + MAX_WAIT_MS) break; }
    const segs = segmentsAt(t - CALIB_LAG_MS);
    const dw = dwellsAt(t - CALIB_LAG_MS);

    // riders reaching the stop on this poll
    while (si < specs.length && specs[si]!.t0 <= t) {
      const spec = specs[si++]!;
      const cfg = cfgByLabel.get(spec.label)!;
      // A bus already inside the radius does not end the wait — the canary
      // arms on its first poll for the same reason — but the wait is flagged,
      // because the app is right to say "arriving now" to that rider.
      const truth0 = truthFor(visits.get(spec.boardStopId), cfg.busRouteIds, spec.t0, MAX_WAIT_MS);
      const busAtStopOnArrival = truth0.kind === "boardedOnArrival" ? truth0.busName : null;
      const truth: Truth = busAtStopOnArrival
        ? truthFor(visits.get(spec.boardStopId), cfg.busRouteIds, spec.t0, MAX_WAIT_MS, true)
        : truth0;
      const from = spec.origin ?? net.stopCoords[spec.boardStopId]!;
      const to = net.stopCoords[spec.alightStopId]!;
      const options = plannerMod.planTrip(from, to, buses, net.routeStops, net.stopCoords, segs, dw, null, t);
      const o = options.find((x) => x.routeLabel === spec.label);
      if (!o) { skipped.push({ id: spec.id, reason: "noOption" }); continue; }
      if (o.boardStopId !== spec.boardStopId) { skipped.push({ id: spec.id, reason: `boardElsewhere:${o.boardStopId}` }); continue; }
      let cohort = cohorts.get(t);
      if (!cohort) cohorts.set(t, (cohort = { store: gateMod ? new Map() : undefined, riders: new Set() }));
      const a: Active = { spec, o, cohort: t, ticks: [], truth, busAtStopOnArrival, endAt: truth.kind === "arrived" ? truth.at : spec.t0 + MAX_WAIT_MS };
      cohort.riders.add(a);
      active.add(a);
    }
    pending = specs.length - si;

    // every live cohort: one call, the rider's own anchor memory
    for (const [key, cohort] of cohorts) {
      if (cohort.riders.size === 0) { cohorts.delete(key); continue; }
      const targets = [...new Set([...cohort.riders].map((a) => a.spec.boardStopId))];
      const arr = (arrivalsMod.computeUpcomingArrivals as any)(targets, buses, net.routeStops, net.stopCoords, segs, t, dw, cohort.store) as UpcomingArrival[];
      for (const a of [...cohort.riders]) {
        const tick = tickFor(a, arr, buses, dw, t);
        a.ticks.push(tick);
        if (TRACE && a.spec.source === "named") {
          const cfg = cfgByLabel.get(a.spec.label)!;
          const stops = stopsOf(a.spec.label);
          const board = net.stopCoords[a.spec.boardStopId]!;
          const bs = buses.filter((b) => cfg.busRouteIds.includes(b.route_id)).map((b) => {
            const raw = anchorMod.findRouteAnchor(b, stops, net.stopCoords);
            const g = cohort.store?.get(`${cfg.label}|${b.bus_name}`);
            return `${b.bus_name} d=${Math.round(distanceMeters(b, board))}m last=${b.last_stop_id} at=${b.at_stop_id ?? "-"}${b.at_stop_since ? `(+${Math.round((t - new Date(b.at_stop_since + "Z").getTime()) / 1000)}s)` : ""} anchor=${raw}${g ? `/gate=${g.index}` : ""}/${stops.length}`;
          });
          const live = arr.filter((x) => x.stopId === a.spec.boardStopId && x.routeLabel === a.spec.label).map((x) => `${x.busName}:${Math.round(x.eta)}`);
          console.error(`  ${new Date(t).toISOString().slice(11, 19)} ${a.spec.id.split("|")[0]}@${a.spec.boardStopId} [${tick.state}] "${tick.token ?? ""}" pin=${tick.bus}  live=[${live.join(" ")}]  ${bs.join(" | ")}`);
        }
        if (a.truth.kind === "arrived" && t >= a.truth.at) finish(a, "arrived");
        else if (t >= a.endAt) finish(a, "gaveUp");
      }
    }
    if (pi % 2000 === 0) log(`poll ${pi}/${polls.length} ${fmtEt(t)} ET  active ${active.size}  done ${results.length}  pending ${pending}`);
  }
  for (const a of [...active]) finish(a, "dataEnded");
}
log(`waits ${results.length}, skipped ${skipped.length}`);

// -- output --------------------------------------------------------------------------

const primary = aggregate(results);
const canaryView = aggregate(results.map((r) => ({ ...r, ...((r as any).canary as object) })));
const bySource = {
  uniform: aggregate(results.filter((r) => r.source === "uniform")),
  targeted: aggregate(results.filter((r) => r.source === "targeted")),
  chain: aggregate(results.filter((r) => r.source === "chain")),
};
const focus = aggregate(results.filter((r) => FOCUS.has(r.label) && r.source !== "chain"));
const holdout = aggregate(results.filter((r) => HOLDOUT.has(r.label)));
const chain = CHAIN ? chainSummary(results.filter((r) => r.source === "chain"), chainStops) : null;
const skippedReasons: Record<string, number> = {};
for (const s of skipped) { const k = s.reason.split(":")[0]!; skippedReasons[k] = (skippedReasons[k] ?? 0) + 1; }

const out = {
  generatedAt: new Date().toISOString(),
  config: { captureFiles, REPLAY_DB: process.env.REPLAY_DB ?? "./store/snap.db", CLIENT_ROOT, PAYLOAD_PATCH: process.env.PAYLOAD_PATCH ?? null, POP, EVERY_MS, MAX_WAIT_MS, SAMPLE_MS, CANARY_MS, CALIB_LAG_MS, FROM: process.env.FROM ?? null, TO: process.env.TO ?? null, DETECTOR_FROM: new Date(DETECTOR_FROM).toISOString() },
  tree,
  data: { positions: rows.length, polls: polls.length, start: new Date(dataStart).toISOString(), end: new Date(dataEnd).toISOString() },
  population: { focus: [...FOCUS], holdout: [...HOLDOUT], chain: CHAIN ? { ...CHAIN, stops: chainStops } : null, riders: specs.length, bySource: { uniform: specs.filter((s) => s.source === "uniform").length, targeted: specs.filter((s) => s.source === "targeted").length, chain: specs.filter((s) => s.source === "chain").length, named: specs.filter((s) => s.source === "named").length }, skipped: skippedReasons },
  summary: primary,
  summaryCanaryCadence: canaryView,
  focus,
  holdout,
  chain,
  bySource,
  named: results.filter((r) => r.source === "named"),
};
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(`${OUT_DIR}/${OUT_NAME}.json`, JSON.stringify(out, null, 1));
fs.writeFileSync(`${OUT_DIR}/${OUT_NAME}.waits.jsonl`, results.map((r) => JSON.stringify(r)).join("\n") + "\n");
log(`wrote ${OUT_DIR}/${OUT_NAME}.json and .waits.jsonl`);

console.log(`\nrider-sim: ${out.data.start} .. ${out.data.end}  tree ${tree.head}${tree.dirty ? " (dirty)" : ""}  riders ${specs.length}  skipped ${JSON.stringify(skippedReasons)}`);
for (const r of out.named) {
  console.log(`\n## ${r.id}  ${net.stopById.get(r.boardStopId)?.name ?? ""}  outcome ${r.outcome}${r.arrivedAt ? ` (bus ${r.arrivedBus} at ${new Date(r.arrivedAt).toISOString().slice(11, 19)}, wait ${r.waitSec}s; detector ${r.detectorArrivedAt ? new Date(r.detectorArrivedAt).toISOString().slice(11, 19) : "-"})` : ""}`);
  console.log(`   first sight ${r.firstSight ? `"${r.firstSight.raw}" @${new Date(r.firstSight.atMs).toISOString().slice(11, 19)}` : "-"}  miss ${r.firstSightMissSec}s  worst drift ${r.worst ? `${r.worst.driftSec}s ("${r.worst.from}" -> "${r.worst.to}" @${new Date(r.worst.atMs).toISOString().slice(11, 19)})` : "-"}  reversals ${r.reversals}  pins ${r.pins.join(">")}  vanished ${r.vanished}  strand ${r.strand}`);
  console.log(`   5 s: ${r.sequence}`);
  console.log(`   15 s: ${(r as any).canary.sequence}`);
}
console.log();
if (chain && CHAIN) {
  console.log(renderChain(`CHAIN — ${CHAIN.label} riders downstream of ${net.stopById.get(CHAIN.stopId)?.name ?? CHAIN.stopId} while a bus is parked there or leaving (${bySource.chain.all.scored} scored waits)`, chain, (id) => net.stopById.get(id)?.name ?? String(id)));
  console.log();
}
console.log(renderSummary(`FOCUS ${[...FOCUS].join(", ")} — uniform + targeted riders, every poll (5 s)`, focus));
console.log();
console.log(renderSummary(`HOLDOUT ${[...HOLDOUT].join(", ")} — uniform riders (a fix tuned on the focus must not regress these)`, holdout));
console.log();
console.log(renderSummary("UNIFORM population (focus + holdout)", bySource.uniform));
console.log();
console.log(renderSummary("TARGETED population (focus)", bySource.targeted));
console.log();
console.log(renderSummary("ALL riders, canary cadence (15 s)", canaryView));
