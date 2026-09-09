/** Reproduce the production worker against a read-only snapshot; never publishes or deploys. */
import Database from "better-sqlite3";
import { parseArgs } from "node:util";
import { writeFileSync } from "node:fs";
import { TransitNetwork } from "../network/TransitNetwork.js";
import type { Route, Stop } from "../schema/api.js";
import { STANDING_ALGORITHM, STANDING_FIT_POLICY, startStandingFitWorker, type StandingFitRequest } from "./standingForecast.js";
import { standingDayBounds } from "./standingForecastData.js";

const { values } = parseArgs({ options: { db: { type: "string" }, at: { type: "string" }, out: { type: "string" } } });
if (!values.db || !values.at || !values.out) throw new Error("--db <read-only snapshot> --at <ISO snapshot time> --out <new JSON file> required");
const now = Date.parse(values.at);
if (!Number.isFinite(now)) throw new Error("Invalid --at timestamp");
const sqlite = new Database(values.db, { readonly: true, fileMustExist: true });
let network: TransitNetwork;
try {
  const stops = sqlite.prepare("SELECT id,name,lat,lon FROM stops").all() as Stop[];
  const rows = sqlite.prepare("SELECT id,name,short_name,color,stops_json,path_json FROM routes").all() as {
    id: number; name: string; short_name: string; color: string; stops_json: string; path_json: string | null;
  }[];
  const routes: Route[] = rows.map(row => ({ id: row.id, name: row.name, shortName: row.short_name, color: row.color,
    stops: JSON.parse(row.stops_json) as number[], ...(row.path_json ? { path: JSON.parse(row.path_json) as [number, number][] } : {}) }));
  network = TransitNetwork.build(stops, routes);
} finally { sqlite.close(); }
const [day] = standingDayBounds(now);
let from = day;
for (let i = 0; i < STANDING_FIT_POLICY.lookbackDays; i++) from = standingDayBounds(from - 1)[0];
const request: StandingFitRequest = { dbPath: values.db,
  patterns: [...network.routes.values()].map(route => ({ routeId: route.id, stopIds: [...route.stops] })),
  from, cutoff: now, serviceDayCutoff: day, observedAt: now, maximumRows: STANDING_FIT_POLICY.maximumRows,
  lookbackDays: STANDING_FIT_POLICY.lookbackDays, serviceDaysPerRoute: STANDING_FIT_POLICY.serviceDaysPerRoute };
const job = startStandingFitWorker(request);
// The production worker is unref'ed so it cannot delay shutdown. This CLI is
// itself the job, and keeps one harmless handle until the promised result.
const keepAlive = setInterval(() => {}, 60_000);
const timeout = setTimeout(() => job.cancel(), STANDING_FIT_POLICY.workerTimeoutMs);
try {
  const result = await job.promise;
  writeFileSync(values.out, JSON.stringify({ algorithm: STANDING_ALGORITHM, policy: STANDING_FIT_POLICY,
    request, ...result }, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify({ output: values.out, ...result.diagnostics }));
} finally { clearInterval(keepAlive); clearTimeout(timeout); }
