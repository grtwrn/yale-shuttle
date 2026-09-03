/**
 * How much of a hop's duration is TRAFFIC — i.e. predictable from when it is?
 *
 * The calibrator already conditions on (route, from, to, weekday, hour +/- 1).
 * This asks what that conditioning is worth: of the variance left inside one
 * (route, from, to) group over 90 days, what share does hour-of-day explain,
 * what share does day-of-week explain, and what is left over?
 *
 * R^2 here is the one-way ANOVA ratio (between-bin variance / total variance),
 * pooled across groups by summing sums-of-squares rather than averaging R^2, so
 * a busy segment counts more than a rare one. An UNADJUSTED R^2 rises purely
 * from adding bins, so the adjusted (Omega^2) figure is reported beside it --
 * with 24 hour-bins and a few hundred samples the inflation is not negligible.
 *
 *   cd services/shuttle-v2 && TZ=America/New_York npx tsx scripts/eta-replay/traffic-variance.ts
 */
import fs from "node:fs";

import { OUT_DIR, MAX_PLAUSIBLE_M_S, loadNet } from "./common.js";
import { ROUTE_ID_LABEL } from "../../web/src/routes";

const net = loadNet();
const { db } = net;
const DAYS = Number(process.env.DAYS ?? 90);

type Row = { r: number; f: number; t: number; s: number; a: number; d: number; h: number };
const maxAt = db.prepare("SELECT MAX(started_at) m FROM segments").get() as { m: number };
const since = maxAt.m - DAYS * 86_400_000;
const rows = db
  .prepare(`SELECT route_id r, from_stop_id f, to_stop_id t, travel_sec s, started_at a, dow d, hour h
            FROM segments WHERE started_at >= ? ORDER BY started_at`)
  .all(since) as Row[];
console.error(`segments ${rows.length} over ${DAYS} d`);

// Same plausibility filter the calibrator applies before any statistic.
const groups = new Map<string, Row[]>();
let dropped = 0;
for (const row of rows) {
  const a = net.stopById.get(row.f);
  const b = net.stopById.get(row.t);
  if (a && b) {
    const R = 6371000, rad = (x: number) => (x * Math.PI) / 180;
    const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
    const m = R * Math.hypot(dLon * Math.cos(rad(a.lat)), dLat);
    if (!(row.s > 0 && m / row.s <= MAX_PLAUSIBLE_M_S)) { dropped++; continue; }
  }
  const k = `${row.r}:${row.f}:${row.t}`;
  let l = groups.get(k);
  if (!l) groups.set(k, (l = []));
  l.push(row);
}
console.error(`groups ${groups.size}, dropped implausible ${dropped}`);

const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
/** Between-bin and total sums of squares for one grouping key. */
function ss(vals: number[], bin: number[]): { between: number; total: number; bins: number } {
  const gm = mean(vals);
  const acc = new Map<number, { s: number; n: number }>();
  for (let i = 0; i < vals.length; i++) {
    let a = acc.get(bin[i]!);
    if (!a) acc.set(bin[i]!, (a = { s: 0, n: 0 }));
    a.s += vals[i]!; a.n++;
  }
  let between = 0;
  for (const [, a] of acc) { const m = a.s / a.n; between += a.n * (m - gm) * (m - gm); }
  let total = 0;
  for (const v of vals) total += (v - gm) * (v - gm);
  return { between, total, bins: acc.size };
}

const MIN_N = Number(process.env.MIN_N ?? 200);
const schemes: Record<string, (r: Row) => number> = {
  hourOfDay: (r) => r.h,
  dayOfWeek: (r) => r.d,
  weekendFlag: (r) => (r.d === 0 || r.d === 6 ? 1 : 0),
  peakFlag: (r) => (r.h >= 7 && r.h <= 9 ? 1 : r.h >= 16 && r.h <= 18 ? 2 : 0),
  dowAndHour: (r) => r.d * 24 + r.h,
  /** Control: a random split with the same number of bins as hourOfDay.
   *  Whatever R^2 this earns is what "explains nothing" looks like here. */
  randomised24: () => Math.floor(Math.random() * 24),
};

const pooled: Record<string, { between: number; total: number; dfB: number; dfW: number }> = {};
for (const k of Object.keys(schemes)) pooled[k] = { between: 0, total: 0, dfB: 0, dfW: 0 };
let usedGroups = 0;
let usedRows = 0;
const perGroup: any[] = [];
for (const [key, l] of groups) {
  if (l.length < MIN_N) continue;
  usedGroups++;
  usedRows += l.length;
  const vals = l.map((r) => r.s);
  const row: any = { key, route: ROUTE_ID_LABEL[l[0]!.r] ?? "?", n: l.length, sd: Math.round(Math.sqrt(ss(vals, vals.map(() => 0)).total / (l.length - 1)) * 10) / 10 };
  for (const [name, fn] of Object.entries(schemes)) {
    const r = ss(vals, l.map(fn));
    pooled[name]!.between += r.between;
    pooled[name]!.total += r.total;
    pooled[name]!.dfB += r.bins - 1;
    pooled[name]!.dfW += l.length - r.bins;
    row[name] = Math.round((1000 * r.between) / r.total) / 10;
  }
  perGroup.push(row);
}

const out: any = {
  generatedAt: new Date().toISOString(),
  window: { days: DAYS, since: new Date(since).toISOString(), segments: rows.length, droppedImplausible: dropped },
  selection: { minSamplesPerGroup: MIN_N, groupsUsed: usedGroups, rowsUsed: usedRows, groupsTotal: groups.size },
  note: "R2 pooled by summing sums-of-squares across (route,from,to) groups; omega2 subtracts the degrees of freedom a bin count buys for free",
  explained: {},
};
for (const [name, p] of Object.entries(pooled)) {
  const r2 = p.between / p.total;
  const msW = (p.total - p.between) / Math.max(1, p.dfW);
  const omega2 = (p.between - p.dfB * msW) / (p.total + msW);
  out.explained[name] = { r2Pct: Math.round(1000 * r2) / 10, omega2Pct: Math.round(1000 * Math.max(0, omega2)) / 10 };
}
perGroup.sort((a, b) => b.hourOfDay - a.hourOfDay);
out.mostTimeOfDaySensitive = perGroup.slice(0, 12);
out.leastTimeOfDaySensitive = perGroup.slice(-6);

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(`${OUT_DIR}/traffic-variance.json`, JSON.stringify(out, null, 1));
console.log(JSON.stringify({ window: out.window, selection: out.selection, explained: out.explained }, null, 1));
console.log("\nmost hour-sensitive segments (R2 % of within-segment variance explained by hour):");
for (const g of out.mostTimeOfDaySensitive.slice(0, 8)) console.log(` ${g.route.padEnd(12)} ${g.key.padEnd(14)} n=${String(g.n).padStart(5)} sd=${String(g.sd).padStart(6)}s hour=${g.hourOfDay}% dow=${g.dayOfWeek}% random24=${g.randomised24}%`);
