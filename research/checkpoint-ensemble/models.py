"""Fixed marginal means and complete physical-journey vectors. No labels here."""
import collections
import datetime as dt
import math
from zoneinfo import ZoneInfo
from ensemble_math import mean_absolute, joint_deviations, wire_forecast

TZ=ZoneInfo('America/New_York')
OFFSETS=tuple(range(11))
def finite(x):return isinstance(x,(int,float)) and not isinstance(x,bool) and math.isfinite(x)
def date(t):return dt.datetime.fromtimestamp(t/1000,TZ).date().isoformat()
def clock(t):
    d=dt.datetime.fromtimestamp(t/1000,TZ);return d.hour*60+d.minute+d.second/60
def weekend(t):return dt.datetime.fromtimestamp(t/1000,TZ).weekday()>=5
def distance(a,b,n):return (b-a)%n
def targets(top,waits,rid,w):
    n=len(top[rid]['stops']);length=min([distance(w,v,n) for v in waits[rid] if v!=w] or [n-1])
    return tuple((w+i)%n for i in range(1,length+1))
def available(v,cut):
    return all(finite(v.get(f)) for f in ('arrived_at','departed_at','known_at')) and v['arrived_at']<=v['departed_at']<=v['known_at']<cut
def strict(v,top):
    seq=top[v['route_id']]['stops'];i=v['stop_index']
    return (0<=i<len(seq) and seq[i]==v['stop_id'] and available(v,float('inf'))
        and v['outcome'] in ('passed','stopped') and v.get('how') not in (None,'gap')
        and finite(v.get('pinned_at')) and v['pinned_at']<=v['known_at']
        and finite(v.get('closest_m')) and v['closest_m']<=75
        and finite(v.get('bus_id')) and finite(v.get('anchor_bus_id')) and v['bus_id']==v['anchor_bus_id'])
def weights(paths,departure):
    out=[]
    for p in paths:
        if weekend(p['start'])!=weekend(departure):continue
        diff=abs(clock(p['start'])-clock(departure));diff=min(diff,1440-diff)
        w=math.exp(-.5*(diff/120)**2)
        if w>=1e-12:out.append((p,w))
    return out
def support(pairs):
    total=sum(w for _,w in pairs);days=collections.Counter()
    for p,w in pairs:days[date(p['start'])]+=w
    eff=total**2/sum(w*w for _,w in pairs) if total else 0
    material=sum(w>=.05*total for w in days.values()) if total else 0
    return dict(paths=len(pairs),sources=len({p['sourceId'] for p,_ in pairs}),dates=sorted(days),effective=eff,materialDates=material,supported=eff>=12 and material>=3)

class Paths:
    def __init__(self,top,waits,visits,quality,cutoff,occurrences):
        self.top,self.waits,self.cutoff=top,waits,cutoff;self.paths=collections.defaultdict(list);self.audit=collections.Counter()
        self.occurrences=occurrences
        self.fit_cache={};self.vector_cache={};groups=collections.defaultdict(list)
        for v in visits:
            if available(v,cutoff):groups[v['bus_name'],v['route_id']].append(v)
        for (bus,rid),vs in groups.items():
            vs.sort(key=lambda v:(v['anchored_at'],v['id']));n=len(top[rid]['stops']);cap=2700 if rid==3 else 5400
            for pos,s in enumerate(vs):
                if not strict(s,top):continue
                sp=occurrences.get(s['id'])
                if sp is None:self.audit['source occurrence proof unavailable']+=1;continue
                for j in OFFSETS:
                    if j>=n:continue
                    w=(s['stop_index']+j)%n
                    if w not in waits[rid]:continue
                    wanted={j+distance(w,t,n):t for t in targets(top,waits,rid,w)}
                    if not wanted:continue
                    progress=0;previous=s['stop_index'];wait=s if j==0 else None;reached=set();before_wait=collections.Counter()
                    for v in vs[pos+1:]:
                        if v['arrived_at']<=s['departed_at']:continue
                        duration=(v['arrived_at']-s['departed_at'])/1000
                        if duration>cap:break
                        hop=distance(previous,v['stop_index'],n)
                        if not hop or hop>5:break
                        progress+=hop;previous=v['stop_index']
                        if progress>max(wanted):break
                        if progress<j:before_wait[v['stop_id']]+=1
                        if progress==j:
                            if strict(v,top):wait=v
                            else:self.audit['wait not strict']+=1;break
                        if progress>j and wait is None:self.audit['wait occurrence not emitted']+=1;break
                        if progress not in wanted or progress in reached:continue
                        reached.add(progress);ti=wanted[progress]
                        if not strict(v,top):self.audit['target not strict']+=1;continue
                        if wait is None or (j>0 and s['departed_at']>wait['arrived_at']) or wait['departed_at']>v['arrived_at']:
                            self.audit['source wait target temporal overlap']+=1;continue
                        wp,tp=occurrences.get(wait['id']),occurrences.get(v['id'])
                        if not wp or not tp or not(sp['epoch']==wp['epoch']==tp['epoch']) or wp['progress']-sp['progress']!=j or tp['progress']-sp['progress']!=progress:
                            self.audit['unwrapped same-traversal proof unavailable']+=1;continue
                        # The source's physical pin/arrival also belongs to the
                        # proven observed-provider interval, not just its emission.
                        if not quality.ok(bus,rid,min(s['pinned_at'],s['arrived_at']),v['arrived_at']):
                            self.audit['source-to-target continuity']+=1;continue
                        assert wait and s['known_at']<cutoff and wait['known_at']<cutoff and v['known_at']<cutoff
                        self.paths[rid,j,w,ti].append(dict(start=s['departed_at'],end=v['arrived_at'],duration=duration,
                            day=date(s['departed_at']),weekend=weekend(s['departed_at']),bus=bus,
                            sourceId=s['id'],targetId=v['id'],waitId=wait['id'],sourceIndex=s['stop_index'],waitIndex=w,targetIndex=ti,
                            sourceKnown=s['known_at'],waitKnown=wait['known_at'],targetKnown=v['known_at'],
                            sourceProvider=s['bus_id'],waitProvider=wait['bus_id'],targetProvider=v['bus_id'],
                            occurrenceEpoch=sp['epoch'],sourceProgress=sp['progress'],waitProgress=wp['progress'],targetProgress=tp['progress'],
                            sourceToWaitHops=j,sourceToTargetHops=progress,earlierSameStopBeforeWait=before_wait[v['stop_id']]))
                        self.audit['paths']+=1;self.audit['earlier same physical stop before wait']+=before_wait[v['stop_id']]
        for ps in self.paths.values():
            ids=[(p['sourceId'],p['waitId'],p['targetId']) for p in ps];assert len(ids)==len(set(ids))

    def fit(self,rid,j,w,t,departure):
        key=rid,j,w,t,departure
        if key not in self.fit_cache:
            pairs=weights(self.paths.get((rid,j,w,t),()),departure);s=support(pairs)
            s['mean']=sum(p['duration']*v for p,v in pairs)/sum(v for _,v in pairs) if pairs else None
            self.fit_cache[key]=s
        return self.fit_cache[key]

    def joint(self,rid,k,w,t,mask,departure):
        key=rid,k,w,t,mask,departure
        if key in self.vector_cache:return self.vector_cache[key]
        indices={}
        for j in mask:
            index={}
            for p in self.paths.get((rid,j,w,t),()):
                cell=p['waitId'],p['targetId']
                # Multiple source occurrences for the same wait/target/offset
                # are ambiguous, never resolved by selecting first/latest.
                if cell in index:index[cell]=None
                else:index[cell]=p
            indices[j]=index
        common=set(indices[k])
        for j in mask:common&=set(indices[j])
        vectors=[];pairs=[];seen_targets=set();seen_waits=set();seen_sources=set()
        for cell in sorted(common):
            ps={j:indices[j][cell] for j in mask}
            if any(p is None for p in ps.values()):continue
            far=ps[k];assert far is not None
            if not all(p['bus']==far['bus'] and p['end']==far['end'] and p['waitId']==far['waitId']
                       and p['sourceToWaitHops']==j and p['sourceProvider']==far['sourceProvider']
                       and p['waitProvider']==far['sourceProvider'] and p['targetProvider']==far['sourceProvider']
                       and p['occurrenceEpoch']==far['occurrenceEpoch'] and p['waitProgress']==far['waitProgress']
                       and p['targetProgress']==far['targetProgress'] for j,p in ps.items()):
                raise AssertionError('cross-journey vector identity')
            target,wait=cell[1],cell[0];source_ids={p['sourceId'] for p in ps.values()}
            assert len(source_ids)==len(mask) and target not in seen_targets and wait not in seen_waits and not(source_ids&seen_sources)
            seen_targets.add(target);seen_waits.add(wait);seen_sources|=source_ids
            weighted=weights([far],departure)
            if not weighted:continue
            journey=str((rid,far['bus'],far['sourceId'],wait));vector=dict(journeyId=journey,targetId=target,waitId=wait,components={})
            for j,p in ps.items():vector['components'][j]=dict(journeyId=journey,targetId=target,waitId=wait,sourceId=p['sourceId'],durationSec=p['duration'])
            vectors.append(vector);pairs.append(weighted[0])
        info=support(pairs);info.update(completeVectors=len(vectors),physicalTargets=len({v['targetId'] for v in vectors}),vectorIds=[(v['journeyId'],v['targetId'],v['waitId']) for v in vectors])
        if info['supported']:
            ws=[weight for _,weight in pairs]
            info['ensemble']=joint_deviations(vectors,mask,ws)
            info['single']=joint_deviations(vectors,mask,ws,project_offsets=(k,))
        self.vector_cache[key]=info;return info

def group_prediction(model,row,m,source_map):
    if not m['supported']:return dict(supported=False,reason=m['reason'])
    rid,w,k=row['route'],m['wait'],m['k'];mask=tuple(m['offsets']);tg=targets(model.top,model.waits,rid,w)
    if tuple(m['targetGroup'])!=tg:return dict(supported=False,reason='fit wait/target-group incompatible')
    if row['targetIndex'] not in tg:return dict(supported=False,reason='target outside fixed downstream group')
    sources={int(j):source_map[sid] for j,sid in m['sourceIds'].items()}
    assert set(sources)==set(mask) and all(s['departed']<=s['knownAt']<=row['asof'] for s in sources.values())
    assert all(s['name']==row['bus'] and s['route']==rid and s['index']==(w-j)%len(model.top[rid]['stops']) for j,s in sources.items())
    assert len({s['epoch'] for s in sources.values()})==1 and len({s['provider'] for s in sources.values()})==1
    result=dict(supported=True,reason='checkpoint ensemble',wait=w,k=k,mask=mask,regime=m['regime'],journey=m['journey'],
        sourceIds=m['sourceIds'],origin=sources[k]['departed'],source=sources[k]['index'],targetGroup=tg,targets={})
    departures={j:sources[j]['departed']/1000 for j in mask}
    for t in tg:
        fits={j:model.fit(rid,j,w,t,sources[j]['departed']) for j in mask}
        if any(not f['supported'] for f in fits.values()):return dict(result,supported=False,reason='whole-group constituent support',unsupportedTarget=t,componentSupport=fits)
        means={j:fits[j]['mean'] for j in mask};components={j:departures[j]+means[j] for j in mask}
        if any(a-row['at']/1000<=60 for a in components.values()):return dict(result,supported=False,reason='whole-group component countdown expired',unsupportedTarget=t)
        result['targets'][t]=dict(pointAbs=mean_absolute(departures,means,mask),singleAbs=components[k],components=components,
            support=fits,joint=model.joint(rid,k,w,t,mask,sources[k]['departed']))
    result['jointSupported']=all(t['joint']['supported'] for t in result['targets'].values())
    return result

def joint_forecast(result,row,estimator,protected):
    target=result['targets'][row['targetIndex']];point=target['pointAbs' if estimator=='ensemble' else 'singleAbs']
    q=target['joint'][estimator]
    return wire_forecast(point,point+q['q10'],point+q['q90'],row['at']/1000,row['deployed']['low'] if protected else None)
