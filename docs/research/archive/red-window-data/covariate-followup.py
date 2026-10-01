"""Offline chronological Red hold-component covariate screen. No app changes.
Prespecified arms and penalties; final dates never fit or tune coefficients.
Legacy data are previously inspected arrival proxies, not pristine holdout.
"""
import collections, datetime, hashlib, heapq, json, math, pathlib, random, sqlite3, statistics
from zoneinfo import ZoneInfo
import numpy as np

ROOT=pathlib.Path('/home/gwarren/projects/yale-shuttle-watcher');HERE=ROOT/'red-window-data';TZ=ZoneInfo('America/New_York')
LEGACY=pathlib.Path('/home/gwarren/wt/r184data/red-arrivals-90d.jsonl');DB=ROOT/'red-eta-data/replay-lap.db'
ARMS=['pooled','lap','lap_hour','lap_bus','lap_hour_bus','lap_hour_weekday']
def clock(t):return datetime.datetime.fromtimestamp(t/1000,TZ)
def cutoff(s):return int(datetime.datetime.fromisoformat(s).replace(tzinfo=TZ).timestamp()*1000)
def quant(a,p):return float(np.quantile(a,p,method='linear'))

legacy=[json.loads(line)for line in LEGACY.read_text().splitlines()if line]
legacy=[dict(id=i,stop=r['stop_id'],bus=r['bus_name'],a=r['arrived_at'],d=r['departed_at'],ready=r['departed_at']+120000,target=True)for i,r in enumerate(legacy)if r['route_id']==3 and r['departed_at']>r['arrived_at']]
d=sqlite3.connect('file:'+str(DB)+'?mode=ro',uri=True);d.row_factory=sqlite3.Row
modern=[dict(id=r['id'],stop=r['stop_id'],bus=r['bus_name'],a=r['arrived_at'],d=r['departed_at'],ready=r['departed_at']+max(120000,(r['confirm_sec']or 0)*1000),
target=r['outcome']=='stopped'and r['closest_m']<=75)for r in d.execute("SELECT * FROM stop_visits WHERE route_id=3 AND stop_id IN (11,121) AND how!='gap' AND arrived_at IS NOT NULL AND departed_at IS NOT NULL AND departed_at>=arrived_at ORDER BY arrived_at")]
d.close()

def audit(records):
    seen=set();by=collections.defaultdict(list)
    for r in records:
        key=(r['bus'],r['stop'],r['a'],r['d'])
        assert key not in seen,'Duplicate visit would overweight a label'
        seen.add(key);by[(r['bus'],r['stop'])].append(r)
    for rs in by.values():
        previousEnd=-1
        for r in sorted(rs,key=lambda r:r['a']):
            assert r['a']>=previousEnd,'Overlapping same-bus visits require investigation'
            previousEnd=r['d']
    return dict(rows=len(records),uniqueRows=len(seen),duplicateRows=0,overlappingVisits=0)
inputAudit=dict(modern=audit(modern),legacy=audit(legacy))

def enrich(records):
    pending=[];past={};out=[]
    for i,r in enumerate(sorted(records,key=lambda r:r['a'])):
        while pending and pending[0][0]<=r['a']:
            _,_,old=heapq.heappop(pending)
            key=(old['bus'],old['stop']);past[key]=max(past.get(key,0),old['d'])
        prev=past.get((r['bus'],r['stop']));opp=past.get((r['bus'],121 if r['stop']==11 else 11))
        at=clock(r['a']);same=prev is not None and clock(prev).date()==at.date();loop=same and opp is not None and prev<opp<r['a']
        if r['target']:
            out.append(dict(r,day=at.date().isoformat(),hour=at.hour+at.minute/60+at.second/3600,dow=at.weekday(),
                y=(r['d']-r['a'])/1000,lap=(r['a']-prev)/1000 if loop else None,period=(r['d']-prev)/1000 if loop else None))
        heapq.heappush(pending,(r['ready'],i,r))
    return out

def metric(outcomes):
    n=len(outcomes);early=sum(r['truth']<r['lo']for r in outcomes);late=sum(r['truth']>r['hi']for r in outcomes)
    def wis(r):
        score=r['hi']-r['lo']+10*max(0,r['lo']-r['truth'])+10*max(0,r['truth']-r['hi'])
        return (.5*abs(r['point']-r['truth'])+.1*score)/1.5
    return dict(n=n,maeSec=statistics.mean(abs(r['point']-r['truth'])for r in outcomes),
        covered=n-early-late,early=early,late=late,widthSec=statistics.mean(r['hi']-r['lo']for r in outcomes),
        meanWIS=statistics.mean(map(wis,outcomes)),underBy120=sum(r['truth']-r['point']>120 for r in outcomes),overBy120=sum(r['point']-r['truth']>120 for r in outcomes))

def evaluate(data,fitDate,testDate,cohort):
    fitCut,testCut=cutoff(fitDate),cutoff(testDate);results=[]
    for stop in [11,121]:
        cell=[r for r in data if r['stop']==stop]
        train=[r for r in cell if r['ready']<fitCut]
        cal=[r for r in cell if r['a']>=fitCut and r['ready']<testCut]
        test=[r for r in cell if r['a']>=testCut]
        assert max(r['ready']for r in train)<min(r['a']for r in cal)
        assert max(r['ready']for r in cal)<min(r['a']for r in test)
        reference=statistics.median(r['period']for r in train if r['period']is not None and 900<r['period']<7200)
        valid=lambda r:r['lap']is not None and .65*reference<=r['lap']<=1.65*reference
        tr=[r for r in train if valid(r)];base=statistics.median(r['y']for r in train)
        busCount=collections.Counter(r['bus']for r in tr);busDates={b:sorted({r['day']for r in tr if r['bus']==b})for b in busCount}
        buses=sorted(b for b,n in busCount.items()if n>=10 and len(busDates[b])>=2)
        def design(r,arm):
            v=[1,(r['lap']-reference)/600]
            if 'hour'in arm:v += [math.sin(2*math.pi*r['hour']/24),math.cos(2*math.pi*r['hour']/24)]
            if 'bus'in arm:v += [float(r['bus']==b)for b in buses]
            if 'weekday'in arm:v += [float(r['dow']==dow)for dow in range(7)]
            return np.array(v)
        fitted={};arms={};preds={}
        for arm in ARMS:
            if arm=='pooled':coef=[]
            else:
                X=np.array([design(r,arm)for r in tr]);y=np.array([r['y']for r in tr]);penalty=[0,0]
                if 'hour'in arm:penalty += [1,1]
                if 'bus'in arm:penalty += [20]*len(buses)
                if 'weekday'in arm:penalty += [20]*7
                coef=np.linalg.solve(X.T@X+np.diag(penalty),X.T@y)
                coef[0]+=statistics.median(r['y']-float(design(r,arm)@coef)for r in tr)
                coef=coef.tolist()
            def predict(r):return max(0,float(design(r,arm)@coef))if arm!='pooled'and valid(r)else base
            residuals=[r['y']-predict(r)for r in cal];lo,hi=quant(residuals,.1),quant(residuals,.9)
            outcomes=[dict(id=r['id'],bus=r['bus'],day=r['day'],truth=r['y'],point=predict(r),lo=max(0,predict(r)+lo),hi=max(0,predict(r)+hi),lapAvailable=valid(r),knownBus=r['bus']in buses)for r in test]
            fitted[arm]=dict(coefficients=coef,residualInterval=[lo,hi]);preds[arm]=outcomes
            arms[arm]=dict(summary=metric(outcomes),byDate={day:metric([r for r in outcomes if r['day']==day])for day in sorted({r['day']for r in outcomes})})
        contrasts={}
        for arm in ARMS:
            if arm in ['pooled','lap']:continue
            groups=collections.defaultdict(list)
            for a,b in zip(preds['lap'],preds[arm]):groups[a['day']].append(abs(b['point']-b['truth'])-abs(a['point']-a['truth']))
            blocks=list(groups.values());rng=random.Random(317+stop);boot=[]
            for _ in range(1000):
                sampled=[rng.choice(blocks)for _ in blocks];boot.append(sum(map(sum,sampled))/sum(map(len,sampled)))
            contrasts[arm]=dict(maeDeltaSec=arms[arm]['summary']['maeSec']-arms['lap']['summary']['maeSec'],dayBlockBootstrap95=[quant(boot,.025),quant(boot,.975)],
                daysImproved=sum(statistics.mean(v)<0 for v in blocks),days=len(blocks))
        results.append(dict(cohort=cohort,stop=stop,trainN=len(train),calibrationN=len(cal),testN=len(test),
            trainDates=sorted({r['day']for r in train}),calibrationDates=sorted({r['day']for r in cal}),testDates=sorted({r['day']for r in test}),
            trainEligibleLapN=len(tr),testEligibleLapN=sum(valid(r)for r in test),referencePeriodSec=reference,
            busTrainingCount=dict(busCount),busTrainingDates=busDates,eligibleBusEffects=buses,unseenOrInsufficientBusTestN=sum(r['bus']not in buses for r in test),
            testBusCounts=dict(collections.Counter(r['bus']for r in test)),models=fitted,arms=arms,contrastsToLap=contrasts,outcomes=preds))
    return results

modernData=enrich(modern);legacyData=enrich(legacy)
out=dict(method='Frozen retrospective component screen. Fit before cutoff; separate residual calibration; later whole service dates test. Bus intercepts ridge20 and require10 training observations on>=2 dates; smooth clock sin/cos ridge1; weekday ridge20. No test tuning.',
    inputs=dict(legacyPath=str(LEGACY),legacySha256=hashlib.sha256(LEGACY.read_bytes()).hexdigest(),modernDatabase=str(DB),modernTargetRowsSha256=hashlib.sha256(json.dumps(modernData,sort_keys=True).encode()).hexdigest()),inputAudit=inputAudit,
    limitations=['Previously inspected records; exploratory rather than untouched confirmation.',
        'Modern labels are stopped-visit plateau durations; old arrivals labels are closed geofence proxies and are not interchangeable.',
        'Assumed previous-event availability delay>=120 seconds is a sensitivity safeguard, not exact historical receipt metadata.',
        'Only already-realized lap at arrival is used; not a future lap or full remaining-journey prediction.',
        'All scored visits retained with pooled fallback when lap unavailable; no filter based on short duration.',
        'No literal guarantee of nominal80% coverage; date and bus dependence, especially3 test dates, limits inference.',
        'Bus label may proxy driver, shift, route assignment or service date; driver identity is unavailable.',
        'No synchronization-based next-bus covariate is constructed.'],
    results=evaluate(modernData,'2026-09-10','2026-09-14','modern_stop_visits')+evaluate(legacyData,'2026-08-15','2026-08-29','legacy_arrivals'))
(HERE/'covariate-followup.json').write_text(json.dumps(out,indent=2)+'\n')
for r in out['results']:
    print(json.dumps({k:r[k]for k in ['cohort','stop','trainN','calibrationN','testN','trainEligibleLapN','testEligibleLapN','unseenOrInsufficientBusTestN','contrastsToLap']},indent=2))
    print(json.dumps({k:v['summary']for k,v in r['arms'].items()},indent=2))
