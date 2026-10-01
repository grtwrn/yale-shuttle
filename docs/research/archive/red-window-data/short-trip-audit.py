"""Read-only audit of selected short connected Red journeys; writes only JSON report.
Run from any cwd. No production calls, record mutations, or model changes.
"""
import collections, datetime, gzip, json, math, pathlib, sqlite3, statistics, zoneinfo

ROOT = pathlib.Path('/home/gwarren/projects/yale-shuttle-watcher')
HERE = ROOT / 'red-window-data'
TZ = zoneinfo.ZoneInfo('America/New_York')
def connect(path):
    d = sqlite3.connect('file:' + str(path) + '?mode=ro', uri=True)
    d.row_factory = sqlite3.Row
    return d
db = connect(ROOT/'red-eta-data/replay-lap.db')
rawdbs = [(str(p.relative_to(ROOT)), connect(p)) for p in [ROOT/'red-eta-data/replay-lap.db',ROOT/'server-eta-data/history.db']]
seq = json.loads(db.execute('SELECT stops_json FROM routes WHERE id=3').fetchone()[0])
stops = {r['id']: dict(r) for r in db.execute('SELECT * FROM stops')}
def iso(t): return datetime.datetime.fromtimestamp(t/1000,TZ).isoformat()
def rows(sql,args=()): return [dict(r) for r in db.execute(sql,args)]
def metres(a,b):
    la1,lo1,la2,lo2 = map(math.radians,[a['lat'],a['lon'],b['lat'],b['lon']])
    h=math.sin((la2-la1)/2)**2+math.cos(la1)*math.cos(la2)*math.sin((lo2-lo1)/2)**2
    return 6371000*2*math.asin(min(1,math.sqrt(h)))

fixtures = [
    ('history-sample-data/expanded-production-fixture.json','historyProbe'),
    ('wait-route-data/rosenkranz-compact/result.json','probes')]
observations=[]
for file,key in fixtures:
    for probe in json.loads((ROOT/file).read_text())[key]:
        j=probe.get('result',{}).get('journey')
        if not j or j['fromStopId']!=11 or j['toStopId']!=48: continue
        for trip in j['trips']:
            sources=rows('SELECT * FROM stop_visits WHERE route_id=3 AND stop_id=11 AND stop_index=14 AND bus_name=? AND departed_at=?',(trip['busName'],trip['departedAt']))
            assert len(sources)==1
            s=sources[0]
            assert s['pinned_at']+1000*j['elapsedSec']==trip['startedAt']
            assert s['arrived_at']<=trip['startedAt']<s['departed_at']
            observations.append(dict(fixture=file,elapsedSec=j['elapsedSec'],source=s,trip=trip))

def chain(source,target):
    index=source['stop_index']; dep=source['departed_at']; path=[]; targetIndex=seq.index(target)
    for _ in range(len(seq)):
        legs=rows('SELECT * FROM legs WHERE route_id=3 AND bus_name=? AND from_index=? AND departed_at=? AND reached=1',(source['bus_name'],index,dep))
        if len(legs)!=1:return None,'missing/ambiguous exact next leg'
        leg=legs[0];remaining=(targetIndex-index)%len(seq)
        if not (leg['from_stop_id']==seq[index] and leg['to_stop_id']==seq[leg['to_index']] and leg['arrived_at']>dep and 1<=leg['hops']<=remaining and (leg['to_index']-index)%len(seq)==leg['hops']):return None,'incorrect route occurrence or time'
        vs=rows('''SELECT * FROM stop_visits WHERE route_id=3 AND stop_id=? AND stop_index=? AND bus_name=? AND anchored_at BETWEEN ? AND ? AND (arrived_at=? OR (outcome='passed' AND departed_at=?))''',(leg['to_stop_id'],leg['to_index'],source['bus_name'],source['anchored_at'],leg['arrived_at'],leg['arrived_at'],leg['arrived_at']))
        if len(vs)!=1:return None,'missing/ambiguous exact arrival visit'
        visit=vs[0];path.append(dict(leg=leg,visit=visit))
        if leg['to_index']==targetIndex:
            if visit['outcome']!='stopped' or visit['closest_m']>75:return None,'target did not have qualifying stopped visit'
            return path,None
        if visit['how']=='gap' or visit['departed_at'] is None or visit['departed_at']<leg['arrived_at']:return None,'intermediate gap or missing departure'
        index=leg['to_index'];dep=visit['departed_at']
    return None,'route traversal exceeded'

# One record per physical source-target pair; if present at both elapsed clocks,
# retain its shorter displayed remaining wait, documenting the chosen clock.
candidates={48:{},4:{}}; failed=collections.Counter();failureCases=[]
for o in observations:
    for target in ([48,4] if o['elapsedSec']==405 else [48]):
        path,error=chain(o['source'],target)
        if error:
            failed[str(target)+': '+error]+=1
            failureCases.append(dict(sourceId=o['source']['id'],bus=o['source']['bus_name'],departedAt=o['source']['departed_at'],target=target,reason=error));continue
        arrival=path[-1]['visit']['arrived_at']; s=o['source']; start=s['pinned_at']+o['elapsedSec']*1000
        if target==48:assert arrival==o['trip']['arrivedAt']
        key=(s['id'],path[-1]['visit']['id'])
        c=dict(journeyId=f"3:{s['id']}:{path[-1]['visit']['id']}",fixture=o['fixture'],targetStopId=target,
               elapsedSec=o['elapsedSec'],remainingSec=(arrival-start)/1000,
               residualSourceWaitSec=(s['departed_at']-start)/1000,departureToTargetSec=(arrival-s['departed_at'])/1000,
               startedAt=start,source=s,path=path,derivedToDropoff=target==4)
        if key not in candidates[target] or c['remainingSec']<candidates[target][key]['remainingSec']:candidates[target][key]=c

selected=[]
for target in [48,4]: selected.extend(sorted(candidates[target].values(),key=lambda c:c['remainingSec'])[:5])

# Older archives can be partial after retention; do not infer coverage from a
# file's existence. Stream only selected date/bus/time windows into memory.
archiveRows=[];archiveInputs=[]
for day in sorted({iso(c['startedAt'])[:10]for c in selected}):
    cases=[c for c in selected if iso(c['startedAt'])[:10]==day]
    paths=[pathlib.Path('/home/gwarren/shuttle-archive')/day/'raw_positions.jsonl.gz',
           pathlib.Path('/home/gwarren/shuttle-captures')/('positions-'+day.replace('-','')+'.jsonl')]
    for p in paths:
        if not p.exists():continue
        count=0;kept=0;first=None;last=None;malformed=[]
        with (gzip.open(p,'rt') if p.suffix=='.gz' else p.open())as f:
            for lineNo,line in enumerate(f,1):
                try:row=json.loads(line)
                except json.JSONDecodeError:
                    malformed.append(lineNo);continue
                t=row['collected_at'];count+=1
                first=t if first is None else min(first,t);last=t if last is None else max(last,t)
                if row['route_id']==3 and any(row['bus_name']==c['source']['bus_name'] and c['source']['pinned_at']-60000<=t<=(c['path'][-1]['visit']['departed_at']or c['path'][-1]['visit']['arrived_at'])+60000 for c in cases):
                    archiveRows.append((str(p),row));kept+=1
        archiveInputs.append(dict(path=str(p),n=count,firstAt=first,lastAt=last,relevantRows=kept,malformedLines=malformed))

def raw_evidence(c):
    s=c['source'];target=c['path'][-1]['visit']; lo=s['pinned_at']-60000;hi=(target['departed_at'] or target['arrived_at'])+60000
    gps={};origins=[]
    for name,d in rawdbs:
        found=[dict(r)for r in d.execute('SELECT * FROM raw_positions WHERE route_id=3 AND bus_name=? AND collected_at BETWEEN ? AND ? ORDER BY collected_at',(s['bus_name'],lo,hi))]
        if found:origins.append(name)
        for p in found:gps[(p['collected_at'],p['bus_id'])]=p
    for name,p in archiveRows:
        if p['bus_name']==s['bus_name'] and lo<=p['collected_at']<=hi:
            if name not in origins:origins.append(name)
            gps[(p['collected_at'],p['bus_id'])]=p
    raw=sorted(gps.values(),key=lambda p:p['collected_at'])
    if not raw:return dict(available=False,reason='No local GPS coverage for this service date.')
    hops=[dict(at=b['collected_at'],sec=(b['collected_at']-a['collected_at'])/1000,metres=metres(a,b))for a,b in zip(raw,raw[1:])if b['collected_at']>a['collected_at']]
    for h in hops:h['metresPerSec']=h['metres']/h['sec']
    targetRaw=[p for p in raw if target['pinned_at']-10000<=p['collected_at']<=(target['departed_at'] or target['arrived_at'])+10000]
    srcRaw=[p for p in raw if s['pinned_at']-10000<=p['collected_at']<=s['departed_at']+10000]
    matched=min(raw,key=lambda p:abs(p['collected_at']-c['startedAt']))
    matchedIndex=raw.index(matched);plateauStart=matchedIndex
    while plateauStart>0 and (raw[plateauStart-1]['lat'],raw[plateauStart-1]['lon'])==(matched['lat'],matched['lon']):plateauStart-=1
    asofIndex=max(i for i,p in enumerate(raw)if p['collected_at']<=c['startedAt']);asofStart=asofIndex
    while asofStart>0 and (raw[asofStart-1]['lat'],raw[asofStart-1]['lon'])==(raw[asofIndex]['lat'],raw[asofIndex]['lon']):asofStart-=1
    targetNear=[p for p in raw if p['collected_at']>=target['arrived_at'] and metres(p,stops[c['targetStopId']])<=25]
    withinVisit=[p for p in raw if s['pinned_at']<=p['collected_at']<=s['departed_at']]
    atTarget=min(raw,key=lambda p:abs(p['collected_at']-target['arrived_at']))
    return dict(available=True,databases=origins,n=len(raw),firstAt=raw[0]['collected_at'],lastAt=raw[-1]['collected_at'],
      maxGapSec=max(h['sec']for h in hops),maxObservedStepMps=max(h['metresPerSec']for h in hops),
      busIds=sorted({p['bus_id']for p in raw}),sourceMinDistanceM=min(metres(p,stops[11])for p in srcRaw)if srcRaw else None,
      targetMinDistanceM=min(metres(p,stops[c['targetStopId']])for p in targetRaw)if targetRaw else None,
      matchedSourcePoll=dict(at=matched['collected_at'],distanceM=metres(matched,stops[11]),clockOffsetSec=(matched['collected_at']-c['startedAt'])/1000,
        identicalCoordinateAgeSec=(matched['collected_at']-raw[plateauStart]['collected_at'])/1000),
      sourceAsOfMatchedTime=dict(lastPollAt=raw[asofIndex]['collected_at'],lastPollAgeSec=(c['startedAt']-raw[asofIndex]['collected_at'])/1000,
        identicalCoordinateAgeSec=(c['startedAt']-raw[asofStart]['collected_at'])/1000),
      sourceMaxDistanceDuringVisitM=max(metres(p,stops[11])for p in withinVisit),sourcePollsOutside75M=sum(metres(p,stops[11])>75 for p in withinVisit),
      targetDistanceAtRecordedArrivalM=metres(atTarget,stops[c['targetStopId']]),
      firstWithin25MAfterRecordedArrivalSec=(targetNear[0]['collected_at']-target['arrived_at'])/1000 if targetNear else None,
      sourceWindow=srcRaw,targetWindow=targetRaw,largestSteps=sorted(hops,key=lambda h:h['metresPerSec'],reverse=True)[:3],
      raw=raw)

for c in selected:
    s=c['source'];target=c['path'][-1]['visit'];c['dateTimeET']=iso(c['startedAt'])
    c['sourceClocksET']={k:iso(s[k])if s[k]is not None else None for k in ['anchored_at','pinned_at','arrived_at','departed_at','first_moved_at','last_at_rest_at']}
    c['sourcePinnedToDepartureSec']=(s['departed_at']-s['pinned_at'])/1000
    c['sourcePriorNearbyVisits']=rows('SELECT * FROM stop_visits WHERE route_id=3 AND stop_id=11 AND bus_name=? AND id!=? AND anchored_at BETWEEN ? AND ? ORDER BY anchored_at',(s['bus_name'],s['id'],s['pinned_at']-1200000,s['pinned_at']-1))
    c['straightLineLowerBoundMps']=metres(stops[11],stops[c['targetStopId']])/c['departureToTargetSec']
    c['rawEvidence']=raw_evidence(c)
    c['flags']=[]
    if s['how']=='gap' or any(p['visit']['how']=='gap'for p in c['path']):c['flags'].append('gap confirmation')
    if any(p['leg']['bus_id']!=s['bus_id']for p in c['path']):c['flags'].append('bus ID changes: inspect handoff')
    if c['straightLineLowerBoundMps']>35:c['flags'].append('physically suspicious endpoint speed')
    if c['rawEvidence']['available'] and c['rawEvidence']['maxGapSec']>30:c['flags'].append('raw gap over 30 seconds')
    c['qualityNotes']=[]
    g=c['rawEvidence']
    if not g['available']:c['qualityNotes'].append('GPS unavailable for this window; structural evidence only')
    else:
        if g['sourceAsOfMatchedTime']['identicalCoordinateAgeSec']<10:c['qualityNotes'].append('As-of matched time has less than 10 seconds since coordinate change; distinguish cadence-boundary cases from substantial deficits')
        if g['targetDistanceAtRecordedArrivalM']>50 and g['firstWithin25MAfterRecordedArrivalSec']is not None and g['firstWithin25MAfterRecordedArrivalSec']>0:c['qualityNotes'].append('Recorded arrival rests upstream; closer mapped-stop passage is later')

out=dict(method='Five shortest distinct Division journeys across two fixture clocks, plus five shortest connected Rosenkranz journeys extended from the 405-second source cohort. Not a random accuracy sample.',
fixtureObservations=len(observations),uniqueCandidates={k:len(v)for k,v in candidates.items()},extensionFailures=dict(failed),extensionFailureCases=failureCases,
rawCoverage=[dict(database=n,range=list(d.execute('SELECT MIN(collected_at),MAX(collected_at),COUNT(*) FROM raw_positions').fetchone()))for n,d in rawdbs],archiveInputs=archiveInputs,selected=selected)
(HERE/'short-trip-audit.json').write_text(json.dumps(out,indent=2)+'\n')
print(json.dumps({k:v for k,v in out.items()if k!='selected'},indent=2))
for c in selected:
 print(json.dumps(dict(id=c['journeyId'],bus=c['source']['bus_name'],et=c['dateTimeET'],target=c['targetStopId'],elapsed=c['elapsedSec'],remaining=c['remainingSec'],wait=c['residualSourceWaitSec'],drive=c['departureToTargetSec'],sourceHow=c['source']['how'],sourceShuffles=c['source']['shuffles'],targetClosestM=c['path'][-1]['visit']['closest_m'],targetStandSec=c['path'][-1]['visit']['stand_sec'],legIds=[p['leg']['id']for p in c['path']],raw=c['rawEvidence']['available'],flags=c['flags'])))
