"""Prespecified subgroup, missingness, physical-case and reproducibility audit."""
import collections
import datetime as dt
import gzip
import hashlib
import json
import math
from pathlib import Path
from evaluate import ARMS, HERE, OUT, Labels, metrics, read, TZ

rows=read(OUT/'primary-scored.jsonl.gz')
summary=json.loads((OUT/'summary.json').read_text())
pads={a:x['padSeconds'] for a,x in summary['calibration'].items()}
freeze=int(dt.datetime.fromisoformat('2026-09-21T17:47:50+00:00').timestamp()*1000)
labels=Labels()
extension=json.loads((HERE/'data/extension.json').read_text())
initial_end=extension['tables']['raw_positions']['previousMaxClock']
test=[r for r in rows if r['day']>'2026-09-16' and r['forecasts']['logged_production']['forecast']]
predicates={
    'division':lambda r:r['target']==48,
    'division_stopped':lambda r:r['target']==48 and r['episode']['outcome']=='stopped',
    'division_before17':lambda r:r['target']==48 and dt.datetime.fromtimestamp(r['at']/1000,TZ).hour<17,
    'division_strict_labels':lambda r:r['target']==48 and r['episode']['method']=='strict',
    'division_0917':lambda r:r['target']==48 and r['day']=='2026-09-17',
    'division_0918':lambda r:r['target']==48 and r['day']=='2026-09-18',
    'division_0921':lambda r:r['target']==48 and r['day']=='2026-09-21',
    'extension_newly_seen':lambda r:r['day']=='2026-09-21' and r['at']>initial_end,
    'extension_after_model_freeze':lambda r:r['day']=='2026-09-21' and r['at']>=freeze,
}
result={'subgroups':{},'cases':{},'departureRisks':{},'trainingSupport':{},'jumpCommonOrigins':{},'falseNow':{},'initialCaptureEnd':initial_end,'modelFrozenAt':freeze,'exploratorySensitivity':'The before17:00 subgroup was added after inspecting a closing-time regression; it is sensitivity only, with no refit or model selection. Primary results retain that regression.','futureInputRules':'Training completed beforeSep16, calibrationSep16. Predictor inputs come only from causal raw-position replay; finalized evaluation outcomes are used only by scorer.'}
for label,predicate in predicates.items():
    rs=[r for r in test if predicate(r)]
    result['subgroups'][label]={'logged_production':metrics(rs,'logged_production')}
    for arm in ARMS:result['subgroups'][label][arm]=metrics(rs,arm,True,pads)
for index in [9,12]:
    es=[e for e in labels.episodes if e['sourceIndex']==index and e['target']==48 and e['day']<'2026-09-16']
    long=[e for e in es if '13' in e['stages'] and e['stages']['13']['depart']-e['stages']['13']['arrive']>=300000]
    result['trainingSupport'][str(index)]={'paths':len(es),'dates':len(set(e['day'] for e in es)),'longCanalPaths':len(long),'longCanalSources':[e['sourceId'] for e in long]}
for arm in ARMS:
    risks=collections.defaultdict(list)
    common=collections.defaultdict(list)
    for r in test:
        p=r['forecasts'][arm];f=p['forecast'];b=r['forecasts']['logged_production']['forecast'];dep=r['episode']['departure']
        if f is None:continue
        if dep is not None and r['target']==48 and r['episode']['outcome']=='stopped':
            low=max(0,f['low']-(pads[arm] if p['supported'] else 0))
            excess=(r['at']+low*1000-dep)/1000
            if excess>0:risks[r['episode']['targetId']].append({'at':r['at'],'day':r['day'],'bus':r['bus'],'excessSec':excess,'baselineExcessSec':(r['at']+b['low']*1000-dep)/1000,'sourceId':r['episode']['sourceId']})
        common[(r['bus'],r['target'],r['episode']['targetId'])].append(r)
    result['departureRisks'][arm]=[max(v,key=lambda r:r['excessSec']) for v in risks.values()]
    deltas=[]
    for group in common.values():
        group.sort(key=lambda r:r['at'])
        for a,b in zip(group,group[1:]):
            elapsed=(b['at']-a['at'])/1000
            if not 0<elapsed<=30:continue
            deltas.append({k:elapsed+b['forecasts'][k]['forecast']['eta']-a['forecasts'][k]['forecast']['eta'] for k in [arm,'logged_production']})
    result['jumpCommonOrigins'][arm]={k:{'n':len(deltas),'upOver60':sum(r[k]>60 for r in deltas),'downOver60':sum(r[k]<-60 for r in deltas)} for k in [arm,'logged_production']}
    result['falseNow'][arm]={}
    for k in [arm,'logged_production']:
        eligible=[r for r in test if r['target']==48 and r['forecasts'][k]['forecast']]
        flagged=[r for r in eligible if r['forecasts'][k]['forecast']['eta']<=15 and r['truth']>120]
        result['falseNow'][arm][k]={'eligibleSnapshots':len(eligible),'flaggedSnapshots':len(flagged),'flaggedJourneys':len(set(r['episode']['targetId'] for r in flagged))}
for max_gap in (15,30):
    selected=[]
    for r in test:
        if r['target']!=48:continue
        origin=r['origins'].get('9')
        if not origin:continue
        quality=labels.raw_quality(r['day'],r['bus'],origin['departed'],r['episode']['end'])
        if quality['continuous'] and quality['maxGapSec']<=max_gap:selected.append(r)
    result['subgroups'][f'division_raw_gap_le{max_gap}']={'logged_production':metrics(selected,'logged_production'),**{a:metrics(selected,a,True,pads) for a in ARMS}}
case_ids=[68528,74774,81098,83605]
for target_id in case_ids:
    selected=[r for r in rows if r['episode']['targetId']==target_id and r['at']%60000==0]
    es=[e for e in labels.episodes if e['targetId']==target_id]
    if not es:continue
    e=min(es,key=lambda e:e['sourceIndex'])
    trace=[]
    previous=None;last=0
    for r in labels.rlookup[(e['day'],e['bus'])]:
        if not e['start']-30000<=r['collected_at']<=e['end']+30000:continue
        key=(r['lat'],r['lon'],r['last_stop_id'])
        if key!=previous or r['collected_at']-last>=60000:
            trace.append(r);previous=key;last=r['collected_at']
    result['cases'][str(target_id)]={'episode':e,'rawQuality':labels.raw_quality(e['day'],e['bus'],e['start'],e['end']),'rawTrace':trace,'timeline':[{'at':r['at'],'phase':r['phase'],'index':r['index'],'truth':r['truth'],'forecasts':r['forecasts']} for r in selected]}
(OUT/'audit.json').write_text(json.dumps(result,indent=2))
manifest={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in OUT.iterdir() if p.is_file() and p.name not in ('result-manifest.json','evaluation.log')}
(OUT/'result-manifest.json').write_text(json.dumps(manifest,indent=2))
print(json.dumps({'subgroups':result['subgroups'],'trainingSupport':result['trainingSupport']},indent=2))
