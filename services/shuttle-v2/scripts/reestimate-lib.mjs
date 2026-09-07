/**
 * The estimators and the promotion rule behind scripts/reestimate-params.mjs
 * (docs/closed-loop.md, stages 3-4) — pure functions over rows, so
 * reestimate-lib.test.mjs can hand them fixtures with known answers.
 *
 * WHAT IS ESTIMATED, AND HOW EACH NUMBER WAS FIRST MEASURED. The filter's
 * constants (web/src/eta/filter.ts) came from docs/eta-error-budget.md on
 * one day of the feed; the definitions are reproduced here exactly so a
 * re-count on the same day gives the same numbers (the first run checked
 * that — see the doc).
 *
 *   stillness      a sample is STANDING iff some run of consecutive samples
 *                  containing it stays inside a 25 m ball for >= 15 s with
 *                  no feed gap over 60 s inside the run (hop-anatomy.ts).
 *                  Not "coordinate unchanged", which calls a moving bus
 *                  stopped a fifth of the time.
 *   P_REPEAT_*     over consecutive samples of one bus_name <= 60 s apart:
 *                  the share whose coordinate is byte-identical, split by the
 *                  earlier sample's mode; _ZONE restricts the moving pairs to
 *                  samples within 75 m of a stop of the bus's route.
 *   HOLD_ENTER     standing-after-moving transitions over moving seconds;
 *   HOLD_LEAVE     the converse. Per second.
 *   SHUFFLE        over stopped visits (stop_visits, outcome "stopped" with
 *                  a rest): repositions per poll at rest.
 *   P_DEPART       departures over (departures + shuffles): the share of
 *                  "a standing bus moved" events that were the bus leaving.
 *   CONFORMAL      per promised-minutes bucket, the factor w by which the
 *                  shown 10-90 band must be scaled about the number for the
 *                  detector's arrival to fall inside it 80% of the time —
 *                  split conformal: the ceil((n+1)·0.8)-th smallest of the
 *                  per-pair factors needed.
 */

export const COMPILED = Object.freeze({
  P_REPEAT_STAND: 0.919,
  P_REPEAT_MOVE: 0.159,
  P_REPEAT_MOVE_ZONE: 0.5,
  HOLD_ENTER_PER_S: 0.01612,
  HOLD_LEAVE_PER_S: 0.01457,
  SHUFFLE_PER_POLL: 0.03,
  P_DEPART_ON_FRESH: 0.76,
  CONFORMAL: Object.freeze({ "0-2": 1, "2-5": 1, "5-10": 1, "10-30": 1 }),
});
export const SCALAR_KEYS = ["P_REPEAT_STAND", "P_REPEAT_MOVE", "P_REPEAT_MOVE_ZONE", "HOLD_ENTER_PER_S", "HOLD_LEAVE_PER_S", "SHUFFLE_PER_POLL", "P_DEPART_ON_FRESH"];
export const HORIZONS = ["0-2", "2-5", "5-10", "10-30"];
/** Mirrors web/src/eta/params.ts and src/server/modelParams.ts. */
export const RANGES = {
  P_REPEAT_STAND: [0.7, 0.995],
  P_REPEAT_MOVE: [0.02, 0.5],
  P_REPEAT_MOVE_ZONE: [0.1, 0.9],
  HOLD_ENTER_PER_S: [0.002, 0.1],
  HOLD_LEAVE_PER_S: [0.002, 0.1],
  SHUFFLE_PER_POLL: [0.002, 0.2],
  P_DEPART_ON_FRESH: [0.3, 0.98],
};
export const CONFORMAL_RANGE = [0.5, 4];

/**
 * The sample a key needs before its estimate is published. Emissions are
 * counted per poll (a day is ~70k pairs, so 5,000 is an hour of fleet); the
 * hazards per transition (the original measurement had ~2,900 of each);
 * the visit rates per stopped visit; the conformal factor per scored pair
 * in the bucket.
 */
export const N_FLOORS = {
  P_REPEAT_STAND: 5000,
  P_REPEAT_MOVE: 5000,
  P_REPEAT_MOVE_ZONE: 2000,
  HOLD_ENTER_PER_S: 500,
  HOLD_LEAVE_PER_S: 500,
  SHUFFLE_PER_POLL: 200,
  P_DEPART_ON_FRESH: 200,
  CONFORMAL: 300,
};
/**
 * How far a fit may move from the compiled constant without `--allow-drift`:
 * a probability by 0.15 absolute, a rate by a factor of 2 either way. A
 * re-measurement of a stationary quantity lands well inside; a jump past
 * these is a changed definition or a broken feed, and wants a human.
 */
export const DRIFT = {
  P_REPEAT_STAND: { abs: 0.15 },
  P_REPEAT_MOVE: { abs: 0.15 },
  P_REPEAT_MOVE_ZONE: { abs: 0.15 },
  P_DEPART_ON_FRESH: { abs: 0.15 },
  HOLD_ENTER_PER_S: { factor: 2 },
  HOLD_LEAVE_PER_S: { factor: 2 },
  SHUFFLE_PER_POLL: { factor: 2 },
};

// -- geometry -------------------------------------------------------------------

/** Equirectangular metres, as src/network/geo.ts distanceMeters. */
export function distanceMeters(a, b) {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const x = dLon * Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180);
  return R * Math.sqrt(x * x + dLat * dLat);
}

// -- stillness ------------------------------------------------------------------

export const STILL_RADIUS_M = 25;
export const MIN_STILL_S = 15;
export const GAP_MS = 60_000;
export const ZONE_M = 75;

/**
 * The run-based classifier of hop-anatomy.ts: still[i] = 1 iff some run of
 * consecutive samples containing i stays inside STILL_RADIUS_M for at least
 * MIN_STILL_S with no gap over GAP_MS. `track` is one bus_name's samples in
 * time order: {lat, lon, t}.
 */
export function stillRuns(track) {
  const n = track.length;
  const still = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    let j = i;
    while (j + 1 < n) {
      if (track[j + 1].t - track[j].t > GAP_MS) break;
      if (distanceMeters(track[i], track[j + 1]) > STILL_RADIUS_M) break;
      j++;
    }
    if (track[j].t - track[i].t >= MIN_STILL_S * 1000) for (let k = i; k <= j; k++) still[k] = 1;
  }
  return still;
}

/** Group positions by bus_name, each in time order. */
export function tracksByName(positions) {
  const by = new Map();
  for (const p of positions) {
    let l = by.get(p.bus_name);
    if (!l) by.set(p.bus_name, (l = []));
    l.push({ lat: p.lat, lon: p.lon, t: p.collected_at, route_id: p.route_id });
  }
  for (const l of by.values()) l.sort((a, b) => a.t - b.t);
  return by;
}

// -- the emissions and the hold hazards -----------------------------------------

/**
 * Count the deadband emissions and the hold hazards over every track.
 * `inZone(sample)` says whether a sample is within ZONE_M of a stop of its
 * route (null = no zone split). Returns {key: {value, n, ...counts}}.
 */
export function estimateEmissions(tracks, inZone = null) {
  let standPairs = 0, standFrozen = 0, movePairs = 0, moveFrozen = 0, zonePairs = 0, zoneFrozen = 0;
  let toStand = 0, toMove = 0, moveSec = 0, standSec = 0;
  for (const track of tracks.values()) {
    const still = stillRuns(track);
    for (let i = 0; i + 1 < track.length; i++) {
      const a = track[i], b = track[i + 1];
      const dtMs = b.t - a.t;
      if (dtMs <= 0 || dtMs > GAP_MS) continue;
      const frozen = a.lat === b.lat && a.lon === b.lon ? 1 : 0;
      const dt = dtMs / 1000;
      if (still[i] === 1) {
        standPairs++; standFrozen += frozen; standSec += dt;
        if (still[i + 1] === 0) toMove++;
      } else {
        movePairs++; moveFrozen += frozen; moveSec += dt;
        if (still[i + 1] === 1) toStand++;
        if (inZone && inZone(a)) { zonePairs++; zoneFrozen += frozen; }
      }
    }
  }
  const ratio = (a, b) => (b > 0 ? a / b : null);
  return {
    P_REPEAT_STAND: { value: ratio(standFrozen, standPairs), n: standPairs, frozen: standFrozen },
    P_REPEAT_MOVE: { value: ratio(moveFrozen, movePairs), n: movePairs, frozen: moveFrozen },
    P_REPEAT_MOVE_ZONE: { value: ratio(zoneFrozen, zonePairs), n: zonePairs, frozen: zoneFrozen },
    HOLD_ENTER_PER_S: { value: ratio(toStand, moveSec), n: toStand, seconds: Math.round(moveSec) },
    HOLD_LEAVE_PER_S: { value: ratio(toMove, standSec), n: toMove, seconds: Math.round(standSec) },
  };
}

/** A zone test from the topology: within ZONE_M of any stop of the sample's route. */
export function zoneTester(routes, stopCoords) {
  const stopsOf = new Map();
  for (const r of routes) stopsOf.set(r.id, [...new Set(r.stops)].map((s) => stopCoords[s]).filter(Boolean));
  return (sample) => {
    const stops = stopsOf.get(sample.route_id);
    if (!stops) return false;
    for (const s of stops) if (distanceMeters(sample, s) <= ZONE_M) return true;
    return false;
  };
}

// -- the visit rates ------------------------------------------------------------

/** Over stopped visits with a rest: shuffles per poll at rest, and departures over moves. */
export function estimateVisitRates(visits) {
  let stopped = 0, shuffles = 0, restPolls = 0;
  for (const v of visits) {
    if (v.outcome !== "stopped") continue;
    if (!(v.rest_polls > 0)) continue;
    stopped++;
    shuffles += v.shuffles ?? 0;
    restPolls += v.rest_polls;
  }
  return {
    SHUFFLE_PER_POLL: { value: restPolls > 0 ? shuffles / restPolls : null, n: stopped, shuffles, restPolls },
    P_DEPART_ON_FRESH: { value: stopped + shuffles > 0 ? stopped / (stopped + shuffles) : null, n: stopped, shuffles },
  };
}

// -- pairs from the replay --------------------------------------------------------

/** The scorecard's bucket for a promised number of seconds (scorecard.ts horizonOf); null past the cap. */
export function horizonOf(sec, capSec = 1800) {
  if (!(sec <= capSec)) return null;
  const m = sec / 60;
  if (m < 2) return "0-2";
  if (m < 5) return "2-5";
  if (m < 10) return "5-10";
  return "10-30";
}

/** Read a PAIRS_OUT file into rows. */
export function parsePairs(text) {
  const out = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    out.push(JSON.parse(line));
  }
  return out;
}

export function widen(eta, low, high, w) {
  if (w === 1) return [low, high];
  return [eta - (eta - low) * w, eta + (high - eta) * w];
}

/**
 * Split-conformal widening per bucket from scored pairs (truth = the
 * detector's arrival, `det`): for each pair the factor its band needed to
 * cover the truth, then the ceil((n+1)·target)-th smallest. A pair whose
 * band has no width on the side the truth fell needs an infinite factor and
 * is counted as such — it pushes the quantile up, honestly.
 */
export function conformalFit(pairs, target = 0.8, capSec = 1800) {
  const need = { "0-2": [], "2-5": [], "5-10": [], "10-30": [] };
  for (const p of pairs) {
    if (p.det === null || p.det === undefined) continue;
    const h = horizonOf(p.eta, capSec);
    if (!h) continue;
    const a = p.det;
    let w;
    if (a > p.eta) w = p.high > p.eta ? (a - p.eta) / (p.high - p.eta) : Infinity;
    else if (a < p.eta) w = p.low < p.eta ? (p.eta - a) / (p.eta - p.low) : Infinity;
    else w = 0;
    need[h].push(w);
  }
  const out = {};
  for (const h of HORIZONS) {
    const v = need[h].sort((x, y) => x - y);
    const n = v.length;
    if (n === 0) { out[h] = { w: null, n: 0 }; continue; }
    const k = Math.min(n - 1, Math.ceil((n + 1) * target) - 1);
    const w = v[k];
    out[h] = { w: Number.isFinite(w) ? Math.round(w * 1000) / 1000 : null, n, infinite: v.filter((x) => !Number.isFinite(x)).length };
  }
  return out;
}

function quantileSorted(sorted, q) {
  if (sorted.length === 0) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i];
}
const r1 = (x) => (x === null ? null : Math.round(x * 10) / 10);

/**
 * Scorecard rows from pairs, the scorecard's own rules (promise <= cap,
 * truth = the detector's arrival, error = promise - actual) with an optional
 * conformal table applied to the bands first. Rows for every route seen and
 * for route 0 (pooled), per horizon and "all". Pairs without a detector
 * truth are `missing`.
 */
export function scoreRows(pairs, conformal = null, capSec = 1800) {
  const cells = new Map();
  const cell = (routeId, horizon) => {
    const key = `${routeId}|${horizon}`;
    let c = cells.get(key);
    if (!c) cells.set(key, (c = { routeId, horizon, n: 0, beyond: 0, missing: 0, errs: [], intervalRows: 0, inside: 0 }));
    return c;
  };
  for (const p of pairs) {
    const routes = [p.r, 0];
    const h = horizonOf(p.eta, capSec);
    if (!h) { for (const r of routes) { const c = cell(r, "all"); c.n++; c.beyond++; } continue; }
    if (p.det === null || p.det === undefined) { for (const r of routes) for (const hh of [h, "all"]) { const c = cell(r, hh); c.n++; c.missing++; } continue; }
    const w = conformal ? conformal[h] ?? 1 : 1;
    const [low, high] = widen(p.eta, p.low, p.high, w);
    const err = p.eta - p.det;
    const band = low < high;
    const covered = band && p.det >= low && p.det <= high;
    for (const r of routes) for (const hh of [h, "all"]) {
      const c = cell(r, hh);
      c.n++; c.errs.push(err);
      if (band) { c.intervalRows++; if (covered) c.inside++; }
    }
  }
  const rows = [];
  for (const c of cells.values()) {
    const abs = c.errs.map(Math.abs).sort((a, b) => a - b);
    const signed = [...c.errs].sort((a, b) => a - b);
    const paired = c.errs.length;
    const pct = (k) => (paired ? r1((100 * k) / paired) : null);
    rows.push({
      routeId: c.routeId, horizon: c.horizon,
      metrics: {
        n: c.n, beyondHorizon: c.beyond, standing: 0, missing: c.missing, paired,
        medianSignedSec: r1(quantileSorted(signed, 0.5)), medianAbsSec: r1(quantileSorted(abs, 0.5)), p90AbsSec: r1(quantileSorted(abs, 0.9)),
        within120Pct: pct(abs.filter((e) => e <= 120).length),
        pessimistic120Pct: pct(c.errs.filter((e) => e >= 120).length),
        optimistic120Pct: pct(c.errs.filter((e) => e <= -120).length),
        intervalRows: c.intervalRows, intervalCoveragePct: c.intervalRows ? r1((100 * c.inside) / c.intervalRows) : null,
        waits: 0, strands: 0, jumpPairs: 0, jumps: 0,
      },
    });
  }
  rows.sort((a, b) => a.routeId - b.routeId || a.horizon.localeCompare(b.horizon));
  return rows;
}

export function pooled(rows, horizon = "all") {
  return rows.find((r) => r.routeId === 0 && r.horizon === horizon)?.metrics ?? null;
}

// -- the candidate ----------------------------------------------------------------

/**
 * Assemble the candidate from the fits: each key takes its fitted value when
 * the fit has enough sample, sits inside its range and — unless `allowDrift`
 * — within the drift bound of the compiled constant; otherwise it keeps the
 * champion's value and the reason is logged. Returns {params, n, issues}.
 */
export function assembleCandidate(fits, conformal, champion, { allowDrift = false } = {}) {
  const params = { ...champion, CONFORMAL: { ...champion.CONFORMAL } };
  const n = {};
  const issues = [];
  const keep = (key, reason) => issues.push({ key, reason, kept: key.startsWith("CONFORMAL") ? champion.CONFORMAL[key.slice(10)] : champion[key] });
  for (const key of SCALAR_KEYS) {
    const f = fits[key];
    n[key] = f?.n ?? 0;
    if (!f || f.value === null || !Number.isFinite(f.value)) { keep(key, "no estimate"); continue; }
    const v = Math.round(f.value * 1e5) / 1e5;
    if (f.n < N_FLOORS[key]) { keep(key, `n ${f.n} under the floor ${N_FLOORS[key]}`); continue; }
    const [lo, hi] = RANGES[key];
    if (v < lo || v > hi) { keep(key, `${v} outside [${lo}, ${hi}]`); continue; }
    const d = DRIFT[key];
    const c = COMPILED[key];
    const drifted = d.abs !== undefined ? Math.abs(v - c) > d.abs : v > c * d.factor || v < c / d.factor;
    if (drifted && !allowDrift) { keep(key, `${v} is more than ${d.abs !== undefined ? `±${d.abs}` : `×${d.factor}`} from the compiled ${c} (pass --allow-drift to publish it)`); continue; }
    params[key] = v;
  }
  for (const h of HORIZONS) {
    const f = conformal?.[h];
    n[`CONFORMAL.${h}`] = f?.n ?? 0;
    if (!f || f.w === null) { keep(`CONFORMAL.${h}`, "no estimate"); continue; }
    if (f.n < N_FLOORS.CONFORMAL) { keep(`CONFORMAL.${h}`, `n ${f.n} under the floor ${N_FLOORS.CONFORMAL}`); continue; }
    if (f.w < CONFORMAL_RANGE[0] || f.w > CONFORMAL_RANGE[1]) { keep(`CONFORMAL.${h}`, `${f.w} outside [${CONFORMAL_RANGE[0]}, ${CONFORMAL_RANGE[1]}]`); continue; }
    params.CONFORMAL[h] = f.w;
  }
  return { params, n, issues };
}

export function sameParams(a, b) {
  for (const k of SCALAR_KEYS) if (a[k] !== b[k]) return false;
  for (const h of HORIZONS) if (a.CONFORMAL[h] !== b.CONFORMAL[h]) return false;
  return true;
}

// -- the promotion rule --------------------------------------------------------------

export function sd(values) {
  const v = values.filter((x) => x !== null && Number.isFinite(x));
  if (v.length < 2) return null;
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  return Math.sqrt(v.reduce((a, b) => a + (b - m) * (b - m), 0) / (v.length - 1));
}

/** The floors under the noise bounds: the median moves by seconds and the coverage by points on any two days. */
export const MIN_MEDIAN_BOUND_SEC = 3;
export const MIN_COVERAGE_BOUND_PCT = 2;

/**
 * Champion against challenger on the same days. `days` is
 * [{day, champion: {medianAbsSec, intervalCoveragePct}, challenger: {...}}]
 * in date order; `heldOut` names the day the challenger's conformal table
 * was NOT fitted on (its coverage there is the honest one). The noise bound
 * is the day-to-day standard deviation of the CHAMPION's own numbers over
 * these days (floored), because that is how much the same estimator moves
 * with nothing changed. The challenger is promoted when its mean median
 * |error| over the days is not worse than the champion's by more than the
 * bound, and its held-out coverage is not lower than the champion's by more
 * than the coverage bound.
 */
export function promotionDecision(days, heldOut) {
  const champMed = days.map((d) => d.champion.medianAbsSec);
  const champCov = days.map((d) => d.champion.intervalCoveragePct);
  const medBound = Math.max(MIN_MEDIAN_BOUND_SEC, sd(champMed) ?? 0);
  const covBound = Math.max(MIN_COVERAGE_BOUND_PCT, sd(champCov) ?? 0);
  const diffs = days.map((d) => d.challenger.medianAbsSec - d.champion.medianAbsSec);
  const medDiff = diffs.reduce((a, b) => a + b, 0) / Math.max(1, diffs.length);
  const held = days.find((d) => d.day === heldOut) ?? days[days.length - 1];
  const covDiff = held ? (held.challenger.intervalCoveragePct ?? 0) - (held.champion.intervalCoveragePct ?? 0) : 0;
  const reasons = [];
  if (days.length === 0) reasons.push("no replay days");
  if (medDiff > medBound) reasons.push(`median |err| worse by ${medDiff.toFixed(1)} s (bound ${medBound.toFixed(1)} s)`);
  if (covDiff < -covBound) reasons.push(`held-out coverage lower by ${(-covDiff).toFixed(1)} pts (bound ${covBound.toFixed(1)})`);
  return {
    promote: reasons.length === 0,
    reasons,
    bounds: { medianSec: Math.round(medBound * 10) / 10, coveragePct: Math.round(covBound * 10) / 10 },
    medianDiffSec: Math.round(medDiff * 10) / 10,
    coverageDiffPct: Math.round(covDiff * 10) / 10,
    heldOut: held?.day ?? null,
    perDay: days.map((d, i) => ({ day: d.day, champion: d.champion, challenger: d.challenger, medianDiffSec: Math.round(diffs[i] * 10) / 10 })),
  };
}
