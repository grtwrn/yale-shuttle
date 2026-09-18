"""Retrospective Red operating-pattern hypotheses; no production mutations.
Frozen families/penalties and chronological splits. All arms reported, not
post-selected as deployable models. Labels are complete pinned-stop durations.
"""
import bisect,collections,datetime,hashlib,json,math,pathlib,sqlite3,statistics
from zoneinfo import ZoneInfo
import numpy as np

ROOT=pathlib.Path('/home/gwarren/projects/yale-shuttle-watcher')
OUT=ROOT/'red-window-data';DB=ROOT/'conditional-replay-data/outcomes.db'
TZ=ZoneInfo('America/New_York')
clock=lambda t:datetime.datetime.fromtimestamp(t/1000,TZ)
cut=lambda s:datetime.datetime.fromisoformat(s).replace(tzinfo=TZ).timestamp()*1000
FIT,TEST=cut('2026-09-10'),cut('2026-09-14')
ARMS=['pooled','lap','lap_hour','lap_clock15','lap_clock20','lap_clock30','lap_clock60',
      'lap_recent_own','lap_recent_fleet','lap_other_stop','lap_pre_pin',
      'lap_hour_interaction','lap_bus_hour','lap_recent_state']
db=sqlite3.connect('file:'+str(DB)+'?mode=ro',uri=True);db.row_factory=sqlite3.Row
legacy=collections.defaultdict(list)
for r in db.execute('SELECT bus_name,stop_id,departed_at FROM arrivals WHERE route_id=3 AND stop_id IN(11,121) AND departed_at IS NOT NULL ORDER BY departed_at'):
    legacy[(r['bus_name'],r['stop_id'])].append(r['departed_at'])
rows=[];excluded=collections.Counter()
for v in db.execute('SELECT * FROM stop_visits WHERE route_id=3 AND stop_id IN(11,121) ORDER BY pinned_at'):
    if v['id']==65237:
        excluded['confirmed restart truncation 65237']+=1;continue
    if not(v['pinned_at'] is not None and v['departed_at'] is not None and v['departed_at']>=v['pinned_at'] and v['outcome']=='stopped' and v['how']!='gap' and v['closest_m']<=75):
        excluded['incomplete, passed, gap, or unsupported pin']+=1;continue
    a=v['pinned_at'];at=clock(a)
    def previous(stop):
        ds=legacy[(v['bus_name'],stop)];i=bisect.bisect_right(ds,a-120000)
        return ds[i-1] if i else None
    prev,other=previous(v['stop_id']),previous(121 if v['stop_id']==11 else 11)
    loop=prev is not None and other is not None and prev<other<a and clock(prev).date()==at.date()
    ready=max(v['departed_at']+120000,(v['first_moved_at'] or v['departed_at'])+(v['confirm_sec'] or 0)*1000)
    rows.append(dict(id=v['id'],stop=v['stop_id'],bus=v['bus_name'],a=a,d=v['departed_at'],ready=ready,
        y=(v['departed_at']-a)/1000,day=at.date().isoformat(),hour=at.hour+at.minute/60+at.second/3600,
        prepin=max(0,(a-v['anchored_at'])/1000),lap=(a-prev)/1000 if loop else None))
db.close()
assert all(r['ready']>=r['d'] for r in rows)
models={}
for stop in [11,121]:
    tr=[r for r in rows if r['stop']==stop and r['ready']<FIT]
    ref=statistics.median(r['lap'] for r in tr if r['lap'] is not None and 900<r['lap']<7200)
    valid=lambda r:r['lap'] is not None and .65*ref<=r['lap']<=1.65*ref
    eligible=[r for r in tr if valid(r)];X=np.array([[1,(r['lap']-ref)/600]for r in eligible]);y=np.array([r['y']for r in eligible])
    co=np.linalg.lstsq(X,y,rcond=None)[0];co[0]+=statistics.median(y-X@co)
    models[stop]=dict(ref=ref,co=co,base=statistics.median(r['y']for r in tr))
def valid(r):
    m=models[r['stop']];return r['lap'] is not None and .65*m['ref']<=r['lap']<=1.65*m['ref']
def lap_prediction(r):
    m=models[r['stop']];return max(0,float(np.array([1,(r['lap']-m['ref'])/600])@m['co'])) if valid(r) else m['base']

# Same-day history is selected using an assumed conservative confirmation
# delay, never by the current or a future hold's eventual outcome. Training
# residual features use a baseline fitted inside training only; this remains
# an exploratory screen, not cross-fitted production training.
for r in rows:
    past=[p for p in rows if p['ready']<=r['a'] and p['day']==r['day']]
    own=sorted((p for p in past if p['stop']==r['stop'] and p['bus']==r['bus']),key=lambda p:p['d'])
    fleet=[p for p in past if p['stop']==r['stop'] and p['bus']!=r['bus'] and p['ready']>=r['a']-3600000]
    other=sorted((p for p in past if p['stop']!=r['stop'] and p['bus']==r['bus']),key=lambda p:p['d'])
    for name,ps in [('own',own[-1:]),('fleet',fleet),('other',other[-1:])]:
        r[name]=statistics.median(p['y']-lap_prediction(p) for p in ps)/300 if ps else 0
        r[name+'Available']=bool(ps)
        r[name+'Ids']=[p['id']for p in ps]
        assert all(p['ready']<=r['a'] for p in ps)

def score(rs):
    e=np.array([r['point']-r['truth']for r in rs]);ae=np.abs(e)
    widths=[r['high']-r['low']for r in rs]
    wis=[(.5*abs(r['point']-r['truth'])+.1*(r['high']-r['low']+10*max(0,r['low']-r['truth'])+10*max(0,r['truth']-r['high'])))/1.5 for r in rs]
    return dict(n=len(rs),mae=float(ae.mean()),medianAbs=float(np.median(ae)),p90Abs=float(np.quantile(ae,.9)),
        width=statistics.mean(widths),WIS=statistics.mean(wis),early=sum(r['truth']<r['low']for r in rs),
        late=sum(r['truth']>r['high']for r in rs),over120=int(sum(e>120)),under120=int(sum(e< -120)))
results=[]
for stop in [11,121]:
    cell=[r for r in rows if r['stop']==stop]
    tr=[r for r in cell if r['ready']<FIT];ca=[r for r in cell if r['a']>=FIT and r['ready']<TEST];te=[r for r in cell if r['a']>=TEST]
    assert max(r['ready']for r in tr)<min(r['a']for r in ca)
    assert max(r['ready']for r in ca)<min(r['a']for r in te)
    eligible=[r for r in tr if valid(r)]
    counts=collections.Counter(r['bus']for r in eligible)
    buses=sorted(b for b,n in counts.items()if n>=10 and len({r['day']for r in eligible if r['bus']==b})>=2)
    def design(r,arm):
        lap=(r['lap']-models[stop]['ref'])/600
        v=[1,lap];pen=[0,0]
        h=[math.sin(2*math.pi*r['hour']/24),math.cos(2*math.pi*r['hour']/24)]
        if arm in ['lap_hour','lap_hour_interaction','lap_bus_hour']:
            v+=h;pen += [10,10]
        if arm.startswith('lap_clock'):
            period=int(arm.removeprefix('lap_clock'));phase=r['hour']*60/period*2*math.pi
            v += [math.sin(phase),math.cos(phase)];pen += [10,10]
        if arm=='lap_hour_interaction':v += [lap*x for x in h];pen += [10,10]
        if arm=='lap_bus_hour':
            for b in buses:v += [float(r['bus']==b)*x for x in [1,*h]];pen += [20,20,20]
        names={'lap_recent_own':['own'],'lap_recent_fleet':['fleet'],'lap_other_stop':['other'],
               'lap_recent_state':['own','fleet','other']}.get(arm,[])
        for name in names:v += [r[name],float(r[name+'Available'])];pen += [10,10]
        if arm in ['lap_pre_pin','lap_recent_state']:v += [math.log1p(r['prepin']/60)];pen += [10]
        return np.array(v),pen
    arms={}
    for arm in ARMS:
        if arm=='pooled':co=None
        else:
            X=np.array([design(r,arm)[0]for r in eligible]);y=np.array([r['y']for r in eligible]);pen=design(eligible[0],arm)[1]
            co=np.linalg.solve(X.T@X+np.diag(pen),X.T@y);co[0]+=statistics.median(y-X@co)
        def predict(r):return max(0,float(design(r,arm)[0]@co))if arm!='pooled'and valid(r)else models[stop]['base']
        residuals=[r['y']-predict(r)for r in ca];q=np.quantile(residuals,[.1,.5,.9])
        predictions=[]
        for r in te:
            p=predict(r);lo,point,hi=[max(0,float(p+x))for x in q]
            predictions.append(dict(id=r['id'],day=r['day'],bus=r['bus'],truth=r['y'],point=point,low=lo,high=hi,lapAvailable=valid(r)))
        arms[arm]=dict(coefficients=co.tolist()if co is not None else None,calibration=q.tolist(),summary=score(predictions),
            byDate={day:score([r for r in predictions if r['day']==day])for day in sorted({r['day']for r in predictions})},predictions=predictions)
    concentration={}
    for period in [15,20,30,60]:
        def circular(rs):
            angles=np.array([2*math.pi*(clock(r['d']).hour*60+clock(r['d']).minute+clock(r['d']).second/60)/period for r in rs]);z=np.exp(1j*angles).mean()
            return dict(n=len(rs),resultantLength=float(abs(z)),phaseMinutes=float((np.angle(z)%(2*math.pi))*period/(2*math.pi)))
        concentration[period]=dict(train=circular(tr),test=circular(te))
    results.append(dict(stop=stop,trainN=len(tr),calibrationN=len(ca),testN=len(te),eligibleTrainN=len(eligible),
        eligibleTestN=sum(valid(r)for r in te),referenceLap=models[stop]['ref'],busEffects=buses,
        featureAvailability={k:sum(r[k+'Available']for r in te)for k in ['own','fleet','other']},
        departureClockConcentration=concentration,arms=arms))
report=dict(method='Pinned hold component at pin time, conditional on a complete stopped visit. Fit beforeSep10,calibrationSep10–11,testSep14–17. Fixed candidate clock periods and ridge penalties; all results reported. Legacy previous-departure clock with120s availability delay; same-day/valid-loop gate and pooled fallback. One proven incomplete stop record excluded; no duration-based outlier filtering.',
    limitations=['Previously inspected dates,14 candidate models: exploratory, not independent confirmation or model selection for release.',
        'Only the wait component at pin time; cannot infer improved full ETA, current-rest survival, or rider connections.',
        'Confirmation availability is assumed with120s delay, not exact server receipt time; current pin-time origin differs from broad live rest origin.',
        'Recent-residual training features use a baseline fitted within the training block, not internally cross-fitted.',
        'Bus number does not identify driver; phase signal does not establish dispatch intent or a fixed timetable.'],
    inputHash=hashlib.sha256(json.dumps(rows,sort_keys=True).encode()).hexdigest(),excluded=dict(excluded),results=results,featureRows=rows)
(OUT/'operating-pattern-screen.json').write_text(json.dumps(report,indent=2)+'\n')
for r in results:
    print('stop',r['stop'],'fit/cal/test',r['trainN'],r['calibrationN'],r['testN'])
    for arm,v in r['arms'].items():print(arm,{k:round(v['summary'][k],1)for k in ['mae','medianAbs','width','WIS','over120']})
