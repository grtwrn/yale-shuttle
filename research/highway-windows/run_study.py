"""Generate first, verify original controls, then score common policy cohorts."""
import collections
import gzip
import hashlib
import json
import math
from pathlib import Path
import sys
import policy as hp

rr,ev=hp.rr,hp.ev
canonical=hp.diag.study
HERE=Path(__file__).resolve().parent
OUT=HERE/'results'
RAW_HASH='3990d06ebdab596cfebdd7f03c528f7efcbb46fd3f6af68a9d64ede648e220b9'
PRED_HASH='5bcc9927337564067af7eabc6c667ff44eeb7c3cba05619cc57cb0a3cf5b12de'


def write(directory,name,rows):
    directory.mkdir(parents=True,exist_ok=True)
    with gzip.open(directory/(name+'.jsonl.gz'),'wt') as f:
        for row in rows:f.write(json.dumps(row,separators=(',',':'))+'\n')


def path_ids(model):
    return {cell:{(p['sourceId'],p['targetId'],p['start'],p['end']) for p in ps} for cell,ps in model.paths.items() if ps}


def fit(visits,raw,cutoff,policy,clause):
    ev.CUTOFF=cutoff
    admitted=[v for v in visits if rr.available(v,cutoff)]
    quality=hp.Quality([r for r in raw if r['collected_at']<cutoff],policy,clause,cutoff)
    model=canonical.Models(admitted,quality)
    for cell,paths in model.paths.items():
        if cell[0]==3:model.paths[cell]=[p for p in paths if p['duration']<=2700]
    assert all(p['end']<cutoff for ps in model.paths.values() for p in ps)
    return model,quality


def model_audit(model,quality,original):
    old_ids=path_ids(original);added=[];support=[]
    for cell,paths in model.paths.items():
        rid,k,w,ti=cell;prior=old_ids.get(cell,set())
        now={(p['sourceId'],p['targetId'],p['start'],p['end']) for p in paths}
        assert prior<=now
        if rid not in hp.TRANSFER:assert prior==now
        newly=[p for p in paths if (p['sourceId'],p['targetId'],p['start'],p['end']) not in prior]
        for p in newly:
            assert (p['bus'],rid,p['start'],p['end']) in quality.promoted
            added.append(dict(route=rid,k=k,wait=w,target=ti,**p))
        support.append(dict(route=rid,k=k,wait=w,target=ti,paths=len(paths),
            sources=len({p['sourceId'] for p in paths}),dates=sorted({p['day'] for p in paths}),
            addedPaths=len(newly),addedSources=len({p['sourceId'] for p in newly}),addedDates=sorted({p['day'] for p in newly})))
    return dict(quality=quality.audit(),support=support,addedPaths=len(added)),added


def generate():
    OUT.mkdir(exist_ok=True);canonical.configure()
    rawfile=ev.IN/'raw_positions.jsonl.gz';predfile=ev.IN/'predictions_log.jsonl.gz'
    assert hashlib.sha256(rawfile.read_bytes()).hexdigest()==RAW_HASH
    assert hashlib.sha256(predfile.read_bytes()).hexdigest()==PRED_HASH
    immutable={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in canonical.OUT.iterdir() if p.is_file() and p.name in
        ('features.jsonl.gz','training-visits.jsonl.gz','canonical-topology.json','preparation.json','unscored.jsonl.gz','forecasts.jsonl.gz')}
    rows=ev.read(canonical.OUT/'unscored.jsonl.gz');visits=ev.read(canonical.OUT/'training-visits.jsonl.gz');raw=ev.read(rawfile)
    old_labels={canonical.key(r):r['label'] for r in ev.read(canonical.OUT/'forecasts.jsonl.gz')}
    clause=hp.HighwayClause();clause.warm(raw)
    controls=dict(sourceCanonicalRun=35684356219,originalCandidateComparisons=0,originalLabelComparisons=0,
        unchangedOtherRoutePredictions=0,prefixChecks=[],immutable=immutable,
        planSha256=hashlib.sha256((HERE/'PLAN.md').read_bytes()).hexdigest(),policies=hp.POLICIES)
    training={policy:{} for policy in hp.POLICIES};generated={policy:[] for policy in hp.POLICIES}
    added_paths={policy:[] for policy in hp.POLICIES};quality_intervals={policy:[] for policy in hp.POLICIES}
    frozen={};frozen_quality={}
    for policy in hp.POLICIES:
        frozen[policy],frozen_quality[policy]=fit(visits,raw,canonical.FROZEN,policy,clause)
    for policy in hp.POLICIES:
        record,added=model_audit(frozen[policy],frozen_quality[policy],frozen['original22'])
        training[policy]['frozen']=record;added_paths[policy]+= [dict(mode='frozen',cutoff=canonical.FROZEN,**r) for r in added]
        quality_intervals[policy]+= [dict(mode='frozen',cutoff=canonical.FROZEN,bus=b,route=rid,start=start,end=end)
            for b,rid,start,end in sorted(frozen_quality[policy].promoted)]
    del frozen_quality
    # Fresh geometry caches and physically deleted future input must match.
    for cutoff in (canonical.FROZEN,max(rr.cutoff_for(ev.date(r['at'])) for r in rows)):
        prefix_raw=[r for r in raw if r['collected_at']<cutoff]
        prefix_visits=[v for v in visits if rr.available(v,cutoff)]
        fresh=hp.HighwayClause();fresh.warm(prefix_raw)
        for policy in hp.POLICIES:
            full,_=fit(visits,raw,cutoff,policy,clause)
            deleted,_=fit(prefix_visits,prefix_raw,cutoff,policy,fresh)
            assert dict(full.paths)==dict(deleted.paths)
            controls['prefixChecks'].append(dict(policy=policy,cutoff=cutoff,rawRows=len(prefix_raw),visits=len(prefix_visits),pathsIdentical=True))
            del full,deleted
        del fresh,prefix_raw,prefix_visits
    for day in sorted({ev.date(r['at']) for r in rows}):
        cutoff=rr.cutoff_for(day);models={};qualities={}
        for policy in hp.POLICIES:models[policy],qualities[policy]=fit(visits,raw,cutoff,policy,clause)
        for policy in hp.POLICIES:
            record,added=model_audit(models[policy],qualities[policy],models['original22'])
            training[policy][day]=record;added_paths[policy]+=[dict(mode='rolling',cutoff=cutoff,**r) for r in added]
            quality_intervals[policy]+=[dict(mode='rolling',cutoff=cutoff,bus=b,route=rid,start=start,end=end)
                for b,rid,start,end in sorted(qualities[policy].promoted)]
        for r in rows:
            if ev.date(r['at'])!=day:continue
            for policy in hp.POLICIES:
                candidates={};reasons={};evidence={}
                for mode,model in (('frozen',frozen[policy]),('rolling',models[policy])):
                    for k in ev.KS:
                        arm=f'{mode}_K{k}';result=model.predict(dict(r,baseline=r['deployed']),f'K{k}')
                        f=result['forecast']
                        if result['changed']:f={field:math.floor(v+.5) for field,v in f.items()}
                        else:assert f==r['deployed']
                        assert 0<=f['low']<=f['eta']<=f['high'] and all(math.isfinite(v) for v in f.values())
                        e={key:value for key,value in result.items() if key!='forecast'}
                        if policy=='original22' or r['route'] not in hp.TRANSFER:
                            assert f==r['candidates'][arm] and e==r['candidateEvidence'][arm] and result['reason']==r['candidateReasons'][arm]
                            controls['originalCandidateComparisons' if policy=='original22' else 'unchangedOtherRoutePredictions']+=1
                        candidates[arm]=f;reasons[arm]=result['reason'];evidence[arm]=e
                if cutoff==canonical.FROZEN:assert all(candidates[f'frozen_K{k}']==candidates[f'rolling_K{k}'] for k in ev.KS)
                generated[policy].append(dict(r,candidates=candidates,candidateReasons=reasons,candidateEvidence=evidence))
        del models,qualities
    # Every policy's forecasts are persisted before any new labels are attached.
    for policy in hp.POLICIES:
        write(OUT/policy,'unscored',generated[policy])
        write(OUT/policy,'added-training-paths',added_paths[policy])
        write(OUT/policy,'admitted-training-intervals',quality_intervals[policy])
    labels_by_policy={};outcome_counts={}
    for policy in hp.POLICIES:
        quality=hp.Quality(raw,policy,clause)
        outcomes=canonical.Outcomes(visits,quality);labelled=[];enriched=[];added=[];labels={};reasons=collections.defaultdict(collections.Counter)
        for r in generated[policy]:
            label,reason=outcomes.label(r);old=old_labels.get(canonical.key(r));key=canonical.key(r)
            if old is not None:assert label==old, 'original physical label excluded or changed'
            if policy=='original22':
                assert label==old;controls['originalLabelComparisons']+=1
            if r['route'] not in hp.TRANSFER:assert label==old
            row=dict(r,label=label,outcomeReason=reason,originalCohort=old is not None)
            if label:
                row['truth']=(label['arrival']-r['at'])/1000;labelled.append(row);labels[key]=label
                if old is None:
                    assert (r['bus'],r['route'],r['at'],label['departure']) in quality.promoted
                    added.append(dict(at=r['at'],bus=r['bus'],route=r['route'],target=r['target'],label=label,
                        originalOutcomeReason='GPS/provider disconnected through departure'))
            else:reasons[r['route']][reason]+=1
            enriched.append(row)
        labels_by_policy[policy]=labels;outcome_counts[policy]=dict(quality=quality.audit(),rejections=reasons,addedSnapshots=len(added),
            addedPhysicalVisits=len({(r['route'],r['label']['id']) for r in added}),
            entirelyNewPhysicalVisits=len({(r['route'],r['label']['id']) for r in added}-{(r['route'],r['label']['id']) for r in labelled if r['originalCohort']}))
        write(OUT/policy,'forecasts',labelled);write(OUT/policy,'enriched',enriched);write(OUT/policy,'added-labels',added)
        write(OUT/policy/'original-cohort','forecasts',[r for r in labelled if r['originalCohort']])
        write(OUT/policy,'admitted-outcome-intervals',[dict(bus=b,route=rid,start=start,end=end) for b,rid,start,end in sorted(quality.promoted)])
        for directory in (OUT/policy,OUT/policy/'original-cohort'):
            target=directory/'raw_positions.jsonl.gz'
            if not target.exists():target.symlink_to(rawfile.resolve())
        del quality,outcomes
    assert labels_by_policy['original22'].keys()<=labels_by_policy['highway25'].keys()<=labels_by_policy['highway50'].keys()
    for k,v in labels_by_policy['highway25'].items():assert labels_by_policy['highway50'][k]==v
    controls['labelNesting']=True
    assert immutable=={name:hashlib.sha256((canonical.OUT/name).read_bytes()).hexdigest() for name in immutable}
    assert hashlib.sha256(rawfile.read_bytes()).hexdigest()==RAW_HASH and hashlib.sha256(predfile.read_bytes()).hexdigest()==PRED_HASH
    (OUT/'verification.json').write_text(json.dumps(dict(controls=controls,training=training,outcomes=outcome_counts),indent=2))
    print(json.dumps(dict(verified=controls,availability={p:len(v) for p,v in labels_by_policy.items()})))


def metrics(rows):
    out={}
    for arm in rr.ARMS:
        changed=[r for r in rows if r['candidates'][arm]!=r['deployed']]
        out[arm]=dict(all=rr.paired(rows,arm),changed=rr.paired(changed,arm),ordering=rr.ordering(rows,arm))
    return out


def score():
    canonical.configure()
    verification=json.loads((OUT/'verification.json').read_text());assert verification['controls']['labelNesting']
    policies={p:ev.read(OUT/p/'forecasts.jsonl.gz') for p in hp.POLICIES}
    original_index={canonical.key(r):r for r in policies['original22']}
    result=dict(planSha256=verification['controls']['planSha256'],note='Reused development dates; primary and sensitivity are fixed, not selected by ETA gains',
        policies={},betweenPolicies={})
    for policy,rows in policies.items():
        enriched=ev.read(OUT/policy/'enriched.jsonl.gz');routes={}
        for rid in ev.ROUTES:
            rs=[r for r in rows if r['route']==rid];allrows=[r for r in enriched if r['route']==rid]
            original=[r for r in rs if r['originalCohort']];added=[r for r in rs if not r['originalCohort']]
            comparison={};refresh={}
            for arm in rr.ARMS:
                union=[r for r in original if r['candidates'][arm]!=original_index[canonical.key(r)]['candidates'][arm]]
                comparison[arm]=dict(policy=rr.metrics(union,arm),original22=rr.metrics([original_index[canonical.key(r)] for r in union],arm),deployed=rr.metrics(union,'deployed'))
            for k in ev.KS:
                a,b=f'frozen_K{k}',f'rolling_K{k}'
                union=[r for r in rs if r['candidates'][a]!=r['deployed'] or r['candidates'][b]!=r['deployed']]
                refresh[k]=dict(frozen=rr.metrics(union,a),rolling=rr.metrics(union,b),deployed=rr.metrics(union,'deployed'))
            routes[rid]=dict(name=ev.ROUTES[rid]['name'],generated=len(allrows),labelled=len(rs),physicalVisits=len({r['label']['id'] for r in rs}),
                originalSnapshots=len(original),addedSnapshots=len(added),all=metrics(rs),originalCohort=metrics(original),additions=metrics(added),
                versusOriginal22OnChangedUnion=comparison,refreshComparisons=refresh,
                generatedReasons={arm:dict(collections.Counter(r['candidateReasons'][arm] for r in allrows)) for arm in rr.ARMS},
                outcomeReasons=dict(collections.Counter(r['outcomeReason'] for r in allrows if not r['label'])),
                handoffs={arm:rr.handoffs(allrows,arm) for arm in rr.ARMS},
                days={day:metrics([r for r in rs if ev.date(r['at'])==day]) for day in sorted({ev.date(r['at']) for r in rs})},
                stops={ti:metrics([r for r in rs if r['targetIndex']==ti]) for ti in sorted({r['targetIndex'] for r in rs})})
        result['policies'][policy]=routes
    sensitivity={canonical.key(r):r for r in policies['highway50']}
    for rid in ev.ROUTES:
        primary=[r for r in policies['highway25'] if r['route']==rid]
        paired={}
        for arm in rr.ARMS:
            union=[r for r in primary if r['candidates'][arm]!=sensitivity[canonical.key(r)]['candidates'][arm]]
            paired[arm]=dict(highway25=rr.metrics(union,arm),highway50=rr.metrics([sensitivity[canonical.key(r)] for r in union],arm),deployed=rr.metrics(union,'deployed'))
        primarykeys={canonical.key(r) for r in primary}
        only=[r for r in policies['highway50'] if r['route']==rid and canonical.key(r) not in primarykeys]
        result['betweenPolicies'][rid]=dict(commonSnapshots=len(primary),commonChangedUnion=paired,sensitivityOnlySnapshots=len(only),sensitivityOnly=metrics(only))
    (OUT/'summary.json').write_text(json.dumps(result,indent=2))
    print(json.dumps(dict(scoredPolicies=list(policies),snapshots={p:len(v) for p,v in policies.items()})))


if __name__=='__main__':
    generate() if '--generate' in sys.argv else score()
