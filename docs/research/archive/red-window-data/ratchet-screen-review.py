"""Score supplied paired Red predictions by observed source journey/checkpoint.
Read-only DB; diagnostic only because the supplied fixed tables see test outcomes.
"""
import collections,datetime,json,math,pathlib,sqlite3,statistics
from zoneinfo import ZoneInfo
ROOT=pathlib.Path('/home/gwarren/projects/yale-shuttle-watcher');HERE=ROOT/'red-window-data';TZ=ZoneInfo('America/New_York')
ELAPSED=[60,180,300,420,600];TOLERANCE=15
pairs=json.loads((HERE/'ratchet-screen-pairs.json').read_text())
frames=[json.loads(line)for line in (ROOT/'red-eta-data/watcher.jsonl').read_text().splitlines()if line]
frameMeta={int(datetime.datetime.fromisoformat(f['at'].replace('Z','+00:00')).timestamp()*1000):f for f in frames}
d=sqlite3.connect('file:'+str(ROOT/'red-eta-data/replay-lap.db')+'?mode=ro',uri=True);d.row_factory=sqlite3.Row
def query(sql,args=()):return [dict(r)for r in d.execute(sql,args)]
seq=json.loads(d.execute('select stops_json from routes where id=3').fetchone()[0])
lo=min(r['at']for r in pairs);hi=max(r['at']for r in pairs)
sources=query("select * from stop_visits where route_id=3 and stop_id=11 and outcome='stopped' and how!='gap' and departed_at is not null and pinned_at<? and departed_at>? order by pinned_at",(hi,lo))
def chain(s,target):
    index=s['stop_index'];dep=s['departed_at'];targetIndex=seq.index(target);path=[]
    for _ in seq:
        legs=query('select * from legs where route_id=3 and bus_name=? and from_index=? and departed_at=? and reached=1',(s['bus_name'],index,dep))
        if len(legs)!=1:return None,'missing/ambiguous leg'
        leg=legs[0];rem=(targetIndex-index)%len(seq)
        if not(leg['from_stop_id']==seq[index]and leg['to_stop_id']==seq[leg['to_index']]and leg['arrived_at']>dep and 1<=leg['hops']<=rem and(leg['to_index']-index)%len(seq)==leg['hops']):return None,'wrong route occurrence/time'
        visits=query("select * from stop_visits where route_id=3 and stop_id=? and stop_index=? and bus_name=? and anchored_at between ? and ? and(arrived_at=? or(outcome='passed'and departed_at=?))",(leg['to_stop_id'],leg['to_index'],s['bus_name'],s['anchored_at'],leg['arrived_at'],leg['arrived_at'],leg['arrived_at']))
        if len(visits)!=1:return None,'missing/ambiguous visit'
        v=visits[0];path.append(dict(leg=leg,visit=v))
        if leg['to_index']==targetIndex:
            if v['arrived_at']is None or v['closest_m']>75 or v['outcome']not in ['passed','stopped']:return None,'unsupported target proximity/time'
            return path,None
        if v['how']=='gap'or v['departed_at']is None or v['departed_at']<leg['arrived_at']:return None,'intermediate gap'
        index=leg['to_index'];dep=v['departed_at']
    return None,'no target'

def metrics(records,arm):
    if not records:return None
    out=[]
    for r in records:
        a=r[arm];y=r['truthSec'];l,h=a['low'],a['high'];err=a['eta']-y
        interval=h-l+10*max(0,l-y)+10*max(0,y-h)
        out.append(dict(absError=abs(err),early=y<l,late=y>h,width=h-l,wis=(.5*abs(err)+.1*interval)/1.5,under120=err< -120,over120=err>120))
    return dict(n=len(out),sourceJourneys=len({r['sourceId']for r in records}),maeSec=statistics.mean(r['absError']for r in out),
        covered=sum(not r['early']and not r['late']for r in out),early=sum(r['early']for r in out),late=sum(r['late']for r in out),
        meanWidthSec=statistics.mean(r['width']for r in out),meanWIS=statistics.mean(r['wis']for r in out),
        underBy120=sum(r['under120']for r in out),overBy120=sum(r['over120']for r in out))

journeys=[];checkpoints=[];postDeparture=[];skipped=[];jumps=[];departurePairs=[]
for s in sources:
    for target in [48,4]:
        path,error=chain(s,target)
        if error:skipped.append(dict(sourceId=s['id'],target=target,reason=error));continue
        v=path[-1]['visit'];jid=f"3:{s['id']}:{v['id']}"
        candidates=sorted([r for r in pairs if r['bus']==s['bus_name']and r['target']==target and s['pinned_at']<=r['at']<v['arrived_at']],key=lambda r:r['at'])
        assert len({r['at']for r in candidates})==len(candidates)
        meta=dict(journeyId=jid,sourceId=s['id'],targetVisitId=v['id'],bus=s['bus_name'],target=target,targetOutcome=v['outcome'],targetClosestM=v['closest_m'])
        runs=sorted({frameMeta[r['at']]['runId']for r in candidates if r['at']<=s['departed_at']})
        journeys.append(dict(meta,pinnedAt=s['pinned_at'],arrivedAtSource=s['arrived_at'],departedAt=s['departed_at'],arrivedAtTarget=v['arrived_at'],standSec=s['stand_sec'],pinDurationSec=(s['departed_at']-s['pinned_at'])/1000,
            observedRunIdsDuringVisit=runs,legIds=[p['leg']['id']for p in path],forecastRows=len(candidates)))
        def annotated(r):return dict(meta,at=r['at'],truthSec=(v['arrived_at']-r['at'])/1000,baseline=r['baseline'],unclamped=r['unclamped'],
            runId=frameMeta[r['at']]['runId'],feedAgeMs=frameMeta[r['at']]['feedAgeMs'],modelRested=r.get('rested'),modelSince=r.get('since'),reportedSource=r.get('source'),stopsAhead=r['stopsAhead'])
        for elapsed in ELAPSED:
            when=s['pinned_at']+elapsed*1000
            if when>=s['departed_at']:continue
            matches=[r for r in candidates if when<=r['at']<=when+TOLERANCE*1000 and r['at']<s['departed_at']]
            if not matches:skipped.append(dict(meta,checkpointSec=elapsed,reason='no forecast within15 seconds while source visit survives'));continue
            checkpoints.append(dict(annotated(matches[0]),elapsedSnapshotSec=elapsed,actualElapsedSec=(matches[0]['at']-s['pinned_at'])/1000))
        for after in [0,30,60]:
            when=s['departed_at']+after*1000
            matches=[r for r in candidates if when<=r['at']<=when+TOLERANCE*1000]
            if matches:postDeparture.append(dict(annotated(matches[0]),afterDepartureSec=after))
        before=[r for r in candidates if s['departed_at']-TOLERANCE*1000<=r['at']<=s['departed_at']]
        after=[r for r in candidates if s['departed_at']<=r['at']<=s['departed_at']+TOLERANCE*1000]
        if before and after and frameMeta[before[-1]['at']]['runId']==frameMeta[after[0]['at']]['runId']:
            a,b=before[-1],after[0]
            departurePairs.append(dict(meta,beforeAt=a['at'],afterAt=b['at'],**{arm:dict(remainingChangeSec=b[arm]['eta']-a[arm]['eta'],absoluteArrivalChangeSec=(b['at']-a['at'])/1000+b[arm]['eta']-a[arm]['eta'],afterErrorSec=b[arm]['eta']-(v['arrived_at']-b['at'])/1000)for arm in ['baseline','unclamped']}))
        window=[r for r in candidates if r['at']<=s['departed_at']+60000]
        for a,b in zip(window,window[1:]):
            dt=(b['at']-a['at'])/1000
            if dt>20 or frameMeta[a['at']]['runId']!=frameMeta[b['at']]['runId']:continue
            jumps.append(dict(meta,at=b['at'],phase='standing_visit'if b['at']<=s['departed_at']else'post_departure',**{arm:dict(remainingChangeSec=b[arm]['eta']-a[arm]['eta'],absoluteArrivalChangeSec=dt+b[arm]['eta']-a[arm]['eta'])for arm in ['baseline','unclamped']}))

score={str(target):{str(e):{arm:metrics([r for r in checkpoints if r['target']==target and r['elapsedSnapshotSec']==e],arm)for arm in ['baseline','unclamped']}for e in ELAPSED}for target in [48,4]}
post={str(target):{str(e):{arm:metrics([r for r in postDeparture if r['target']==target and r['afterDepartureSec']==e],arm)for arm in ['baseline','unclamped']}for e in [0,30,60]}for target in [48,4]}
jumpSummary={}
for target in [48,4]:
    jumpSummary[target]={}
    for arm in ['baseline','unclamped']:
        rs=[r for r in jumps if r['target']==target];vs=[r[arm]['absoluteArrivalChangeSec']for r in rs]
        jumpSummary[target][arm]=dict(adjacentPairs=len(rs),positiveOver60=sum(v>60 for v in vs),negativeUnderMinus60=sum(v< -60 for v in vs),
          positiveOver180=sum(v>180 for v in vs),negativeUnderMinus180=sum(v< -180 for v in vs),
          journeysWithPositiveOver60=len({r['sourceId']for r in rs if r[arm]['absoluteArrivalChangeSec']>60}),
          maxPositiveSec=max(vs),maxNegativeSec=min(vs))

before=lo;after=hi
standRows=query("select * from stop_visits where route_id=3 and stop_id=11 and pinned_at is not null and(outcome='passed'or(outcome='stopped'and departed_at>=pinned_at))and anchored_at between ? and ? and departed_at<=?",(after-30*86400000,after,after))
futureRows=[r for r in standRows if r['departed_at']>before]
standValues=sorted(0 if r['outcome']=='passed'else(r['departed_at']-r['pinned_at'])/1000 for r in standRows)
def q(v,p):
    k=(len(v)-1)*p;i=math.floor(k);j=math.ceil(k);return v[i]+(k-i)*(v[j]-v[i])
recomputedQ=[math.floor(q(standValues,(i+.5)/10)+.5)for i in range(10)]
payloadQ=json.loads((ROOT/'red-eta-data/payload.json').read_text())['dwells']['3']['11']['q']
assert recomputedQ==payloadQ,'Table provenance reconstruction failed'
out=dict(method='Fixed elapsed pin-clock snapshots 60/180/300/420/600s; first paired forecast within15s, only if source visit still survives. Exact connected target occurrence. Passed targets retained as physical passage outcomes and identified explicitly.',
limitations=['One service date, nine source visits and three buses, not independent dates; target48 and4 and repeated checkpoints share source journeys.',
  'Fixed payload tables contain same-day outcomes; no out-of-time calibration or deployment claim.',
  'Nine watcher-run resets create cold state; not continuously warm server replay.',
  'Stop arrival is detector geofence/rest/pass timing, not verified boarding;3 target4 endpoints are passes.',
  'Both arms retain existing widening/bias coefficients; no recalibration of candidate or future provenance repair was done.',
  'Remaining source visit includes yard repositioning; no claim of continuous stillness.',
  'Recorded five/ten-second polls and missing paired near-departure frames limit departure timing inference.'],
inputCounts=dict(pairs=len(pairs),watcherFrames=len(frames),sourceVisits=len(sources),targetJourneys=len(journeys),checkpoints=len(checkpoints),scoredPostDeparture=len(postDeparture),targetOutcomeCounts=dict(collections.Counter(r['targetOutcome']for r in journeys))),
tableProvenance=dict(payloadQn=json.loads((ROOT/'red-eta-data/payload.json').read_text())['dwells']['3']['11']['qn'],matchingDbRecords=len(standRows),recomputedQ=recomputedQ,payloadQExactlyReproduced=True,completedBeforeFirstForecast=sum(r['departed_at']<=before for r in standRows),completedAfterFirstForecast=len(futureRows),futureSourceVisitIds=[r['id']for r in futureRows]),
scoresByTargetAndElapsed=score,postDepartureScores=post,jumpSummary=jumpSummary,
stoppedTargetsOnly={str(target):{str(e):{arm:metrics([r for r in checkpoints if r['target']==target and r['elapsedSnapshotSec']==e and r['targetOutcome']=='stopped'],arm)for arm in ['baseline','unclamped']}for e in ELAPSED}for target in [48,4]},
journeys=journeys,checkpoints=checkpoints,postDeparture=postDeparture,departurePairs=departurePairs,skipped=skipped,jumps=jumps)
(HERE/'ratchet-screen-review.json').write_text(json.dumps(out,indent=2)+'\n')
print(json.dumps({k:out[k]for k in ['inputCounts','tableProvenance','scoresByTargetAndElapsed','postDepartureScores','jumpSummary','skipped']},indent=2))
