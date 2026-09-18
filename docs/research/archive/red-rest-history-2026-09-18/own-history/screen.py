"""Frozen own-bus rest-history survival families; artifacts only."""
from pathlib import Path
import bisect, collections, datetime, hashlib, importlib.util, json, math, sqlite3, statistics
from zoneinfo import ZoneInfo
import numpy as np
from scipy.optimize import minimize
from scipy.special import expit

OUT=Path(__file__).resolve().parent
ROOT=OUT.parent.parent
OLD=ROOT/'red-early-covariates-2026-09-18/union-survival'
spec=importlib.util.spec_from_file_location('union_survival',OLD/'screen.py')
base=importlib.util.module_from_spec(spec);spec.loader.exec_module(base)
PLAN=json.loads((OUT/'PLAN.json').read_text());ARMS=PLAN['arms']
REGIMES=['primary','earlier120','maxgap600']
TZ=ZoneInfo('America/New_York')
FIELDS=['previous_winchester','previous_winchester_missing','previous_union','previous_union_missing',
    'cedar117','cedar117_missing','cedar13','cedar13_missing','lap_rest_sum','lap_coverage','last_rest_age',
    'partial_duration','no_lap_last_rest']
COLS={ARMS[0]:[],ARMS[1]:[],ARMS[2]:[0,1],ARMS[3]:[2,3],ARMS[4]:[4,5,6,7],ARMS[5]:[8,9,10,11,12],ARMS[6]:list(range(13))}


def day(t):return datetime.datetime.fromtimestamp(t/1000,TZ).date().isoformat()


def known(v,regime):
    d=v['departed_at']
    if d is None:return None
    confirm=(v['confirm_sec'] or 0)*1000
    older=max(d+120000,(v['first_moved_at'] or d)+confirm)
    if regime=='earlier120':return older
    if regime=='primary':return max(older,d+confirm+15000)
    return max(older,d+confirm+600000)


def history(e,bybus,seq,regime):
    a=e['a'];bus=e['bus']
    observed=[v for v in bybus.get(bus,[]) if v['anchored_at']+15000<=a and v['id']!=e['id'] and day(v['anchored_at'])==e['day']]
    other=max((v['anchored_at'] for v in observed if v['route_id']!=3),default=-math.inf)
    candidates=[v for v in observed if v['route_id']==3 and a-5400000<=v['anchored_at'] and v['anchored_at']>other and
        v['stop_index'] is not None and 0<=v['stop_index']<len(seq) and seq[v['stop_index']]==v['stop_id']]
    def describe(v):
        if v is None:return dict(id=None,reason='no_prior_observed_visit',knownAt=None,duration=None,clockUsable=False)
        ka=known(v,regime)
        reason='valid'
        if ka is None or ka>a:reason='completion_not_known'
        elif v['how']=='gap':reason='gap_completion'
        elif v['outcome'] not in ('stopped','passed'):reason='unresolved_outcome'
        elif v['closest_m']>75:reason='unsupported_stop_geometry'
        clock=reason=='valid'
        duration=v['stand_sec'] if reason=='valid' else None
        if v['id']==65237:duration=None;reason='audited_truncated_duration_clock_retained'
        if duration is not None and (not math.isfinite(duration) or duration<0):duration=None;reason='invalid_duration'
        if duration is None and reason=='valid':reason='duration_unavailable'
        if clock:assert ka<=a and v['departed_at']<a
        return dict(id=v['id'],stop=v['stop_id'],anchor=v['anchored_at'],departedAt=v['departed_at'],
            knownAt=ka,duration=duration,reason=reason,clockUsable=clock,outcome=v['outcome'])
    latest={s:max((v for v in candidates if v['stop_id']==s),key=lambda v:(v['anchored_at'],v['id']),default=None) for s in [11,121,117,13]}
    described={s:describe(v) for s,v in latest.items()}
    features=[]
    for s in [11,121,117,13]:
        d=described[s]['duration'];features.extend([math.log1p(d/60) if d is not None else 0,float(d is None)])
    origin=described[11]
    union=described[121]
    valid_lap=bool(origin['clockUsable'] and union['clockUsable'] and origin['departedAt']<union['anchor']<a)
    lap_events=[]
    if valid_lap:
        lap_events=[describe(v) for v in candidates if v['stop_id'] in [117,13,121] and v['anchored_at']>origin['departedAt']]
    usable=[v for v in lap_events if v['duration'] is not None]
    covered={v['stop'] for v in usable}
    total=sum(v['duration'] for v in usable)
    rests=[v for v in usable if v['outcome']=='stopped']
    last=max(rests,key=lambda v:v['departedAt'],default=None)
    features.extend([math.log1p(total/60) if valid_lap else 0,len(covered)/3,
        (a-last['departedAt'])/3600000 if last else 0,float(not valid_lap or len(covered)<3 or len(usable)!=len(lap_events)),float(not valid_lap or last is None)])
    assert len(features)==len(FIELDS)
    return dict(features=features,latest=described,validLap=valid_lap,origin=origin if valid_lap else None,
        currentLapEvents=lap_events,coveredStops=sorted(covered),observedRestSumSec=total if valid_lap else None,
        lastRestAgeSec=(a-last['departedAt'])/1000 if last else None,latestOtherRouteAnchor=other if math.isfinite(other) else None)


def design(e,t,ref,uref,arm,regime,runtime=False):
    core=base.design(e,t,ref,uref,arm!=ARMS[0],runtime)
    cols=COLS[arm]
    if cols:
        features=np.array(e['histories'][regime]['features'])[cols]
        core=np.column_stack([core,np.broadcast_to(features,(len(t),len(cols)))])
    return core


def distribution(e,beta,ref,uref,arm,regime):
    z=design(e,(np.arange(120)+.5)*15,ref,uref,arm,regime,True)@beta
    hs=np.clip(expit(z),1e-9,1-1e-9);xs,ls=[0.],[0.];log_s=0;last_h=1/240
    for i,h in enumerate(hs):
        last_h=-math.log1p(-h)/15;log_s+=math.log1p(-h)
        if log_s<math.log(1e-6):break
        xs.append((i+1)*15);ls.append(log_s)
    return np.array(xs),np.array(ls),min(1/5,max(1/1800,last_h))


def load_history():
    db=sqlite3.connect('file:'+str(ROOT/'release-integration-data/outcomes-complete.db')+'?mode=ro',uri=True);db.row_factory=sqlite3.Row
    visits={r['id']:dict(r) for r in db.execute('select * from stop_visits')};db.close()
    captured=json.loads((ROOT/'red-early-covariates-2026-09-18/recordings-followup.json').read_text())
    visits.update({r['id']:r for r in captured['stop_visits']})
    bybus=collections.defaultdict(list)
    for v in visits.values():bybus[v['bus_name']].append(v)
    for vs in bybus.values():vs.sort(key=lambda v:(v['anchored_at'],v['id']))
    return visits,bybus


def main():
    for f,h in PLAN['inputs'].items():assert hashlib.sha256(Path(f).read_bytes()).hexdigest()==h,f
    records,episodes,ref,uref=base.load()
    visits,bybus=load_history()
    seq=PLAN['redSequence'];assert len(seq)==29 and seq[26:]==[117,13,14]
    for e in episodes.values():e['histories']={reg:history(e,bybus,seq,reg) for reg in REGIMES}
    train=[e for e in episodes.values() if e['split']=='train'];assert len(train)==160
    audit=dict(cohortVisits=len(episodes),trainVisits=len(train),cohortByDay=dict(collections.Counter(e['day'] for e in episodes.values())),
        featureNames=FIELDS,arms=ARMS,cols=COLS,referenceLap=ref,referenceUnionAge=uref,
        changedVsPrimary={reg:[e['id'] for e in episodes.values() if e['histories'][reg]['features']!=e['histories']['primary']['features']] for reg in REGIMES},
        sourceHash=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        source65237Used=[dict(id=e['id'],regime=reg,history=e['histories'][reg]['latest'][11]) for e in episodes.values() for reg in REGIMES if e['histories'][reg]['latest'][11]['id']==65237])
    (OUT/'extraction-audit.json').write_text(json.dumps(audit,indent=2)+'\n')
    (OUT/'cohort.json').write_text(json.dumps(list(episodes.values()),indent=2)+'\n')
    fits={};predictions=[]
    for reg in REGIMES:
        if reg!='primary' and not audit['changedVsPrimary'][reg]:
            fits[reg]=dict(alias='primary',reason='All cohort history features identical')
            continue
        fits[reg]={}
        for arm in ARMS:
            xx,yy=[],[]
            for e in train:
                bins=max(1,math.ceil(min(e['y'],1800)/15))
                xx.append(design(e,(np.arange(bins)+.5)*15,ref,uref,arm,reg))
                y=np.zeros(bins)
                if e['y']<=1800:y[-1]=1
                yy.append(y)
            X,y=np.vstack(xx),np.concatenate(yy);penalty=np.r_[0,np.full(X.shape[1]-1,4.)]
            def objective(beta):
                z=X@beta
                return float(np.logaddexp(0,z).sum()-y@z+.5*np.dot(penalty,beta*beta)),X.T@(expit(z)-y)+penalty*beta
            initial=np.zeros(X.shape[1]);initial[0]=math.log(y.mean()/(1-y.mean()))
            fit=minimize(objective,initial,jac=True,method='L-BFGS-B',options={'maxiter':1500,'gtol':1e-8,'ftol':1e-13})
            assert fit.success,fit.message
            fits[reg][arm]=dict(coefficients=fit.x.tolist(),iterations=fit.nit,objective=float(fit.fun),maxGradient=float(max(abs(fit.jac))),trainVisits=160)
            print(reg,arm,'fitted',flush=True)
    # Save complete coefficients before scoring original or opening newer data.
    fitted=dict(createdAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),fits=fits,referenceLap=ref,referenceUnionAge=uref,
        planHash=hashlib.sha256((OUT/'PLAN.json').read_bytes()).hexdigest(),sourceHash=hashlib.sha256(Path(__file__).read_bytes()).hexdigest())
    (OUT/'fits.json').write_text(json.dumps(fitted,indent=2)+'\n')
    for reg in REGIMES:
        use_reg='primary' if 'alias' in fits[reg] else reg
        for r in records:
            if r['split']!='development':continue
            e=episodes[r['id']]
            output={k:r[k] for k in ['id','bus','day','pinAt','forecastAt','elapsed','truthRemaining','holdSec','lap','weight','split']}
            output.update(regime=reg,lapSupported=e['lapSupported'],ownUnionDeparture=e['ownUnionDeparture'],predictions={})
            for arm in ARMS:
                d=distribution(e,np.array(fits[use_reg][arm]['coefficients']),ref,uref,arm,reg)
                q,p=base.remaining(d,r['elapsed']);output['predictions'][arm]=dict(q=q,p120=p)
            predictions.append(output)
    scores=[]
    for reg in REGIMES:
        for s in base.summarize([r for r in predictions if r['regime']==reg],ARMS):scores.append(dict(regime=reg,**s))
    (OUT/'predictions.jsonl').write_text(''.join(json.dumps(r)+'\n' for r in predictions))
    (OUT/'scores.json').write_text(json.dumps(scores,indent=2)+'\n')
    print(json.dumps(audit,indent=2))
    for s in scores:
        if s['regime']=='primary' and s['cohort']=='lap_supported' and s['weighting']=='visit' and s['period'] in ['Sep14_17','Sep18']:
            print(s['period'],json.dumps({a:{k:v[k] for k in ['visits','mae','wis80','width80','earlyCount','lateCount','lowerPinball10']} for a,v in s['arms'].items()}))


if __name__=='__main__':main()
