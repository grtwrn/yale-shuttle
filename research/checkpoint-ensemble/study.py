"""Hosted fixed ensemble study: causal fits first, immutable outcome join last."""
import argparse
import collections
import copy
import gzip
import hashlib
import json
import math
from pathlib import Path
import sys
from models import Paths,group_prediction,joint_forecast,date,available
from identity_quality import IdentityQuality

HERE=Path(__file__).resolve().parent;OUT=HERE/'results';REFERENCE=HERE/'reference'
sys.path.insert(0,str(HERE.parent/'highway-windows'))
import run_study as hw
hp,canonical,rr,ev=hw.hp,hw.canonical,hw.rr,hw.ev
MODES=('frozen','rolling');KS=(5,10);REGIMES=('primary','extended');ESTIMATORS=('ensemble','single')
BASES=tuple(f'{mode}_K{k}_{regime}' for mode in MODES for k in KS for regime in REGIMES)
OLD_ARMS=tuple(f'original_{mode}_K{k}' for mode in MODES for k in KS)
ARMS=OLD_ARMS+tuple(f'{b}_{e}_joint_{p}' for b in BASES for e in ESTIMATORS for p in ('raw','protected'))
POINT_ARMS=tuple(f'{b}_{e}' for b in BASES for e in ESTIMATORS)
def key(r):return r['at'],r['bus'],r['route'],r['target']
def stream(path):
    with gzip.open(path,'rt') as f:
        for line in f:
            if line.strip():yield json.loads(line)
def read(path):return list(stream(path))
def write(path,rows):
    path.parent.mkdir(parents=True,exist_ok=True)
    with gzip.open(path,'wt') as f:
        for row in rows:f.write(json.dumps(row,separators=(',',':'),allow_nan=False)+'\n')
def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def digest_paths(m):return hashlib.sha256(json.dumps(sorted(m.paths.items()),sort_keys=True,separators=(',',':')).encode()).hexdigest()
def clone(m):
    c=copy.copy(m);c.fit_cache={};c.vector_cache={};return c
def signature(v):return json.dumps([v['bus_name'],v['route_id'],v['stop_index'],v['departed_at'],v['known_at'],v['bus_id']],separators=(',',':'),ensure_ascii=False)
def occurrence_proofs(visits,sources):
    out={};reasons=collections.Counter()
    for v in visits:
        source=sources.get(signature(v));p=(source or {}).get('occurrenceProof')
        if p and p['supported']:
            assert p['observedAt']<=v['known_at']
            out[v['id']]=dict(epoch=p['occurrenceEpoch'],progress=p['progress'],proof=p)
        else:reasons[(p or {}).get('reason','no exact causal emitted-source match')]+=1
    return out,dict(reasons)
def fit(top,waits,visits,raw,cutoff,policy,clause,occurrences):
    pr=[r for r in raw if r['collected_at']<cutoff]
    q=IdentityQuality(hp.Quality(pr,policy,clause,cutoff),pr,cutoff)
    model=Paths(top,waits,visits,q,cutoff,occurrences)
    return model,dict(cutoff=cutoff,paths=sum(map(len,model.paths.values())),audit=dict(model.audit),identity=q.audit(),pathHash=digest_paths(model))
def slim_result(g,row):
    out={k:v for k,v in g.items() if k!='targets'}
    if g['supported']:
        t=g['targets'][row['targetIndex']]
        out.update(pointAbs=t['pointAbs'],singleAbs=t['singleAbs'],components=t['components'],componentSupport=t['support'],
            joint={k:v for k,v in t['joint'].items() if k!='vectorIds'})
    return out

def generate(policy):
    canonical.configure();directory=OUT/policy;directory.mkdir(parents=True,exist_ok=True)
    material=json.loads((OUT/'materialization-audit.json').read_text())
    assert material['exactOriginalFeatures']==44763 and material['experimentalFullPollFeatureDifferences']==0 and len(material['prefixChecks'])==3
    features={key(r):r for r in stream(OUT/'features.jsonl.gz') if r['at']>=ev.TEST}
    sources={r['id']:r for r in stream(OUT/'physical-sources.jsonl.gz')}
    prior=read(REFERENCE/policy/'unscored.jsonl.gz');assert set(features)=={key(r) for r in prior}
    assert all('2026-09-17'<=date(r['at'])<='2026-09-20' for r in prior)
    immutable={str(p):sha(p) for p in (ev.IN/'raw_positions.jsonl.gz',ev.IN/'predictions_log.jsonl.gz',canonical.OUT/'training-visits.jsonl.gz',canonical.OUT/'preparation.json',REFERENCE/policy/'unscored.jsonl.gz',REFERENCE/policy/'enriched.jsonl.gz')}
    raw=read(ev.IN/'raw_positions.jsonl.gz');visits=read(canonical.OUT/'training-visits.jsonl.gz')
    occurrences,unproven=occurrence_proofs(visits,sources)
    assert occurrences,'No causal raw-phase occurrence proof is available; do not fit modulo-only paths'
    top=ev.ROUTES;waits=ev.WAITS;clause=hp.HighwayClause();clause.warm(raw)
    audit=dict(policy=policy,planSha256=sha(HERE/'PLAN.md'),materialization=material,immutable=immutable,
        strictOccurrenceVisits=len(occurrences),unprovenOccurrenceReasons=unproven,training={},prefixChecks=[],exactOldSingleControls=0,exactDeployedFallback=0,labelsExact=0)
    frozen,audit['training']['frozen']=fit(top,waits,visits,raw,canonical.FROZEN,policy,clause,occurrences)
    old_frozen,_=hw.fit(visits,raw,canonical.FROZEN,policy,clause)
    for cutoff in (canonical.FROZEN,max(rr.cutoff_for(date(r['at'])) for r in prior)):
        pr=[r for r in raw if r['collected_at']<cutoff];pv=[v for v in visits if available(v,cutoff)];fresh=hp.HighwayClause();fresh.warm(pr)
        a,_=fit(top,waits,visits,raw,cutoff,policy,clause,occurrences)
        po={v['id']:occurrences[v['id']] for v in pv if v['id'] in occurrences}
        b,_=fit(top,waits,pv,pr,cutoff,policy,fresh,po)
        assert dict(a.paths)==dict(b.paths)
        audit['prefixChecks'].append(dict(cutoff=cutoff,exact=True,paths=sum(map(len,a.paths.values()))));del a,b,pr,pv,fresh
    generated=[];expired=set()
    def save_model(model,mode,day):
        write(directory/f'training-paths-{mode}-{day}.jsonl.gz',
            (dict(mode=mode,day=day,cutoff=model.cutoff,cell=cell,**p) for cell,paths in model.paths.items() for p in paths))
        write(directory/f'vector-queries-{mode}-{day}.jsonl.gz',
            (dict(mode=mode,day=day,cutoff=model.cutoff,query=query,**info) for query,info in model.vector_cache.items()))
    for day in sorted({date(r['at']) for r in prior}):
        cutoff=rr.cutoff_for(day);rolling,audit['training'][day]=fit(top,waits,visits,raw,cutoff,policy,clause,occurrences)
        old_rolling,_=hw.fit(visits,raw,cutoff,policy,clause)
        for original in prior:
            if date(original['at'])!=day:continue
            f=features[key(original)]
            row={k:v for k,v in original.items() if k not in ('candidates','candidateReasons','candidateEvidence','rawCandidates','rawCandidateReasons','rawCandidateEvidence')}
            row.update(candidates={},candidateReasons={},candidateEvidence={},pointCandidates={},pointDiagnostics={})
            for mode,model,old in (('frozen',frozen,old_frozen),('rolling',rolling,old_rolling)):
                for k in KS:
                    oldarm=f'{mode}_K{k}';arm='original_'+oldarm
                    control=old.predict(dict(original,baseline=original['deployed']),f'K{k}')
                    cf={name:math.floor(v+.5) for name,v in control['forecast'].items()} if control['changed'] else control['forecast']
                    assert cf==original['rawCandidates'][oldarm]
                    assert {k:v for k,v in control.items() if k!='forecast'}==original['rawCandidateEvidence'][oldarm]
                    audit['exactOldSingleControls']+=1
                    row['candidates'][arm]=cf;row['candidateReasons'][arm]=control['reason'];row['candidateEvidence'][arm]={name:v for name,v in control.items() if name!='forecast'}
                    for regime in REGIMES:
                        base=f'{mode}_K{k}_{regime}';m=f['ensemble'][f'K{k}_{regime}']
                        expiry=(mode,k,m.get('journey'))
                        g=dict(supported=False,reason='whole-group countdown previously expired') if m.get('journey') and expiry in expired else group_prediction(model,f,m,sources)
                        if g['reason']=='whole-group component countdown expired':expired.add(expiry)
                        row['pointDiagnostics'][base]=slim_result(g,f)
                        for estimator in ESTIMATORS:
                            pbase=f'{base}_{estimator}'
                            proposed=(g['targets'][f['targetIndex']]['pointAbs' if estimator=='ensemble' else 'singleAbs']-row['at']/1000) if g['supported'] else row['deployed']['eta']
                            point=math.floor(max(0,proposed)+.5)
                            row['pointCandidates'][pbase]=dict(eta=point,low=row['deployed']['low'],high=row['deployed']['high'])
                            for protection in ('raw','protected'):
                                arm=f'{pbase}_joint_{protection}';ok=g['supported'] and g.get('jointSupported',False)
                                value=joint_forecast(g,dict(f,deployed=row['deployed']),estimator,protection=='protected') if ok else row['deployed']
                                assert 0<=value['low']<=value['eta']<=value['high']
                                if not ok:assert value==row['deployed'];audit['exactDeployedFallback']+=1
                                if ok and protection=='protected':assert value['low']<=row['deployed']['low']
                                reason=g['reason'] if not g['supported'] else 'joint complete-vector support unavailable' if not ok else 'joint empirical vector'
                                e=dict(changed=value!=row['deployed'],supported=ok,reason=reason)
                                for field in ('journey','wait','source','origin','mask','regime'):
                                    if field in g:e[field]=g[field]
                                row['candidates'][arm]=value;row['candidateReasons'][arm]=reason;row['candidateEvidence'][arm]=e
            if cutoff==canonical.FROZEN:
                for arm in ARMS:
                    if arm.startswith('frozen_'):assert row['candidates'][arm]==row['candidates'][arm.replace('frozen_','rolling_',1)]
            generated.append(row)
        save_model(rolling,'rolling',day)
        print(json.dumps(dict(policy=policy,generatedDay=day,rows=len(generated),newPathAudit=audit['training'][day])),flush=True)
    save_model(frozen,'frozen','fixed')
    write(directory/'unscored.jsonl.gz',generated)
    # Open outcomes only after all new forecasts and support decisions are persisted.
    outcomes={key(r):r for r in stream(REFERENCE/policy/'enriched.jsonl.gz')};assert set(outcomes)==set(features)
    enriched=[];labelled=[]
    for r in generated:
        prior=outcomes[key(r)];row=dict(r,**{k:prior[k] for k in ('label','truth','originalCohort','outcomeReason') if k in prior})
        if row.get('label'):labelled.append(row);audit['labelsExact']+=1
        enriched.append(row)
    assert {key(r):r['label'] for r in labelled}=={key(r):r['label'] for r in stream(REFERENCE/policy/'forecasts.jsonl.gz')}
    write(directory/'forecasts.jsonl.gz',labelled);write(directory/'enriched.jsonl.gz',enriched)
    for cohort,rows in (('all',labelled),('original-cohort',[r for r in labelled if r['originalCohort']])):
        dest=directory if cohort=='all' else directory/cohort
        if cohort!='all':write(dest/'forecasts.jsonl.gz',rows)
        rawlink=dest/'raw_positions.jsonl.gz'
        if not rawlink.exists():rawlink.symlink_to((ev.IN/'raw_positions.jsonl.gz').resolve())
        pointdir=dest/'point-only';write(pointdir/'forecasts.jsonl.gz',(dict(r,candidates=r['pointCandidates']) for r in rows))
        if not(pointdir/'raw_positions.jsonl.gz').exists():(pointdir/'raw_positions.jsonl.gz').symlink_to((ev.IN/'raw_positions.jsonl.gz').resolve())
    assert immutable=={name:sha(Path(name)) for name in immutable}
    (directory/'verification.json').write_text(json.dumps(audit,indent=2)+'\n')
    print(json.dumps(dict(policy=policy,generated=len(generated),labelled=len(labelled),controls={k:audit[k] for k in ('strictOccurrenceVisits','exactOldSingleControls','exactDeployedFallback','labelsExact')})))

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--policy',choices=('highway25','highway50'),required=True);args=parser.parse_args();generate(args.policy)
