/**
 * Q4 — going out of service: what upstream's rows do before a bus leaves the feed.
 *
 * For every (bus, service day — 4 am to 4 am ET) in the captures, the bus's
 * LAST appearance L is the end of its final presence run (gaps ≤ 10 min);
 * runs ending within 20 min of the end of the data are censored and skipped.
 * CONTROL windows are moments T every 15 min through each presence run at
 * which the bus went on for ≥ 30 min. For each window [T − 15 min, T]:
 *
 *   gap        minutes from the bus's last upstream row (any stop) to T;
 *   flag k     "no upstream row for the bus in the last k minutes" — the
 *              candidate out-of-service rule; precision/recall are over the
 *              pooled EOS + control windows, i.e. per 15-min window of a live bus;
 *   horizon    the longest promise in the window's first 5 min vs its last 5;
 *   past end   rows in the window promising an arrival after T + 60 s — for an
 *              EOS window, a promise of a bus that never came.
 *
 * Only windows where the poller was active (rows for ANY bus in ≥ 80% of
 * the window's minutes) are scored, so an outage is not read as a signal.
 *
 *   cd services/shuttle-v2
 *   TZ=America/New_York REPLAY_DB=./store/snap-0906-1230.db npx tsx scripts/eta-replay/upstream-eta-eos.ts
 */
import {
  fmtEt, loadCaptures, loadUpstream, mdTable, openDb, parseWindow, quantile, r1, routeNames, tracksByBus, writeJson, writeText,
  type UpstreamRow,
} from "./upstream-eta-common.js";

const T0 = Date.now();
const log = (...a: unknown[]) => console.error(`[${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a);

const WINDOW_MS = 15 * 60_000;
const GAP_MS = 10 * 60_000;
const CENSOR_MS = 20 * 60_000;
const CONTROL_EVERY_MS = 15 * 60_000;
const CONTROL_AHEAD_MS = 30 * 60_000;
const FLAGS_MIN = [2, 3, 5, 10];

const db = openDb();
const { from, to } = parseWindow();
const up = loadUpstream(db, from, to);
const winFrom = up[0]!.at, winTo = up[up.length - 1]!.at;
log(`upstream rows ${up.length}, ${fmtEt(winFrom)} .. ${fmtEt(winTo)} ET`);
const names = routeNames(db);
const pos = loadCaptures(winFrom - 3_600_000, winTo + 3_600_000);
const tracks = tracksByBus(pos);
const dataEnd = Math.min(pos[pos.length - 1]!.t, winTo);
log(`capture rows ${pos.length}, data end ${fmtEt(dataEnd)} ET`);

const upByBus = new Map<string, UpstreamRow[]>();
for (const u of up) (upByBus.get(u.bus) ?? upByBus.set(u.bus, []).get(u.bus)!).push(u);
const activeMinutes = new Set<number>(up.map((u) => Math.floor(u.at / 60_000)));
function pollerCoverage(a: number, b: number): number {
  const m0 = Math.floor(a / 60_000), m1 = Math.floor(b / 60_000);
  let n = 0, hit = 0;
  for (let m = m0; m <= m1; m++) { n++; if (activeMinutes.has(m)) hit++; }
  return n ? hit / n : 0;
}
function rowsIn(bus: string, a: number, b: number): UpstreamRow[] {
  const rows = upByBus.get(bus);
  if (!rows) return [];
  let lo = 0, hi = rows.length;
  while (lo < hi) { const m = (lo + hi) >>> 1; if (rows[m]!.at < a) lo = m + 1; else hi = m; }
  const out: UpstreamRow[] = [];
  for (let i = lo; i < rows.length && rows[i]!.at <= b; i++) out.push(rows[i]!);
  return out;
}
function lastRowBefore(bus: string, t: number): number | null {
  const rows = upByBus.get(bus);
  if (!rows) return null;
  let lo = 0, hi = rows.length;
  while (lo < hi) { const m = (lo + hi) >>> 1; if (rows[m]!.at <= t) lo = m + 1; else hi = m; }
  return lo > 0 ? rows[lo - 1]!.at : null;
}

/** Service day (4 am ET boundary) as a label. */
function serviceDay(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms - 4 * 3_600_000));
}

interface Win { kind: "eos" | "control"; bus: string; routeId: number; day: string; T: number; gapMin: number | null; hasRow: boolean[]; hMaxEarly: number | null; hMaxLate: number | null; pastEnd: number; afterEnd: number; rowsN: number; coverage: number }
const wins: Win[] = [];
let censored = 0, inactive = 0;
for (const [bus, track] of tracks) {
  // presence runs
  const runs: Array<{ start: number; end: number; routeId: number }> = [];
  let cur: { start: number; end: number; routeId: number } | null = null;
  for (const p of track) {
    if (!cur || p.t - cur.end > GAP_MS) { if (cur) runs.push(cur); cur = { start: p.t, end: p.t, routeId: p.r }; }
    cur.end = p.t; cur.routeId = p.r;
  }
  if (cur) runs.push(cur);
  const measure = (kind: "eos" | "control", T: number, routeId: number): void => {
    if (T - WINDOW_MS < winFrom) return;
    const coverage = pollerCoverage(T - WINDOW_MS, T);
    if (coverage < 0.8) { inactive++; return; }
    const rows = rowsIn(bus, T - WINDOW_MS, T);
    const last = lastRowBefore(bus, T);
    const hasRow: boolean[] = [];
    for (let k = 1; k <= 15; k++) hasRow.push(rows.some((r) => r.at > T - k * 60_000 && r.at <= T - (k - 1) * 60_000));
    const early = rows.filter((r) => r.at <= T - 10 * 60_000).map((r) => r.sec);
    const late = rows.filter((r) => r.at > T - 5 * 60_000).map((r) => r.sec);
    wins.push({
      kind, bus, routeId, day: serviceDay(T), T,
      gapMin: last === null ? null : (T - last) / 60_000,
      hasRow,
      hMaxEarly: early.length ? Math.max(...early) : null,
      hMaxLate: late.length ? Math.max(...late) : null,
      pastEnd: rows.filter((r) => r.at + r.sec * 1000 > T + 60_000).length,
      // Rows written AFTER the bus's last fix (an EOS window only): upstream
      // still naming a vehicle the position feed no longer carries.
      afterEnd: kind === "eos" ? rowsIn(bus, T + 1, T + 30 * 60_000).length : 0,
      rowsN: rows.length, coverage,
    });
  };
  // last appearance of each service day = the last run ending in that day (censored near the data end)
  const byDay = new Map<string, { start: number; end: number; routeId: number }>();
  for (const r of runs) byDay.set(serviceDay(r.end), r);
  for (const r of byDay.values()) {
    if (dataEnd - r.end < CENSOR_MS) { censored++; continue; }
    if (r.end - r.start < WINDOW_MS) continue;
    measure("eos", r.end, r.routeId);
  }
  for (const r of runs) {
    for (let T = r.start + WINDOW_MS; T + CONTROL_AHEAD_MS <= r.end; T += CONTROL_EVERY_MS) measure("control", T, r.routeId);
  }
}
log(`windows: eos ${wins.filter((w) => w.kind === "eos").length}, control ${wins.filter((w) => w.kind === "control").length}, censored ${censored}, poller inactive ${inactive}`);

// -- Tables ---------------------------------------------------------------------
const pct = (a: number, b: number) => (b ? `${r1((100 * a) / b)}%` : "–");
function summary(sel: readonly Win[]) {
  const n = sel.length;
  const gaps = sel.map((w) => (w.gapMin === null ? 999 : w.gapMin)).sort((a, b) => a - b);
  const flagged = FLAGS_MIN.map((k) => sel.filter((w) => w.gapMin === null || w.gapMin >= k).length);
  const noRowAtAll = sel.filter((w) => w.rowsN === 0).length;
  const shrink = sel.filter((w) => w.hMaxEarly !== null && w.hMaxLate !== null).map((w) => (w.hMaxEarly! - w.hMaxLate!) / 60).sort((a, b) => a - b);
  const vanishedHorizon = sel.filter((w) => w.hMaxEarly !== null && w.hMaxLate === null).length;
  const pastEnd = sel.filter((w) => w.pastEnd > 0).length;
  const pastEndRows = sel.reduce((s, w) => s + w.pastEnd, 0);
  const afterEnd = sel.filter((w) => w.afterEnd > 0).length;
  return { n, afterEnd, gapP50: quantile(gaps, 0.5), gapP25: quantile(gaps, 0.25), gapP75: quantile(gaps, 0.75), flagged, noRowAtAll, shrinkP50: quantile(shrink, 0.5), shrinkN: shrink.length, vanishedHorizon, pastEnd, pastEndRows };
}
const header = ["slice", "kind", "windows", "gap to last row: p25 / p50 / p75 (min)", ...FLAGS_MIN.map((k) => `no row in last ${k} min`), "no row in the whole 15 min", "rows early but none late", "horizon shrink p50 (min, early−late)", "windows with a promise past the end", "rows promised past the end", "EOS: rows written after the last fix (30 min)"];
function row(label: string, kind: "eos" | "control", sel: readonly Win[]): (string | number)[] {
  const s = summary(sel);
  return [label, kind, s.n, `${r1(s.gapP25)} / ${r1(s.gapP50)} / ${r1(s.gapP75)}`, ...s.flagged.map((f) => pct(f, s.n)), pct(s.noRowAtAll, s.n), pct(s.vanishedHorizon, s.n), `${r1(s.shrinkP50)} (n=${s.shrinkN})`, pct(s.pastEnd, s.n), s.pastEndRows, kind === "eos" ? pct(s.afterEnd, s.n) : "–"];
}
const rows: (string | number)[][] = [];
const routes = [...new Set(wins.map((w) => w.routeId))].sort((a, b) => a - b);
for (const r of routes) {
  rows.push(row(`${names.get(r)} (${r})`, "eos", wins.filter((w) => w.routeId === r && w.kind === "eos")));
  rows.push(row("", "control", wins.filter((w) => w.routeId === r && w.kind === "control")));
}
rows.push(row("all", "eos", wins.filter((w) => w.kind === "eos")));
rows.push(row("", "control", wins.filter((w) => w.kind === "control")));

// Precision / recall of the flag over pooled windows.
const prHeader = ["rule", "EOS flagged (recall)", "control flagged (false-positive rate)", "precision over pooled windows", "precision if EOS is 1 in 20 live windows"];
const eos = wins.filter((w) => w.kind === "eos"), ctl = wins.filter((w) => w.kind === "control");
const prRows = FLAGS_MIN.map((k) => {
  const tp = eos.filter((w) => w.gapMin === null || w.gapMin >= k).length;
  const fp = ctl.filter((w) => w.gapMin === null || w.gapMin >= k).length;
  const rec = tp / Math.max(1, eos.length), fpr = fp / Math.max(1, ctl.length);
  return [`no upstream row for the bus in the last ${k} min`, `${tp}/${eos.length} = ${r1(100 * rec)}%`, `${fp}/${ctl.length} = ${r1(100 * fpr)}%`, pct(tp, tp + fp), `${r1((100 * 0.05 * rec) / (0.05 * rec + 0.95 * fpr))}%`];
});
// Per-minute presence curve: share of windows with a row in minute k before T.
const curveHeader = ["minutes before the end", ...Array.from({ length: 15 }, (_, i) => String(15 - i))];
const curve = (sel: readonly Win[]) => Array.from({ length: 15 }, (_, i) => { const k = 15 - i; return pct(sel.filter((w) => w.hasRow[k - 1]).length, sel.length); });
const curveRows = [["EOS windows (bus about to leave)", ...curve(eos)], ["control windows", ...curve(ctl)]];

const md = [
  `# Q4 — upstream before a bus goes out of service (${fmtEt(winFrom)} .. ${fmtEt(winTo)} ET)`,
  ``,
  `EOS window = the 15 min before a bus's last appearance of the service day (4 am–4 am ET; presence runs with gaps ≤ 10 min; runs ending within 20 min of the data end are censored: ${censored}). Control = a window every 15 min through every presence run where the bus went on ≥ 30 min. Windows with the poller active < 80% of minutes are skipped (${inactive}). "gap" = minutes from the bus's latest upstream row (any stop) to the window's end; 999 = never seen by upstream. A bus has upstream rows only while it is within 30 min of a POLLED stop (five focus stops every cycle, the rest a rotation), so a gap is also just the sampling — which is what the control column measures.`,
  ``,
  mdTable(header, rows),
  ``,
  `**The flag as a rule** — "no upstream row for the bus in the last k minutes" ⇒ out of service. Precision is over the pooled EOS + control windows; the last column re-weights to one EOS per twenty live 15-min windows (a bus in service ~5 h).`,
  ``,
  mdTable(prHeader, prRows),
  ``,
  `**Presence curve** — share of windows with at least one upstream row for the bus in each minute before the window's end.`,
  ``,
  mdTable(curveHeader, curveRows),
  ``,
].join("\n");
writeText("eos.md", md);
writeJson("eos.json", { eos: summary(eos), control: summary(ctl), byRoute: Object.fromEntries(routes.map((r) => [names.get(r), { eos: summary(wins.filter((w) => w.routeId === r && w.kind === "eos")), control: summary(wins.filter((w) => w.routeId === r && w.kind === "control")) }])) });
console.log(md);
log("done");
