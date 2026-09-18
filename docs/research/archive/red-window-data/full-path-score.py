"""Read-only paired forecast scorer, grouped by connected visit/checkpoint.

Input JSON/JSONL rows: {at,bus,target,stopsAhead,baseline:{eta,low,high},
candidate:{eta,low,high},segmentId?,observedAt?,resetReason?}. `at` is epoch ms
or ISO UTC. Bus IDs and per-arm diagnostics may be included and are retained.
Pass --candidate-key unclamped to inspect the older diagnostic fixture.
No promotion decision, model fitting, or implied independent truth.
"""
import argparse,bisect,collections,datetime,hashlib,json,math,pathlib,sqlite3,statistics
from zoneinfo import ZoneInfo
P=argparse.ArgumentParser();P.add_argument('--pairs',required=True);P.add_argument('--db',required=True);P.add_argument('--out',required=True)
P.add_argument('--candidate-key',default='candidate');P.add_argument('--baseline-key',default='baseline');P.add_argument('--sources',default='11,121');P.add_argument('--targets',default='48,4');P.add_argument('--tolerance-sec',type=float,default=15);P.add_argument('--min-warm-sec',type=float,default=0);P.add_argument('--extra-labels',help='JSON {stop_visits:[],legs:[]} from a read-only export; merged in memory only')
A=P.parse_args(); TZ=ZoneInfo('America/New_York'); sources=list(map(int,A.sources.split(',')));targets=list(map(int,A.targets.split(',')))
def timestamp(x):return int(x) if isinstance(x,(int,float)) else int(datetime.datetime.fromisoformat(x.replace('Z','+00:00')).timestamp()*1000)
def name(x):return str(x).lstrip('#')
def quant(v,p):
    s=sorted(v);i=(len(s)-1)*p;l=math.floor(i);return s[l]+(s[math.ceil(i)]-s[l])*(i-l)
def read(p):
    s=pathlib.Path(p).read_text();return json.loads(s) if s.lstrip().startswith('[') else [json.loads(x) for x in s.splitlines() if x.strip()]
raw=read(A.pairs); rows=[];rejected=collections.Counter();clipped=collections.Counter()
for r in raw:
    if r.get('target') not in targets:continue
    if r.get('route',r.get('routeId',3))!=3:continue
    x=dict(r,at=timestamp(r['at']),bus=name(r['bus']),baseline=r.get(A.baseline_key),candidate=r.get(A.candidate_key))
    if A.min_warm_sec and (x.get('warmMs') is None or x['warmMs']<A.min_warm_sec*1000):rejected['insufficient or unknown warm duration']+=1;continue
    if any(not isinstance(x.get(arm),dict) for arm in ['baseline','candidate']):rejected['unpaired forecast row']+=1;continue
    if any(not all(isinstance(x[arm].get(k),(int,float)) and math.isfinite(x[arm][k]) for k in ['eta','low','high']) or x[arm]['low']>x[arm]['high'] for arm in ['baseline','candidate']):rejected['invalid forecast row']+=1;continue
    # Match the existing rider adapter at zero elapsed: nonnegative remaining
    # seconds. Preserve raw wire values; negative bounds are not discarded.
    for arm in ['baseline','candidate']:
        x[arm+'Raw']=dict(x[arm])
        for k in ['eta','low','high']:
            if x[arm][k]<0:clipped[arm+'.'+k]+=1
        x[arm]={**x[arm],**{k:max(0,x[arm][k]) for k in ['eta','low','high']}}
    rows.append(x)
assert rows,'No valid paired rows'
lo=min(r['at'] for r in rows);hi=max(r['at'] for r in rows); indexed=collections.defaultdict(list)
for r in rows:indexed[(r['bus'],r['target'])].append(r)
for key,rs in indexed.items():
    rs.sort(key=lambda r:(r['at'],r.get('stopsAhead',999)))
    # The first target occurrence is scored. Other occurrences are counted,
    # never silently interpreted as separate observed arrivals.
    unique=[]
    for r in rs:
        if unique and unique[-1]['at']==r['at']:
            if unique[-1].get('stopsAhead')==r.get('stopsAhead') and unique[-1].get('occurrence')==r.get('occurrence'):raise ValueError('Duplicate forecast identity; deduplicate capture overlaps explicitly')
            rejected['additional target occurrence']+=1;continue
        unique.append(r)
    indexed[key]=unique
db=sqlite3.connect('file:'+str(pathlib.Path(A.db).resolve())+'?mode=ro',uri=True);db.row_factory=sqlite3.Row
if A.extra_labels:
    extra=json.loads(pathlib.Path(A.extra_labels).read_text()); memory=sqlite3.connect(':memory:');memory.row_factory=sqlite3.Row
    for table in ['routes','stop_visits','legs']:
        columns=[r['name'] for r in db.execute('PRAGMA table_info('+table+')')]
        # The source DB remains read-only. Copy just the rows used by this scorer.
        memory.execute('CREATE TABLE '+table+' ('+','.join('"'+c+'"' for c in columns)+')')
        source=list(db.execute('SELECT * FROM '+table+(' WHERE id=3' if table=='routes' else ' WHERE route_id=3')))
        known={r['id']:dict(r) for r in source}
        for row in extra.get(table,[]):
            if row.get('route_id')!=3:continue
            if row['id'] in known:
                # The same ID may be refreshed from incomplete to complete, but
                # never repurposed for a different physical visit or leg.
                old=known[row['id']]
                identities=['bus_name','stop_id','anchored_at'] if table=='stop_visits' else ['bus_name','from_stop_id','departed_at']
                assert all(old[k]==row[k] for k in identities),'Conflicting outcome IDs across exports'
            known[row['id']]=row
        memory.executemany('INSERT INTO '+table+' VALUES ('+','.join('?' for _ in columns)+')',[[r.get(c) for c in columns] for r in known.values()])
    db.close();db=memory
    db.execute('CREATE INDEX leg_chain ON legs(route_id,bus_name,from_index,departed_at)')
    db.execute('CREATE INDEX visit_chain ON stop_visits(route_id,bus_name,stop_id,stop_index,arrived_at)')
def query(sql,args=()):return [dict(r) for r in db.execute(sql,args)]
seq=json.loads(db.execute('SELECT stops_json FROM routes WHERE id=3').fetchone()[0]);N=len(seq)
assert len(seq)==len(set(seq)),'Red repeated target occurrences require explicit occurrence matching'
allVisits=query('SELECT * FROM stop_visits WHERE route_id=3 AND anchored_at>=? AND anchored_at<=? ORDER BY anchored_at',(lo-7200000,hi+7200000))
sourceVisits=[s for s in allVisits if s['stop_id'] in sources and s['outcome']=='stopped' and s['how']!='gap' and s['pinned_at'] is not None and s['departed_at'] is not None and s['pinned_at']<=hi and s['departed_at']>=lo-60000]
targetTimes=collections.defaultdict(list)
for v in allVisits:
    if v['stop_id'] in targets and v['arrived_at'] is not None:targetTimes[(name(v['bus_name']),v['stop_id'])].append(v['arrived_at'])
for ts in targetTimes.values():ts.sort()
def chain(s,target):
    index=s['stop_index'];dep=s['departed_at'];ti=seq.index(target);path=[]
    for _ in seq:
        rem=(ti-index)%N
        if rem==0:return None,'target is same source occurrence'
        ls=query('SELECT * FROM legs WHERE route_id=3 AND bus_name=? AND from_index=? AND departed_at=? AND reached=1',(s['bus_name'],index,dep))
        if len(ls)!=1:return None,'missing or ambiguous connected leg'
        leg=ls[0]
        if not (leg['from_stop_id']==seq[index] and leg['to_stop_id']==seq[leg['to_index']] and leg['arrived_at']>dep and 1<=leg['hops']<=rem and (leg['to_index']-index)%N==leg['hops']):return None,'invalid route occurrence or time'
        vs=query("SELECT * FROM stop_visits WHERE route_id=3 AND stop_id=? AND stop_index=? AND bus_name=? AND anchored_at BETWEEN ? AND ? AND (arrived_at=? OR (outcome='passed' AND departed_at=?))",(leg['to_stop_id'],leg['to_index'],s['bus_name'],s['anchored_at'],leg['arrived_at'],leg['arrived_at'],leg['arrived_at']))
        if len(vs)!=1:return None,'missing or ambiguous connected visit'
        v=vs[0];path.append((leg,v))
        if leg['to_index']==ti:
            if v['arrived_at'] is None or v['closest_m']>75 or v['outcome'] not in ['passed','stopped'] or v['how']=='gap':return None,'unsupported target outcome'
            return path,None
        if v['how']=='gap' or v['departed_at'] is None or v['departed_at']<leg['arrived_at']:return None,'intermediate gap or missing departure'
        index=leg['to_index'];dep=v['departed_at']
    return None,'no target reached'
def metric(rs,arm):
    if not rs:return {'n':0}
    err=[r[arm]['eta']-r['truthSec'] for r in rs];ae=list(map(abs,err));early=[r['truthSec']<r[arm]['low'] for r in rs];late=[r['truthSec']>r[arm]['high'] for r in rs]
    widths=[r[arm]['high']-r[arm]['low'] for r in rs]
    wis=[(.5*abs(r[arm]['eta']-r['truthSec'])+.1*(r[arm]['high']-r[arm]['low']+10*max(0,r[arm]['low']-r['truthSec'])+10*max(0,r['truthSec']-r[arm]['high'])))/1.5 for r in rs]
    return {'n':len(rs),'dates':len({r['day'] for r in rs}),'sourceVisits':len({r['sourceId'] for r in rs}),'targetVisits':len({r['targetVisitId'] for r in rs}),'medianAbsSec':statistics.median(ae),'maeSec':statistics.mean(ae),'p90AbsSec':quant(ae,.9),'meanSignedSec':statistics.mean(err),'meanWidthSec':statistics.mean(widths),'WIS':statistics.mean(wis),'covered':len(rs)-sum(early)-sum(late),'early':sum(early),'late':sum(late),'overpredictionGT120':sum(e>120 for e in err),'underpredictionGT120':sum(e< -120 for e in err),'overpredictionGT300':sum(e>300 for e in err),'underpredictionGT300':sum(e< -300 for e in err)}
events=[];journeys=[];skipped=[];jumps=[]
for s in sourceVisits:
    for target in targets:
        path,error=chain(s,target)
        if error:skipped.append({'sourceId':s['id'],'target':target,'reason':error});continue
        v=path[-1][1];arrival=v['arrived_at'];jid=f"3:{s['id']}:{v['id']}";key=(name(s['bus_name']),target)
        times=targetTimes[key];prevIndex=bisect.bisect_left(times,arrival)-1;prevTarget=times[prevIndex] if prevIndex>=0 else -math.inf
        candidates=[r for r in indexed.get(key,[]) if max(s['pinned_at']-600000,prevTarget)<r['at']<arrival]
        ctimes=[r['at'] for r in candidates]
        meta={'journeyId':jid,'sourceId':s['id'],'sourceStop':s['stop_id'],'targetVisitId':v['id'],'target':target,'targetOutcome':v['outcome'],'targetClosestM':v['closest_m'],'bus':name(s['bus_name']),'day':datetime.datetime.fromtimestamp(s['pinned_at']/1000,TZ).date().isoformat()}
        journeys.append(dict(meta,pinnedAt=s['pinned_at'],departedAt=s['departed_at'],targetArrivedAt=arrival,legIds=[l['id'] for l,_ in path],forecastRows=len(candidates)))
        clocks=[('approach',e,s['pinned_at']+e*1000) for e in [-600,-300,-120,-60]]+ [('standing',e,s['pinned_at']+e*1000) for e in [0,60,180,300,420,600] if s['pinned_at']+e*1000<s['departed_at']]+ [('departure',e,s['departed_at']+e*1000) for e in [0,5,15,30,60]]
        for phase,e,t in clocks:
            if t>=arrival:continue
            k=bisect.bisect_left(ctimes,t)
            if k==len(candidates) or candidates[k]['at']>t+A.tolerance_sec*1000 or (phase=='standing' and candidates[k]['at']>=s['departed_at']) or (phase=='approach' and candidates[k]['at']>=s['pinned_at']):
                skipped.append(dict(meta,phase=phase,checkpointSec=e,reason='no paired forecast at checkpoint before phase ends'));continue
            r=candidates[k]
            events.append(dict(r,**meta,phase=phase,checkpointSec=e,checkpointDelaySec=(r['at']-t)/1000,truthSec=(arrival-r['at'])/1000))
        for a,b in zip(candidates,candidates[1:]):
            dt=(b['at']-a['at'])/1000
            if dt<=0 or dt>A.tolerance_sec or a.get('segmentId')!=b.get('segmentId') or b.get('resetReason'):continue
            jumps.append(dict(meta,at=b['at'],phase='approach' if b['at']<s['pinned_at'] else 'standing' if b['at']<s['departed_at'] else 'departure',**{arm:dt+b[arm]['eta']-a[arm]['eta'] for arm in ['baseline','candidate']}))
groups=collections.defaultdict(list)
for r in events:groups[(r['sourceStop'],r['target'],r['phase'],r['checkpointSec'])].append(r)
scores=[]
for (source,target,phase,e),rs in sorted(groups.items()):
    scores.append({'sourceStop':source,'target':target,'phase':phase,'checkpointSec':e,'allObserved':{arm:metric(rs,arm) for arm in ['baseline','candidate']},'stoppedTargetsOnly':{arm:metric([r for r in rs if r['targetOutcome']=='stopped'],arm) for arm in ['baseline','candidate']},'byDate':{day:{arm:metric([r for r in rs if r['day']==day],arm) for arm in ['baseline','candidate']} for day in sorted({r['day'] for r in rs})}})
uniqueJumps={}
for r in jumps:
    key=(r['bus'],r['targetVisitId'],r['at'])
    context={'sourceId':r['sourceId'],'phase':r['phase']}
    if key in uniqueJumps:
        old=uniqueJumps[key]
        assert all(math.isclose(old[arm],r[arm],abs_tol=1e-8) for arm in ['baseline','candidate'])
        old['sourceContexts'].append(context)
    else:uniqueJumps[key]=dict(r,sourceContexts=[context])
duplicateJumpContexts=len(jumps)-len(uniqueJumps);jumps=list(uniqueJumps.values())
jumpScores={}
for target in targets:
    jr=[r for r in jumps if r['target']==target];jumpScores[target]={}
    for arm in ['baseline','candidate']:
        jumpScores[target][arm]={'adjacentPairs':len(jr),'positiveGT60':sum(r[arm]>60 for r in jr),'negativeLTMinus60':sum(r[arm]< -60 for r in jr),'positiveGT180':sum(r[arm]>180 for r in jr),'negativeLTMinus180':sum(r[arm]< -180 for r in jr),'targetVisitsPositiveGT60':len({r['targetVisitId'] for r in jr if r[arm]>60}),'largestAbsolute':max((abs(r[arm]) for r in jr),default=None)}
out={'method':'Retrospective paired full-path checkpoint score on exact connected source-target journeys. No fitting; no automatic pass/fail. Repeated checkpoints and source contexts share target visits. Arrival labels are detector/GPS proxies, not verified doors. Early actual arrival relative to forecast does not itself establish a missed rider connection.', 'input':{'pairs':str(pathlib.Path(A.pairs).resolve()),'sha256':hashlib.sha256(pathlib.Path(A.pairs).read_bytes()).hexdigest(),'db':str(pathlib.Path(A.db).resolve()),'extraLabels':A.extra_labels,'extraLabelsSha256':hashlib.sha256(pathlib.Path(A.extra_labels).read_bytes()).hexdigest() if A.extra_labels else None,'baselineKey':A.baseline_key,'candidateKey':A.candidate_key,'toleranceSec':A.tolerance_sec,'minWarmSec':A.min_warm_sec,'normalization':'Clip finite wire eta/low/high to zero as rider adapter does at zero elapsed; preserve Raw arm values'},'counts':{'rawRows':len(raw),'pairedRows':len(rows),'rejected':dict(rejected),'riderZeroClipping':dict(clipped),'sources':len(sourceVisits),'connectedJourneys':len(journeys),'uniqueTargets':len({j['targetVisitId'] for j in journeys}),'checkpointRows':len(events),'duplicateJumpContextsRemoved':duplicateJumpContexts,'rowsWithoutSegmentIdentity':sum(r.get('segmentId') is None for r in rows),'rowsWithoutWarmDuration':sum(r.get('warmMs') is None for r in rows),'skippedReasons':dict(collections.Counter(r['reason'] for r in skipped))},'scores':scores,'jumpScores':jumpScores,'journeys':journeys,'checkpoints':events,'skipped':skipped,'jumps':jumps,'largestRegressions':sorted(events,key=lambda r:abs(r['candidate']['eta']-r['truthSec'])-abs(r['baseline']['eta']-r['truthSec']),reverse=True)[:20]}
pathlib.Path(A.out).write_text(json.dumps(out,indent=2)+'\n');print(json.dumps({'output':A.out,'counts':out['counts'],'jumpScores':jumpScores},indent=2))
