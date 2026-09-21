"""Destination generalization and discontinuity audit on Red's downstream arc."""
import collections
import gzip
import hashlib
import json
import statistics
from evaluate import HERE, OUT, TRAIN_END, Predictor, metrics, read
from followup import FollowupLabels, FollowupPredictor, TARGET_INDEX, adjusted, calibration_pad
from hybrid import release_gate

DIR=OUT/'multistop'
BASES=['wait_minus5_departure_mean','wait_minus10_departure_mean','trailing_ten_mean','ten_before_pickup_mean']
ARMS=[base+'/'+mode for base in BASES for mode in ['no_switch','after_344']]
TOPOLOGY=json.loads((HERE/'data/topology.json').read_text())
TARGETS=TOPOLOGY['route']['stops'][15:]
NAMES={s['id']:s['name'] for s in TOPOLOGY['stops']}


def save(name,rows):
    with gzip.open(DIR/(name+'.jsonl.gz'),'wt') as stream:
        for row in rows:stream.write(json.dumps(row,separators=(',',':'))+'\n')


def forecasts(row,model):
    production=Predictor.fallback(row,'actual logged production')
    event=release_gate(row)
    output={'logged_production':production}
    for base in BASES:
        original=dict(model.predict(row,base),switched=False)
        output[base+'/no_switch']=original
        output[base+'/after_344']=(dict(production,switched=True,release=event,
            reason='confirmed wait departure: production') if event else original)
    return output


def availability(rows,arm):
    counts=collections.Counter()
    for row in rows:
        p=row['forecasts'][arm]
        counts['features']+=1
        counts['supported']+=bool(p['supported'])
        counts['switched']+=bool(p.get('switched'))
        counts['hasForecast']+=p['forecast'] is not None
        if p['forecast'] is None:counts[p.get('reason','unknown')]+=1
    return dict(counts)


def choice_pair(a,b,arm):
    # Require a single forward physical approach for incremental-travel labels.
    if a['episode']['sourceId']!=b['episode']['sourceId'] or b['truth']<a['truth']:
        return None
    p,q=a['forecasts'][arm],b['forecasts'][arm]
    result={'at':a['at'],'day':a['day'],'bus':a['bus'],'targetA':a['target'],'targetB':b['target'],
            'visitA':a['episode']['targetId'],'visitB':b['episode']['targetId'],
            'actualIncrement':b['truth']-a['truth'],'supportA':p['supported'],'supportB':q['supported'],
            'supportChange':p['supported']!=q['supported'],'switchActive':bool(p.get('switched')),
            'forecastA':p['forecast'],'forecastB':q['forecast']}
    if p['forecast'] and q['forecast']:
        result['predictedIncrement']=q['forecast']['eta']-p['forecast']['eta']
        result['incrementError']=result['predictedIncrement']-result['actualIncrement']
    return result


def summarize_choices(records):
    numeric=[r for r in records if 'incrementError' in r]
    return {'pairs':len(records),'physicalVisitPairs':len({(r['visitA'],r['visitB']) for r in records}),
            'supportChanges':sum(r['supportChange'] for r in records),'numericPairs':len(numeric),
            'meanAbsIncrementError':statistics.mean(abs(r['incrementError']) for r in numeric) if numeric else None,
            'reversalsOver30':sum(r['predictedIncrement']<-30 for r in numeric),
            'incrementErrorsOver180':sum(abs(r['incrementError'])>180 for r in numeric),
            'largestErrors':sorted(numeric,key=lambda r:abs(r['incrementError']),reverse=True)[:6],
            'supportChangeExamples':[r for r in records if r['supportChange']][:4]}


def main():
    labels=FollowupLabels(source_indices=range(28),target_ids=TARGETS)
    model=FollowupPredictor(labels.episodes,max_index=27)
    features=read(DIR/'features.jsonl.gz')
    generated=[dict(r,forecasts=forecasts(r,model)) for r in features]
    save('predictions',generated)
    scored=[];unmatched=collections.Counter()
    for r in generated:
        episode,reason=labels.match(r)
        if episode is None:unmatched[reason]+=1;continue
        scored.append(dict(r,episode={k:episode[k] for k in ['sourceId','targetId','end','departure','outcome','method']},truth=(episode['end']-r['at'])/1000))
    save('scored',scored)
    calibration=[r for r in scored if r['day']=='2026-09-16' and r['dense']]
    pads={};calibration_audit={}
    for probability in [.8,.9]:
        key=str(int(probability*100))
        calibration_audit[key]={base:calibration_pad(calibration,base+'/no_switch',probability) for base in BASES}
        pads[key]={base+'/'+mode:calibration_audit[key][base]['seconds'] for base in BASES for mode in ['no_switch','after_344']}
    test=[r for r in scored if r['day']>'2026-09-16']
    versions={key:adjusted(test,value) for key,value in pads.items()}
    paired=[r for r in versions['80'] if r['forecasts']['logged_production']['forecast']]
    result={'plan':'MULTISTOP-PLAN.md','calibration':calibration_audit,'featureCount':len(features),
            'scored':len(scored),'unmatched':dict(unmatched),'labelCounts':dict(labels.audit),
            'targets':{},'pairedAllTargets':{},'choiceBoundaries':{},'movingBoundaries':{},'tests':{}}
    for target in TARGETS:
        rs=[r for r in paired if r['target']==target]
        candidate_only=[r for r in versions['80'] if r['target']==target and r['dense']]
        target_result={'index':TARGET_INDEX[target],'name':NAMES[target],
            'loggedSnapshots':len(rs),'loggedJourneys':len({r['episode']['targetId'] for r in rs}),
            'loggedDates':sorted({r['day'] for r in rs}),'paired':{},'denseSupportedOnly':{},'availability':{}}
        for arm in ['logged_production']+ARMS:
            target_result['paired'][arm]={key:metrics([r for r in rows if r['target']==target and r['forecasts']['logged_production']['forecast']],arm) for key,rows in versions.items()}
            target_result['denseSupportedOnly'][arm]=metrics([r for r in candidate_only if r['forecasts'][arm]['supported']],arm)
            target_result['availability'][arm]=availability([r for r in generated if r['day']>'2026-09-16' and r['target']==target],arm)
        result['targets'][str(target)]=target_result
    result['pairedAllTargets']={arm:metrics(paired,arm) for arm in ['logged_production']+ARMS}
    result['pairedOtherTargets']={arm:metrics([r for r in paired if r['target'] not in [48,4]],arm) for arm in ['logged_production']+ARMS}
    result['strictPaired']={arm:metrics([r for r in paired if r['episode']['method']=='strict'],arm) for arm in ['logged_production']+ARMS}
    prefix=FollowupPredictor([e for e in labels.episodes if e['end']<TRAIN_END],max_index=27)
    for r in features[::311]:assert forecasts(r,prefix)==forecasts(r,model)
    result['tests']['futureTrainingDeletionInvariant']=True
    for rows in versions.values():
        for r in rows:
            for arm in ARMS:
                p=r['forecasts'][arm]
                if p.get('switched'):assert p['forecast']==r['forecasts']['logged_production']['forecast']
    result['tests']['exactProductionAfterSwitch']=True

    byclock=collections.defaultdict(dict)
    for r in versions['80']:
        if r['dense']:byclock[r['day'],r['bus'],r['at']][TARGET_INDEX[r['target']]]=r
    for arm in ['logged_production']+ARMS:
        all_pairs=[];boundary_pairs=[];paired_boundary=[]
        for rows in byclock.values():
            for index,a in rows.items():
                b=rows.get(index+1)
                if not b:continue
                pair=choice_pair(a,b,arm)
                if pair is None:continue
                all_pairs.append(pair)
                if index in [23,24]:
                    boundary_pairs.append(pair)
                    if a['forecasts']['logged_production']['forecast'] and b['forecasts']['logged_production']['forecast']:
                        paired_boundary.append(pair)
        result['choiceBoundaries'][arm]={'allAdjacent':summarize_choices(all_pairs),
            'cutoffPairs23_24_and24_25':summarize_choices(boundary_pairs),
            'loggedProductionCommonCutoffPairs':summarize_choices(paired_boundary)}

    byvisit=collections.defaultdict(list)
    for r in versions['80']:
        if r['dense']:byvisit[r['day'],r['bus'],r['target'],r['episode']['targetId']].append(r)
    crossings=[]
    for rows in byvisit.values():
        rows.sort(key=lambda r:r['at'])
        for a,b in zip(rows,rows[1:]):
            if b['at']-a['at']!=30000:continue
            old=a['nearestIndex']-10;new=b['nearestIndex']-10
            if not (old<14<=new or old<=14<new):continue
            rec={'day':b['day'],'bus':b['bus'],'at':b['at'],'target':b['target'],
                'targetId':b['episode']['targetId'],'oldOrigin':old,'newOrigin':new,
                'releaseActiveBefore':release_gate(a) is not None,'releaseActiveAfter':release_gate(b) is not None,
                'actualRemaining':b['truth'],'arms':{}}
            for arm in ['logged_production']+ARMS:
                p,q=a['forecasts'][arm],b['forecasts'][arm]
                rec['arms'][arm]={'supportedBefore':p['supported'],'supportedAfter':q['supported'],
                    'before':p['forecast'],'after':q['forecast'],
                    'jump':30+q['forecast']['eta']-p['forecast']['eta'] if p['forecast'] and q['forecast'] else None}
            crossings.append(rec)
    for arm in ['logged_production']+ARMS:
        numeric=[r for r in crossings if r['arms'][arm]['jump'] is not None]
        result['movingBoundaries'][arm]={'crossings':len(crossings),'numericComparisons':len(numeric),
            'releaseAlreadyActive':sum(r['releaseActiveBefore'] for r in crossings),
            'upJumpsOver60':sum(r['arms'][arm]['jump']>60 for r in numeric),
            'downJumpsOver60':sum(r['arms'][arm]['jump']<-60 for r in numeric),
            'largest':sorted(numeric,key=lambda r:abs(r['arms'][arm]['jump']),reverse=True)[:6]}
    result['movingBoundaryEvents']=crossings
    (DIR/'summary.json').write_text(json.dumps(result,indent=2))
    manifest={str(p.relative_to(OUT)):hashlib.sha256(p.read_bytes()).hexdigest() for p in OUT.rglob('*')
              if p.is_file() and p.name!='result-manifest.json' and p.suffix!='.log'}
    (OUT/'result-manifest.json').write_text(json.dumps(manifest,indent=2))
    print(json.dumps({'targets':{k:{n:v[n] for n in ['name','loggedSnapshots','loggedJourneys','loggedDates']} for k,v in result['targets'].items()},'tests':result['tests']},indent=2))


if __name__=='__main__':main()
