"""Two frozen event-history hazards; artifact-only chronological screen."""
from pathlib import Path
import bisect, collections, datetime, hashlib, json, math, statistics
import numpy as np
from scipy.optimize import minimize
from scipy.special import expit

OUT = Path(__file__).resolve().parent
SOURCE = OUT.parent
ARMS = ['lap_elapsed_clock', 'plus_own_union_age']
STEP = 15
CUT = 1789358400000  # September14 00:00ET
FRESH = 1789704000000  # September18 00:00ET
PROBS = [.05, .1, .25, .5, .75, .9, .95]


def load():
    plan = json.loads((OUT/'PLAN.json').read_text())
    assert plan['arms'] == ARMS
    for file, expected in plan['inputs'].items():
        assert hashlib.sha256(Path(file).read_bytes()).hexdigest() == expected, file
    original = [json.loads(line) for line in (SOURCE/'features-predictions.jsonl').read_text().splitlines()]
    records = [r for r in original if r['regime'] == 'arrival15']
    alternate = {(r['id'], r['elapsed']): r for r in original if r['regime'] == 'completed120'}
    assert len(alternate) == len(records)
    departures = collections.defaultdict(list)
    for v in json.loads((SOURCE/'legacy-followup.json').read_text())['arrivals']:
        if v['stop_id'] == 121:
            departures[v['bus_name']].append(v['departed_at'])
    for ds in departures.values():
        assert ds == sorted(ds), 'Prior extraction requires sorted departure history'
    episodes = {}
    for r in records:
        other = alternate[r['id'], r['elapsed']]
        assert all(r['features'][f] == other['features'][f] for f in ['lap', 'lap_missing', 'own_union_age', 'own_union_missing'])
        assert (r['forecastAt']-r['pinAt'])/1000 == r['elapsed']
        if r['elapsed'] == 0:
            ds = departures[r['bus']]
            i = bisect.bisect_right(ds, r['pinAt']-120000)
            dep = ds[i-1] if i else None
            known = r['features']['own_union_missing'] == 0
            if known:
                assert dep is not None and abs(r['pinAt']-dep-r['features']['own_union_age']*600000) < .001
                assert dep+120000 <= r['pinAt'] and 0 < r['pinAt']-dep <= 7200000
            episodes[r['id']] = dict(id=r['id'], bus=r['bus'], day=r['day'], a=r['pinAt'], y=r['holdSec'],
                lap=r['lap'], stop=11, split=r['split'], ownUnionDeparture=dep if known else None,
                ownUnionAge=(r['pinAt']-dep)/1000 if known else None)
    assert len(episodes) == 285
    for r in records:
        e = episodes[r['id']]
        assert e['y']-r['elapsed'] == r['truthRemaining']
        assert r['features']['own_union_missing'] == float(e['ownUnionDeparture'] is None)
        if e['ownUnionDeparture'] is not None:
            assert abs(r['forecastAt']-e['ownUnionDeparture']-r['features']['own_union_age']*600000) < .001
        assert abs(r['weight']-1/sum(x['id'] == r['id'] for x in records)) < 1e-12
    train = [r for r in episodes.values() if r['split'] == 'train']
    assert len(train) == 160
    reference = statistics.median(r['lap'] for r in train if r['lap'] is not None and 900 < r['lap'] < 7200)
    assert all(r['referenceLap'] == reference for r in records)
    union_reference = statistics.median(r['ownUnionAge'] for r in train if r['ownUnionAge'] is not None)
    for e in episodes.values():
        e['lapSupported'] = e['lap'] is not None and .65*reference <= e['lap'] <= 1.65*reference
    return records, episodes, reference, union_reference


def design(e, t, reference, union_reference, candidate=False, runtime=False):
    t = np.asarray(t, dtype=float)
    pin_phase = math.floor(e['a']/1000) % 900
    lap = e['lap'] if e['lapSupported'] else None
    if runtime:
        pin_phase = math.floor(((e['a']/1000)%900)/5+.5)*5
        if lap is not None:
            lap = math.floor(lap/5+.5)*5
    angle = 2*np.pi*(pin_phase+t)/900
    columns = [np.ones_like(t), np.log1p(t/60), t/600, np.maximum(t-300, 0)/600,
        np.maximum(t-600, 0)/600, np.full_like(t, (lap-reference)/600 if lap is not None else 0),
        np.full_like(t, float(lap is None)), np.sin(angle), np.cos(angle)]
    if candidate:
        columns += [((e['ownUnionAge']+t-union_reference)/600 if e['ownUnionAge'] is not None else np.zeros_like(t)),
            np.full_like(t, float(e['ownUnionAge'] is None))]
    return np.column_stack(columns)


def distribution(e, beta, reference, union_reference, candidate):
    # Mirror runtime knot/tail construction, including its finite-survival break.
    t = (np.arange(120)+.5)*STEP
    z = design(e, t, reference, union_reference, candidate, runtime=True)@beta
    hs = np.clip(expit(z), 1e-9, 1-1e-9)
    xs, ls, log_s, last_h = [0.], [0.], 0., 1/240
    for i, h in enumerate(hs):
        last_h = -math.log1p(-h)/STEP
        log_s += math.log1p(-h)
        if log_s < math.log(1e-6):
            break
        xs.append((i+1)*STEP); ls.append(log_s)
    return np.array(xs), np.array(ls), min(1/5, max(1/1800, last_h))


def log_survival(d, t):
    xs, ls, tail = d
    return float(np.interp(t, xs, ls)) if t < xs[-1] else float(ls[-1]-tail*(t-xs[-1]))


def remaining(d, elapsed):
    xs, ls, tail = d
    at = log_survival(d, elapsed)
    qs = []
    for p in PROBS:
        target = at+math.log1p(-p)
        if target <= ls[-1]:
            absolute = xs[-1]+(ls[-1]-target)/tail
        else:
            absolute = np.interp(-target, -ls, xs)
        qs.append(float(max(0, absolute-elapsed)))
    assert all(math.isfinite(v) for v in qs) and qs == sorted(qs)
    return qs, -math.expm1(log_survival(d, elapsed+120)-at)


def metrics(rs, arm, weighting):
    w = np.array([r['weight'] if weighting == 'visit' else 1. for r in rs]); w /= w.sum()
    qs = np.array([r['predictions'][arm]['q'] for r in rs]); y = np.array([r['truthRemaining'] for r in rs])
    low, med, high = qs[:,1], qs[:,3], qs[:,5]
    ae = abs(med-y); width = high-low
    early = y < low; late = y > high
    lower_shortfall = np.maximum(0, low-y); upper_shortfall = np.maximum(0, y-high)
    wis = (.5*ae+.1*width+lower_shortfall+upper_shortfall)/1.5
    pinball10 = np.maximum(.1*(y-low), -.9*(y-low))
    p120 = np.array([r['predictions'][arm]['p120'] for r in rs])
    event = y <= 120
    order = np.argsort(ae); cum = np.cumsum(w[order])
    aq = lambda p: float(ae[order[min(len(order)-1, int(np.searchsorted(cum, p)))]] )
    return dict(visits=len({r['id'] for r in rs}), landmarks=len(rs), dates=len({r['day'] for r in rs}),
        mae=float(w@ae), medianAbs=aq(.5), p90Abs=aq(.9), wis80=float(w@wis), width80=float(w@width),
        earlyCount=int(early.sum()), lateCount=int(late.sum()), earlyRate=float(w@early), lateRate=float(w@late),
        meanLowerShortfall=float(w@lower_shortfall), maxLowerShortfall=float(max(lower_shortfall)),
        lowerPinball10=float(w@pinball10), medianTooLate120Count=int((med-y > 120).sum()),
        medianTooLate120Rate=float(w@(med-y > 120)), brier120=float(w@((p120-event)**2)))


def summarize(records, arm_names):
    rs = [r for r in records if r['split'] == 'development']
    scores = []
    periods = {'Sep14_17': [r for r in rs if r['pinAt'] < FRESH], 'Sep18': [r for r in rs if r['pinAt'] >= FRESH]}
    periods.update({day: [r for r in rs if r['day'] == day] for day in sorted({r['day'] for r in rs})})
    for period, rows in periods.items():
        cohorts = {'all': rows, 'lap_supported': [r for r in rows if r['lapSupported']],
            'lap_fallback': [r for r in rows if not r['lapSupported']],
            'remaining_le120': [r for r in rows if r['truthRemaining'] <= 120],
            'own_union_missing': [r for r in rows if r['ownUnionDeparture'] is None]}
        for age in [0, 60, 180, 300, 480]:
            cohorts[f'elapsed_{age}'] = [r for r in rows if r['elapsed'] == age]
            cohorts[f'supported_elapsed_{age}'] = [r for r in rows if r['elapsed'] == age and r['lapSupported']]
        for cohort, rr in cohorts.items():
            if not rr:
                continue
            for weight in ['visit', 'checkpoint']:
                scores.append(dict(period=period, cohort=cohort, weighting=weight,
                    arms={a: metrics(rr, a, weight) for a in arm_names}))
    return scores


def main():
    records, episodes, ref, uref = load()
    train = [r for r in episodes.values() if r['split'] == 'train']
    fits = {}
    for arm in ARMS:
        xx, yy = [], []
        for e in train:
            bins = max(1, math.ceil(min(e['y'], 1800)/STEP))
            xx.append(design(e, (np.arange(bins)+.5)*STEP, ref, uref, arm == ARMS[1]))
            y = np.zeros(bins)
            if e['y'] <= 1800:
                y[-1] = 1
            yy.append(y)
        X, y = np.vstack(xx), np.concatenate(yy)
        penalty = np.r_[0., np.full(X.shape[1]-1, 4.)]
        def objective(beta):
            z = X@beta
            return float(np.logaddexp(0, z).sum()-y@z+.5*np.dot(penalty, beta*beta)), X.T@(expit(z)-y)+penalty*beta
        initial = np.zeros(X.shape[1]); initial[0] = math.log(y.mean()/(1-y.mean()))
        fit = minimize(objective, initial, jac=True, method='L-BFGS-B', options={'maxiter':1500,'gtol':1e-8,'ftol':1e-13})
        assert fit.success, fit.message
        fits[arm] = dict(coefficients=fit.x.tolist(), trainVisits=len(train), dates=len({r['day'] for r in train}),
            riskBins=len(y), objective=float(fit.fun), maxGradient=float(max(abs(fit.jac))), iterations=fit.nit)
        for e in episodes.values():
            d = distribution(e, fit.x, ref, uref, arm == ARMS[1])
            for r in records:
                if r['id'] != e['id']:
                    continue
                r['lapSupported'] = e['lapSupported']; r['ownUnionDeparture'] = e['ownUnionDeparture']
                q, p = remaining(d, r['elapsed'])
                r.setdefault('predictions', {})[arm] = dict(q=q, p120=p)
    # Existing classifier outputs are inputs only, never fitted survival arms.
    for r in records:
        r['predictions'] = {a:r['predictions'][a] for a in ARMS}
        r.pop('snapshots', None); r.pop('identities', None)
    scores = summarize(records, ARMS)
    by = collections.defaultdict(list)
    for r in records:
        if r['split'] == 'development':
            by[r['id']].append(r)
    cases = []
    for vid, rr in by.items():
        b, c = [metrics(rr, arm, 'visit') for arm in ARMS]
        cases.append(dict(id=vid, bus=rr[0]['bus'], day=rr[0]['day'], holdSec=rr[0]['holdSec'],
            lap=rr[0]['lap'], lapSupported=rr[0]['lapSupported'], ownUnionDeparture=rr[0]['ownUnionDeparture'],
            deltaWis=c['wis80']-b['wis80'], deltaMae=c['mae']-b['mae'], baseline=b, candidate=c,
            checkpoints=[{k:r[k] for k in ['elapsed','truthRemaining','predictions']} for r in rr]))
    regressions = {period: sorted([r for r in cases if (r['day'] == '2026-09-18') == (period == 'Sep18')],
        key=lambda r:-r['deltaWis'])[:5] for period in ['Sep14_17','Sep18']}
    provenance = dict(referenceLap=ref, referenceUnionAge=uref, probabilities=PROBS, fits=fits,
        trainingVisits=len(train), evaluationVisits=len(by), inputLandmarks=len(records),
        supportedCounts=dict(collections.Counter((r['split']+'_'+str(r['lapSupported'])) for r in episodes.values())),
        knownTimeAudits=dict(unionOriginChanges=0, arrivalAndCompletedContractsIdentical=True),
        hash=hashlib.sha256(Path(__file__).read_bytes()).hexdigest())
    (OUT/'fits.json').write_text(json.dumps(provenance, indent=2)+'\n')
    (OUT/'predictions.jsonl').write_text(''.join(json.dumps(r)+'\n' for r in records))
    (OUT/'scores.json').write_text(json.dumps(scores, indent=2)+'\n')
    (OUT/'top-regressions.json').write_text(json.dumps(regressions, indent=2)+'\n')
    (OUT/'runtime-input.json').write_text(json.dumps(dict(training=[dict(e, ready=CUT-1) for e in train],
        records=[{k:r[k] for k in ['id','bus','day','pinAt','forecastAt','elapsed','truthRemaining','lap','lapSupported','weight','split']} for r in records],
        probabilities=PROBS, cut=CUT), indent=2)+'\n')
    print(json.dumps(provenance, indent=2))
    for s in scores:
        if s['period'] in ['Sep14_17','Sep18'] and s['cohort'] in ['all','lap_supported','lap_fallback'] and s['weighting'] == 'visit':
            print(json.dumps(s))


if __name__ == '__main__':
    main()
