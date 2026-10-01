"""Offline feasibility replay: replace Winchester pinned forecasts in recorded wire.

Uses only current wire at_stop_since, fresh position, legacy lap ages, and model
fits/ride samples preceding Sep10. Outside the gate, retain the recorded joint
production forecast. This intentionally simple switch is a deployment diagnostic,
not a proposed production integration. Gold episodes are used for scoring only.
"""
import bisect, collections, datetime, hashlib, json, math, pathlib, statistics
import numpy as np
from scipy.special import expit
from zoneinfo import ZoneInfo

D=pathlib.Path(__file__).resolve().parent; R=D.parent/'conditional-replay-data'
screen=json.loads((D/'release-survival-screen.json').read_text())
orig=json.loads((D/'operating-pattern-screen.json').read_text())
TZ=ZoneInfo('America/New_York'); ARM='hazard_age_lap_clock15'
fit=next(r for r in screen['fits']if r['stop']==11 and r['arm']==ARM)
co=np.array(fit['coefficients']); ref=next(r['referenceLap']for r in orig['results']if r['stop']==11)
STEP=screen['spec']['step']; GRID=np.arange(0,screen['spec']['horizon']+STEP,STEP,dtype=float)
links={(l['sourceId'],l['target']):l for l in screen['downstreamLinks']}
rides={int(t):np.array([links[i,int(t)]['ride']for i in v['sourceIds']])for t,v in screen['downstreamRideSupport'].items()}
quantiles=(np.arange(256)+.5)/256

def utc(s):
    return datetime.datetime.fromisoformat(s.replace('Z','+00:00') if s.endswith('Z')else s+'+00:00').timestamp()*1000
def day(t):return datetime.datetime.fromtimestamp(t/1000,TZ).date()
def distance(lat,lon):
    # Fixed official stop coordinates, metres; local equirectangular distance.
    return 6371000*math.hypot(math.radians(lat-41.324661),math.radians(lon+72.928677)*math.cos(math.radians(41.324661)))

cache={}; evidence=[]; cdf_cache={}
def conditional(b,at):
    pin=utc(b['at_stop_since']);age=(at-pin)/1000
    if not 0<=age<=1200:return None
    key=(b['bus_name'],pin)
    if key not in cdf_cache:
        ages=b.get('lap',{});own=ages.get('11');other=ages.get('121')
        last=at-own*1000 if own is not None else None
        prev_other=at-other*1000 if other is not None else None
        lap=(pin-last)/1000 if last is not None else None
        available=(last is not None and prev_other is not None and last<prev_other<pin-120000
                   and day(last)==day(pin) and .65*ref<=lap<=1.65*ref)
        t=GRID[1:]-STEP/2;hour=datetime.datetime.fromtimestamp(pin/1000,TZ)
        seconds=hour.hour*3600+hour.minute*60+hour.second
        phase=2*np.pi*(seconds+t)/900
        X=np.stack([np.ones_like(t),np.log1p(t/60),t/600,np.maximum(t-300,0)/600,
            np.maximum(t-600,0)/600,np.full_like(t,(lap-ref)/600 if available else 0),
            np.full_like(t,float(not available)),np.sin(phase),np.cos(phase)],axis=-1)
        hazard=np.clip(expit(X@co),1e-9,1-1e-9)
        cdf=np.r_[0,-np.expm1(np.cumsum(np.log1p(-hazard)))]
        cdf_cache[key]=cdf
        evidence.append(dict(bus=b['bus_name'],pin=pin,firstKnownAt=at,lap=lap,lapAvailable=available,
                             previousDeparture=last,previousOppositeDeparture=prev_other))
    f=cdf_cache[key];old=float(np.interp(age,GRID,f))
    fc=np.clip((np.interp(age+GRID,GRID,f)-old)/max(1-old,1e-12),0,1)
    if fc[-1]<.999:return None
    # No post-hoc PIT recentering is transferred into this wire prototype.
    return np.interp(quantiles,fc,GRID)

frames={};fresh=collections.defaultdict(list)
for line in(R/'raw-frames.jsonl').open():
    f=json.loads(line);at=utc(f['at']);frames[at]={b['bus_name']:b for b in f['buses']}
    for b in f['buses']:
        if b.get('observed_at')==at:fresh[b['bus_name']].append(at)
paired={};statuses=collections.Counter();fd=(D/'release-wire-shadow-pairs.jsonl').open('w')
for line in(R/'joint-release-pairs.jsonl').open():
    p=json.loads(line)
    if p['stopsAhead']>=29 or p['candidate']is None:continue
    at=p['at'];bus=p['bus'];target=p['target'];b=frames.get(at,{}).get(bus)
    base=p['candidate'];model=base;mode='production_fallback'
    if (b and p['warmMs']>=600000 and at-b.get('observed_at',at)<45000
        and b.get('at_stop_id')==11 and b.get('stationary') and b.get('at_stop_since')
        and distance(b['lat'],b['lon'])<=75 and p['stopsAhead']==({48:3,4:6}[target])):
        key=(at,bus)
        if key not in cache:cache[key]=conditional(b,at)
        remaining=cache[key]
        if remaining is not None:
            values=(remaining[:,None]+rides[target][None,:]).ravel()
            low,eta,high=np.quantile(values,[.1,.5,.9])
            model=dict(eta=float(eta),low=float(low),high=float(high));mode='wire_pin_hazard'
    rec=dict(at=at,bus=bus,target=target,stopsAhead=p['stopsAhead'],warmMs=p['warmMs'],
             observedAt=p.get('observedAt'),mode=mode,production=base,shadow=model)
    k=(bus,target,at);assert k not in paired
    paired[k]=rec;statuses[mode]+=1;fd.write(json.dumps(rec)+'\n')
fd.close()

def metric(rs,arm):
    if not rs:return dict(n=0)
    e=np.array([r[arm]['eta']-r['truth']for r in rs]);w=np.array([r[arm]['high']-r[arm]['low']for r in rs])
    ae=np.abs(e);below=np.array([max(0,r[arm]['low']-r['truth'])for r in rs]);above=np.array([max(0,r['truth']-r[arm]['high'])for r in rs])
    return dict(n=len(rs),episodes=len({r['id']for r in rs}),mae=float(ae.mean()),medianAbs=float(np.median(ae)),
        p90Abs=float(np.quantile(ae,.9)),signed=float(e.mean()),width=float(w.mean()),
        WIS=float((.5*ae+.1*w+below+above).mean()/1.5),early=int(sum(below>0)),late=int(sum(above>0)),
        over120=int(sum(e>120)),under120=int(sum(e< -120)))

checks=[];excluded=collections.Counter();transitions=[];series=[]
for r in orig['featureRows']:
    if r['stop']!=11 or r['day']<'2026-09-16':continue
    fs=fresh[r['bus']]
    for target in [48,4]:
        link=links.get((r['id'],target))
        if not link:excluded['no connected target']+=1;continue
        clocks=[('approach',a,r['a']+a*1000)for a in[-120,-60]]
        clocks += [('standing',a,r['a']+a*1000)for a in[0,60,120,180,300,480,600]if a<r['y']]
        clocks += [('departure',a,r['d']+a*1000)for a in[0,5,15,30,60]]
        for phase,age,t in clocks:
            i=bisect.bisect_left(fs,t)
            if i==len(fs)or fs[i]-t>15000:excluded['no fresh frame']+=1;continue
            at=fs[i]
            if at>=link['arrival'] or (phase=='standing'and at>=r['d']):continue
            p=paired.get((r['bus'],target,at))
            if not p or p['warmMs']<600000:excluded['no warm forecast']+=1;continue
            checks.append(dict(id=r['id'],targetId=link['targetId'],day=r['day'],phase=phase,age=age,
                truth=(link['arrival']-at)/1000,**p))
        eligible=[]
        for at in fs[bisect.bisect_left(fs,r['a']-120000):bisect.bisect_left(fs,link['arrival'])]:
            p=paired.get((r['bus'],target,at))
            if p and p['warmMs']>=600000:eligible.append(p)
        series.append(dict(id=r['id'],target=target,bus=r['bus'],pin=r['a'],departure=r['d'],arrival=link['arrival'],rows=eligible))
        for a,b in zip(eligible,eligible[1:]):
            dt=(b['at']-a['at'])/1000
            if not 0<dt<=15:continue
            transitions.append(dict(id=r['id'],target=target,day=r['day'],at=b['at'],dt=dt,
                beforeMode=a['mode'],afterMode=b['mode'],
                production=b['production']['eta']-a['production']['eta'],
                shadow=b['shadow']['eta']-a['shadow']['eta']))

scores=[]
for target in[48,4]:
    keys=sorted({(r['phase'],r['age'])for r in checks if r['target']==target})
    for phase,age in keys:
        rs=[r for r in checks if(r['target'],r['phase'],r['age'])==(target,phase,age)]
        scores.append(dict(target=target,phase=phase,age=age,changed=sum(r['mode']=='wire_pin_hazard'for r in rs),
            production=metric(rs,'production'),shadow=metric(rs,'shadow')))
stability=[]
for target in[48,4]:
    rs=[r for r in transitions if r['target']==target]
    stats={}
    for arm in ['production','shadow']:
        stats[arm]=dict(upward60=sum(r[arm]>60 for r in rs),upward120=sum(r[arm]>120 for r in rs),
            downward60=sum(r[arm]< -60 for r in rs),absoluteUpward60=sum(r[arm]+r['dt']>60 for r in rs),
            maxUp=max((r[arm]for r in rs),default=0))
    stability.append(dict(target=target,updates=len(rs),episodes=len({r['id']for r in rs}),**stats,
        switchCount=sum(r['beforeMode']!=r['afterMode']for r in rs)))
report=dict(method=__doc__,hazardArm=ARM,modelInputSha256=hashlib.sha256((D/'release-survival-screen.json').read_bytes()).hexdigest(),
    limitations=['First-harmonic candidate chosen from already-inspected component screens; this is exploratory development.',
        'Recorded production comparator has preSep14 tables; shadow uses preSep10 hazard and whole-ride samples, so this is not a one-coefficient ablation.',
        'Pins/lap inputs are reconstructed causally from raw GPS; collector starts without prior-day seeds.',
        'A switch to a wholly separate pinned predictor deliberately exposes integration discontinuities.',
        'Only Winchester to first Division/Prospect and130Prospect arrivals; no Union or full-next-lap pricing integration.'],
    statuses=dict(statuses),originEvidence=evidence,excluded=dict(excluded),scores=scores,checkpoints=checks,stability=stability,
    transitions=transitions,
    largestNewJumps=sorted([r for r in transitions if r['shadow']>60 and r['shadow']>r['production']],key=lambda r:r['shadow'],reverse=True)[:15],
    largestAvoidedDrops=sorted([r for r in transitions if r['production']< -60 and r['shadow']>r['production']],key=lambda r:r['shadow']-r['production'],reverse=True)[:15],
    largestRegressions=sorted(checks,key=lambda r:abs(r['shadow']['eta']-r['truth'])-abs(r['production']['eta']-r['truth']),reverse=True)[:15])
(D/'release-wire-shadow.json').write_text(json.dumps(report,indent=2)+'\n')
(D/'release-wire-shadow-series.json').write_text(json.dumps(series)+'\n')
print(json.dumps(dict(statuses=report['statuses'],excluded=report['excluded'],scores=scores,stability=stability),indent=2))
