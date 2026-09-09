/** Scoring-only GPS adapter. No stored forecast or fitted model is read. */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import readline from "node:readline";
import { parseArgs } from "node:util";
import { TransitNetwork } from "../../../src/network/TransitNetwork.js";
import { distanceMeters } from "../../../src/network/geo.js";
import { MAX_HANDOFF_JUMP_M, MAX_HANDOFF_SPEED_MPS } from "../../../src/collector/detector.js";
import { rebuildLabels, LABEL_REBUILD_RULE } from "./rebuild-labels.js";
import { registerRoutePaths } from "../../../web/src/anchor.js";
import { ringForBus } from "../../../web/src/eta/index.js";
import type { Position } from "./contract.js";

const { values } = parseArgs({ options: { input: { type: "string" }, out: { type: "string" }, day: { type: "string" } } });
if (!values.input || !values.out || !values.day) throw new Error("--input --out --day required");
const input = path.resolve(values.input), out = path.resolve(values.out), day = values.day;
if (fs.existsSync(out)) throw new Error("Refusing to overwrite frozen prospective labels");
const sha = (v: string | Buffer): string => crypto.createHash("sha256").update(v).digest("hex");
const clock = (x: unknown): number | null => { if (typeof x !== "string") return null; const t = Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(x) ? x : `${x}Z`); return Number.isFinite(t) ? t : null; };
const tables = new Map<string, any>(), firstRoutes = new Map<number, any>(), firstStops = new Map<number, any>(), geometry = new Map<number, string>();
const unstable = new Set<number>(), counts: Record<string, number> = { polls: 0, rawBuses: 0, positions: 0, staleFixes: 0, repeatedFixes: 0, contendedBuses: 0, invalidBuses: 0, routeChanges: 0, discontinuousHandoffs: 0 };
type Track = { id: string; routeId: number; busKey: string; positions: Position[] };
const tracks: Track[] = [], active = new Map<string, Track>();
const audit: any[] = [];
const pollTimes: number[] = [];
function readTable(id: string): any {
  const known = tables.get(id); if (known) return known;
  const bytes = zlib.gunzipSync(fs.readFileSync(path.join(input, "tables", `${id}.json.gz`)));
  if (sha(bytes) !== id) throw new Error("Captured table hash mismatch");
  const table = JSON.parse(bytes.toString()); registerRoutePaths(table.route_paths);
  const patterns: Record<string,string> = {};
  for (const routeId of firstRoutes.keys()) if (!Object.hasOwn(table.routes,String(routeId))) unstable.add(routeId);
  for (const [rid, sequence] of Object.entries(table.routes)) {
    const routeId = Number(rid), ring = ringForBus({ route_id: routeId } as any, sequence as number[], table.stop_coords);
    if (!ring) { unstable.add(routeId); continue; }
    const stops = [...ring.stops];
    patterns[rid] = `${routeId}:${sha(JSON.stringify([stops])).slice(0,24)}`;
    const key = sha(JSON.stringify({ stops, coords: stops.map(id => [id, table.stop_coords[id]]), path: table.route_paths?.[rid] ?? null }));
    if (geometry.has(routeId) && geometry.get(routeId) !== key) unstable.add(routeId);
    if (!geometry.has(routeId)) {
      geometry.set(routeId, key);
      firstRoutes.set(routeId, { id: routeId, name: String(routeId), shortName: String(routeId), color: "#000000", stops,
        ...(table.route_paths?.[rid] ? { path: table.route_paths[rid] } : {}) });
      for (const id of stops) if (table.stop_coords[id]) {
        const previous = firstStops.get(id), coord = table.stop_coords[id];
        if (previous && (previous.lat !== coord.lat || previous.lon !== coord.lon)) {
          unstable.add(routeId);
          for (const old of firstRoutes.values()) if (old.stops.includes(id)) unstable.add(old.id);
        } else if (!previous) firstStops.set(id, { id, name: table.stop_names?.[id] ?? String(id), ...coord });
      }
    }
  }
  // Store only geometry. Labeling never receives model parameters or contexts.
  const small = { routes: table.routes, stop_coords: table.stop_coords, patterns };
  tables.set(id, small); return small;
}
const stream = fs.createReadStream(path.join(input, "inputs.jsonl.gz")).pipe(zlib.createGunzip());
for await (const line of readline.createInterface({ input: stream, crlfDelay: Infinity })) {
  if (!line.trim()) continue;
  const row = JSON.parse(line), t = row.observedAt;
  if (!Number.isFinite(t) || !Array.isArray(row.buses)) throw new Error("Invalid captured input");
  if (pollTimes.length && t <= pollTimes.at(-1)!) throw new Error("Duplicate or nonmonotonic captured poll clock");
  pollTimes.push(t);
  const table = readTable(row.tableSha), names = new Map<string, number>();
  counts.polls!++;
  for (const b of row.buses) names.set(b.bus_name, (names.get(b.bus_name) ?? 0) + 1);
  for (const b of row.buses) {
    counts.rawBuses!++;
    const fix = clock(b.seen_at), routeId = Number(b.route_id), name = b.bus_name;
    if (names.get(name)! > 1) { active.delete(name); counts.contendedBuses!++; continue; }
    if (fix == null || fix > t + 5000 || t - fix > 30_000) { counts.staleFixes!++; continue; }
    if (!Number.isInteger(routeId) || !Number.isFinite(b.lat) || !Number.isFinite(b.lon) || !table.routes[String(routeId)]) { counts.invalidBuses!++; continue; }
    const contexts = Array.isArray(b.standing_forecasts) ? b.standing_forecasts : [];
    const contextsPresent = contexts.length > 0;
    // This audit describes payload provenance only; it never enters labels.
    audit.push({ key: `${routeId}:${name}:${t}`, issuedAt: t, fixAt: fix, tableSha: row.tableSha, routeId, busKey: name,
      busId: b.bus_id, lat: b.lat, lon: b.lon, routePatternId: table.patterns[String(routeId)], servedContextSha: sha(JSON.stringify(contexts)), contextCount: contexts.length,
      contextPresent: contextsPresent,
      futureContextClock: contexts.some((c: any) => [c.fitted_at, c.history_available_at, c.previous_departed_at].some(x => typeof x === "number" && x > t)),
      contextFitAt: contexts.map((c: any) => c.fitted_at),
      contextHistoryAvailableAt: contexts.map((c: any) => c.history_available_at) });
    let track = active.get(name), previous = track?.positions.at(-1);
    if (previous && previous.route_id !== routeId) { active.delete(name); track = undefined; previous = undefined; counts.routeChanges!++; }
    if (previous && b.bus_id !== previous.bus_id) {
      const seconds = (fix - previous.collected_at) / 1000, jump = distanceMeters(previous, b);
      if (jump > MAX_HANDOFF_JUMP_M && jump > seconds * MAX_HANDOFF_SPEED_MPS) {
        active.delete(name); track = undefined; previous = undefined; counts.discontinuousHandoffs!++;
      }
    }
    if (previous && fix <= previous.collected_at) { counts.repeatedFixes!++; continue; }
    if (!track) { track = { id: sha(JSON.stringify([name, routeId, fix, tracks.length])).slice(0, 24), routeId, busKey: name, positions: [] }; tracks.push(track); active.set(name, track); }
    track.positions.push({ bus_id: b.bus_id, bus_name: name, route_id: routeId, lat: b.lat, lon: b.lon,
      heading: b.heading ?? null, last_stop_id: b.last_stop_id ?? null, collected_at: fix });
    counts.positions!++;
    if (counts.positions! > 1_000_000) throw new Error("Prospective position cap exceeded; refuse truncation");
  }
}
const routeRows = [...firstRoutes.values()].filter(r => !unstable.has(r.id));
const network = TransitNetwork.build([...firstStops.values()], routeRows);
for (const r of routeRows) if (JSON.stringify(network.routes.get(r.id)?.stops) !== JSON.stringify(r.stops)) unstable.add(r.id);
const stableTracks = tracks.filter(t => !unstable.has(t.routeId));
const episodes: any[] = [], rebuildCounts: Record<string, number> = {};
for (const track of stableTracks) {
  const rebuilt = rebuildLabels(network, track.positions, day);
  episodes.push(...rebuilt.episodes.map(e => ({ ...e, split: "prospective", sourceTrackId: track.id })));
  for (const [key, value] of Object.entries(rebuilt.counts)) rebuildCounts[key] = (rebuildCounts[key] ?? 0) + value;
}
fs.mkdirSync(path.join(out, day), { recursive: true });
function write(file: string, rows: any[]): void { fs.writeFileSync(path.join(out, file), zlib.gzipSync(rows.map(r => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""))); }
const routes = [...network.routes.values()].filter(r => !unstable.has(r.id)).map(r => ({ id: r.id, name: r.name, stops: [...r.stops], patternId: `${r.id}:${sha(JSON.stringify([r.stops])).slice(0,24)}` }));
const routePatterns = new Map(routes.map(r=>[r.id,r.patternId]));
for (const e of episodes) if (routePatterns.get(e.routeId) !== e.routePatternId) throw new Error("Rebuilt episode and physical-crossing topology pattern differ");
fs.writeFileSync(path.join(out, "topology.json"), JSON.stringify({ routes, stops: [...firstStops.values()], unstableRoutes: [...unstable] }, null, 2));
write(`${day}/episodes.jsonl.gz`, episodes);
write(`${day}/positions.jsonl.gz`, stableTracks.flatMap(t => t.positions).sort((a,b) => a.collected_at - b.collected_at || a.bus_id - b.bus_id));
write("position-tracks.jsonl.gz", stableTracks);
const finalStatusPath = path.join(input,"status.json");
const finalStatusAt = fs.existsSync(finalStatusPath) ? JSON.parse(fs.readFileSync(finalStatusPath,"utf8")).at : null;
const appendBounds = new Map(pollTimes.map((t,i)=>[t,pollTimes[i+1] ?? (Number.isFinite(finalStatusAt) && finalStatusAt >= t ? finalStatusAt : null)]));
write("query-inputs.jsonl.gz", audit.map(r=>({...r,stableGeometry:routePatterns.get(r.routeId)===r.routePatternId,
  appendUpperBoundAt:appendBounds.get(r.issuedAt) ?? null})));
fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify({ createdAt: Date.now(), day, counts, rebuildCounts,
  sourceInputsSha256: sha(fs.readFileSync(path.join(input,"inputs.jsonl.gz"))), sourceTableHashes: [...tables.keys()],
  unstableRoutes: [...unstable], stableTrackCount: stableTracks.length, omittedUnstablePositions: tracks.filter(t=>unstable.has(t.routeId)).reduce((n,t)=>n+t.positions.length,0),
  labelRule: LABEL_REBUILD_RULE, forecastInputsRead: false, labelingInputs: "GPS fix clocks, fleet identity and exact captured geometry only; wire context metadata is exported separately for provenance audit",
  geometryPolicy: "A route with any geometry/version change is excluded as unresolved for this bounded morning report; no mixed-version label or silently repaired occurrence",
  outputs: ["topology.json", `${day}/episodes.jsonl.gz`, `${day}/positions.jsonl.gz`, "position-tracks.jsonl.gz", "query-inputs.jsonl.gz"].map(file=>({file,sha256:sha(fs.readFileSync(path.join(out,file)))})) }, null, 2));
console.log(JSON.stringify({ out, counts, rebuildCounts, unstableRoutes: [...unstable], episodes: episodes.length }));
