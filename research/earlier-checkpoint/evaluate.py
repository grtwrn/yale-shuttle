"""Frozen chronological experiment; predictions generated before outcome scoring.

The predictor accepts causal replay features and completed training journeys only.
Finalized evaluation stop records are confined to the separate label/scoring layer.
"""
import bisect
import collections
import datetime as dt
import gzip
import hashlib
import json
import math
import random
import statistics as st
from pathlib import Path
from zoneinfo import ZoneInfo

HERE = Path(__file__).resolve().parent
OUT = HERE / 'results'
TZ = ZoneInfo('America/New_York')
TRAIN_END = int(dt.datetime(2026,9,16,tzinfo=TZ).timestamp()*1000)
ARMS = ['current_suffix','fixed_mean','fixed_survival','fixed_progress','five_before_mean','five_before_progress','trailing_five_mean']

def read(path):
    op = gzip.open if str(path).endswith('.gz') else open
    with op(path,'rt') as f:
        return [json.loads(l) for l in f if l.strip()]

def write(name, rows):
    with gzip.open(OUT / (name+'.jsonl.gz'),'wt') as f:
        for row in rows:
            f.write(json.dumps(row,separators=(',',':'))+'\n')

def quantile(values,p,weights=None):
    if not values:
        return None
    if weights is None:
        x=sorted(values);i=(len(x)-1)*p
        return x[math.floor(i)]+(i%1)*(x[math.ceil(i)]-x[math.floor(i)])
    pairs=sorted(zip(values,weights));cut=p*sum(weights);acc=0
    for v,w in pairs:
        acc+=w
        if acc>=cut:return v
    return pairs[-1][0]

def clock(ms):
    t=dt.datetime.fromtimestamp(ms/1000,TZ)
    return t.hour*60+t.minute+t.second/60

class Labels:
    def __init__(self,source_indices=None):
        source_indices=set(range(4,13) if source_indices is None else source_indices)
        self.seq=json.loads((HERE/'data/topology.json').read_text())['route']['stops']
        self.visits=read(HERE/'data/stop_visits.jsonl.gz')
        self.legs=read(HERE/'data/legs.jsonl.gz')
        self.raw=read(HERE/'data/raw_positions.jsonl.gz')
        self.bybus=collections.defaultdict(list)
        self.vlookup=collections.defaultdict(list)
        self.llookup=collections.defaultdict(list)
        self.rlookup=collections.defaultdict(list)
        for v in self.visits:
            self.bybus[(v['day'],v['bus_name'])].append(v)
            for t in set([v['arrived_at']]+([v['departed_at']] if v['outcome']=='passed' else [])):
                if t is not None:self.vlookup[(v['bus_name'],v['stop_index'],t)].append(v)
        for rs in self.bybus.values():rs.sort(key=lambda v:(v['anchored_at'],v['id']))
        for l in self.legs:self.llookup[(l['bus_name'],l['from_index'],l['departed_at'])].append(l)
        for r in self.raw:self.rlookup[(r['day'],r['bus_name'])].append(r)
        for rs in self.rlookup.values():rs.sort(key=lambda r:r['collected_at'])
        self.rtimes={k:[r['collected_at'] for r in rs] for k,rs in self.rlookup.items()}
        self.audit=collections.Counter();self.episodes=[];self.by_origin=collections.defaultdict(list)
        self.raw_audits={}
        for s in self.visits:
            if not (s['stop_index'] in source_indices and s['departed_at'] is not None and s['arrived_at'] is not None and s['how']!='gap' and s['outcome'] in ('passed','stopped')):continue
            for target in (48,4):
                ep,reason=self.episode(s,target)
                self.audit[reason]+=1
                if ep:
                    self.episodes.append(ep)
                    self.by_origin[(s['day'],s['bus_name'],s['stop_index'],target)].append(ep)

    def strict(self,s,target):
        index=s['stop_index'];dep=s['departed_at'];ti=self.seq.index(target);path=[s]
        for _ in self.seq:
            ls=[l for l in self.llookup.get((s['bus_name'],index,dep),[]) if l['reached']==1]
            if len(ls)!=1:return None
            l=ls[0];rem=ti-index
            if not (0<l['hops']<=rem and l['to_index']-index==l['hops'] and l['arrived_at']>dep and l['to_stop_id']==self.seq[l['to_index']]):return None
            vs=[v for v in self.vlookup.get((s['bus_name'],l['to_index'],l['arrived_at']),[]) if s['anchored_at']<=v['anchored_at']<=l['arrived_at']]
            if len(vs)!=1:return None
            v=vs[0]
            if v['how']=='gap' or v['outcome'] not in ('passed','stopped') or v['arrived_at'] is None:return None
            path.append(v)
            if v['stop_id']==target:return path
            if v['departed_at'] is None or v['departed_at']<l['arrived_at']:return None
            index=v['stop_index'];dep=v['departed_at']
        return None

    def raw_quality(self,day,bus,start,end):
        key=(day,bus,start,end)
        if key in self.raw_audits:return self.raw_audits[key]
        rs=self.rlookup.get((day,bus),[]);ts=self.rtimes.get((day,bus),[])
        lo=max(0,bisect.bisect_right(ts,start)-1);hi=min(len(ts),bisect.bisect_left(ts,end)+1)
        sub=rs[lo:hi];times=[r['collected_at'] for r in sub]
        gap=max([b-a for a,b in zip(times,times[1:])],default=math.inf)
        speed=0
        for a,b in zip(sub,sub[1:]):
            secs=(b['collected_at']-a['collected_at'])/1000
            distance=math.hypot((b['lat']-a['lat'])*111195,(b['lon']-a['lon'])*111195*math.cos(math.radians(a['lat'])))
            if secs>0:speed=max(speed,distance/secs)
        ok=bool(times and times[0]<=start+10000 and times[-1]>=end-10000 and gap<=60000 and speed<=22)
        result={'continuous':ok,'n':len(sub),'maxGapSec':gap/1000 if math.isfinite(gap) else None,'maxSpeedMps':speed,'first':times[0] if times else None,'last':times[-1] if times else None,'providerIds':sorted(set(r['bus_id'] for r in sub))}
        self.raw_audits[key]=result
        return result

    def episode(self,s,target):
        ti=self.seq.index(target);rs=self.bybus[(s['day'],s['bus_name'])]
        candidates=[v for v in rs if v['stop_id']==target and v['arrived_at'] is not None and s['departed_at']<v['arrived_at']<=s['departed_at']+2700000]
        if not candidates:return None,'no target within45min/censored'
        v=min(candidates,key=lambda v:v['arrived_at'])
        if v['how']=='gap' or v['outcome'] not in ('passed','stopped') or v['closest_m'] is None or v['closest_m']>75:return None,'unresolved/distant target'
        path=self.strict(s,target);method='strict'
        if not path or path[-1]['id']!=v['id']:
            span=[a for a in rs if s['anchored_at']<=a['anchored_at']<=v['anchored_at']]
            if any(a['stop_index']<s['stop_index'] or a['stop_index']>ti or (a['id']!=s['id'] and a['stop_index']==s['stop_index']) for a in span):return None,'intervening loop/route occurrence'
            quality=self.raw_quality(s['day'],s['bus_name'],s['departed_at'],v['arrived_at'])
            if not quality['continuous']:return None,'disconnected labels and insufficient raw continuity'
            path=span;method='raw-continuous'
        stages={}
        for a in path:
            if a['arrived_at'] is None or a['departed_at'] is None or a['how']=='gap':continue
            k=str(a['stop_index']);old=stages.get(k)
            if old is None:stages[k]={'arrive':a['arrived_at'],'depart':a['departed_at'],'visits':[a['id']]}
            else:old.update(arrive=min(old['arrive'],a['arrived_at']),depart=max(old['depart'],a['departed_at']),visits=old['visits']+[a['id']])
        # Drive starts at the FINAL departure of the stage and ends at the next
        # actual forward encounter, preserving Winchester excursions in the path.
        for k,stage in stages.items():
            subsequent=[a['arrived_at'] for a in path if a['stop_index']==int(k)+1 and a['arrived_at'] is not None and a['arrived_at']>=stage['depart']]
            stage['driveEnd']=min(subsequent) if subsequent else None
        return {'day':s['day'],'bus':s['bus_name'],'sourceId':s['id'],'sourceIndex':s['stop_index'],'start':s['departed_at'],'target':target,'targetId':v['id'],'end':v['arrived_at'],'departure':v['departed_at'],'outcome':v['outcome'],'duration':(v['arrived_at']-s['departed_at'])/1000,'method':method,'stages':stages,'visitIds':[a['id'] for a in path]},method

    def match(self,row):
        origins=sorted(row['origins'].items(),key=lambda kv:kv[1]['departed'],reverse=True)
        for index,source in origins:
            candidates=self.by_origin.get((row['day'],row['bus'],int(index),row['target']),[])
            matches=[e for e in candidates if abs(e['start']-source['departed'])<=15000]
            if len(matches)==1:
                e=matches[0]
                if row['at']>=e['end']:return None,'target already arrived'
                return e,'matched'
        return None,'no unambiguous causal source/outcome match'

class Predictor:
    def __init__(self,episodes,cutoff=TRAIN_END):
        self.cutoff=cutoff
        self.paths=collections.defaultdict(list)
        for e in episodes:
            if e['end']<cutoff:
                self.paths[(e['sourceIndex'],e['target'])].append(e)
        assert all(e['end']<cutoff for rs in self.paths.values() for e in rs)

    @staticmethod
    def fallback(r,reason):
        b=r.get('baseline')
        if not b or not all(isinstance(b.get(k),(int,float)) and math.isfinite(b[k]) for k in ('eta','low','high')):return {'forecast':None,'supported':False,'reason':reason}
        return {'forecast':{k:max(0,b[k]) for k in ('eta','low','high')},'supported':False,'reason':reason}

    def predict(self,r,arm):
        assert r['asof']<=r['at']
        source_index=12 if arm.startswith('five_before') else 9
        if arm=='trailing_five_mean':
            source_index=r.get('nearestIndex',r['index'])-5
            if source_index>=13:source_index=12
        origin=r['origins'].get(str(source_index))
        if arm!='current_suffix' and origin is None:return self.fallback(r,'origin not yet confirmed')
        if origin:
            assert origin['knownAt']<=r['asof'] and origin['departed']<=r['asof']
        paths=self.paths.get((source_index,r['target']),[])
        if not paths:return self.fallback(r,'no historical paths')
        elapsed=(r['at']-origin['departed'])/1000 if origin else None
        prior_canal=r.get('canal')
        if prior_canal and origin and prior_canal['departed']<origin['departed']:prior_canal=None
        suffix=arm in ('current_suffix','fixed_progress','five_before_progress')
        values=[];weights=[];days=[]
        for e in paths:
            assert e['end']<self.cutoff<=r['at']
            if suffix:
                stage=e['stages'].get(str(r['index']))
                if not stage:continue
                if r['phase']=='hold':begin=stage['arrive'];finish=stage['depart']
                else:begin=stage['depart'];finish=stage['driveEnd']
                if finish is None or (finish-begin)/1000<=r['age']:continue
                value=(e['end']-begin)/1000-r['age']
                historical_clock=clock(begin+r['age']*1000)
                actual_clock=clock(r['at'])
            else:
                value=e['duration']-elapsed
                if arm=='fixed_survival' and value<=0:continue
                historical_clock=clock(e['start']);actual_clock=clock(origin['departed'])
            weight=math.exp(-0.5*((historical_clock-actual_clock)/120)**2)
            if arm in ('fixed_progress','five_before_progress'):
                historic_approach=(begin-e['start'])/1000
                current_approach=(r['began']-origin['departed'])/1000
                weight*=math.exp(-0.5*((historic_approach-current_approach)/180)**2)
                if prior_canal and prior_canal['knownAt']<=r['asof'] and r['index']>13:
                    canal=e['stages'].get('13')
                    if canal is None:continue
                    hist_duration=(canal['depart']-canal['arrive'])/1000
                    weight*=math.exp(-0.5*((hist_duration-prior_canal['stand'])/120)**2)
            if weight<1e-12:continue
            values.append(value);weights.append(weight);days.append(e['day'])
        total=sum(weights);effective=total*total/sum(w*w for w in weights) if weights else 0
        day_weights=collections.defaultdict(float)
        for day,w in zip(days,weights):day_weights[day]+=w
        supported_days=sum(v>=.05*total for v in day_weights.values())
        if effective<12 or supported_days<3:
            f=self.fallback(r,'insufficient historical support');f.update(effective=effective,n=len(values),days=supported_days);return f
        mean_arm=arm.endswith('_mean')
        eta=max(0,sum(v*w for v,w in zip(values,weights))/total if mean_arm else quantile(values,.5,weights))
        low=max(0,min(eta,quantile(values,.1,weights)));high=max(eta,quantile(values,.9,weights))
        assert all(math.isfinite(v) for v in (low,eta,high)) and 0<=low<=eta<=high
        return {'forecast':{'eta':eta,'low':low,'high':high},'supported':True,'n':len(values),'effective':effective,'days':supported_days,'originIndex':source_index}

def metrics(rows,arm,calibrated=False,pads=None):
    selected=[]
    for r in rows:
        p=r['forecasts'].get(arm)
        if p is None:continue
        f=p['forecast']
        if f is None:continue
        f=dict(f)
        if calibrated and p['supported'] and pads:
            f['low']=max(0,f['low']-pads.get(arm,0));f['high']+=pads.get(arm,0)
        y=r['truth'];error=f['eta']-y;width=f['high']-f['low']
        early=max(0,f['low']-y);late=max(0,y-f['high'])
        departure=r['episode'].get('departure')
        departure_over=max(0,(r['at']+f['low']*1000-departure)/1000) if departure is not None else None
        selected.append((r,{'mae':abs(error),'mse':error*error,'bias':error,'width':width,'coverage':int(early==0 and late==0),'earlyRate':int(early>0),'lateRate':int(late>0),'earlySeverity':early,'lateSeverity':late,'wis':(.5*abs(error)+.1*width+early+late)/1.5,'departureRisk':int(departure_over>0) if departure_over is not None else 0,'departureExcess':departure_over or 0}))
    if not selected:return {'n':0}
    groups=collections.defaultdict(list)
    for r,m in selected:groups[(r['target'],r['episode']['targetId'])].append(m)
    per=[{k:st.mean(m[k] for m in group) for k in group[0]} for group in groups.values()]
    result={k:st.mean(m[k] for m in per) for k in per[0]}
    result['rmse']=math.sqrt(result.pop('mse'))
    result.update(n=len(selected),journeys=len(groups),days=len(set(r['day'] for r,_ in selected)),earlyJourneys=len(set(r['episode']['targetId'] for r,m in selected if m['earlyRate'])),lateJourneys=len(set(r['episode']['targetId'] for r,m in selected if m['lateRate'])),departureRiskJourneys=len(set(r['episode']['targetId'] for r,m in selected if m['departureRisk'])),maxEarlySec=max(m['earlySeverity'] for _,m in selected),maxLateSec=max(m['lateSeverity'] for _,m in selected),maxDepartureExcess=max(m['departureExcess'] for _,m in selected),p90AbsSnapshotSec=quantile([m['mae'] for _,m in selected],.9))
    return result

def bootstrap(rows,arm,pads,calibrated=True):
    byjourney=collections.defaultdict(list)
    for r in rows:byjourney[(r['target'],r['episode']['targetId'])].append(r)
    diffs=[]
    for rs in byjourney.values():
        a=metrics(rs,arm,calibrated,pads);b=metrics(rs,'logged_production')
        if a['n'] and b['n']:diffs.append({'day':rs[0]['day'],**{k:a[k]-b[k] for k in ('mae','width','wis','earlyRate','coverage')}})
    if not diffs:return {}
    rng=random.Random(210926);result={}
    for key in ('mae','width','wis','earlyRate','coverage'):
        samples=[st.mean(rng.choice(diffs)[key] for _ in diffs) for _ in range(600)]
        daymeans=[st.mean(d[key] for d in diffs if d['day']==day) for day in sorted(set(d['day'] for d in diffs))]
        result[key]={'mean':st.mean(d[key] for d in diffs),'journeyBootstrap90':[quantile(samples,.05),quantile(samples,.95)],'dayMeans':daymeans,'leaveOneDayOut':[st.mean(d[key] for d in diffs if d['day']!=day) for day in sorted(set(d['day'] for d in diffs))] if len(daymeans)>1 else []}
    return result

def evaluate(features,predictor,labels,name):
    # Freeze every numeric forecast without consulting the evaluation labels.
    generated=[]
    for r in features:
        forecasts={a:predictor.predict(r,a) for a in ARMS}
        forecasts['logged_production']=Predictor.fallback(r,'actual logged production')
        generated.append({**r,'forecasts':forecasts})
    write(name+'-predictions',generated)
    scored=[];unmatched=collections.Counter()
    for r in generated:
        e,reason=labels.match(r)
        if e is None:unmatched[reason]+=1;continue
        scored.append({**r,'episode':{k:e[k] for k in ('sourceId','targetId','end','departure','outcome','method')},'truth':(e['end']-r['at'])/1000})
    write(name+'-scored',scored)
    return generated,scored,dict(unmatched)

def main():
    OUT.mkdir(exist_ok=True)
    labels=Labels();predictor=Predictor(labels.episodes)
    (OUT/'label-audit.json').write_text(json.dumps({'counts':dict(labels.audit),'trainingByOriginTarget':{str(k):len(v) for k,v in predictor.paths.items()},'episodes':labels.episodes},indent=2))
    features=read(OUT/'features.jsonl.gz')
    generated,scored,unmatched=evaluate(features,predictor,labels,'primary')
    calibration=[r for r in scored if r['day']=='2026-09-16' and r['dense']]
    pads={};calibration_audit={}
    for arm in ARMS:
        rs=[r for r in calibration if r['forecasts'][arm]['supported']]
        counts=collections.Counter((r['target'],r['episode']['targetId']) for r in rs)
        values=[max(r['forecasts'][arm]['forecast']['low']-r['truth'],r['truth']-r['forecasts'][arm]['forecast']['high'],0) for r in rs]
        weights=[1/counts[(r['target'],r['episode']['targetId'])] for r in rs]
        pads[arm]=quantile(values,.8,weights) if values else 0
        calibration_audit[arm]={'padSeconds':pads[arm],'snapshots':len(rs),'journeys':len(counts)}
    (OUT/'frozen-calibration.json').write_text(json.dumps({'trainBefore':TRAIN_END,'calibrationDay':'2026-09-16','arms':calibration_audit,'noModelSelection':True},indent=2))
    # Independent future-data deletion invariant: predictor never gets evaluation
    # outcomes; modifying unused future episodes cannot change any forecast.
    check=Predictor([e for e in labels.episodes if e['end']<TRAIN_END])
    for r in features[::71]:
        for arm in ARMS:assert check.predict(r,arm)==predictor.predict(r,arm)
    test=[r for r in scored if r['day']>'2026-09-16']
    summary={'labelCounts':dict(labels.audit),'featureCount':len(features),'scored':len(scored),'unmatched':unmatched,'calibration':calibration_audit,'pairs':{},'dense':{},'strata':{},'support':{},'jumps':{},'tests':{'futureTrainingDeletionInvariant':True,'orderedForecasts':True,'noOutcomeInput':True}}
    regressions=[]
    for arm in ARMS:
        paired=[r for r in test if r['forecasts']['logged_production']['forecast'] and r['forecasts'][arm]['forecast']]
        supported=[r for r in paired if r['forecasts'][arm]['supported']]
        summary['support'][arm]={'allTestFeatures':len([r for r in generated if r['day']>'2026-09-16']),'supportedFeatures':sum(r['forecasts'][arm]['supported'] for r in generated if r['day']>'2026-09-16'),'paired':len(paired),'supportedPaired':len(supported),'fallbackReasons':dict(collections.Counter(r['forecasts'][arm].get('reason','supported') for r in generated if r['day']>'2026-09-16'))}
        for label,rs in [('all',paired),('supported',supported)]:
            summary['pairs'][arm+'/'+label]={'production':metrics(rs,'logged_production'),'raw':metrics(rs,arm),'calibrated':metrics(rs,arm,True,pads),'deltaBootstrap':bootstrap(rs,arm,pads)}
        for day in sorted(set(r['day'] for r in test)):
            rs=[r for r in paired if r['day']==day]
            summary['pairs'][arm+'/'+day]={'production':metrics(rs,'logged_production'),'raw':metrics(rs,arm),'calibrated':metrics(rs,arm,True,pads)}
        dense=[r for r in test if r['dense'] and r['forecasts'][arm]['supported']]
        summary['dense'][arm]={'raw':metrics(dense,arm),'calibrated':metrics(dense,arm,True,pads)}
        strata={}
        predicates={'division':lambda r:r['target']==48,'prospect_south':lambda r:r['target']==4,'canal_hold':lambda r:r['index']==13 and r['phase']=='hold','winchester_hold':lambda r:r['index']==14 and r['phase']=='hold','moving':lambda r:r['phase']=='drive','after_long_canal':lambda r:r.get('canal') and r['canal']['stand']>=300 and r['index']>13,'current_canal_over5':lambda r:r['index']==13 and r['phase']=='hold' and r['age']>=300,'point_under3':lambda r:r['baseline']['eta']<=180,'point_3to8':lambda r:180<r['baseline']['eta']<=480,'point_over8':lambda r:r['baseline']['eta']>480,'stopped_target':lambda r:r['episode']['outcome']=='stopped'}
        for label,fn in predicates.items():
            rs=[r for r in paired if fn(r)]
            strata[label]={'production':metrics(rs,'logged_production'),'raw':metrics(rs,arm),'calibrated':metrics(rs,arm,True,pads)}
        summary['strata'][arm]=strata
        for r in supported:
            f=r['forecasts'][arm]['forecast'];b=r['forecasts']['logged_production']['forecast']
            low=max(0,f['low']-pads[arm])
            regressions.append({'arm':arm,'day':r['day'],'bus':r['bus'],'at':r['at'],'target':r['target'],'targetId':r['episode']['targetId'],'sourceId':r['episode']['sourceId'],'index':r['index'],'phase':r['phase'],'truth':r['truth'],'candidate':f,'calibratedLow':low,'baseline':b,'maeRegression':abs(f['eta']-r['truth'])-abs(b['eta']-r['truth']),'earlyExcess':max(0,low-r['truth']),'labelMethod':r['episode']['method']})
        groups=collections.defaultdict(list)
        for r in test:
            if r['dense'] and r['forecasts'][arm]['forecast']:groups[(r['bus'],r['target'],r['episode']['targetId'])].append(r)
        changes=[]
        for rs in groups.values():
            rs.sort(key=lambda r:r['at'])
            for a,b in zip(rs,rs[1:]):
                if b['at']-a['at']!=30000:continue
                changes.append({'at':b['at'],'bus':b['bus'],'target':b['target'],'targetId':b['episode']['targetId'],'delta':30+b['forecasts'][arm]['forecast']['eta']-a['forecasts'][arm]['forecast']['eta'],'supportTransition':a['forecasts'][arm]['supported']!=b['forecasts'][arm]['supported']})
        summary['jumps'][arm]={'adjacent30sPairs':len(changes),'upOver60':sum(c['delta']>60 for c in changes),'downOver60':sum(c['delta']<-60 for c in changes),'supportTransitions':sum(c['supportTransition'] for c in changes),'largest':sorted(changes,key=lambda c:abs(c['delta']),reverse=True)[:10]}
    # Prespecified delayed-input sensitivity uses the same training and calibration.
    _,delay_rows,delay_unmatched=evaluate(read(OUT/'features-delay15.jsonl.gz'),predictor,labels,'delay15')
    summary['delay15']={'unmatched':delay_unmatched,'arms':{}}
    for arm in ARMS:
        rs=[r for r in delay_rows if r['day']>'2026-09-16' and r['forecasts']['logged_production']['forecast'] and r['forecasts'][arm]['forecast']]
        summary['delay15']['arms'][arm]={'production':metrics(rs,'logged_production'),'raw':metrics(rs,arm),'calibrated':metrics(rs,arm,True,pads)}
    (OUT/'summary.json').write_text(json.dumps(summary,indent=2))
    worst={'mae':sorted(regressions,key=lambda r:r['maeRegression'],reverse=True)[:40],'early':sorted(regressions,key=lambda r:r['earlyExcess'],reverse=True)[:40]}
    for category in worst.values():
        for r in category:
            e=next(e for e in labels.episodes if e['sourceId']==r['sourceId'] and e['target']==r['target'])
            r['rawAudit']=labels.raw_quality(e['day'],e['bus'],e['start'],e['end'])
    (OUT/'regressions.json').write_text(json.dumps(worst,indent=2))
    print(json.dumps({'features':len(features),'scored':len(scored),'unmatched':unmatched,'calibration':calibration_audit,'results':{a:summary['pairs'][a+'/all'] for a in ARMS}},indent=2))

if __name__=='__main__':main()
