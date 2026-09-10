/**
 * Write the lap-fit half of a `PAYLOAD_PATCH` from a snapshot, through the
 * SERVER'S OWN fitter (src/calibrator/lapFit.ts) — so what a replay scores is
 * what production would serve, not a transcription of it.
 *
 *   TZ=America/New_York REPLAY_DB=./store/snap.db FIT_BEFORE=2026-09-04 \
 *     PATCH_IN=./store/model-patch-0904.json PATCH_OUT=./store/model-patch-0904-lap.json \
 *     npx tsx scripts/eta-replay/lap-fit.ts
 *
 * `FIT_BEFORE` is an ET day, exclusive: the fit may not see the day it is
 * scored on, or a held-out replay is not held out.
 */
import fs from "node:fs";
import Database from "better-sqlite3";
import { computeLapFits, etDay, LAP_SERVED_ROUTE_IDS, type GateResult, type LapArrival } from "../../src/calibrator/lapFit.js";

const DB = process.env.REPLAY_DB ?? "./store/snap.db";
const BEFORE = process.env.FIT_BEFORE;
const IN = process.env.PATCH_IN;
const OUT = process.env.PATCH_OUT ?? "./store/lap-fit.json";

const db = new Database(DB, { readonly: true });
const names = Object.fromEntries(
  (db.prepare("SELECT id, name FROM stops").all() as Array<{ id: number; name: string }>).map((s) => [s.id, s.name]),
);

// Only cells that could possibly qualify, and streamed: a 90-day `arrivals`
// table is half a million rows and materialising it costs more memory than
// this Pi has to spare.
const cut = BEFORE ? Date.parse(`${BEFORE}T00:00:00-04:00`) : Number.MAX_SAFE_INTEGER;
const corpus: LapArrival[] = [];
const it = db.prepare(
  `SELECT bus_name, route_id, stop_id, arrived_at, departed_at FROM arrivals
   WHERE departed_at IS NOT NULL AND arrived_at < ?
     AND (route_id, stop_id) IN (
       SELECT route_id, stop_id FROM arrivals WHERE departed_at IS NOT NULL AND arrived_at < ?
       GROUP BY route_id, stop_id HAVING count(*) >= 60 AND avg((departed_at - arrived_at) / 1000.0) >= 90
     )
   ORDER BY arrived_at`,
).iterate(cut, cut) as Iterable<{ bus_name: string; route_id: number; stop_id: number; arrived_at: number; departed_at: number }>;
for (const r of it) {
  if (BEFORE && etDay(r.arrived_at) >= BEFORE) continue;
  corpus.push({ busName: r.bus_name, routeId: r.route_id, stopId: r.stop_id, arrivedAt: r.arrived_at, departedAt: r.departed_at });
}
// `LAP_ROUTES=all` or `LAP_ROUTES=13,1` fits a route the rollout gate does not
// serve yet — the only way to build the case for adding it.
const served = process.env.LAP_ROUTES
  ? (process.env.LAP_ROUTES === "all"
    ? new Set([...new Set(corpus.map((r) => r.routeId))])
    : new Set(process.env.LAP_ROUTES.split(",").map(Number)))
  : LAP_SERVED_ROUTE_IDS;
const gates = new Map<string, GateResult>();
const fits = computeLapFits(corpus, gates, served);
console.log(`rollout gate: routes ${[...served].sort((a, b) => a - b).join(",")}${process.env.LAP_ROUTES ? " (LAP_ROUTES override)" : ""}`);
console.log(`${corpus.length} closed visits${BEFORE ? ` before ET ${BEFORE}` : ""} -> ${gates.size} candidate cells, ${fits.size} SERVED`);
console.log("");
console.log("  rt  stop  name                          n   days   pooled      lap    delta    upper  served");
const rows = [...gates].map(([k, g]) => {
  const [rid, sid] = k.split(":");
  return { k, rid: rid!, sid: sid!, g, delta: g.lap - g.pooled };
});
rows.sort((a, b) => (Number.isNaN(a.delta) ? 1e9 : a.delta) - (Number.isNaN(b.delta) ? 1e9 : b.delta));
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : "  -");
for (const r of rows) {
  console.log(`  ${r.rid.padStart(2)}  ${r.sid.padStart(4)}  ${(names[Number(r.sid)] ?? r.sid).slice(0, 26).padEnd(28)}${String(r.g.n).padStart(5)}${String(r.g.days).padStart(6)}` +
    `${f1(r.g.pooled).padStart(9)}${f1(r.g.lap).padStart(9)}${f1(r.delta).padStart(9)}${f1(r.g.upper).padStart(9)}   ${r.g.pass ? "yes" : "no"}`);
}
console.log("");

const byRoute: Record<string, Record<string, { lapB: number; lapM: number; lapN: number }>> = {};
for (const [key, f] of fits) {
  const [rid, sid] = key.split(":");
  (byRoute[rid!] ??= {})[sid!] = { lapB: f.b, lapM: f.m, lapN: f.n };
  console.log(`  route ${rid!.padStart(3)} stop ${sid!.padStart(4)} ${(names[Number(sid)] ?? sid!).slice(0, 26).padEnd(28)} b*1e4 ${(f.b * 1e4).toFixed(2).padStart(8)}  lapM ${(f.m / 60).toFixed(1).padStart(6)} min  nEff ${f.n}`);
}

if (IN) {
  const patch = JSON.parse(fs.readFileSync(IN, "utf8")) as { dwells?: Record<string, Record<string, Record<string, unknown>>> };
  let merged = 0;
  for (const rid in byRoute) {
    const rd = patch.dwells?.[rid];
    if (!rd) continue;
    for (const sid in byRoute[rid]!) {
      for (const k of Object.keys(rd)) {
        if (k.split("#")[0] !== sid) continue;
        Object.assign(rd[k]!, byRoute[rid]![sid]!);
        merged++;
      }
    }
  }
  fs.writeFileSync(OUT, JSON.stringify(patch));
  console.log(`merged into ${merged} dwell keys -> ${OUT}`);
} else {
  fs.writeFileSync(OUT, JSON.stringify(byRoute, null, 1));
  console.log(`wrote ${OUT}`);
}
