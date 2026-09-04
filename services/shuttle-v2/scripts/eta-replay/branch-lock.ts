/**
 * BRANCH LOCK — how often the client puts a bus on the wrong branch of a fold.
 *
 * Green (9) and Purple (10) run out to West Campus and back along the same
 * road, so the same coordinates belong to two legs at once. A point anchor has
 * to choose, and choosing wrong does not cost a stop, it costs a LAP: the
 * rider is shown the bus's next visit an hour out, or a bus an hour away as
 * "2 min". `docs/eta-estimator-design.md` measured the class at 118 of 380
 * Purple departures and 104 of 383 Green ones for the filter arms it was
 * grading; this script measures it for the SHIPPED client, so a candidate can
 * be scored on the mechanism as well as on the rider (`rider-sim/`).
 *
 * TRUTH is the collector's own detector (`stepMany`). It is not a better
 * anchor in general — its index switches at the midpoint between stops while
 * the client's means "the segment the bus is on", so the two disagree by a
 * stop constantly and neither is wrong — but it never has to CHOOSE a branch:
 * it walks the sequence forward from where the bus already was, two stops of
 * lookahead, and only re-anchors globally when something is 150 m closer. So a
 * disagreement of a stop or two says nothing, and a disagreement of a QUARTER
 * OF THE LOOP is the branch and nothing else. That is what is counted here.
 *
 * Two populations, because they answer different questions:
 *   every poll     — how much of the day a rider watching this bus is looking
 *                    at the wrong branch
 *   at a departure — the poll `at_stop_id` clears, which is the moment the
 *                    doc's number is quoted at and the moment a rider is
 *                    deciding whether to run
 *
 * The client is driven exactly as the app drives it: one shared `AnchorStore`
 * for the whole session (production's `liveAnchorStore`), `noteFix` then
 * `findRouteAnchor` then `gateAnchor`, all imported from CLIENT_ROOT so two
 * trees can be compared on one capture.
 *
 *   cd services/shuttle-v2
 *   TZ=America/New_York npx tsx scripts/eta-replay/branch-lock.ts
 *   CLIENT_ROOT=/path/to/worktree/services/shuttle-v2 ... npx tsx scripts/eta-replay/branch-lock.ts
 *
 * Env: CAPTURE (default every ~/shuttle-captures/positions-*.jsonl), CLIENT_ROOT,
 *      ROUTES (default Green,Purple; "all" for every line), FROM/TO (ISO).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadNet } from "../eta-replay/common.js";
import { dedupeAndSort, groupPolls, parseCaptureLine, type PosRow } from "./rider-sim/lib.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_ROOT = path.resolve(process.env.CLIENT_ROOT ?? path.resolve(HERE, "../.."));
const log = (...a: unknown[]) => console.error("[branch-lock]", ...a);

async function fromClient<T>(rel: string): Promise<T> {
  return (await import(pathToFileURL(path.join(CLIENT_ROOT, rel)).href)) as T;
}
type AnchorMod = typeof import("../../web/src/anchor");
type GateMod = typeof import("../../web/src/anchorGate");
type RoutesMod = typeof import("../../web/src/routes");
type DetMod = typeof import("../../src/collector/detector.js");

const anchorMod = await fromClient<AnchorMod>("web/src/anchor.ts");
const routesMod = await fromClient<RoutesMod>("web/src/routes.ts");
const det = await fromClient<DetMod>("src/collector/detector.ts");
let gateMod: GateMod | null = null;
try { gateMod = await fromClient<GateMod>("web/src/anchorGate.ts"); } catch { gateMod = null; }
const hasNoteFix = !!gateMod && typeof (gateMod as { noteFix?: unknown }).noteFix === "function";

const AT_STOP_MAX_M = 75;
const AT_STOP_MIN_DWELL_MS = 15_000;

const net = loadNet();
const network = net.network as unknown as Parameters<DetMod["stepMany"]>[0];
anchorMod.registerRoutePaths(net.routePaths as never);

const wanted = (process.env.ROUTES ?? "Green,Purple").split(",").map((s) => s.trim()).filter(Boolean);
const cfgs = routesMod.ROUTE_LISTS.filter((c) => wanted.includes("all") || wanted.includes(c.label));
const stopsOf = new Map(cfgs.map((c) => [c.label, routesMod.mergedRouteStops(c, net.routeStops)] as const));

const captureFiles = (process.env.CAPTURE
  ? process.env.CAPTURE.split(",")
  : fs.readdirSync(`${process.env.HOME}/shuttle-captures`).filter((f) => /^positions-\d{8}\.jsonl$/.test(f)).sort()
      .map((f) => `${process.env.HOME}/shuttle-captures/${f}`)
).map((f) => f.trim()).filter(Boolean);
let raw: PosRow[] = [];
for (const f of captureFiles) for (const line of fs.readFileSync(f, "utf8").split("\n")) {
  const r = parseCaptureLine(line);
  if (r) raw.push(r);
}
const rows = dedupeAndSort(raw);
raw = [];
const polls = groupPolls(rows);
const FROM = process.env.FROM ? Date.parse(process.env.FROM) : -Infinity;
const TO = process.env.TO ? Date.parse(process.env.TO) : Infinity;
log(`${rows.length} positions, ${polls.length} polls; client ${CLIENT_ROOT} (noteFix=${hasNoteFix})`);

interface Tally { polls: number; lap: number; departures: number; departuresLap: number; gap: number[]; heldMoved: number; heldFrozen: number; movedPolls: number; frozenPolls: number }
const tally = new Map<string, Tally>();
const get = (label: string): Tally => {
  let t = tally.get(label);
  if (!t) tally.set(label, (t = { polls: 0, lap: 0, departures: 0, departuresLap: 0, gap: [], heldMoved: 0, heldFrozen: 0, movedPolls: 0, frozenPolls: 0 }));
  return t;
};

const states = new Map<string, import("../../src/collector/detector.js").BusState>();
const store: import("../../web/src/anchorGate").AnchorStore = new Map();
/** the last coordinate each bus reported, to tell a fresh fix from a repeat */
const lastCoord = new Map<string, { lat: number; lon: number }>();
/** previous poll's at_stop_id per bus, to spot the departure instant */
const wasAtStop = new Map<string, number | null>();

for (const poll of polls) {
  const t = poll[0]!.t;
  const obs = poll.map((p) => ({ busId: p.i, busName: p.b, routeId: p.r, lat: p.lat, lon: p.lon, heading: p.h, lastStopId: p.l, collectedAt: p.t }));
  const plan = det.planTracks(obs);
  det.stepMany(network, states as never, obs, plan);
  if (t < FROM || t > TO) continue;

  for (const o of obs) {
    const cfg = cfgs.find((c) => c.busRouteIds.includes(o.routeId));
    if (!cfg) continue;
    const stops = stopsOf.get(cfg.label)!;
    const N = stops.length;
    const key = plan.keys.get(o.busId) ?? o.busName;
    const st = states.get(key);
    if (!st) continue;
    // The detector's index is into the raw sequence; the client's is into the
    // merged one. They are the same list for every route with one stop list.
    const detIdx = st.nearestIndex;
    if (detIdx < 0 || detIdx >= N) continue;

    const dwellingForMs = t - st.enteredAt;
    const cand = dwellingForMs >= AT_STOP_MIN_DWELL_MS ? net.stopById.get(st.nearestStopId) : undefined;
    const near = cand
      ? Math.hypot((o.lat - cand.lat) * 111_000, (o.lon - cand.lon) * 84_000) <= AT_STOP_MAX_M
      : false;
    const atStopId = cand && near ? st.nearestStopId : null;

    const bus = {
      lat: o.lat, lon: o.lon, last_stop_id: o.lastStopId ?? undefined,
      ...(atStopId != null ? { at_stop_id: atStopId } : {}),
    };
    if (!anchorMod.isBusOnRoute({ ...bus, route_id: o.routeId }, stops, net.stopCoords)) continue;

    const gkey = `${cfg.label}|${o.busName}`;
    const hint = hasNoteFix
      ? (gateMod as unknown as { noteFix: (s: typeof store, k: string, b: unknown, n: number) => { lat: number; lon: number } | null })
          .noteFix(store, gkey, bus, t)
      : null;
    const rawIdx = (anchorMod.findRouteAnchor as (b: unknown, s: number[], c: unknown, h?: unknown) => number)(
      bus, stops, net.stopCoords, hint,
    );
    if (rawIdx < 0) continue;
    // The feed repeats a coordinate rather than interpolating (53.6% of
    // samples), so "did anything happen this poll" is asked of the raw fix,
    // tracked here rather than read off the client's own memory — the baseline
    // client has none.
    const seen = lastCoord.get(gkey);
    const fixMoved = !seen || seen.lat !== o.lat || seen.lon !== o.lon;
    lastCoord.set(gkey, { lat: o.lat, lon: o.lon });
    const gr = gateMod ? gateMod.gateAnchor(store, gkey, rawIdx, bus, t, N) : { index: rawIdx, released: "first" as const };
    const idx = gr.index;

    // Cyclic distance in sequence positions, the short way round.
    const fwd = ((idx - detIdx) % N + N) % N;
    const gap = Math.min(fwd, N - fwd);
    const lap = gap > N / 4;

    const tl = get(cfg.label);
    tl.polls++;
    if (fixMoved) tl.movedPolls++; else tl.frozenPolls++;
    if (gr.released === null) { if (fixMoved) tl.heldMoved++; else tl.heldFrozen++; }
    if (lap) tl.lap++;
    tl.gap.push(gap);
    const prevAt = wasAtStop.get(gkey);
    if (prevAt !== undefined && prevAt !== null && atStopId === null) {
      tl.departures++;
      if (lap) tl.departuresLap++;
    }
    wasAtStop.set(gkey, atStopId);
  }
}

const pct = (n: number, d: number) => (d ? ((100 * n) / d).toFixed(1) : "—");
const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]! : 0);
console.log(`\nbranch lock vs the detector's own anchor — client ${CLIENT_ROOT}`);
console.log("  a gap over a quarter of the loop is the branch; anything smaller is the two anchors' different definitions\n");
console.log("  route          polls   lap-wrong        departures   lap-wrong at departure   median gap");
for (const label of [...tally.keys()].sort()) {
  const t = tally.get(label)!;
  console.log(
    `  ${label.padEnd(13)} ${String(t.polls).padStart(6)}  ${String(t.lap).padStart(6)} (${pct(t.lap, t.polls).padStart(4)}%)` +
    `   ${String(t.departures).padStart(6)}      ${String(t.departuresLap).padStart(4)} of ${String(t.departures).padStart(4)} (${pct(t.departuresLap, t.departures).padStart(4)}%)` +
    `        ${median(t.gap)}`,
  );
}
console.log("\n  the gate's holds, split by whether the raw fix moved this poll (a hold is the anchor declining to relocate)");
console.log("  route          fix moved   held        fix repeated   held");
for (const label of [...tally.keys()].sort()) {
  const t = tally.get(label)!;
  console.log(
    `  ${label.padEnd(13)} ${String(t.movedPolls).padStart(7)} ${String(t.heldMoved).padStart(6)} (${pct(t.heldMoved, t.movedPolls).padStart(4)}%)` +
    `   ${String(t.frozenPolls).padStart(10)} ${String(t.heldFrozen).padStart(6)} (${pct(t.heldFrozen, t.frozenPolls).padStart(4)}%)`,
  );
}
