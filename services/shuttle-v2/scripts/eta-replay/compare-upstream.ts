/**
 * OURS vs THE OPERATOR'S — the same predictions, the same arrivals, two apps.
 *
 * `predictions_log` now holds two populations. The rider-reported surfaces
 * (`trip`, `ride`, `card`) are what OUR app put on a screen. `upstream` is what
 * `routes_eta.php` told the official Downtowner app about the same vehicle at
 * the same stop, recorded by `src/collector/upstreamEta.ts`. Both pair against
 * the same `arrivals` rows, so this script is a query rather than a replay:
 * nothing here recomputes an ETA, it only scores what each app actually said.
 *
 *   cd services/shuttle-v2
 *   TZ=America/New_York REPLAY_DB=./store/snap.db \
 *     npx tsx scripts/eta-replay/compare-upstream.ts
 *
 * Env: REPLAY_DB, HOURS (24), FROM/TO (ISO, override HOURS), ROUTES
 *      (comma-separated route ids, default all), MIN_CELL (50).
 *
 * ── Three things this prints, and why all three ────────────────────────────
 *
 * 1. BY HORIZON, per arm. Everything each app said, bucketed by the time it
 *    promised (<=3 min, 3-10, >10). This is the honest per-arm summary and it
 *    is NOT a controlled comparison: the two arms do not cover the same stops.
 *    We log every rider-watched stop; we sample twelve stops per 30 s upstream
 *    (see `upstreamEta.ts`). A difference here can be a difference in mix.
 * 2. HEAD-TO-HEAD, on shared (bus, stop, minute) triples where BOTH arms have
 *    a row and both matched the SAME arrival. This is the controlled read —
 *    same vehicle, same stop, same instant, same truth — and it is the number
 *    to quote.
 * 3. BY ROUTE, head-to-head, because Green/Purple/Orange East are where our
 *    anchor is weakest (docs/eta-accuracy.md) and a pooled median hides it.
 *
 * ── The caveat that must travel with every number ──────────────────────────
 *
 * `routes_eta.php` serves WHOLE MINUTES. Rounding alone puts ~±30 s on their
 * side (uniform, so ~15 s on a median |error|) before any real disagreement.
 * A gap smaller than that is not evidence of anything. The header prints this
 * and it is not decoration.
 *
 * ── Why cells are withheld ─────────────────────────────────────────────────
 *
 * A cell with fewer than MIN_CELL paired rows prints `n=… withheld`, not a
 * number. An hour of thin coverage produces medians that flip sign the next
 * hour, and a withheld cell is the honest failure; a printed one with a
 * footnote is not (this project has been burned by exactly that).
 */
import { openDb, metricsOf, fmtEt, type Metrics } from "./common.js";

const UPSTREAM_SURFACE = "upstream";
/** Same window `predictions.ts` pairs across. */
const MATCH_WINDOW_MS = 2 * 60 * 60 * 1000;
const MIN_CELL = Number(process.env.MIN_CELL ?? 50);

interface PredRow {
  bus_name: string;
  route_id: number;
  to_stop_id: number;
  predicted_sec: number;
  predicted_at: number;
  surface: string;
}

interface Scored extends PredRow {
  /** Epoch ms the bus actually reached the stop. */
  arrivedAt: number;
  /** predicted − actual, seconds. Negative = optimistic; the bus beat us. */
  errSec: number;
}

const HORIZONS = [
  { label: "<=3 min", lo: 0, hi: 180 },
  { label: "3-10 min", lo: 180, hi: 600 },
  { label: ">10 min", lo: 600, hi: Number.POSITIVE_INFINITY },
] as const;

function main(): void {
  const db = openDb();

  const to = process.env.TO ? Date.parse(process.env.TO) : Date.now();
  const from = process.env.FROM
    ? Date.parse(process.env.FROM)
    : to - Number(process.env.HOURS ?? 24) * 3_600_000;
  const routeFilter = process.env.ROUTES
    ? new Set(process.env.ROUTES.split(",").map((s) => Number(s.trim())))
    : null;

  const preds = db
    .prepare(
      `SELECT bus_name, route_id, to_stop_id, predicted_sec, predicted_at, surface
       FROM predictions_log WHERE predicted_at >= ? AND predicted_at <= ?
       ORDER BY predicted_at ASC`,
    )
    .all(from, to) as PredRow[];
  const rows = routeFilter ? preds.filter((p) => routeFilter.has(p.route_id)) : preds;

  if (rows.length === 0) {
    console.log(`no predictions between ${fmtEt(from)} and ${fmtEt(to)} ET`);
    return;
  }

  const routeNames = new Map<number, string>(
    (db.prepare("SELECT id, name FROM routes").all() as Array<{ id: number; name: string }>)
      .map((r) => [r.id, r.name] as const),
  );

  // One arrivals index, shared by both arms — the whole point is that the two
  // apps are scored against the SAME truth.
  const arrivals = db
    .prepare(
      `SELECT bus_name, route_id, stop_id, arrived_at FROM arrivals
       WHERE arrived_at >= ? AND arrived_at <= ? ORDER BY arrived_at ASC`,
    )
    .all(rows[0]!.predicted_at, rows[rows.length - 1]!.predicted_at + MATCH_WINDOW_MS) as Array<{
    bus_name: string;
    route_id: number;
    stop_id: number;
    arrived_at: number;
  }>;
  const index = new Map<string, number[]>();
  for (const a of arrivals) {
    const key = `${norm(a.bus_name)}:${a.route_id}:${a.stop_id}`;
    const list = index.get(key);
    if (list) list.push(a.arrived_at);
    else index.set(key, [a.arrived_at]);
  }

  const ours: Scored[] = [];
  const theirs: Scored[] = [];
  let ourN = 0;
  let theirN = 0;
  for (const p of rows) {
    const official = p.surface === UPSTREAM_SURFACE;
    if (official) theirN += 1;
    else ourN += 1;
    const list = index.get(`${norm(p.bus_name)}:${p.route_id}:${p.to_stop_id}`);
    const actual = list ? firstAtLeast(list, p.predicted_at) : null;
    if (actual === null || actual > p.predicted_at + MATCH_WINDOW_MS) continue;
    const errSec = p.predicted_sec - (actual - p.predicted_at) / 1000;
    (official ? theirs : ours).push({ ...p, arrivedAt: actual, errSec });
  }

  const ourStops = new Set(ours.map((r) => r.to_stop_id)).size;
  const theirStops = new Set(theirs.map((r) => r.to_stop_id)).size;

  console.log("");
  console.log("OURS vs OFFICIAL — predictions_log scored against detected arrivals");
  console.log(`window   ${fmtEt(from)} .. ${fmtEt(to)} ET` + (routeFilter ? `  routes=${process.env.ROUTES}` : ""));
  console.log(
    `ours     ${ourN} predictions, ${ours.length} paired, ${ourStops} stops` +
      `   (surfaces trip/ride/card — what a rider was shown)`,
  );
  console.log(
    `official ${theirN} predictions, ${theirs.length} paired, ${theirStops} stops` +
      `   (routes_eta.php, sampled 12 stops / 30 s)`,
  );
  console.log("");
  console.log("CAVEAT  routes_eta.php serves WHOLE MINUTES: ~±30 s of the official");
  console.log("        error is rounding (~15 s on a median |err|). A gap smaller");
  console.log("        than that is not evidence. Error is predicted − actual, so");
  console.log("        NEGATIVE is optimistic — the bus beat what was promised.");
  console.log("");

  // -- 1. per arm, by horizon ------------------------------------------------
  console.log("BY HORIZON — each arm's own coverage. NOT controlled: the arms watch");
  console.log("different stops, so a difference here can be a difference in mix.");
  header();
  for (const h of HORIZONS) {
    line(h.label, "ours", ours.filter((r) => inH(r, h)));
    line("", "official", theirs.filter((r) => inH(r, h)));
  }
  line("all", "ours", ours);
  line("", "official", theirs);
  console.log("");

  // -- 2. head-to-head -------------------------------------------------------
  //
  // Same bus, same stop, same MINUTE, and both arms matched the same arrival.
  // Where they matched different arrivals the pair is ambiguous and dropped
  // rather than guessed at.
  const byKey = (list: readonly Scored[]): Map<string, Scored> => {
    const m = new Map<string, Scored>();
    for (const r of list) {
      const k = `${norm(r.bus_name)}:${r.to_stop_id}:${Math.floor(r.predicted_at / 60_000)}`;
      // Earliest row in the minute wins, so the choice is deterministic and
      // the same rule applies to both arms.
      const prev = m.get(k);
      if (!prev || r.predicted_at < prev.predicted_at) m.set(k, r);
    }
    return m;
  };
  const oursByKey = byKey(ours);
  const theirsByKey = byKey(theirs);
  const pairs: Array<{ ours: Scored; theirs: Scored }> = [];
  let ambiguous = 0;
  for (const [k, o] of oursByKey) {
    const t = theirsByKey.get(k);
    if (!t) continue;
    if (t.arrivedAt !== o.arrivedAt) {
      ambiguous += 1;
      continue;
    }
    pairs.push({ ours: o, theirs: t });
  }

  console.log(
    `HEAD-TO-HEAD — ${pairs.length} shared (bus, stop, minute) pairs, same arrival` +
      (ambiguous ? `; ${ambiguous} dropped as ambiguous` : ""),
  );
  if (pairs.length < MIN_CELL) {
    console.log(`  n=${pairs.length} < ${MIN_CELL} — withheld. Both arms need coverage of the`);
    console.log("  same stops; give the poller longer, or widen HOURS.");
  } else {
    header();
    for (const h of HORIZONS) {
      // Bucket by what OURS promised, so a row sits in one bucket in both arms
      // and the comparison is like-for-like.
      const sel = pairs.filter((p) => inH(p.ours, h));
      line(h.label, "ours", sel.map((p) => p.ours));
      line("", "official", sel.map((p) => p.theirs));
    }
    line("all", "ours", pairs.map((p) => p.ours));
    line("", "official", pairs.map((p) => p.theirs));
    console.log("");

    // -- 3. by route, head-to-head -------------------------------------------
    console.log("BY ROUTE — head-to-head only.");
    header();
    const routeIds = [...new Set(pairs.map((p) => p.ours.route_id))].sort((a, b) => a - b);
    for (const id of routeIds) {
      const sel = pairs.filter((p) => p.ours.route_id === id);
      const label = `${routeNames.get(id) ?? id}`.slice(0, 14);
      line(label, "ours", sel.map((p) => p.ours));
      line("", "official", sel.map((p) => p.theirs));
    }
  }
  console.log("");
}

function inH(r: Scored, h: (typeof HORIZONS)[number]): boolean {
  return r.predicted_sec >= h.lo && r.predicted_sec < h.hi;
}

function header(): void {
  console.log(
    pad("", 14) + pad("arm", 10) + rpad("n", 7) + rpad("signed", 9) +
      rpad("|err|p50", 10) + rpad("|err|p90", 10) + rpad("<60s", 8) + rpad("<120s", 8),
  );
}

function line(label: string, arm: string, sel: readonly Scored[]): void {
  const n = sel.length;
  if (n < MIN_CELL) {
    console.log(pad(label, 14) + pad(arm, 10) + rpad(String(n), 7) + `  n<${MIN_CELL} withheld`);
    return;
  }
  const m: Metrics = metricsOf(sel.map((r) => r.errSec));
  console.log(
    pad(label, 14) + pad(arm, 10) + rpad(String(n), 7) +
      rpad(fmt(m.medianSignedSec), 9) +
      rpad(fmt(m.medianAbsSec), 10) +
      rpad(fmt(m.p90AbsSec), 10) +
      rpad(`${m.within60}%`, 8) +
      rpad(`${m.within120}%`, 8),
  );
}

const fmt = (x: number): string => `${Math.round(x)}s`;
const pad = (s: string, n: number): string => (s + " ".repeat(n)).slice(0, n);
const rpad = (s: string, n: number): string => (" ".repeat(n) + s).slice(-n) + " ";
const norm = (s: string): string => s.trim().replace(/^#/, "");

/** First element of a sorted ascending list ≥ target, or null. */
function firstAtLeast(sorted: readonly number[], target: number): number | null {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid]! < target) lo = mid + 1;
    else hi = mid;
  }
  return lo < sorted.length ? sorted[lo]! : null;
}

main();
