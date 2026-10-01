/** Chronological evaluation and artifact integrity. No publication side effects. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { conformalFactor } from '../web/src/eta/conformal.mjs';
import { COMPILED, assembleCandidate, conformalFit, fitHorizonBias, fitRouteScales,
  horizonBiasEffect, horizonOf, scaleEffect, widen } from './reestimate-lib.mjs';

export function chronologicalPlan(available, { trainDays = 14, evaluationDays = 8 } = {}) {
  const days = [...new Set(available)].sort();
  // Two correction-fit days, one correction-selection day, two interval-
  // calibration days, and at least three final test days. Training is earlier.
  const testDays = Math.max(3, evaluationDays - 5);
  const reserved = 5 + testDays;
  if (days.length < reserved + 7) return { ready: false, reasons: [
    `Need at least ${reserved + 7} distinct archived days for seven training days and separate correction fit, selection, calibration and test blocks; found ${days.length}.`,
  ] };
  const training = days.slice(Math.max(0, days.length - reserved - Math.max(7, trainDays)), -reserved);
  const later = days.slice(-reserved);
  return { ready: true, training, correctionFit: later.slice(0, 2), selection: later.slice(2, 3),
    calibration: later.slice(3, 5), test: later.slice(5), reasons: [] };
}

export function visitAvailableBy(row, cutoff) {
  const departure = Number.isFinite(row.departed_at) ? row.departed_at : row.outcome === 'passed' ? row.anchored_at : NaN;
  if (!Number.isFinite(departure)) return false;
  const first = Number.isFinite(row.first_moved_at) ? row.first_moved_at : departure;
  const confirmation = Number.isFinite(row.confirm_sec) ? Math.max(0, row.confirm_sec) * 1000 : 0;
  return Math.max(departure, first) + confirmation <= cutoff;
}

/** Injectable I/O keeps the ordering testable without replaying/publishing.
 * The final test block is deliberately not read by candidate fitting. */
export function researchCandidate(plan, { fits, allowDrift = false, replay, read, pooledShares }) {
  if (!plan.ready) throw new Error('Insufficient chronological blocks');
  const files = (dates, phase, params) => dates.map(day => replay(day, phase, params));
  function* pairs(paths) {
    for (const file of paths) for (const p of read(file)) {
      if ([p.eta, p.low, p.high, p.det].every(v => typeof v === 'number' && Number.isFinite(v))
        && p.det >= 0 && p.eta >= 0 && p.low <= p.eta && p.eta <= p.high) yield p;
    }
  }
  // A current published champion may have learned from our historical test
  // dates. Sparse candidate cells fall back to fixed compiled parameters,
  // never to that future-fitted champion.
  let candidate = assembleCandidate(fits, null, COMPILED, { allowDrift });
  const reference = { ...candidate.params, ROUTE_SCALE: {}, HORIZON_BIAS: COMPILED.HORIZON_BIAS };
  const fitFiles = files(plan.correctionFit, 'correction-fit', reference);
  const selectionFiles = files(plan.selection, 'correction-selection', reference);
  const routeScaleFit = fitRouteScales(pairs(fitFiles), { coverage: pooledShares(plan.correctionFit) });
  const horizonBiasFit = fitHorizonBias(pairs(fitFiles));
  const routeEffect = { day: plan.selection.join(','), ...scaleEffect(pairs(selectionFiles),
    Object.fromEntries(Object.entries(routeScaleFit).map(([r, f]) => [r, f.value]))) };
  const biasEffect = { day: plan.selection.join(','), ...horizonBiasEffect(pairs(selectionFiles), horizonBiasFit) };
  candidate = assembleCandidate(fits, null, COMPILED, { allowDrift,
    routeScales: routeScaleFit, heldOut: routeEffect, horizonBias: horizonBiasFit, horizonHeldOut: biasEffect });
  const conformal = conformalFit(pairs(files(plan.calibration, 'interval-calibration', candidate.params)));
  const calibrated = assembleCandidate({}, conformal, candidate.params);
  candidate = { params: calibrated.params,
    n: { ...candidate.n, ...Object.fromEntries(Object.entries(calibrated.n).filter(([key]) => key.startsWith('CONFORMAL.'))) },
    issues: [...candidate.issues, ...calibrated.issues.filter(i => i.key.startsWith('CONFORMAL.'))] };
  return { candidate, conformal, routeScaleFit, horizonBiasFit };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
export function identityHash(value) { return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'); }
export function fileHash(file) {
  const hash = createHash('sha256');
  const fd = fs.openSync(file, 'r'), buf = Buffer.alloc(1024 * 1024);
  try { for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0;) hash.update(buf.subarray(0, n)); }
  finally { fs.closeSync(fd); }
  return hash.digest('hex');
}
export function fileIdentity(files) {
  return files.sort().map(file => [file, fs.existsSync(file) ? fileHash(file) : null]);
}

/** A successful producer and validation are required before a cache becomes
 * reusable. A bare file, interrupted write, altered output, or different input
 * identity is a miss. The receipt is written last, atomically. */
export function cachedArtifact(file, identity, produce, validate) {
  const key = identityHash(identity), receipt = `${file}.complete.json`;
  try {
    const old = JSON.parse(fs.readFileSync(receipt, 'utf8'));
    if (old.key === key && old.sha256 === fileHash(file)) return { file, reused: true, key };
  } catch { /* missing, interrupted, or invalid */ }
  const temp = `${file}.partial-${process.pid}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.rmSync(receipt, { force: true });
  try {
    produce(temp);
    validate(temp);
    const sha256 = fileHash(temp);
    fs.renameSync(temp, file);
    fs.writeFileSync(`${receipt}.partial`, JSON.stringify({ key, sha256, identity }));
    fs.renameSync(`${receipt}.partial`, receipt);
  } finally {
    for (const f of [temp, `${temp}-wal`, `${temp}-shm`, `${receipt}.partial`]) fs.rmSync(f, { force: true });
  }
  return { file, reused: false, key };
}

/** Descriptive scores. Repeated poll rows are NOT independent test trips.
 * Promotion separately requires verified trip sampling and availability. */
export function validationCells(pairs, conformal) {
  const cells = new Map();
  for (const p of pairs) {
    if (![p.r, p.eta].every(Number.isFinite)) continue;
    const h = horizonOf(p.eta, 1800);
    if (!h || p.eta < 0) continue;
    const keys = [`0|all`, `0|${h}`, `${p.r}|all`, `${p.r}|${h}`];
    const usable = [p.det, p.low, p.high].every(v => typeof v === 'number' && Number.isFinite(v))
      && p.det >= 0 && p.low <= p.eta && p.eta <= p.high;
    let low, high;
    if (usable) {
      [low, high] = widen(p.eta, p.low, p.high, conformalFactor(p.eta, conformal));
      low = Math.max(0, low); // the live browser clips remaining time at zero
    }
    for (const key of keys) {
      let c = cells.get(key);
      if (!c) cells.set(key, c = { n: 0, scored: 0, covered: 0, late: 0, early: 0, abs: 0, wis: 0, width: 0 });
      c.n++;
      if (!usable) continue;
      const abs = Math.abs(p.det - p.eta);
      const intervalScore = high - low + 10 * Math.max(0, low - p.det) + 10 * Math.max(0, p.det - high);
      c.scored++; c.covered += Number(p.det >= low && p.det <= high);
      c.late += Number(p.det > high); c.early += Number(p.det < low);
      c.abs += abs; c.width += high - low;
      // Weighted interval score: median plus the central 80% interval.
      c.wis += (0.5 * abs + 0.1 * intervalScore) / 1.5;
    }
  }
  return Object.fromEntries(cells);
}

/** Operational promotion gate, not a proof of conditional calibration. */
export function validationDecision(perDay, { groupingVerified = false, availabilityVerified = false, baselineVintageVerified = false } = {}) {
  const reasons = [];
  if (!groupingVerified) reasons.push('Automatic promotion blocked: replay pairs lack verified bus-target-visit sampling/identity; correlated polls are not independent trips.');
  if (!availabilityVerified) reasons.push('Automatic promotion blocked: legacy outcomes lack exact availability/confirmation timestamps.');
  if (!baselineVintageVerified) reasons.push('Automatic promotion blocked: current champion is a counterfactual comparator, not a verified pre-test model vintage.');
  if (new Set(perDay.map(d => d.day)).size < 3) reasons.push('Need at least three untouched test dates with paired data.');
  const totals = { champion: {}, challenger: {} };
  const daysPerCell = new Map();
  for (const d of perDay) {
    if (!d.champion?.['0|all']?.scored || !d.challenger?.['0|all']?.scored) reasons.push(`${d.day}: missing paired test data.`);
    for (const arm of ['champion', 'challenger']) for (const [key, c] of Object.entries(d[arm] ?? {})) {
      const sum = totals[arm][key] ??= { n: 0, scored: 0, covered: 0, late: 0, early: 0, abs: 0, wis: 0, width: 0 };
      for (const metric of Object.keys(sum)) sum[metric] += c[metric];
      if (c.scored && d.champion?.[key]?.scored && d.challenger?.[key]?.scored) {
        if (!daysPerCell.has(key)) daysPerCell.set(key, new Set());
        daysPerCell.get(key).add(d.day);
      }
    }
  }
  const keys = new Set([...Object.keys(totals.champion), ...Object.keys(totals.challenger)]);
  if (!keys.size) reasons.push('No scored route/horizon cells.');
  for (const key of keys) {
    const a = totals.champion[key], b = totals.challenger[key];
    if (!a || !b || Math.min(a.scored, b.scored) < 30 || (daysPerCell.get(key)?.size ?? 0) < 3) {
      reasons.push(`${key}: insufficient paired trip support (30 trips on three dates required).`); continue;
    }
    const coverA = a.covered / a.scored, coverB = b.covered / b.scored;
    if (coverB < 0.78 || coverB < coverA - 0.02) reasons.push(`${key}: interval coverage below 78% or regressed by more than two points.`);
    if (b.late / b.scored > 0.15 || b.late / b.scored > a.late / a.scored + 0.02) reasons.push(`${key}: upper-tail misses exceed 15% or regress by more than two points.`);
    if (b.early / b.scored > 0.15 || b.early / b.scored > a.early / a.scored + 0.02) reasons.push(`${key}: early-arrival misses exceed 15% or regress by more than two points.`);
    if (b.wis / b.scored > a.wis / a.scored * 1.05) reasons.push(`${key}: weighted interval score worsened by more than 5%.`);
    if (b.abs / b.scored > a.abs / a.scored + 3) reasons.push(`${key}: mean absolute error worsened by more than three seconds.`);
    if (b.scored / b.n < a.scored / a.n - 0.02) reasons.push(`${key}: outcome matching fell by more than two points.`);
  }
  const a = totals.champion['0|all'], b = totals.challenger['0|all'];
  if (a?.scored && b?.scored && !(b.wis / b.scored < a.wis / a.scored * 0.999)) reasons.push('No improvement in pooled weighted interval score.');
  return { promote: reasons.length === 0, reasons, testDays: perDay.map(d => d.day), totals };
}
