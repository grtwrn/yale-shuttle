/**
 * HOLD ANATOMY — what the anchor gate freezes, for how long, and whether the
 * freeze is the gate working or the gate stuck.
 *
 * WHY THIS EXISTS. `gateAnchor` is a ring-aware VETO in front of a chooser that
 * (before the ring prior) had no memory: `findRouteAnchor` re-decided from
 * scratch every poll, proposed whatever leg looked best, and the gate could
 * only accept it or FREEZE the bus where it was. Freezing is the thing the
 * operator ruled out as a way to buy stability, so the size and shape of the
 * freeze population is a number a candidate has to be judged on — not just its
 * strand and jump shares.
 *
 *   "I don't want a slew limiter. it can go 5->1 if it leaves early. but if it
 *    is jitter we need a fix."
 *
 * WHAT IT PRINTS, per route:
 *
 *   held / held-while-the-fix-moved   the freeze share, split the way
 *                                     `docs/eta-estimator-design.md` splits it
 *   backwards / forward               whether the REFUSED proposal read as a
 *                                     retreat on the ring. A backwards hold is
 *                                     the gate working — the proposal was
 *                                     physically impossible and no chooser
 *                                     should have made it. A forward hold is
 *                                     the conservative half: the move was
 *                                     possible and the corroboration rules
 *                                     could not account for it
 *   lap-wrong                         how often the shown anchor sits a quarter
 *                                     of the loop from the detector's
 *   hold episodes                     contiguous runs of refusal, longest first
 *
 * TRUTH is the collector's own detector (`stepMany`), with the caveat
 * `branch-lock.ts` states: its index switches at the midpoint between stops
 * while the client's means "the segment the bus is on", so a one-slot
 * disagreement is definitional and says nothing. Only a gap over a quarter of
 * the loop is read. AND IT IS AN INDEX METRIC: where it and the rider simulator
 * disagree, the simulator decides. That is not hypothetical here — see below.
 *
 * WHAT IT MEASURED, 2026-09-04 capture, Red + Green + Purple, 74,976 polls:
 *
 *   tree                     held    held/moved   backwards   lap-wrong   longest hold
 *   926af30 (before #90/#93) 22.2%     29.8%        93.0%        5.1%         300 s
 *   4a59795 (after)          44.8%     48.9%        98.3%       11.0%       3,567 s
 *   91e4467 (after #97)      25.4%     32.2%        96.3%        4.3%       2,348 s
 *
 * PRs #90 and #93 doubled the freeze and doubled the index-level lap-wrongness,
 * and by closing the backwards half of the 300 s timeout valve they removed the
 * bound on how long a wrong hold can last. PR #97 then gave most of it back, by
 * letting `at_stop_id` pull a backwards anchor home when the flag names the very
 * slot the scan proposes.
 *
 * AND THE RIDERS WERE BETTER OFF THROUGHOUT. Paired on the rider simulator
 * (8,327 waits, 2026-09-03 capture, `rider-sim/run.ts --compare`), 926af30 ->
 * 4a59795: 248 waits lose a jump >=180 s against 8 that gain one, 173 lose a
 * strand against 75, 445 lose a >=60 s reversal against 4, worst drift improved
 * on 765 and worsened on 79. The holds those PRs added are overwhelmingly right.
 *
 * That is the whole reason this script prints an index metric and then tells
 * you not to decide on it. The freeze is a cost to WATCH, not a defect on its
 * own; what makes it a defect is a hold that spans a real departure, which the
 * trace below is for (`TRACE=#316`, the operator's reference incident).
 *
 *   cd services/shuttle-v2
 *   TZ=America/New_York npx tsx scripts/eta-replay/hold-anatomy.ts
 *   CLIENT_ROOT=/path/to/worktree/services/shuttle-v2 ... npx tsx scripts/eta-replay/hold-anatomy.ts
 *
 * Env: CAPTURE (default every ~/shuttle-captures/positions-*.jsonl), CLIENT_ROOT,
 *      ROUTES (default all), FROM/TO (ISO), TRACE=Label|#bus|Label|#bus to print
 *      every poll for one bus, EPISODES=n (default 15).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadNet } from "../eta-replay/common.js";
import { dedupeAndSort, groupPolls, parseCaptureLine, type PosRow } from "./rider-sim/lib.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_ROOT = path.resolve(process.env.CLIENT_ROOT ?? path.resolve(HERE, "../.."));
const log = (...a: unknown[]) => console.error("[hold-anatomy]", ...a);

async function fromClient<T>(rel: string): Promise<T> {
  return (await import(pathToFileURL(path.join(CLIENT_ROOT, rel)).href)) as T;
}
type AnchorMod = typeof import("../../web/src/anchor");
type GateMod = typeof import("../../web/src/anchorGate");
type RoutesMod = typeof import("../../web/src/routes");
type GeoMod = typeof import("../../web/src/geo");
type DetMod = typeof import("../../src/collector/detector.js");

const anchorMod = await fromClient<AnchorMod>("web/src/anchor.ts");
const routesMod = await fromClient<RoutesMod>("web/src/routes.ts");
const geo = await fromClient<GeoMod>("web/src/geo.ts");
const det = await fromClient<DetMod>("src/collector/detector.ts");
const gateMod = await fromClient<GateMod>("web/src/anchorGate.ts");

/**
 * A tree that knows the ring prior gets one, and its `raw` column is then the
 * WINDOWED proposal rather than the stateless one. A tree that does not is
 * driven exactly as production drives it, so two trees are comparable on one
 * capture.
 */
const ringPriorOf = (gateMod as unknown as {
  ringPrior?: (s: AnchorStore, k: string, n: number) => unknown;
}).ringPrior;
type AnchorStore = import("../../web/src/anchorGate").AnchorStore;

const AT_STOP_MAX_M = 75;
const AT_STOP_MIN_DWELL_MS = 15_000;

const net = loadNet();
const network = net.network as unknown as Parameters<DetMod["stepMany"]>[0];
anchorMod.registerRoutePaths(net.routePaths as never);

const wanted = (process.env.ROUTES ?? "all").split(",").map((s) => s.trim()).filter(Boolean);
const cfgs = routesMod.ROUTE_LISTS.filter((c) => wanted.includes("all") || wanted.includes(c.label));
const stopsOf = new Map(cfgs.map((c) => [c.label, routesMod.mergedRouteStops(c, net.routeStops)] as const));

const captureFiles = (process.env.CAPTURE
  ? process.env.CAPTURE.split(",")
  : fs.readdirSync(`${process.env.HOME}/shuttle-captures`)
      .filter((f) => /^positions-\d{8}\.jsonl$/.test(f)).sort()
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
const TRACE = process.env.TRACE ?? "";
log(`${rows.length} positions, ${polls.length} polls; client ${CLIENT_ROOT} (ringPrior=${!!ringPriorOf})`);

interface Tally {
  polls: number; moved: number;
  heldMoved: number; heldFrozen: number;
  heldBackwards: number; heldForward: number;
  lapWrong: number; gap: number[];
}
const tally = new Map<string, Tally>();
const get = (label: string): Tally => {
  let t = tally.get(label);
  if (!t) tally.set(label, (t = {
    polls: 0, moved: 0, heldMoved: 0, heldFrozen: 0,
    heldBackwards: 0, heldForward: 0, lapWrong: 0, gap: [],
  }));
  return t;
};

/** One contiguous run of held polls for one bus. */
interface Episode {
  label: string; bus: string; from: number; to: number;
  polls: number; movedPolls: number; backwards: number; maxDelta: number;
}
const openEp = new Map<string, Episode>();
const episodes: Episode[] = [];

const states = new Map<string, import("../../src/collector/detector.js").BusState>();
const store: AnchorStore = new Map();
/** the last coordinate each bus reported, to tell a fresh fix from a repeat */
const lastCoord = new Map<string, { lat: number; lon: number }>();

for (const poll of polls) {
  const t = poll[0]!.t;
  const obs = poll.map((p) => ({
    busId: p.i, busName: p.b, routeId: p.r, lat: p.lat, lon: p.lon,
    heading: p.h, lastStopId: p.l, collectedAt: p.t,
  }));
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
    const detIdx = st.nearestIndex;
    if (detIdx < 0 || detIdx >= N) continue;

    // The collector's own at-stop rule, so the client sees what production
    // serves rather than a reconstruction of it.
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
    const before = store.get(gkey);
    const prevIdx = before && before.index >= 0 ? before.index : -1;

    const hint = gateMod.noteFix(store, gkey, bus, t);
    const prior = ringPriorOf ? ringPriorOf(store, gkey, t) : null;
    const rawIdx = (anchorMod.findRouteAnchor as (
      b: unknown, s: number[], c: unknown, h?: unknown, p?: unknown,
    ) => number)(bus, stops, net.stopCoords, hint, prior);
    if (rawIdx < 0) continue;

    // The feed repeats a coordinate rather than interpolating (53.6% of
    // samples), so "did anything happen this poll" is asked of the raw fix,
    // tracked here rather than read off the client's own memory.
    const seen = lastCoord.get(gkey);
    const fixMoved = !seen || seen.lat !== o.lat || seen.lon !== o.lon;
    const stepM = seen ? geo.haversineMeters({ lat: o.lat, lon: o.lon }, seen) : 0;
    lastCoord.set(gkey, { lat: o.lat, lon: o.lon });

    // `stops` is PR #97's seventh argument: the gate asks whether `at_stop_id`
    // names the very slot the scan proposes, which is the one backwards move it
    // still allows. Omitting it silently scores a pre-#97 gate — an extra
    // argument is harmless on a tree that predates it.
    const gr = (gateMod.gateAnchor as (
      s: AnchorStore, k: string, r: number, b: unknown, n: number, c: number, seq?: readonly number[],
    ) => { index: number; released: string | null })(store, gkey, rawIdx, bus, t, N, stops);
    const idx = gr.index;
    const held = gr.released === null;

    const fwdRaw = prevIdx >= 0 ? ((rawIdx - prevIdx) % N + N) % N : 0;
    const backwards = prevIdx >= 0 && fwdRaw > N / 2;
    const fwdDet = ((idx - detIdx) % N + N) % N;
    const gap = Math.min(fwdDet, N - fwdDet);

    const tl = get(cfg.label);
    tl.polls++;
    if (fixMoved) tl.moved++;
    if (gap > N / 4) tl.lapWrong++;
    tl.gap.push(gap);
    if (held) {
      if (fixMoved) tl.heldMoved++; else tl.heldFrozen++;
      if (backwards) tl.heldBackwards++; else tl.heldForward++;

      let ep = openEp.get(gkey);
      if (!ep) {
        ep = { label: cfg.label, bus: o.busName, from: t, to: t, polls: 0, movedPolls: 0, backwards: 0, maxDelta: 0 };
        openEp.set(gkey, ep);
      }
      ep.to = t;
      ep.polls++;
      if (fixMoved) ep.movedPolls++;
      if (backwards) ep.backwards++;
      ep.maxDelta = Math.max(ep.maxDelta, Math.min(fwdRaw, N - fwdRaw));
    } else {
      const ep = openEp.get(gkey);
      if (ep) { episodes.push(ep); openEp.delete(gkey); }
    }

    if (TRACE && (TRACE === cfg.label || TRACE === o.busName || TRACE === gkey)) {
      console.log(
        `${new Date(t).toISOString()} ${cfg.label} ${o.busName} last=${o.lastStopId ?? "-"} ` +
        `at=${atStopId ?? "-"} fix=${fixMoved ? "moved" : "same"} step=${stepM.toFixed(0)}m ` +
        `prev=${prevIdx} raw=${rawIdx} shown=${idx}${held ? " HELD" : ` (${gr.released})`} det=${detIdx}`,
      );
    }
  }
}
for (const ep of openEp.values()) episodes.push(ep);

const pct = (n: number, d: number) => (d ? ((100 * n) / d).toFixed(1) : "—");
const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]! : 0);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

const labels = [...tally.keys()].sort();
console.log(`\nHOLD ANATOMY — client ${CLIENT_ROOT}`);
console.log("\n  A hold is the gate refusing to relocate the bus. Split by whether the REFUSED");
console.log("  proposal read backwards on the ring: backwards = the gate working (the move was");
console.log("  impossible), forward = the conservative half (it was possible and unaccounted).\n");
console.log("  route          polls    held            held/moved      backwards       forward       lap-wrong   median gap");
for (const l of labels) {
  const t = tally.get(l)!;
  const held = t.heldMoved + t.heldFrozen;
  console.log(
    `  ${l.padEnd(13)} ${String(t.polls).padStart(6)}  ${String(held).padStart(6)} (${pct(held, t.polls).padStart(4)}%)` +
    `   ${String(t.heldMoved).padStart(6)} (${pct(t.heldMoved, t.moved).padStart(4)}%)` +
    `   ${String(t.heldBackwards).padStart(6)} (${pct(t.heldBackwards, held).padStart(4)}%)` +
    `  ${String(t.heldForward).padStart(6)} (${pct(t.heldForward, held).padStart(4)}%)` +
    `     ${pct(t.lapWrong, t.polls).padStart(5)}%       ${median(t.gap)}`,
  );
}

const tot = labels.reduce((a, l) => {
  const t = tally.get(l)!;
  a.polls += t.polls; a.moved += t.moved; a.held += t.heldMoved + t.heldFrozen;
  a.heldMoved += t.heldMoved; a.back += t.heldBackwards; a.fwd += t.heldForward;
  a.lap += t.lapWrong;
  return a;
}, { polls: 0, moved: 0, held: 0, heldMoved: 0, back: 0, fwd: 0, lap: 0 });
console.log(
  `\n  ALL: ${tot.polls} polls, ${tot.held} held (${pct(tot.held, tot.polls)}%), ` +
  `${tot.heldMoved} while the fix moved (${pct(tot.heldMoved, tot.moved)}% of moving polls). ` +
  `Backwards ${pct(tot.back, tot.held)}%, forward ${pct(tot.fwd, tot.held)}%. ` +
  `Lap-wrong vs the detector ${pct(tot.lap, tot.polls)}%.`,
);

const EPISODES = Number(process.env.EPISODES ?? 15);
episodes.sort((a, b) => (b.to - b.from) - (a.to - a.from));
console.log(`\n  The ${EPISODES} longest hold episodes — a contiguous run of polls the gate refused:`);
console.log("  route        bus     from       held for   polls  fix moved  backwards  max |delta|");
for (const ep of episodes.slice(0, EPISODES)) {
  console.log(
    `  ${ep.label.padEnd(12)} ${ep.bus.padEnd(6)} ${new Date(ep.from).toISOString().slice(11, 19)}` +
    `  ${String(Math.round((ep.to - ep.from) / 1000)).padStart(7)}s  ${String(ep.polls).padStart(5)}` +
    `  ${String(ep.movedPolls).padStart(9)}  ${String(ep.backwards).padStart(9)}  ${String(ep.maxDelta).padStart(10)}`,
  );
}
const durs = episodes.map((e) => (e.to - e.from) / 1000);
console.log(
  `\n  ${episodes.length} hold episodes, median ${median(durs)}s, mean ${mean(durs).toFixed(1)}s, ` +
  `${episodes.filter((e) => e.to - e.from >= 60_000).length} lasting a minute or more, ` +
  `${episodes.filter((e) => e.movedPolls > 0).length} with the fix moving at some point.`,
);
console.log("\n  An index metric. Where this and rider-sim disagree, the simulator decides.");
