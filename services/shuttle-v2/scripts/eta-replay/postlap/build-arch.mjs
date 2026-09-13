/**
 * Build one route-day of trough-harness input from ~/shuttle-archive.
 *
 * The decomposition harness (`decompose.ts`, and `layover.ts` beside this file)
 * reads a TSV whose every line is a type letter, a TAB, and one JSON row:
 * `A` an `arrivals` row, `V` a `stop_visits` row, `R` a `raw_positions` row,
 * all for ONE route and ONE archived ET day. That is the same schema the
 * 2026-09-11 trough investigation used, so its inputs and these are
 * interchangeable.
 *
 *   ROUTE=13 DAY=2026-09-10 OUT=../../.eta-replay/postlap node build-arch.mjs
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import readline from "node:readline";

const ROUTE = Number(process.env.ROUTE ?? 3);
const DAY = process.env.DAY ?? "2026-09-10";
const ARCHIVE = process.env.ARCHIVE ?? path.join(process.env.HOME ?? "", "shuttle-archive");
const OUT = process.env.OUT ?? ".";
const dir = path.join(ARCHIVE, DAY);

/** Stream one gzipped JSONL table, keeping the rows of this route. */
async function take(file, keep, fields) {
  const p = path.join(dir, file);
  if (!fs.existsSync(p)) throw new Error(`missing ${p}`);
  const rl = readline.createInterface({ input: fs.createReadStream(p).pipe(zlib.createGunzip()) });
  const out = [];
  for await (const line of rl) {
    if (!line) continue;
    const r = JSON.parse(line);
    if (!keep(r)) continue;
    const o = {};
    for (const f of fields) o[f] = r[f];
    out.push(o);
  }
  return out;
}

const ofRoute = (r) => Number(r.route_id) === ROUTE;
const A = await take("arrivals.jsonl.gz", ofRoute, ["bus_name", "stop_id", "arrived_at", "departed_at"]);
const V = await take("stop_visits.jsonl.gz", ofRoute, ["bus_name", "stop_id", "pinned_at", "departed_at"]);
const R = await take("raw_positions.jsonl.gz", ofRoute, ["collected_at", "bus_id", "bus_name", "lat", "lon", "heading", "last_stop_id"]);
A.sort((a, b) => a.arrived_at - b.arrived_at);
V.sort((a, b) => a.pinned_at - b.pinned_at);
R.sort((a, b) => a.collected_at - b.collected_at);

fs.mkdirSync(OUT, { recursive: true });
const file = path.join(OUT, `arch-r${ROUTE}-${DAY}.tsv`);
const w = fs.createWriteStream(file);
for (const r of A) w.write(`A\t${JSON.stringify(r)}\n`);
for (const r of V) w.write(`V\t${JSON.stringify(r)}\n`);
for (const r of R) w.write(`R\t${JSON.stringify(r)}\n`);
await new Promise((res) => w.end(res));
const et = (ms) => new Date(ms - 4 * 3600e3).toISOString().slice(5, 19);
const buses = [...new Set(R.map((r) => r.bus_name))].sort();
console.log(`${file}: A ${A.length} V ${V.length} R ${R.length} | ET ${R.length ? et(R[0].collected_at) : "-"} -> ${R.length ? et(R[R.length - 1].collected_at) : "-"} | buses ${buses.join(",")}`);
