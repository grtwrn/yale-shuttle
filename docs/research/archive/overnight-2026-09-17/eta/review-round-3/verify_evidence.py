"""Independent reconstruction, with no fitting and no builder-output writes."""
import bisect, cmath, collections, datetime as dt, hashlib, json, math, sqlite3
from pathlib import Path
from zoneinfo import ZoneInfo
import numpy as np
from scipy.special import expit
OUT=Path(__file__).resolve().parent
P=OUT.parent/'cycle-3'; OLD=OUT.parent/'cycle-1'
ROOT=Path('/home/gwarren/projects/yale-shuttle-watcher')
TZ=ZoneInfo('America/New_York'); FIT=1789012800000; END=1789665240913
load=lambda p:json.loads(p.read_text())
rows=[json.loads(s) for s in (P/'role-landmarks.jsonl').read_text().splitlines()]
preds=[json.loads(s) for s in (P/'predictions.jsonl').read_text().splitlines()]
plan=load(P/'PLAN.json'); saved=load(P/'fits.json')
hashes={**plan['inputs'],**plan['currentComparatorHashes']}
for p,h in hashes.items():assert hashlib.sha256(Path(p).read_bytes()).hexdigest()==h,p
for key,name in [('scriptSha256','run_role.py'),('stateScriptSha256','role_state.py'),('planSha256','PLAN.json')]:
    assert saved[key]==hashlib.sha256((P/name).read_bytes()).hexdigest()
con=sqlite3.connect(f'file:{ROOT}/conditional-replay-data/outcomes.db?mode=ro',uri=True)
con.row_factory=sqlite3.Row
visits={v['id']:dict(v) for v in con.execute('SELECT * FROM stop_visits')}
date=lambda t:dt.datetime.fromtimestamp(t/1000,TZ).date().isoformat()
def ready(v):
    if v['departed_at'] is None or v['how']=='gap':return None
    return max(v['departed_at']+120000,(v['first_moved_at'] or v['departed_at'])+1000*(v['confirm_sec'] or 0))
def phase(t):return complex(math.cos(2*math.pi*(t/1000%3600)/3600),math.sin(2*math.pi*(t/1000%3600)/3600))
def error(a,b):return abs(cmath.phase(a/b))*1800/math.pi
D=collections.defaultdict(list); A=collections.defaultdict(list)
for v in visits.values():
    if v['anchored_at']>END:continue
    A[v['bus_name'],date(v['anchored_at'])].append(v)
    if v['route_id']==3 and v['stop_id'] in (11,121) and v['pinned_at'] is not None and ready(v) is not None and v['closest_m']<=75 and v['id']!=65237:
        D[v['bus_name'],v['stop_id'],date(v['departed_at'])].append(v)
for vs in D.values():vs.sort(key=lambda v:(v['departed_at'],v['id']))
def opposite(bus,stop,day,left,right,known,delay=0):
    return any(left<v['departed_at']<right and ready(v)+delay<=known for v in D[bus,121 if stop==11 else 11,day])
threshold_values=collections.defaultdict(list);pairs=[]
for (bus,stop,day),vs in list(D.items()):
    ts=[v for v in vs if ready(v)<FIT]
    for prior,v in zip(ts,ts[1:]):
        left=prior['departed_at'];right=v['departed_at'];known=ready(v)
        if not 1800000<=right-left<=5400000 or not opposite(bus,stop,day,left,right,known):continue
        if any(a['route_id']!=3 and left<a['anchored_at']<right and a['anchored_at']+15000<=known for a in A[bus,day]):continue
        delta=error(phase(right),phase(left));threshold_values[stop].append(delta)
        pairs.append(dict(stop=stop,previous=prior['id'],current=v['id'],known=known,deltaSec=delta))
thresholds={s:float(np.quantile(v,.95)) for s,v in threshold_values.items()}
extraction=load(P/'extraction.json')
assert {(p['stop'],p['previous'],p['current']) for p in pairs}=={(p['stop'],p['previous'],p['current']) for p in extraction['trainingThresholdPairs']}
for s,t in thresholds.items():assert abs(t-extraction['thresholdsSec'][str(s)])<1e-8
weights=collections.defaultdict(float);states={};event_uses=0
for r in rows:
    v=visits[r['id']];at=r['pinAt'];day=date(at);delay=120000 if r['regime']=='confirmed240' else 0
    assert at==v['pinned_at'] and r['forecastAt']==at+1000*r['elapsed']
    assert abs(r['truthRemaining']-(v['departed_at']-r['forecastAt'])/1000)<1e-9
    weights[r['id'],r['regime']]+=r['landmarkWeight']
    key=r['id'],r['regime']
    if key not in states:
        anchors=[a for a in A[r['bus'],day] if a['anchored_at']+15000<=at]
        latest=max(anchors,key=lambda a:a['anchored_at'],default=None)
        reset=max((a['anchored_at'] for a in anchors if a['route_id']!=3),default=0)
        history=[h for h in D[r['bus'],r['stop'],day] if reset<h['departed_at']<at and ready(h)+delay<=at]
        chain=[];z=0j;w=0.;prev=None;resets=[]
        for h in history:
            why=None
            if prev:
                gap=h['departed_at']-prev['departed_at']
                if not 1800000<=gap<=5400000:why='gap_outside_30_90min'
                elif not opposite(r['bus'],r['stop'],day,prev['departed_at'],h['departed_at'],ready(h)+delay,delay):why='missing_opposite_at_update'
                elif abs(z)>0 and error(phase(h['departed_at']),z)>thresholds[r['stop']]:why='phase_innovation'
                if why:
                    chain=[];z=0j;w=0.;resets.append(dict(atId=h['id'],reason=why))
                else:
                    decay=math.exp(-math.log(2)*gap/7200000);z*=decay;w*=decay
            chain.append(h);z+=phase(h['departed_at']);w+=1;prev=h
        reason='known'
        if not r['lapSupported']:reason='unsupported_lap'
        elif latest and latest['route_id']!=3:reason='latest_route_not_red'
        elif not chain:reason='no_confirmed_history'
        elif at-chain[-1]['departed_at']>5400000:reason='stale_history'
        elif not opposite(r['bus'],r['stop'],day,chain[-1]['departed_at'],at,at,delay):reason='missing_opposite_at_pin'
        elif len(chain)<2:reason='fewer_than_two_histories'
        s=r['role'];assert (reason,reset,resets)==(s['reason'],s['routeResetAt'],s['resets'])
        assert [h['id'] for h in chain]==s['ids'] and [ready(h)+delay for h in chain]==s['knownTimes']
        assert [h['departed_at'] for h in chain]==s['physicalTimes'] and len(chain)==s['count']
        assert s['supported']==(reason=='known')
        two=sum((phase(h['departed_at']) for h in chain[-2:]),0j)
        for name,value,weight in [('recursive',z,w),('two',two,min(2,len(chain)))]:
            assert abs(cmath.phase(value)-s[name]['phase'])<1e-10
            assert abs((abs(value)/(weight+2) if reason=='known' else 0)-s[name]['confidence'])<1e-12
        states[key]=s
    assert r['role']==states[key];event_uses+=len(r['role']['ids'])
assert len(states)==1070 and len(weights)==1070 and all(abs(w-1)<1e-12 for w in weights.values())
assert len({r['id'] for r in rows})==535
assert {64318,58224,65347,48550,51469,54002,52633,52168,54777,53429}<={r['id'] for r in rows}

def matrix(r,n,name=None):
    t=np.arange(n)*15.+7.5+r['elapsed'];phi=2*np.pi*(r['pinAt']/1000%900+t)/900
    lap=(r['lap']-r['referenceLap'])/600 if r['lapSupported'] else 0
    x=np.stack([np.ones(n),np.log1p(t/60),t/600,np.maximum(t-300,0)/600,np.maximum(t-600,0)/600,np.full(n,lap),np.full(n,float(not r['lapSupported'])),np.sin(phi),np.cos(phi),np.full(n,r['elapsed']/600)],axis=1)
    if name is None:return x
    s=r['role'][name];theta=2*np.pi*(r['pinAt']/1000%3600+t)/3600-s['phase'];c=s['confidence']
    return np.stack([c*np.sin(theta),c*np.cos(theta),np.full(n,c)],axis=1)
def quantiles(z):
    exposure=np.logaddexp(0,z);cumulative=np.r_[0,np.cumsum(exposure)];out=[]
    for p in (.1,.5,.9):
        target=-math.log1p(-p);j=bisect.bisect_left(cumulative,target)
        if j==len(cumulative):out.append(1800+(target-cumulative[-1])/min(.2,max(1/1800,exposure[-1]/15)))
        else:out.append((j-1)*15+(target-cumulative[j-1])*15/exposure[j-1])
    return out
fit_map={(f['stop'],f['contract'],f['history']):f for f in saved['fits']};fit_checks=[]
for key,f in fit_map.items():
    stop,contract,name=key;train=[r for r in rows if (r['stop'],r['regime'],r['split'])==(stop,contract,'train')]
    assert all(r['outcomeReady']<FIT for r in train)
    x=[];offset=[];ys=[];ws=[]
    old=next(fit for fit in load(OLD/'fits.json')['fits'] if (fit['stop'],fit['regime'],fit['arm'])==(stop,'arrival15','landmark_lap_elapsed_clock'))
    assert f['coreCoefficients']==old['coefficients']
    for r in train:
        n=max(1,math.ceil(min(1800,r['truthRemaining'])/15));x.append(matrix(r,n,name));offset.extend(matrix(r,n)@np.array(f['coreCoefficients']))
        y=np.zeros(n)
        if r['truthRemaining']<=1800:y[-1]=1
        ys.extend(y);ws.extend([r['landmarkWeight']]*n)
    X=np.vstack(x);y=np.array(ys);w=np.array(ws);b=np.array(f['coefficients']);z=np.array(offset)+X@b
    objective=float(w@(np.logaddexp(0,z)-y*z)+5*(b@b));gradient=X.T@(w*(expit(z)-y))+10*b
    assert abs(objective-f['diagnostic']['objective'])<1e-7 and max(abs(gradient))<.001
    assert f['riskRows']==len(y) and f['supportedVisits']==len({r['id'] for r in train if r['role']['supported']})
    fit_checks.append(dict(stop=stop,contract=contract,history=name,objective=objective,maxGradient=float(max(abs(gradient)))))
index={(r['id'],r['elapsed'],r['regime']):r for r in rows};maxdiff=0
arms=plan['arms'];oldcore={(r['id'],r['elapsed']):r for r in (json.loads(l) for l in (OLD/'predictions.jsonl').read_text().splitlines()) if r['regime']=='arrival15' and r['arm']==arms[0]}
for p in preds:
    r=index[p['id'],p['elapsed'],p['regime']];name=dict(zip(arms,[None,'two','recursive']))[p['arm']]
    f=fit_map[p['stop'],p['regime'],name or 'two'];z=matrix(r,120)@np.array(f['coreCoefficients'])
    if name:z+=matrix(r,120,name)@np.array(f['coefficients'])
    q=quantiles(z);d=max(abs(a-b) for a,b in zip(q,p['q']));maxdiff=max(maxdiff,d);assert d<1e-8
    if name is None or not r['role']['supported']:assert p['q']==oldcore[p['id'],p['elapsed']]['q']
current={(r['id'],r['elapsed']):r for r in load(OLD/'comparator.json')['forecasts']}
all_preds=preds+[dict(r,arm='current_code_component',q=current[r['id'],r['elapsed']]['q']) for r in preds if r['arm']==arms[0]]
scores=load(P/'scores.json')
for s in scores:
    rs=[r for r in all_preds if (r['stop'],r['regime'],r['arm'])==(s['stop'],s['contract'],s['arm'])];group=s['group']
    if group=='role_supported':rs=[r for r in rs if r['roleSupported']]
    elif group=='fallback':rs=[r for r in rs if not r['roleSupported']]
    elif group=='three_plus_history':rs=[r for r in rs if r['roleSupported'] and r['historyCount']>=3]
    elif group=='same_neighbor':rs=[r for r in rs if r['sameAsAhead']]
    elif group=='other_neighbor':rs=[r for r in rs if not r['sameAsAhead']]
    elif group.startswith('elapsed_'):rs=[r for r in rs if r['elapsed']==int(group[8:])]
    elif group!='all':rs=[r for r in rs if r['day']==group]
    w=np.array([r['landmarkWeight'] if s['weighting']=='original_cohort' else 1 for r in rs]);w=w/w.sum()
    y=np.array([r['truthRemaining'] for r in rs]);q=np.array([r['q'] for r in rs]);ae=np.abs(q[:,1]-y);width=q[:,2]-q[:,0];early=y<q[:,0];late=y>q[:,2]
    wis=(.5*ae+.1*width+np.maximum(q[:,0]-y,0)+np.maximum(y-q[:,2],0))/1.5
    values=dict(mae=w@ae,wis80=w@wis,width80=w@width,earlyCount=early.sum(),lateCount=late.sum(),earlyRate=w@early,lateRate=w@late,visits=len({r['id'] for r in rs}),dates=len({r['day'] for r in rs}),landmarks=len(rs))
    for k,v in values.items():assert abs(v-s[k])<1e-8,(s,k,v)
    for key,pct in [('medianAbs',.5),('p90Abs',.9)]:
        value=s[key];assert sum(w[ae<value-1e-9])<=pct+1e-10 and sum(w[ae<=value+1e-9])>=pct-1e-10
# Verify original completed short/long regression records; raw-specific audit separately.
regressions=load(P/'verification.json')['regressions']
for a in regressions:
    v=visits[a['id']];assert v['outcome']=='stopped' and v['how']!='gap' and v['rest_polls']>0
    assert abs(a['holdSec']-(v['departed_at']-v['pinned_at'])/1000)<1e-9
    for leg in a['outgoingLegs']:
        actual=dict(con.execute('SELECT * FROM legs WHERE id=?',(leg['id'],)).fetchone())
        assert all(actual[k]==value for k,value in leg.items())
        assert actual['route_id']==3 and actual['bus_name']==v['bus_name']
con.close()
result=dict(hashReferences=len(hashes),fitProvenanceHashes=3,thresholdPairs=len(pairs),thresholds=thresholds,independentStates=len(states),historyEventUses=event_uses,weightSums=len(weights),models=len(fit_checks),maxGradient=max(f['maxGradient'] for f in fit_checks),forecasts=len(preds),maxForecastDifference=maxdiff,scoreRows=len(scores),regressionRecords=len(regressions),fitChecks=fit_checks)
(OUT/'evidence-check.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({k:v for k,v in result.items() if k!='fitChecks'},indent=2))
