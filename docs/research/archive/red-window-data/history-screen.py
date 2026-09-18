import collections, datetime as dt, hashlib, json, math, sqlite3, statistics as stats
from pathlib import Path
from zoneinfo import ZoneInfo
ROOT=Path('/home/gwarren/projects/yale-shuttle-watcher')
OUT=Path('/tmp/red-wide-window-recency-2026-09-17')
DB=ROOT/'red-eta-data/replay-lap.db'
ET=ZoneInfo('America/New_York'); DAY=86400000
# Offline descriptive screen. Fixed before scoring: 55 s elapsed, 120 min
# time-of-day match; q10/q90; Tukey 1.5 IQR, protect completions <=48h old.
# Freeze every training set at ET midnight of its later evaluation date.
c=sqlite3.connect(f'file:{DB}?mode=ro',uri=True); c.row_factory=sqlite3.Row
seq=json.loads((ROOT/'red-eta-data/payload.json').read_text())['routes']['3']
startidx=seq.index(11); targetidx=seq.index(48)
vis=[dict(x) for x in c.execute('select * from stop_visits where route_id=3')]
legs=[dict(x) for x in c.execute('select * from legs where route_id=3 and reached=1')]
byLeg=collections.defaultdict(list); byArrival=collections.defaultdict(list)
for l in legs: byLeg[(l['bus_name'],l['from_index'],l['departed_at'])].append(l)
for v in vis:
    for at in set([v['arrived_at']]+([v['departed_at']] if v['outcome']=='passed' else [])):
        if at is not None: byArrival[(v['bus_name'],v['stop_index'],at)].append(v)
def available(v):
    d=v['departed_at']
    base=max(v['anchored_at'],v['first_moved_at'] or v['anchored_at']) if d is None and v['outcome']=='passed' else max(d or float('inf'),v['first_moved_at'] or d or float('inf'))
    return base+max(0,v['confirm_sec'] or 0)*1000
def local(at):return dt.datetime.fromtimestamp(at/1000,ET)
def q(xs,p):
    ys=sorted(xs); i=(len(ys)-1)*p;lo=math.floor(i);hi=math.ceil(i)
    return ys[lo]+(i-lo)*(ys[hi]-ys[lo])
def describe(rows):
    if not rows:return {'n':0}
    vs=[r['actualSec'] for r in rows]
    return {'n':len(vs),'dates':len(set(local(r['startedAt']).date().isoformat() for r in rows)), 'q0_10_25_50_75_90_100_sec':[round(q(vs,p),3) for p in [0,.1,.25,.5,.75,.9,1]],'remainingWaitMedianSec':round(stats.median((r['departedAt']-r['startedAt'])/1000 for r in rows),3),'travelMedianSec':round(stats.median((r['arrivedAt']-r['departedAt'])/1000 for r in rows),3)}
journeys=[]
for s in vis:
    if not(s['stop_id']==11 and s['stop_index']==startidx and s['outcome']=='stopped' and s['how'] is not None and s['how']!='gap' and s['closest_m']<=75 and s['pinned_at'] is not None and s['departed_at'] is not None and s['arrived_at'] is not None):continue
    started=s['pinned_at']+55000
    if not s['arrived_at']<=started<s['departed_at']:continue
    idx=startidx;departure=s['departed_at'];availability=available(s)
    for _ in seq:
        ls=byLeg[(s['bus_name'],idx,departure)]
        if len(ls)!=1:break
        l=ls[0]; rem=(targetidx-idx)%len(seq)
        if not(l['from_stop_id']==seq[idx] and 0<=l['to_index']<len(seq) and l['to_stop_id']==seq[l['to_index']] and l['arrived_at']>departure and 1<=l['hops']<=rem and (l['to_index']-idx)%len(seq)==l['hops']):break
        vs=[v for v in byArrival[(s['bus_name'],l['to_index'],l['arrived_at'])] if s['anchored_at']<=v['anchored_at']<=l['arrived_at']]
        if len(vs)!=1:break
        v=vs[0];availability=max(availability,l['arrived_at'],l['to_pinned_at'] or 0,available(v))
        if l['to_index']==targetidx:
            if v['outcome']=='stopped' and v['closest_m']<=75:
                journeys.append({'sourceId':s['id'],'targetId':v['id'],'busName':s['bus_name'],'startedAt':started,'departedAt':s['departed_at'],'arrivedAt':l['arrived_at'],'availableAfter':availability,'actualSec':(l['arrived_at']-started)/1000})
            break
        if v['how']=='gap' or v['departed_at'] is None or v['departed_at']<l['arrived_at']:break
        idx=l['to_index'];departure=v['departed_at']
# One completed journey per bus/target arrival, matching production de-duplication.
journeys=list({(r['busName'],r['arrivedAt']):r for r in journeys}.values())
journeys.sort(key=lambda r:r['startedAt'])
fixture=json.loads((ROOT/'history-sample-data/expanded-production-fixture.json').read_text())['historyProbe'][0]['result'];asof=fixture['asOf'];fr=fixture['journey']['trips']
ref=local(asof)
def same_period(r,t):
    l=local(r['startedAt']);distance=abs((l.hour*60+l.minute)-(t.hour*60+t.minute))
    return (l.weekday()>=5)==(t.weekday()>=5) and min(distance,1440-distance)<=120
matched=[r for r in journeys if asof-30*DAY<=r['startedAt']<=asof and r['arrivedAt']<=asof and same_period(r,ref)]
assert {(r['busName'],r['arrivedAt'],r['actualSec']) for r in matched}=={(r['busName'],r['arrivedAt'],r['actualSec']) for r in fr},'SQLite reconstruction must exactly reproduce the fixture'
def filtered(rows,cutoff):
    vals=[r['actualSec'] for r in rows];lo=q(vals,.25);hi=q(vals,.75);span=hi-lo
    lower=lo-1.5*span;upper=hi+1.5*span
    removed=[r for r in rows if cutoff-r['arrivedAt']>2*DAY and not lower<=r['actualSec']<=upper]
    ids={r['sourceId'] for r in removed}
    kept=[r for r in rows if r['sourceId'] not in ids]
    assert all(cutoff-r['arrivedAt']>2*DAY for r in removed)
    return kept,removed,[lower,upper]
keep,remove,bounds=filtered(matched,asof)
arms=['30d_q10_90','30d_old_iqr_q10_90','7d_old_iqr_q10_90','30d_old_iqr_q20_80']
pairs=[];skipped=collections.Counter();excluded=set()
for test in journeys:
    l=local(test['startedAt']); cutoff=int(l.replace(hour=0,minute=0,second=0,microsecond=0).timestamp()*1000)
    train=[r for r in journeys if cutoff-30*DAY<=r['startedAt']<cutoff and r['availableAfter']<=cutoff and same_period(r,l)]
    short=[r for r in train if r['startedAt']>=cutoff-7*DAY]
    if len(train)<10 or len(short)<10 or len({local(r['startedAt']).date() for r in train})<3 or len({local(r['startedAt']).date() for r in short})<3:
        skipped[l.date().isoformat()]+=1;continue
    old,drop,_=filtered(train,cutoff);recent,drop7,_=filtered(short,cutoff)
    excluded.update((r['sourceId'],l.date().isoformat()) for r in drop)
    for arm,rows,tail,removed in [(arms[0],train,.1,[]),(arms[1],old,.1,drop),(arms[2],recent,.1,drop7),(arms[3],old,.2,drop)]:
        assert all(r['availableAfter']<=cutoff and local(r['startedAt']).date()<l.date() and r['sourceId']!=test['sourceId'] for r in rows)
        vs=[r['actualSec'] for r in rows];low,mid,high=q(vs,tail),q(vs,.5),q(vs,1-tail);y=test['actualSec'];alpha=2*tail
        interval_score=high-low+(2/alpha)*max(0,low-y)+(2/alpha)*max(0,y-high)
        pairs.append({'date':l.date().isoformat(),'sourceId':test['sourceId'],'targetId':test['targetId'],'busName':test['busName'],'arm':arm,'cutoff':cutoff,'trainingN':len(rows),'removedN':len(removed),'actual':y,'low':low,'median':mid,'high':high,'early':y<low,'late':y>high,'width':high-low,'mae':abs(y-mid),'wis':(.5*abs(y-mid)+alpha/2*interval_score)/1.5})
def score(ps):
    n=len(ps)
    return {'n':n,'early':sum(p['early'] for p in ps),'late':sum(p['late'] for p in ps),'coveragePct':round(100*sum(not p['early'] and not p['late'] for p in ps)/n,2),'meanWidthSec':round(stats.mean(p['width'] for p in ps),2),'medianWidthSec':round(stats.median(p['width'] for p in ps),2),'maeSec':round(stats.mean(p['mae'] for p in ps),2),'meanWIS':round(stats.mean(p['wis'] for p in ps),2),'removedTrainingMemberships':sum(p['removedN'] for p in ps)}
report={'method':{'elapsedSec':55,'lookbackDays':[30,7],'timeWindowMinutes':120,'trainingCutoff':'ET midnight before each later service date; all known completion/confirmation lower bounds <= cutoff','minTrainingTrips':10,'minTrainingDates':3,'old':'arrival completion >48h before cutoff','filter':'Tukey [q25-1.5*IQR,q75+1.5*IQR], computed solely from training; recent observations always retained','baseline':'empirical connected-journey quantiles, not served-model replay','limitation':'Legacy exact ingestion/confirmation timestamps missing; descriptive trip-level screen, no nominal coverage or promotion claim'},'fixture':describe(matched),'recent48h':describe([r for r in matched if asof-r['arrivedAt']<=2*DAY]),'older48h':describe([r for r in matched if asof-r['arrivedAt']>2*DAY]),'fixtureIQR':{'boundsSec':bounds,'removed':len(remove),'kept':len(keep)},'allConnectedJourneys':describe(journeys),'skippedByDate':dict(skipped),'pooled':{a:score([p for p in pairs if p['arm']==a]) for a in arms},'byDate':{day:{a:score([p for p in pairs if p['arm']==a and p['date']==day]) for a in arms} for day in sorted({p['date'] for p in pairs})}}
(OUT/'journeys.json').write_text(json.dumps(journeys,indent=2));(OUT/'screen-pairs.json').write_text(json.dumps(pairs,indent=2));(OUT/'history-screen.json').write_text(json.dumps(report,indent=2))
print(json.dumps({k:v for k,v in report.items() if k not in ['method','byDate']},indent=2))
print('Assertions passed: exact 75-trip fixture reconstruction, no same-date/future training, recent observations protected.')
