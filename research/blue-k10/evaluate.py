"""Occurrence-aware Blue transfer test. Freeze forecasts before attaching test outcomes."""
import bisect, collections, datetime as dt, gzip, json, math, statistics as st
from pathlib import Path
from prepare import HERE, OUT, ROUTES, TZ, CUTOFF, read, write, date
ARMS={'K10':(10,None),'K5':(5,None),'K10_first10':(10,10),'K5_first10':(5,10)}
WAITS={int(k):v for k,v in json.loads((OUT/'preparation.json').read_text())['waits'].items()}
TEST=int(dt.datetime(2026,9,17,tzinfo=TZ).timestamp()*1000)
def clock(ms):
    t=dt.datetime.fromtimestamp(ms/1000,TZ);return t.hour*60+t.minute+t.second/60
def weekend(ms):return dt.datetime.fromtimestamp(ms/1000,TZ).weekday()>=5
def distance(a,b,n):return (b-a)%n
def targets(rid,w,limit=None):
    n=len(ROUTES[rid]['stops']);others=[distance(w,v,n) for v in WAITS[rid] if v!=w]
    length=min(others) if others else n-1
    return [(w+d)%n for d in range(1,min(length,limit or n)+1)]
def previous_wait(rid,ti):
    n=len(ROUTES[rid]['stops'])
    return min(WAITS[rid],key=lambda w:distance(w,ti,n) or n) if WAITS[rid] else None
def q(values,p,weights):
    pairs=sorted(zip(values,weights));threshold=sum(weights)*p;acc=0
    for v,w in pairs:
        acc+=w
        if acc>=threshold:return v
    return pairs[-1][0]
class Quality:
    def __init__(self,raw):
        groups=collections.defaultdict(list)
        for r in raw:groups[r['bus_name']].append(r)
        self.groups={}
        for bus,rs in groups.items():
            rs.sort(key=lambda r:r['collected_at']);bad=[0]
            for a,b in zip(rs,rs[1:]):
                sec=(b['collected_at']-a['collected_at'])/1000
                metres=math.hypot((b['lat']-a['lat'])*111195,(b['lon']-a['lon'])*111195*math.cos(math.radians(a['lat'])))
                bad.append(bad[-1]+int(sec<=0 or sec>60 or metres/max(.001,sec)>22 or a['route_id']!=b['route_id']))
            self.groups[bus]=([r['collected_at'] for r in rs],[r['route_id'] for r in rs],bad)
    def ok(self,bus,rid,start,end):
        ts,ids,bad=self.groups.get(bus,([],[],[]))
        if not ts or end<=start:return False
        lo=max(0,bisect.bisect_right(ts,start)-1);hi=min(len(ts)-1,bisect.bisect_left(ts,end))
        return ts[lo]<=start+10000 and ts[hi]>=end-10000 and ids[lo]==rid and ids[hi]==rid and bad[hi]==bad[lo]
def valid(v):
    seq=ROUTES[v['route_id']]['stops'];i=v['stop_index']
    return 0<=i<len(seq) and seq[i]==v['stop_id'] and v['arrived_at'] is not None and v['outcome'] in ('passed','stopped') and v['how']!='gap' and v['closest_m'] is not None and v['closest_m']<=75
class Models:
    def __init__(self,visits,quality):
        self.paths=collections.defaultdict(list);self.audit=collections.Counter();self.cache={}
        groups=collections.defaultdict(list)
        # Only completed training rows can create paths.
        for v in visits:
            if v['arrived_at'] is not None and v['arrived_at']<CUTOFF:groups[v['bus_name'],v['route_id']].append(v)
        for (bus,rid),vs in groups.items():
            vs.sort(key=lambda v:(v['anchored_at'],v['id']));seq=ROUTES[rid]['stops'];n=len(seq)
            sources=collections.defaultdict(list)
            for w in WAITS[rid]:
                for k in (5,10):sources[(w-k)%n].append((k,w))
            for pos,s in enumerate(vs):
                if s['stop_index'] not in sources or not valid(s) or s['departed_at'] is None or s['departed_at']>=CUTOFF:continue
                for k,w in sources[s['stop_index']]:
                    wanted={k+distance(w,t,n):t for t in targets(rid,w)}
                    progress=0;prev=s['stop_index'];reached=set()
                    for v in vs[pos+1:]:
                        if v['arrived_at'] is None:continue
                        if v['arrived_at']<=s['departed_at']:continue
                        duration=(v['arrived_at']-s['departed_at'])/1000
                        if duration>2700:break
                        hop=distance(prev,v['stop_index'],n)
                        if hop>5:break
                        progress+=hop;prev=v['stop_index']
                        if progress>max(wanted):break
                        if progress not in wanted or progress in reached:continue
                        reached.add(progress);ti=wanted[progress]
                        if not valid(v):self.audit['invalid_target']+=1;continue
                        if not quality.ok(bus,rid,s['departed_at'],v['arrived_at']):self.audit['disconnected_path']+=1;continue
                        e=dict(start=s['departed_at'],end=v['arrived_at'],day=date(s['departed_at']),duration=duration,weekend=weekend(s['departed_at']),bus=bus,sourceId=s['id'],targetId=v['id'])
                        self.paths[rid,k,w,ti].append(e);self.audit['paths']+=1
                    self.audit['unreached_or_over45min']+=len(wanted)-len(reached)
        assert all(e['end']<CUTOFF for es in self.paths.values() for e in es)
    def fit(self,rid,k,w,ti,departure):
        key=(rid,k,w,ti,departure)
        if key in self.cache:return self.cache[key]
        values=[];weights=[];days=[]
        for e in self.paths.get((rid,k,w,ti),[]):
            if e['weekend']!=weekend(departure):continue
            diff=abs(clock(e['start'])-clock(departure));diff=min(diff,1440-diff)
            weight=math.exp(-.5*(diff/120)**2)
            if weight<1e-12:continue
            values.append(e['duration']);weights.append(weight);days.append(e['day'])
        total=sum(weights);eff=total*total/sum(w*w for w in weights) if total else 0
        dw=collections.defaultdict(float)
        for d,weight in zip(days,weights):dw[d]+=weight
        material=sum(v>=.05*total for v in dw.values())
        result=None
        if eff>=12 and material>=3:
            mean=sum(v*w for v,w in zip(values,weights))/total
            result=dict(eta=mean,low=min(mean,q(values,.1,weights)),high=max(mean,q(values,.9,weights)),effective=eff,days=material)
        self.cache[key]=result
        return result
    def predict(self,r,arm):
        base=dict(forecast=r['baseline'],changed=False,reason='not warm/fresh')
        if not r['ready']:return base
        rid=r['route'];seq=ROUTES[rid]['stops'];n=len(seq);ti=seq.index(r['target']) if r['target'] in seq else -1
        if ti<0:return dict(base,reason='target not on route')
        w=previous_wait(rid,ti);k,limit=ARMS[arm]
        if w is None or ti not in targets(rid,w,limit):return dict(base,reason='outside target group')
        index=r['index'];origin=r['origins'].get(str((w-k)%n))
        if not origin:return dict(base,reason='source departure unavailable')
        assert origin['knownAt']<=r['asof'] and origin['departed']<=r['asof']
        release=r['origins'].get(str(w))
        if (release and release['departed']>origin['departed']) or distance((w-k)%n,index,n)>k or (index==w and r['phase']=='drive'):
            return dict(base,reason='released/live')
        if index!=w and (distance(index,ti,n) or n)<=distance(index,w,n):return dict(base,reason='pickup before wait')
        # The logged estimate must refer to this same upcoming stop occurrence.
        if not 0<r['stopsAhead']<n or r['stopsAhead']!=distance(r['nearest'],ti,n):return dict(base,reason='occurrence disagreement')
        forecasts={};elapsed=(r['at']-origin['departed'])/1000
        for target in targets(rid,w,limit):
            f=self.fit(rid,k,w,target,origin['departed'])
            if f is None:return dict(base,reason='group lacks historical support')
            candidate={key:max(0,f[key]-elapsed) for key in ('eta','low','high')}
            if candidate['eta']<=60:return dict(base,reason='group countdown expired')
            forecasts[target]=candidate
        return dict(forecast=forecasts[ti],changed=True,reason='checkpoint',wait=w,source=(w-k)%n,origin=origin['departed'])
class Outcomes:
    def __init__(self,visits,quality):
        self.q=quality;self.groups=collections.defaultdict(list)
        for v in visits:
            if v['arrived_at'] is not None:self.groups[v['bus_name'],v['route_id'],v['stop_id']].append(v)
        for vs in self.groups.values():vs.sort(key=lambda v:v['arrived_at'])
        self.times={k:[v['arrived_at'] for v in vs] for k,vs in self.groups.items()}
    def label(self,r):
        key=r['bus'],r['route'],r['target'];vs=self.groups.get(key,[]);ts=self.times.get(key,[])
        i=bisect.bisect_right(ts,r['at'])
        # Already at the stop is not a new arrival forecast.
        if i and vs[i-1]['departed_at'] is not None and r['at']<vs[i-1]['departed_at']:return None,'already at pickup'
        if i==len(vs):return None,'no next arrival'
        v=vs[i]
        if v['arrived_at']-r['at']>2700000:return None,'arrival beyond45min'
        if not valid(v):return None,'unresolved/distant target'
        if not self.q.ok(r['bus'],r['route'],r['at'],v['arrived_at']):return None,'disconnected outcome'
        if r['stopsAhead']<=0:return None,'at-stop forecast'
        return dict(id=v['id'],arrival=v['arrived_at'],departure=v['departed_at'],outcome=v['outcome']),None
def metrics(rows,arm):
    by=collections.defaultdict(list)
    for r in rows:
        f=r['baseline'] if arm=='usual' else r['forecasts'][arm]['forecast'];truth=r['truth'];err=f['eta']-truth
        by[r['route'],r['label']['id']].append(dict(mae=abs(err),width=f['high']-f['low'],coverage=float(f['low']<=truth<=f['high']),bias=err,early=float(truth<f['low']),late=float(truth>f['high']),falseNow=float(f['eta']<=15 and truth>120)))
    if not by:return dict(snapshots=0,visits=0)
    return dict(snapshots=len(rows),visits=len(by),days=len({date(r['at']) for r in rows}),**{k:st.mean(st.mean(v[k] for v in vs) for vs in by.values()) for k in next(iter(by.values()))[0]})
def summarize(rows):
    result={}
    for arm in ARMS:
        changed=[r for r in rows if r['forecasts'][arm]['changed']]
        result[arm]=dict(all=metrics(rows,arm),usual=metrics(rows,'usual'),changed=metrics(changed,arm),usualOnChanged=metrics(changed,'usual'),fallbacks=dict(collections.Counter(r['forecasts'][arm]['reason'] for r in rows)))
    return result
def invariants():
    # Blue West's source=1, wait=0: target1 AFTER the wait is 11 hops
    # after the checkpoint, never its earlier same-stop occurrence.
    assert distance(1,0,11)==10 and 10+distance(0,1,11)==11
    assert targets(4,19)==[20,21,22,23]
    assert previous_wait(4,23)==19 and previous_wait(4,24)==23
    assert clock(DateTs('2026-09-17T04:01:00+00:00'))==1
    assert min(abs(1439-1),1440-abs(1439-1))==2
    return dict(wraparound=True,multipleWaits=True,overnightClock=True)
def DateTs(s):return int(dt.datetime.fromisoformat(s).timestamp()*1000)
def main():
    checks=invariants();quality=Quality(read(OUT/'raw_positions.jsonl.gz'));visits=read(OUT/'stop_visits.jsonl.gz')
    model=Models(visits,quality)
    features=read(OUT/'features.jsonl.gz')
    generated=[dict(r,forecasts={a:model.predict(r,a) for a in ARMS}) for r in features]
    write('forecasts',generated) # This artifact is written before evaluation labels are read.
    # Removing every future finalized visit must leave the training model identical.
    prior=Models([v for v in visits if v['arrived_at'] is not None and v['arrived_at']<CUTOFF],quality)
    assert dict(prior.paths)==dict(model.paths);checks['futureTrainingDeletion']=True
    labels=Outcomes(visits,quality);scored=[];unmatched=collections.Counter()
    for r in generated:
        label,reason=labels.label(r)
        if label is None:unmatched[r['route'],reason]+=1;continue
        scored.append(dict(r,label=label,truth=(label['arrival']-r['at'])/1000))
    write('scored',scored)
    test=[r for r in scored if r['at']>=TEST]
    result=dict(checks=checks,training=dict(model.audit),trainingByCell={str(k):len(v) for k,v in model.paths.items()},unmatched={str(k):v for k,v in unmatched.items()},routes={},days={},stops={},worst={})
    for rid in ROUTES:
        rs=[r for r in test if r['route']==rid];result['routes'][rid]=summarize(rs)
        result['days'][rid]={d:summarize([r for r in rs if date(r['at'])==d]) for d in sorted({date(r['at']) for r in rs})}
        result['stops'][rid]={t:summarize([r for r in rs if r['target']==t]) for t in sorted({r['target'] for r in rs})}
        result['worst'][rid]={a:sorted([dict(bus=r['bus'],at=r['at'],target=r['target'],truth=r['truth'],usual=r['baseline'],candidate=r['forecasts'][a]['forecast'],visit=r['label']['id']) for r in rs if r['forecasts'][a]['changed']],key=lambda r:abs(r['candidate']['eta']-r['truth']),reverse=True)[:10] for a in ARMS}
    # Delayed feed uses the SAME forecasts' evaluation rules and fixed prior.
    delayed=[]
    for r in read(OUT/'features-delay15.jsonl.gz'):
        if r['at']<TEST:continue
        label,reason=labels.label(r)
        if label:delayed.append(dict(r,forecasts={a:model.predict(r,a) for a in ARMS},label=label,truth=(label['arrival']-r['at'])/1000))
    result['delay15']={rid:summarize([r for r in delayed if r['route']==rid]) for rid in ROUTES}
    (OUT/'summary.json').write_text(json.dumps(result,indent=2))
    print(json.dumps(dict(training=result['training'],checks=checks,routes=result['routes'])))
if __name__=='__main__':main()
