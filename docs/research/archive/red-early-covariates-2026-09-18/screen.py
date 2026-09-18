"""Causal, chronological early-release diagnostic. No application changes."""
import bisect, collections, datetime, hashlib, importlib.util, json, math, pathlib, sqlite3, statistics
import numpy as np
from scipy.optimize import minimize
from scipy.special import expit

OUT = pathlib.Path(__file__).resolve().parent
ROOT = OUT.parent
OLD = ROOT / 'overnight-2026-09-17/eta/cycle-1'
spec = importlib.util.spec_from_file_location('landmark_events', OLD / 'extract_landmarks.py')
events_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(events_module)
plan = json.loads((OUT / 'PLAN.json').read_text())
CUT = events_module.CAL
FRESH = 1789704000000  # Sep18 00:00 ET
DEPLOY = 1789740720000  # Sep18 10:12 ET
AGES = [0, 60, 180, 300, 480]
capture = json.loads((OUT / 'recordings-followup.json').read_text())
db = sqlite3.connect('file:' + str(ROOT / 'release-integration-data/outcomes-complete.db') + '?mode=ro', uri=True)
db.row_factory = sqlite3.Row
seq = json.loads(db.execute('SELECT stops_json FROM routes WHERE id=3').fetchone()[0])
visits = {r['id']: dict(r) for r in db.execute('SELECT * FROM stop_visits')}
legs = {r['id']: dict(r) for r in db.execute('SELECT * FROM legs WHERE route_id=3')}
db.close()
for table, lookup in [('stop_visits', visits), ('legs', legs)]:
    for row in capture[table]:
        if row['id'] in lookup:
            old = lookup[row['id']]
            assert all(row[k] == old[k] for k in ('bus_id', 'route_id'))
            assert row['anchored_at' if table == 'stop_visits' else 'departed_at'] == old['anchored_at' if table == 'stop_visits' else 'departed_at']
        lookup[row['id']] = row
visits = sorted(visits.values(), key=lambda r: (r['anchored_at'], r['id']))
events = events_module.Events(visits, seq)
legacy = collections.defaultdict(list)
for row in json.loads((OUT / 'legacy-followup.json').read_text())['arrivals']:
    if row['departed_at'] < capture['capturedAt']:
        legacy[row['bus_name'], row['stop_id']].append(row['departed_at'])
def prior(bus, stop, at):
    values = legacy[bus, stop]
    i = bisect.bisect_right(values, at - 120_000)
    return values[i-1] if i else None

rows, excluded = [], collections.Counter()
for v in visits:
    if v['route_id'] != 3 or v['stop_id'] != 11:
        continue
    if v['id'] == 65237:
        excluded['proved_restart_truncation'] += 1
        continue
    if not (v['pinned_at'] is not None and v['departed_at'] is not None and v['departed_at'] >= v['pinned_at'] and v['outcome'] == 'stopped' and v['how'] != 'gap' and v['closest_m'] <= 75):
        excluded['incomplete_passed_gap_or_unsupported_pin'] += 1
        continue
    ready = events_module.ready(v)
    if ready is None or ready >= capture['capturedAt']:
        excluded['outcome_not_yet_available'] += 1
        continue
    a = v['pinned_at']; day = events_module.day(a)
    prev, other = prior(v['bus_name'], 11, a), prior(v['bus_name'], 121, a)
    loop = prev is not None and other is not None and prev < other < a and events_module.day(prev) == day
    rows.append(dict(id=v['id'], bus=v['bus_name'], stop=11, a=a, d=v['departed_at'], ready=ready,
        y=(v['departed_at']-a)/1000, day=day, lap=(a-prev)/1000 if loop else None))
train_rows = [r for r in rows if r['ready'] < CUT]
reference = statistics.median(r['lap'] for r in train_rows if r['lap'] is not None and 900 < r['lap'] < 7200)

# Typical complete edge times use only outcomes available in training.
drive, dwell = collections.defaultdict(list), collections.defaultdict(list)
for r in legs.values():
    if r['hops'] == 1 and r['reached'] and r['arrived_at'] + 120_000 < CUT and r['from_stop_id'] in seq and r['to_stop_id'] == seq[(seq.index(r['from_stop_id'])+1)%len(seq)] and r['leg_sec'] >= 0:
        drive[r['from_stop_id']].append(r['leg_sec'])
for v in visits:
    if v['route_id'] == 3 and v['stop_id'] in seq and events_module.ready(v) is not None and events_module.ready(v) < CUT and v['how'] != 'gap' and v['stand_sec'] is not None:
        dwell[v['stop_id']].append(max(0, v['stand_sec']))
assert all(drive[s] for s in seq), 'Missing training edge; do not silently invent travel'
edge = {s: statistics.median(drive[s]) + (statistics.median(dwell[s]) if dwell[s] else 0) for s in seq}
def anchor_proxy(index, target, age):
    distance = (seq.index(target)-index) % len(seq)
    return max(0, sum(edge[seq[(index+j)%len(seq)]] for j in range(distance)) - age)

records = []
for r in rows:
    split = 'train' if r['ready'] < CUT else 'development' if r['a'] >= CUT else 'boundary'
    if split == 'boundary':
        excluded['train_test_boundary'] += 1
        continue
    identity = events.identities(r)
    ages = [a for a in AGES if a < r['y']]
    for age in ages:
        at = r['a'] + age*1000
        lap_ok = r['lap'] is not None and .65*reference <= r['lap'] <= 1.65*reference
        angle = 2*math.pi*((at/1000)%900)/900
        own_union = prior(r['bus'], 121, at)
        own_ok = own_union is not None and events_module.day(own_union) == r['day'] and 0 < at-own_union <= 7_200_000
        common = dict(elapsed_log=math.log1p(age/60), elapsed=age/600, clock_sin=math.sin(angle), clock_cos=math.cos(angle))
        lap_feats = dict(lap=(r['lap']-reference)/600 if lap_ok else 0, lap_missing=float(not lap_ok))
        anchor_feats = dict(own_union_age=(at-own_union)/600000 if own_ok else 0, own_union_missing=float(not own_ok))
        for regime in events_module.REGIMES:
            snapshots = {k: events.snapshot(identity[k], 11, at, regime) for k in ('ahead', 'follower')}
            features = dict(common, **lap_feats, **anchor_feats)
            for name, s in snapshots.items():
                p = s['progress'] if s['usable'] else None
                usable = bool(p)
                # A latched historical identity may now be stale or reassigned.
                # Its source age must not silently remain a current peer input.
                peer = identity[name] if s['usable'] else None
                progress_age = (at-p['physical'])/1000 if usable else 0
                relative = (p['index']-seq.index(11))%len(seq) if usable else 0
                values = dict(known=float(peer is not None), usable=float(usable),
                    source_age=(at-peer['origin'])/600000 if peer else 0,
                    progress_sin=math.sin(2*math.pi*relative/len(seq)) if usable else 0,
                    progress_cos=math.cos(2*math.pi*relative/len(seq)) if usable else 0,
                    progress_age=progress_age/600,
                    to_winchester=anchor_proxy(p['index'], 11, progress_age)/600 if usable else 0,
                    to_union=anchor_proxy(p['index'], 121, progress_age)/600 if usable else 0,
                    union_reached=float(any(e['stop']==121 for e in s['reached'])) if s['usable'] else 0)
                features.update({name+'_'+k:v for k,v in values.items()})
                if p: assert p['known'] <= at
                if peer: assert peer['known'] <= r['a'] and peer['originKnown'] <= r['a']
            features['same_peer'] = float(identity['sameAsAhead'] and all(s['usable'] for s in snapshots.values()))
            records.append(dict(id=r['id'], bus=r['bus'], day=r['day'], pinAt=r['a'], forecastAt=at,
                elapsed=age, holdSec=r['y'], truthRemaining=r['y']-age, event=int(r['y']-age<=120),
                split=split, regime=regime, weight=1/len(ages), lap=r['lap'], referenceLap=reference,
                identities=identity, snapshots=snapshots, features=features))

def names(arm, example):
    fields = list(common)
    if arm != 'clock': fields += list(lap_feats)
    if 'anchor' in arm: fields += list(anchor_feats)
    for peer in ('ahead', 'follower'):
        if peer in arm or 'both' in arm: fields += [k for k in example if k.startswith(peer+'_')]
    if 'both' in arm: fields += ['same_peer']
    return fields

def metric(rs, arm):
    w = np.array([r['weight'] for r in rs]); w /= w.sum()
    y = np.array([r['event'] for r in rs]); p = np.array([r['predictions'][arm] for r in rs])
    early, late = np.flatnonzero(y), np.flatnonzero(1-y)
    auc = None
    if len(early) and len(late):
        auc = float(sum(w[i]*sum(w[j]*(float(p[i]>p[j])+.5*float(p[i]==p[j])) for j in late) for i in early)/(w[early].sum()*w[late].sum()))
    groups = []
    for lo, hi in [(0,.1),(.1,.25),(.25,.5),(.5,1.000001)]:
        mask = (p>=lo)&(p<hi)
        groups.append(dict(predictedRange=[lo,min(1,hi)], landmarks=int(mask.sum()),
            visits=len({r['id'] for i,r in enumerate(rs) if mask[i]}), early=int(y[mask].sum()),
            observedRate=float(w[mask]@y[mask]/w[mask].sum()) if mask.any() else None))
    return dict(visits=len({r['id'] for r in rs}), landmarks=len(rs), earlyLandmarks=int(y.sum()),
        eventRate=float(w@y), brier=float(w@((p-y)**2)), logLoss=float(-w@(y*np.log(p)+(1-y)*np.log1p(-p))), auc=auc, riskGroups=groups)

fits = []
for regime in events_module.REGIMES:
    tr = [r for r in records if r['split']=='train' and r['regime']==regime]
    te = [r for r in records if r['split']=='development' and r['regime']==regime]
    y = np.array([r['event'] for r in tr]); w=np.array([r['weight'] for r in tr])
    assert len({r['id'] for r in tr}) == len(train_rows)
    for arm in plan['arms']:
        fields = names(arm,tr[0]['features'])
        raw = np.array([[r['features'][f] for f in fields] for r in tr])
        mean=np.average(raw,axis=0,weights=w); sd=np.sqrt(np.average((raw-mean)**2,axis=0,weights=w)); keep=sd>1e-9
        X=np.column_stack([np.ones(len(tr)),(raw[:,keep]-mean[keep])/sd[keep]])
        def obj(b):
            z=X@b; penalty=np.r_[0,np.full(len(b)-1,4.)]
            return float(w@np.logaddexp(0,z)-w@(y*z)+.5*np.dot(penalty,b*b)), X.T@(w*(expit(z)-y))+penalty*b
        initial=np.zeros(X.shape[1]); initial[0]=math.log(np.average(y,weights=w)/(1-np.average(y,weights=w)))
        opt=minimize(obj,initial,jac=True,method='L-BFGS-B',options={'maxiter':1500,'gtol':1e-8,'ftol':1e-12})
        assert opt.success,opt.message
        for r in tr+te:
            v=np.array([r['features'][f] for f in fields]); x=np.r_[1,(v[keep]-mean[keep])/sd[keep]]
            r.setdefault('predictions',{})[arm]=float(np.clip(expit(x@opt.x),1e-9,1-1e-9))
        fits.append(dict(regime=regime,arm=arm,fields=np.array(fields)[keep].tolist(),coefficients=opt.x.tolist(),
            mean=mean[keep].tolist(),sd=sd[keep].tolist(),trainVisits=len(train_rows),converged=True))

scores = []
for regime in events_module.REGIMES:
    te=[r for r in records if r['regime']==regime and r['split']=='development']
    cohorts={'all_later':te,'Sep14_17':[r for r in te if r['pinAt']<FRESH],
        'Sep18':[r for r in te if r['pinAt']>=FRESH], 'post_1012':[r for r in te if r['pinAt']>=DEPLOY]}
    cohorts.update({day:[r for r in te if r['day']==day] for day in sorted({r['day'] for r in te})})
    for cohort,rs in cohorts.items():
        if rs: scores.append(dict(regime=regime,cohort=cohort,arms={a:metric(rs,a) for a in plan['arms']}))

pin = [r for r in records if r['regime']=='arrival15' and r['elapsed']==0]
descriptive=[]
for split in ['train','development']:
    for bucket in ['missing', *sorted({int(r['lap']//300) for r in pin if r['lap'] is not None})]:
        rs=[r for r in pin if r['split']==split and ('missing' if r['lap'] is None else int(r['lap']//300))==bucket]
        if rs: descriptive.append(dict(split=split,lapMinutes='missing' if bucket=='missing' else [bucket*5,(bucket+1)*5],visits=len(rs),shortHolds=sum(r['event'] for r in rs),medianHoldSec=statistics.median(r['holdSec'] for r in rs)))

out=dict(plan=plan,sourceCapturedAt=capture['capturedAt'],referenceLap=reference,excluded=dict(excluded),
    cohortCounts=dict(collections.Counter(r['day'] for r in rows)),trainVisits=len(train_rows),
    scores=scores,descriptive=descriptive,fits=fits,
    inputHashes={str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in [OUT/'PLAN.json',OUT/'recordings-followup.json',OUT/'legacy-followup.json',OLD/'extract_landmarks.py',pathlib.Path(__file__)]})
(OUT/'results.json').write_text(json.dumps(out,indent=2)+'\n')
(OUT/'features-predictions.jsonl').write_text(''.join(json.dumps(r,separators=(',',':'))+'\n' for r in records))
print('train',len(train_rows),'rows',len(rows),'landmarks',len(records),'excluded',dict(excluded))
for s in scores:
    if s['regime']=='arrival15' and s['cohort'] in ('Sep14_17','Sep18','post_1012'):
        print(s['cohort'],json.dumps({a:{k:v[k] for k in ['visits','landmarks','earlyLandmarks','brier','logLoss','auc']} for a,v in s['arms'].items()}))
print('lap strata',json.dumps(descriptive))
