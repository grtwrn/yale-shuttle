"""Bounded retrospective departure/remaining-wait experiment; no app mutations.

Frozen specification: 15 s hazard bins; L2 penalty 4; clock harmonics 15 min;
45 s logistic smoothing of training residuals; elapsed checkpoints 0/120/300/480.
The separately motivated prior-two-departure slot arm was added after the first
five-arm run; that original script/output is preserved as *-five-arms.*.
Fit before Sep10, calibrate Sep10-11, evaluate Sep14-17 (previously inspected).
"""
import collections, datetime, hashlib, json, math, pathlib, sqlite3, statistics
import numpy as np
from scipy.optimize import minimize
from scipy.special import expit
from zoneinfo import ZoneInfo

D = pathlib.Path(__file__).resolve().parent
ROOT = D.parent
source = json.loads((D / 'operating-pattern-screen.json').read_text())
slot_source = json.loads((D / 'release-policy-review.json').read_text())
slot_rows = {r['id']: r for r in slot_source['featureRows']}
slot_fits = {r['stop']: r['arms']['modernPhase2'] for r in slot_source['results']}
rows = source['featureRows']
TZ = ZoneInfo('America/New_York')
cut = lambda s: datetime.datetime.fromisoformat(s).replace(tzinfo=TZ).timestamp() * 1000
FIT, TEST = cut('2026-09-10'), cut('2026-09-14')
STEP, END, BANDWIDTH, PENALTY = 15, 3600, 45, 4
GRID = np.arange(0, END + STEP, STEP, dtype=float)
AGES = [0, 120, 300, 480]
ARMS = ['lap_residual', 'lap_clock15_residual', 'hazard_age_lap',
        'hazard_age_lap_clock15', 'hazard_age_lap_clock15_h2', 'slot_phase2_residual']
stops = {r['stop']: r for r in source['results']}

def split(rs):
    return ([r for r in rs if r['ready'] < FIT],
            [r for r in rs if r['a'] >= FIT and r['ready'] < TEST],
            [r for r in rs if r['a'] >= TEST])

def valid(r):
    ref = stops[r['stop']]['referenceLap']
    return r['lap'] is not None and .65 * ref <= r['lap'] <= 1.65 * ref

def metrics(rs):
    if not rs:
        return {'n': 0}
    e = np.array([r['point'] - r['truth'] for r in rs])
    ae = np.abs(e)
    w = np.array([r['high'] - r['low'] for r in rs])
    early = np.array([max(0, r['low'] - r['truth']) for r in rs])
    late = np.array([max(0, r['truth'] - r['high']) for r in rs])
    return dict(n=len(rs), episodes=len({r['id'] for r in rs}), mae=float(ae.mean()),
                medianAbs=float(np.median(ae)), p90Abs=float(np.quantile(ae, .9)),
                signed=float(e.mean()), width=float(w.mean()),
                WIS=float((.5 * ae + .1 * w + early + late).mean() / 1.5),
                early=int(sum(early > 0)), late=int(sum(late > 0)),
                over120=int(sum(e > 120)), under120=int(sum(e < -120)))

def design(r, t, arm):
    t = np.asarray(t)
    available = valid(r)
    lap = (r['lap'] - stops[r['stop']]['referenceLap']) / 600 if available else 0
    cols = [np.ones_like(t), np.log1p(t / 60), t / 600,
            np.maximum(t - 300, 0) / 600, np.maximum(t - 600, 0) / 600,
            np.full_like(t, lap), np.full_like(t, float(not available))]
    if 'clock15' in arm:
        phase = 2 * np.pi * (r['hour'] * 3600 + t) / 900
        cols += [np.sin(phase), np.cos(phase)]
        if arm.endswith('_h2'):
            cols += [np.sin(2 * phase), np.cos(2 * phase)]
    return np.stack(cols, axis=-1)

fits = {}
cdfs = {}
for stop in [11, 121]:
    tr, ca, te = split([r for r in rows if r['stop'] == stop])
    pooled = statistics.median(r['y'] for r in tr)
    for arm in ARMS:
        if arm.endswith('_residual'):
            original = 'lap_clock15' if 'clock15' in arm else 'lap'
            co = np.array(stops[stop]['arms'][original]['coefficients'])
            def center(r):
                slot = slot_rows[r['id']]
                if arm == 'slot_phase2_residual' and slot['modernPhase2Available']:
                    return max(0, slot['modernPhase2Slot'] + slot_fits[stop]['trainCenterCorrectionSec'])
                if not valid(r):
                    return pooled
                x = [1, (r['lap'] - stops[stop]['referenceLap']) / 600]
                if 'clock15' in arm:
                    phase = 2 * np.pi * r['hour'] * 60 / 15
                    x += [math.sin(phase), math.cos(phase)]
                return max(0, float(np.array(x) @ co))
            residuals = np.array([r['y'] - center(r) for r in tr])
            fits[stop, arm] = dict(coefficients=co.tolist(), residuals=residuals.tolist())
            for r in tr + ca + te:
                f = expit((GRID[:, None] - center(r) - residuals[None, :]) / BANDWIDTH).mean(axis=1)
                f = (f - f[0]) / max(1 - f[0], 1e-12)
                cdfs[r['id'], arm] = f
        else:
            xx, yy = [], []
            for r in tr:
                bins = max(1, int(math.ceil(r['y'] / STEP)))
                t = (np.arange(bins) + .5) * STEP
                xx.append(design(r, t, arm))
                y = np.zeros(bins); y[-1] = 1
                yy.append(y)
            X, y = np.vstack(xx), np.concatenate(yy)
            penalty = np.full(X.shape[1], PENALTY); penalty[0] = 0
            def objective(co):
                z = X @ co
                return (float((np.logaddexp(0, z) - y * z).sum() + .5 * (penalty * co ** 2).sum()),
                        X.T @ (expit(z) - y) + penalty * co)
            initial = np.zeros(X.shape[1]); initial[0] = math.log(y.mean() / (1 - y.mean()))
            opt = minimize(objective, initial, jac=True, method='L-BFGS-B', options={'maxiter': 2000, 'gtol': 1e-8})
            assert opt.success, opt.message
            fits[stop, arm] = dict(coefficients=opt.x.tolist(), trainRiskBins=len(y),
                                   trainEvents=int(y.sum()), converged=bool(opt.success))
            for r in tr + ca + te:
                hazard = np.clip(expit(design(r, GRID[1:] - STEP / 2, arm) @ opt.x), 1e-9, 1 - 1e-9)
                cdfs[r['id'], arm] = np.r_[0, -np.expm1(np.cumsum(np.log1p(-hazard)))]

def remaining(r, age, arm):
    f = cdfs[r['id'], arm]
    old = float(np.interp(age, GRID, f))
    alive = max(1 - old, 1e-12)
    total = age + GRID
    fc = (np.interp(total, GRID, f) - old) / alive
    return np.clip(fc, 0, 1)

def invert(f, qs):
    return np.interp(qs, f, GRID)

calibration = {}
predictions = []
for stop in [11, 121]:
    tr, ca, te = split([r for r in rows if r['stop'] == stop])
    for arm in ARMS:
        for age in AGES:
            cal = [r for r in ca if r['y'] > age]
            assert len(cal) >= 20
            pits = [float(np.interp(r['y'] - age, GRID, remaining(r, age, arm))) for r in cal]
            levels = np.quantile(pits, [.1, .5, .9])
            calibration[stop, arm, age] = dict(n=len(cal), levels=levels.tolist())
            for r in te:
                if r['y'] <= age:
                    continue
                f = remaining(r, age, arm)
                for calibrated in [False, True]:
                    lo, point, hi = invert(f, levels if calibrated else [.1, .5, .9])
                    assert 0 <= lo <= point <= hi
                    predictions.append(dict(id=r['id'], stop=stop, day=r['day'], bus=r['bus'],
                        age=age, arm=arm, calibrated=calibrated, truth=r['y'] - age,
                        low=float(lo), point=float(point), high=float(hi), lapAvailable=valid(r),
                        remainingTail=float(1 - f[-1])))

# Exact modern leg/visit links for downstream arrival checks; future labels only
# construct training outcomes and evaluation truth, never origin features.
db = sqlite3.connect('file:' + str(ROOT / 'conditional-replay-data/outcomes.db') + '?mode=ro', uri=True)
db.row_factory = sqlite3.Row
seq = json.loads(db.execute('SELECT stops_json FROM routes WHERE id=3').fetchone()[0]); N = len(seq)
visits = {v['id']: dict(v) for v in db.execute('SELECT * FROM stop_visits WHERE route_id=3')}
by_leg, by_visit = collections.defaultdict(list), collections.defaultdict(list)
for l in db.execute('SELECT * FROM legs WHERE route_id=3'):
    by_leg[l['bus_name'], l['from_index'], l['departed_at']].append(dict(l))
for v in visits.values():
    if v['arrived_at'] is not None:
        by_visit[v['bus_name'], v['stop_id'], v['stop_index'], v['arrived_at']].append(v)
    if v['outcome'] == 'passed' and v['departed_at'] is not None and v['departed_at'] != v['arrived_at']:
        by_visit[v['bus_name'], v['stop_id'], v['stop_index'], v['departed_at']].append(v)
db.close()

def connect(s, target):
    index, dep = s['stop_index'], s['departed_at']
    remaining_hops = (seq.index(target) - index) % N
    path = []
    for _ in range(N):
        ls = by_leg[s['bus_name'], index, dep]
        if len(ls) != 1:
            return None, 'missing or ambiguous leg'
        l = ls[0]
        if not (l['reached'] == 1 and l['from_stop_id'] == seq[index] and l['to_stop_id'] == seq[l['to_index']]
                and l['arrived_at'] > dep and 1 <= l['hops'] <= remaining_hops
                and (l['to_index'] - index) % N == l['hops']):
            return None, 'invalid leg or skipped target'
        vs = [v for v in by_visit[s['bus_name'], l['to_stop_id'], l['to_index'], l['arrived_at']]
              if s['anchored_at'] <= v['anchored_at'] <= l['arrived_at']]
        if len(vs) != 1:
            return None, 'missing or ambiguous visit'
        v = vs[0]
        if v['how'] == 'gap':
            return None, 'gap'
        remaining_hops -= l['hops']; path.append(l['id'])
        if remaining_hops == 0:
            if not (v['stop_id'] == target and v['arrived_at'] is not None and v['outcome'] in ['stopped', 'passed']
                    and v['closest_m'] is not None and v['closest_m'] <= 75):
                return None, 'unsupported target'
            return dict(targetId=v['id'], arrival=v['arrived_at'], legIds=path,
                        ride=(v['arrived_at'] - s['departed_at']) / 1000), None
        if v['departed_at'] is None or v['departed_at'] < l['arrived_at']:
            return None, 'missing intermediate departure'
        index, dep = l['to_index'], v['departed_at']
    return None, 'incomplete'

links = {}; exclusions = collections.Counter()
for r in rows:
    if r['stop'] != 11:
        continue
    for target in [48, 4]:
        link, err = connect(visits[r['id']], target)
        if err:
            exclusions[err] += 1
        else:
            links[r['id'], target] = link

downstream = []; downstream_cal = []
tr, ca, te = split([r for r in rows if r['stop'] == 11])
ride_support = {}
samples = (np.arange(256) + .5) / 256
for target in [48, 4]:
    # Keep the completed target itself before the fit cutoff, not just source departure.
    ride_rows = [r for r in tr if (r['id'], target) in links and links[r['id'], target]['arrival'] + 120000 < FIT]
    rides = np.array([links[r['id'], target]['ride'] for r in ride_rows])
    ride_support[target] = dict(n=len(rides), sourceIds=[r['id'] for r in ride_rows],
                                quantiles=np.quantile(rides, [.1, .5, .9]).tolist())
    for arm in ARMS:
        for age in AGES:
            distributions = {}
            for r in ca + te:
                if r['y'] <= age or (r['id'], target) not in links:
                    continue
                h = invert(remaining(r, age, arm), samples)
                distributions[r['id']] = np.sort((h[:, None] + rides[None, :]).ravel())
            cal = [r for r in ca if r['id'] in distributions and links[r['id'], target]['arrival'] + 120000 < TEST]
            if len(cal) < 15:
                continue
            levels = np.quantile([np.searchsorted(distributions[r['id']],
                (links[r['id'], target]['arrival'] - r['a']) / 1000 - age, side='right') / len(distributions[r['id']]) for r in cal], [.1, .5, .9])
            downstream_cal.append(dict(target=target, arm=arm, age=age, n=len(cal), levels=levels.tolist()))
            for r in te:
                if r['id'] not in distributions:
                    continue
                lo, point, hi = np.quantile(distributions[r['id']], levels)
                downstream.append(dict(id=r['id'], target=target, targetId=links[r['id'], target]['targetId'],
                    day=r['day'], arm=arm, age=age, truth=(links[r['id'], target]['arrival'] - r['a']) / 1000 - age,
                    low=float(lo), point=float(point), high=float(hi)))

# Descriptive sequential stress check, conditional on known continuing pin episodes.
# Calibration probability levels interpolate between the fixed elapsed checkpoints.
# These are not a live filter replay or a departure-detection evaluation.
stability = []
for r in rows:
    if r['a'] < TEST:
        continue
    for arm in ARMS:
        points = []; lows = []; highs = []
        for age in np.arange(0, min(r['y'], 900), STEP):
            levels = [float(np.interp(age, AGES, [calibration[r['stop'], arm, a]['levels'][i] for a in AGES])) for i in range(3)]
            lo, p, hi = invert(remaining(r, age, arm), levels)
            points.append(p); lows.append(lo); highs.append(hi)
        delta = np.diff(points)
        stability.append(dict(id=r['id'], stop=r['stop'], arm=arm, updates=len(delta),
            upward60=int(sum(delta > 60)), upward120=int(sum(delta > 120)),
            departureUpward60=int(sum(delta + STEP > 60)), departureUpward120=int(sum(delta + STEP > 120)),
            maximumDepartureUp=float(max(delta + STEP, default=0)),
            maximumUp=float(max(delta, default=0)), maximumDown=float(min(delta, default=0))))

scores = []
for stop in [11, 121]:
    for age in AGES:
        for calibrated in [False, True]:
            for arm in ARMS:
                rs = [r for r in predictions if (r['stop'], r['age'], r['arm'], r['calibrated']) == (stop, age, arm, calibrated)]
                scores.append(dict(stop=stop, age=age, arm=arm, calibrated=calibrated, summary=metrics(rs),
                    byDate={d: metrics([r for r in rs if r['day'] == d]) for d in sorted({r['day'] for r in rs})}))
down_scores = []
for target in [48, 4]:
    for age in AGES:
        for arm in ARMS:
            rs = [r for r in downstream if (r['target'], r['age'], r['arm']) == (target, age, arm)]
            down_scores.append(dict(target=target, age=age, arm=arm, summary=metrics(rs),
                byDate={d: metrics([r for r in rs if r['day'] == d]) for d in sorted({r['day'] for r in rs})}))

out = dict(method=__doc__, inputSha256=hashlib.sha256((D / 'operating-pattern-screen.json').read_bytes()).hexdigest(),
    spec=dict(step=STEP, horizon=END, residualBandwidth=BANDWIDTH, ridgePenalty=PENALTY, ages=AGES, arms=ARMS),
    limitations=['Complete stopped visits only, no censoring or stop/pass model; feature clock is historical pin, not live broad rest.',
        'Conditional survival is evaluated on recorded continuing episodes, not inferred moving/standing state.',
        'Per-age PIT calibration uses only 22-61 episodes; no guarantee of conditional coverage.',
        'Previously inspected dates are development evidence; repeated checkpoints are not independent episodes.',
        'Winchester downstream adds independent training-only whole-ride samples, not the complete production estimator.',
        'Stability is conditional on staying in the pin episode, not a live approach/departure transition test.'],
    fits=[dict(stop=k[0], arm=k[1], **v) for k,v in fits.items()],
    calibration=[dict(stop=k[0], arm=k[1], age=k[2], **v) for k,v in calibration.items()],
    scores=scores, predictions=predictions, downstreamRideSupport=ride_support,
    downstreamLinks=[dict(sourceId=k[0], target=k[1], **v) for k,v in links.items()],
    downstreamExclusions=dict(exclusions), downstreamCalibration=downstream_cal,
    downstreamScores=down_scores, downstreamPredictions=downstream, stability=stability)
(D / 'release-survival-screen.json').write_text(json.dumps(out, indent=2) + '\n')
for s in scores:
    if s['calibrated']:
        print(s['stop'], s['age'], s['arm'], {k: round(s['summary'][k], 1) for k in ['n','mae','width','WIS','early','late']})
print('Downstream support:', ride_support)
