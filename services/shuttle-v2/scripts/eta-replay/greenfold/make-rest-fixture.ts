/**
 * Write `web/src/__fixtures__/green-fold-rest.json` from a captured
 * `/api/buses` poll directory plus the detector's own visit/arrival rows.
 *
 * `raw_positions` is swept at 6 h and route 9 had no rider rows in
 * `predictions_log` that day, so the capture IS the record — see
 * `scripts/eta-replay/greenfold/README.md`.
 *
 *   D=<capture dir> V=<events json with {a,v}> OUT=web/src/__fixtures__/green-fold-rest.json \
 *     npx tsx scripts/eta-replay/greenfold/make-rest-fixture.ts
 */
import fs from "node:fs";

const D = process.env.D!;
const derived = JSON.parse(fs.readFileSync(`${D}/derived.json`, "utf8")) as any[];
const files = fs.readdirSync(`${D}/buses`).sort().filter((f) => f.endsWith(".json"));
const tmpl = JSON.parse(fs.readFileSync(`${D}/buses/${files[0]!}`, "utf8"));
const ev = JSON.parse(fs.readFileSync(process.env.V!, "utf8"));
// A second dump continues the arrival list past the first one's open row, so
// the downstream stops the incident was scored against (the station, Bradley
// (N), Willow (N)) have a truth instant. Deduped on (stop, arrival).
const more: any[] = process.env.V2 ? JSON.parse(fs.readFileSync(process.env.V2, "utf8")) : [];

const FROM = Date.parse("2026-09-12T14:05:00Z");
const TO = Date.parse("2026-09-12T14:33:30Z");
const positions = derived.filter((d) => d.t >= FROM && d.t <= TO).map((d) => ({
  t: d.t, lat: d.lat, lon: d.lon, heading: d.heading, last_stop_id: d.last,
  at_stop_id: d.at ?? null, at_stop_since: d.atSince ?? null,
  stationary_since: d.ss ?? null, last_moved_at: d.moved ?? null,
}));
const stops: number[] = tmpl.routes["9"];
const ids = new Set<number>(stops);
const pick = <T,>(o: Record<string, T>) => Object.fromEntries(Object.entries(o).filter(([k]) => ids.has(Number(k))));

const out = {
  capturedAt: new Date().toISOString(),
  note: "Green (route 9) bus #331 standing 435 s at Building 800 on 2026-09-12, 10:16-10:24 ET. Building 800 is ring 13 OUTBOUND and ring 18 on the return, the same kerb; the published line's outbound pass never comes within 99 m of it. The detector's stop_visits row for this stand names stop_index 13. Recorded from captured /api/buses polls (raw_positions was swept) by scripts/eta-replay/greenfold/make-rest-fixture.ts.",
  routeId: "9",
  routeLabel: "Green",
  busName: "#331",
  busRouteId: 9,
  restStopId: 25,
  restRingIndex: 13,
  rest: { arrivedAt: 1789222568862, pinnedAt: 1789222583669, departedAt: 1789223023668, standSec: 435.059 },
  stopNames: pick(tmpl.stop_names),
  routeStops: { "9": stops },
  stopCoords: pick(tmpl.stop_coords),
  routePath: tmpl.route_paths["9"],
  segments: { "9": tmpl.segments["9"] ?? {} },
  dwells: { "9": tmpl.dwells["9"] ?? {} },
  // The whole WIRE object: applyModelParams reads `wire.params`, so handing
  // it the inner params silently resets to the compiled defaults.
  modelParams: tmpl.model_params ?? null,
  positions,
  visits: (ev.v as any[]).map((v) => ({ stopId: v.stop_id, stopIndex: v.stop_index, arrivedAt: v.anchored_at, pinnedAt: v.pinned_at, departedAt: v.departed_at, standSec: v.stand_sec, outcome: v.outcome })),
  arrivals: [...(ev.a as any[]), ...more]
    .filter((a, i, all) => all.findIndex((b) => b.stop_id === a.stop_id && b.arrived_at === a.arrived_at) === i)
    .sort((a, b) => a.arrived_at - b.arrived_at)
    .map((a) => ({ stopId: a.stop_id, arrivedAt: a.arrived_at, departedAt: a.departed_at })),
};
fs.writeFileSync(process.env.OUT!, JSON.stringify(out, null, 1));
console.log(`positions ${positions.length}  visits ${out.visits.length}  arrivals ${out.arrivals.length}  modelParams ${out.modelParams ? "yes" : "no"}`);
console.log(`span ${new Date(positions[0]!.t).toISOString()} -> ${new Date(positions.at(-1)!.t).toISOString()}`);
