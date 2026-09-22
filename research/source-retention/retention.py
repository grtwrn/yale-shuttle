"""Fixed retention experiment. Generate, prove controls, persist, then join labels."""
import collections
import copy
import gzip
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import sys

HERE=Path(__file__).resolve().parent;OUT=HERE/'results';IN=HERE/'protected'
sys.path.insert(0,str(HERE.parent/'highway-windows'))
import run_study as hw
hp=hw.hp;canonical=hw.canonical;rr=hw.rr;ev=hw.ev
sys.path.insert(0,str(HERE.parent/'highway-protected'))
spec=importlib.util.spec_from_file_location('protected_study',HERE.parent/'highway-protected/study.py')
protected=importlib.util.module_from_spec(spec);spec.loader.exec_module(protected)
tr=protected.tr;shared=protected.shared
POLICIES=('highway25','highway50');CAPS=(45,90);BASE_ARMS=tuple(rr.ARMS)
ARMS=[f'{a}_cap{cap}' for cap in CAPS for a in BASE_ARMS]
CAP_FEATURES={};CAP_PROOF={}

def key(r):return r['at'],r['bus'],r['route'],r['target']
def read(path):return ev.read(path)
def write(directory,name,rows):return hw.write(directory,name,rows)
def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def sources():
    return [p for p in IN.rglob('*') if p.is_file() and p.name in ('unscored.jsonl.gz','forecasts.jsonl.gz','enriched.jsonl.gz','rider-risk-records.jsonl.gz','rider-risk-cohort.jsonl.gz','verification.json')]
def clones(model):
    result={}
    for cap in CAPS:
        m=copy.copy(model);m.cache={};result[cap]=m
    assert result[45].cache is not result[90].cache
    return result
def path_hash(model):return hashlib.sha256(json.dumps(sorted((cell,paths) for cell,paths in model.paths.items()),sort_keys=True).encode()).hexdigest()

def support(model,rid,k,w,ti,departure):
    paths=model.paths.get((rid,k,w,ti),[]);admitted=[]
    for p in paths:
        if p['weekend']!=ev.weekend(departure):continue
        diff=abs(ev.clock(p['start'])-ev.clock(departure));diff=min(diff,1440-diff)
        weight=math.exp(-.5*(diff/120)**2)
        if weight>=1e-12:admitted.append((p,weight))
    total=sum(w for _,w in admitted);by_day=collections.Counter()
    for p,wgt in admitted:by_day[p['day']]+=wgt
    eff=total*total/sum(w*w for _,w in admitted) if total else 0
    material=sum(v>=.05*total for v in by_day.values())
    return dict(target=ti,allPaths=len(paths),eligiblePaths=len(admitted),sourceTrips=len({p['sourceId'] for p,_ in admitted}),
        dates=sorted(by_day),effective=eff,materialDates=material,supported=eff>=12 and material>=3)

def gate(r,old,proof,k,result,model,cutoff):
    rid=r['route'];n=len(ev.ROUTES[rid]['stops']);ti=r.get('targetIndex');w=ev.previous_wait(rid,ti) if ti is not None else None
    source=(w-k)%n if w is not None and k<n else None
    origin=r['origins'].get(str(source));prior=old['origins'].get(str(source));p=proof['retainedPhysicalProofs'].get(str(source))
    record=dict(reason=result['reason'],cutoff=cutoff,wait=w,source=source,retained=origin is not None,
        newlyRetained=origin is not None and prior is None,ready=r['ready'],phase=r['phase'],index=r['index'],
        warm=proof['warm'],resetId=(proof['lastReset'] or {}).get('id'),occurrenceReason=r['occurrenceReason'],releaseFlags=[])
    history=proof['ks'][str(k)].get('history')
    if history and history['route']==rid:
        record.update(observedHistoryOrigin=history['departed'],historyAgeSec=(r['at']-history['departed'])/1000)
    if origin:
        assert p and origin['departed']==p['departedAt'] and origin['knownAt']==p['knownAt']<=r['asof']
        record.update(origin=origin['departed'],knownAt=origin['knownAt'],ageSec=p['ageSec'],physicalEmission=p['emission'],observedProvider=p['provider'])
        end=r['origins'].get(str(w))
        if r.get('releasedOrigins',{}).get(f'{k}/{w}')==origin['departed']:record['releaseFlags'].append('latched source release')
        if end and end['departed']>origin['departed']:record['releaseFlags'].append('later wait departure retained')
        if (r['index']-source)%n>k:record['releaseFlags'].append('phase progressed beyond wait segment')
        if r['index']==w and r['phase']=='drive':record['releaseFlags'].append('departing wait phase')
        if result['reason']=='group lacks historical support':
            record['unsupportedTarget']=result['unsupportedTargetIndex']
            record['wholeGroupSupport']=[support(model,rid,k,w,t,origin['departed']) for t in ev.targets(rid,w)]
            assert not next(v for v in record['wholeGroupSupport'] if v['target']==record['unsupportedTarget'])['supported']
    else:record['sourceDiagnostic']=proof['ks'][str(k)]
    return record

def generate():
    OUT.mkdir(exist_ok=True);canonical.configure()
    meta=json.loads((IN/'artifact-metadata.json').read_text())
    assert meta['id']==10678003242 and meta['digest']=='sha256:3d9efacd609484fce0691deb4074b4c8139018a632f15586cac709342131e63e'
    hashes={str(p.relative_to(IN)):sha(p) for p in sources()}
    feature_audit=json.loads((OUT/'feature-verification.json').read_text());assert len(feature_audit['prefixChecks'])==6
    for cap in CAPS:
        CAP_FEATURES[cap]={key(r):r for r in read(OUT/f'features-cap{cap}.jsonl.gz')}
        CAP_PROOF[cap]={key(r):r for r in read(OUT/f'provenance-cap{cap}.jsonl.gz')}
    source={policy:read(IN/policy/'unscored.jsonl.gz') for policy in POLICIES}
    source_index={policy:{key(r):r for r in rows} for policy,rows in source.items()}
    expected=set(source_index['highway25']);assert expected==set(source_index['highway50'])
    raw=read(ev.IN/'raw_positions.jsonl.gz');visits=read(canonical.OUT/'training-visits.jsonl.gz')
    clause=hp.HighwayClause();clause.warm(raw)
    audit=dict(planSha256=sha(HERE/'PLAN.md'),sourceHashes=hashes,featureControls=feature_audit,exact45Raw=0,exact45Protected=0,
        otherRouteExactDeployed=0,labelsExact=0,trainingPrefixChecks=[],trainingPathHashes={},gateCounts={},providerInterpretation='Observed provider IDs, not proven physical vehicle identity')
    frozen={};generated={p:[] for p in POLICIES}
    for policy in POLICIES:
        model,_=hw.fit(visits,raw,canonical.FROZEN,policy,clause);frozen[policy]=clones(model)
        audit['trainingPathHashes'][policy+'/frozen']=path_hash(model)
    # Existing predeclared training deletion checkpoints, independent geometry/model caches.
    for cutoff in (canonical.FROZEN,max(rr.cutoff_for(ev.date(r['at'])) for r in source['highway25'])):
        pr=[r for r in raw if r['collected_at']<cutoff];pv=[v for v in visits if rr.available(v,cutoff)]
        fresh=hp.HighwayClause();fresh.warm(pr)
        for policy in POLICIES:
            a,_=hw.fit(visits,raw,cutoff,policy,clause);b,_=hw.fit(pv,pr,cutoff,policy,fresh)
            assert dict(a.paths)==dict(b.paths)
            audit['trainingPrefixChecks'].append(dict(policy=policy,cutoff=cutoff,raw=len(pr),visits=len(pv),exact=True))
        del a,b,fresh,pr,pv
    for day in sorted({ev.date(r['at']) for r in source['highway25']}):
        assert '2026-09-17'<=day<='2026-09-20';cutoff=rr.cutoff_for(day)
        for policy in POLICIES:
            model,_=hw.fit(visits,raw,cutoff,policy,clause);rolling=clones(model)
            audit['trainingPathHashes'][policy+'/'+day]=path_hash(model)
            for prior in source[policy]:
                if ev.date(prior['at'])!=day:continue
                fk=key(prior);control=CAP_FEATURES[45][fk]
                assert all(prior[field]==v for field,v in control.items())
                # Common action metadata stays the original45 feature row; each arm's
                # exact replay features/provenance are separately persisted above.
                rawrow={name:v for name,v in prior.items() if name not in ('candidates','candidateReasons','candidateEvidence','rawCandidates','rawCandidateReasons','rawCandidateEvidence')}
                rawrow.update(candidates={},candidateReasons={},candidateEvidence={});gates={}
                for cap in CAPS:
                    feature=CAP_FEATURES[cap][fk];proof=CAP_PROOF[cap][fk]
                    for mode,model in (('frozen',frozen[policy][cap]),('rolling',rolling[cap])):
                        for k in ev.KS:
                            basearm=f'{mode}_K{k}';arm=f'{basearm}_cap{cap}'
                            result=model.predict(dict(feature,baseline=prior['deployed']),f'K{k}')
                            f=result['forecast']
                            if result['changed']:f={field:math.floor(v+.5) for field,v in f.items()}
                            assert tr.valid(f)
                            evidence={name:v for name,v in result.items() if name!='forecast'}
                            if cap==45:
                                assert f==prior['rawCandidates'][basearm]
                                assert evidence==prior['rawCandidateEvidence'][basearm]
                                assert result['reason']==prior['rawCandidateReasons'][basearm]
                                audit['exact45Raw']+=1
                            rawrow['candidates'][arm]=f;rawrow['candidateReasons'][arm]=result['reason'];rawrow['candidateEvidence'][arm]=evidence
                            if prior['route'] in tr.TARGETS:gates[arm]=gate(feature,control,proof,k,result,model,canonical.FROZEN if mode=='frozen' else cutoff)
                row=tr.row(rawrow);row['retentionGates']=gates
                for basearm in BASE_ARMS:
                    arm=basearm+'_cap45';assert row['candidates'][arm]==prior['candidates'][basearm]
                    assert row['candidateEvidence'][arm]==prior['candidateEvidence'][basearm]
                    assert row['candidateReasons'][arm]==prior['candidateReasons'][basearm];audit['exact45Protected']+=1
                for arm,f in row['candidates'].items():
                    assert f['eta']==row['deployed']['eta'] and f['low']<=row['deployed']['low']
                    if row['route'] not in tr.TARGETS:assert f==row['deployed'];audit['otherRouteExactDeployed']+=1
                if cutoff==canonical.FROZEN:
                    for cap in CAPS:
                        for k in ev.KS:assert row['candidates'][f'frozen_K{k}_cap{cap}']==row['candidates'][f'rolling_K{k}_cap{cap}']
                generated[policy].append(row)
            assert path_hash(rolling[45])==path_hash(rolling[90])==audit['trainingPathHashes'][policy+'/'+day]
        print(json.dumps(dict(generatedDay=day,cutoff=cutoff)),flush=True)
    for policy in POLICIES:
        assert {key(r) for r in generated[policy]}==expected and len(generated[policy])==len(expected)
        assert path_hash(frozen[policy][45])==path_hash(frozen[policy][90])==audit['trainingPathHashes'][policy+'/frozen']
        write(OUT/policy,'unscored',generated[policy])
        audit['gateCounts'][policy]={rid:{arm:dict(collections.Counter(r['retentionGates'][arm]['reason'] for r in generated[policy] if r['route']==rid)) for arm in ARMS} for rid in tr.TARGETS}
    # Immutable outcome join starts only after both policy streams are saved.
    for policy in POLICIES:
        outcomes={key(r):r for r in read(IN/policy/'enriched.jsonl.gz')};labelled=[];enriched=[]
        original_labels={key(r):r['label'] for r in read(IN/policy/'forecasts.jsonl.gz')}
        assert set(outcomes)==expected
        for r in generated[policy]:
            original=outcomes[key(r)];row=dict(r,**{name:original[name] for name in ('label','truth','originalCohort','outcomeReason') if name in original})
            if row.get('label'):
                assert row['label']==original_labels[key(r)];labelled.append(row);audit['labelsExact']+=1
            enriched.append(row)
        assert {key(r):r['label'] for r in labelled}==original_labels
        write(OUT/policy,'forecasts',labelled);write(OUT/policy,'enriched',enriched)
        write(OUT/policy/'original-cohort','forecasts',[r for r in labelled if r['originalCohort']])
        for directory in (OUT/policy,OUT/policy/'original-cohort'):
            target=directory/'raw_positions.jsonl.gz'
            if not target.exists():target.symlink_to((ev.IN/'raw_positions.jsonl.gz').resolve())
    assert hashes=={str(p.relative_to(IN)):sha(p) for p in sources()}
    (OUT/'verification.json').write_text(json.dumps(audit,indent=2)+'\n')
    print(json.dumps({k:v for k,v in audit.items() if k not in ('sourceHashes','featureControls','gateCounts')}))

def metrics(rows,arms=ARMS):
    raw=[tr.raw_row(r) for r in rows]
    out=dict(deployed=rr.metrics(rows,'deployed'),protected={},raw={})
    for arm in arms:
        out['protected'][arm]=dict(metrics=rr.metrics(rows,arm),movements=shared.movements(rows,arm),ordering=rr.ordering(rows,arm))
        out['raw'][arm]=dict(metrics=rr.metrics(raw,arm),movements=shared.movements(raw,arm),ordering=rr.ordering(raw,arm))
        if rows:
            m=out['protected'][arm]['metrics'];assert m['mae']==out['deployed']['mae'] and m['introducedFalseNowSnapshots']==m['introducedSevereEarlyVisits']==0
    return out
def splits(rows,arms=ARMS):return dict(all=metrics(rows,arms),original=metrics([r for r in rows if r['originalCohort']],arms),additions=metrics([r for r in rows if not r['originalCohort']],arms))

def scope_counts(rows):return dict(snapshots=len(rows),visits=len({r['label']['id'] for r in rows}),days=len({ev.date(r['at']) for r in rows}))

def source_breakdown(generated,labelled):
    labels={key(r):r['label']['id'] for r in labelled};result={}
    for arm in ARMS:
        rows=[r for r in generated if r['retentionGates'][arm]['newlyRetained']]
        groups=collections.defaultdict(list)
        for r in rows:groups[r['retentionGates'][arm]['reason']].append(r)
        result[arm]=dict(newlyRetained=len(rows),strictEmissions=len({r['retentionGates'][arm]['physicalEmission'] for r in rows}),
            labelledSnapshots=sum(key(r) in labels for r in rows),physicalVisits=len({labels[key(r)] for r in rows if key(r) in labels}),
            reasons={reason:dict(snapshots=len(rs),labelledSnapshots=sum(key(r) in labels for r in rs),
                physicalVisits=len({labels[key(r)] for r in rs if key(r) in labels}),
                strictEmissions=len({r['retentionGates'][arm]['physicalEmission'] for r in rs}),
                firstChronologicalExample={**{f:rs[0][f] for f in ('at','bus','route','target')},**rs[0]['retentionGates'][arm]}) for reason,rs in groups.items()})
    return result

def transitions(generated,arm):
    groups=collections.defaultdict(list);records=[];excluded=collections.Counter();examples={}
    for r in generated:groups[r['bus'],r['target']].append(r)
    for rs in groups.values():
        for a,b in zip(rs,rs[1:]):
            x=a['retentionGates'][arm];y=b['retentionGates'][arm];flags=[]
            if x.get('observedHistoryOrigin')==y.get('observedHistoryOrigin') and x.get('observedHistoryOrigin') is not None:
                for cap in CAPS:
                    if x.get('historyAgeSec',-1)<=cap*60<y.get('historyAgeSec',-1):flags.append(f'crossed{cap}min source age')
            if x.get('origin')!=y.get('origin'):flags.append('retained source changed/vanished')
            if x['resetId']!=y['resetId']:flags.append('observed reset epoch changed')
            if x['phase']!=y['phase']:flags.append('phase changed')
            if x['ready']!=y['ready'] or x['warm'] and y['warm'] and x['warm']['first']!=y['warm']['first']:flags.append('readiness/warm epoch changed')
            if x['releaseFlags']!=y['releaseFlags']:flags.append('release flags changed')
            if x['reason']!=y['reason']:flags.append('gate reason changed')
            if not flags:continue
            public=dict(bus=b['bus'],route=b['route'],target=b['target'],previousAt=a['at'],at=b['at'],flags=flags,before=x,after=y)
            for flag in flags:examples.setdefault(flag,public)
            if not a.get('label') or not b.get('label'):excluded['unlabelled']+=1;continue
            if a['label']['id']!=b['label']['id']:excluded['different pickup occurrence']+=1;continue
            if not 0<b['at']-a['at']<=30000:excluded['snapshot gap']+=1;continue
            sec=(b['at']-a['at'])/1000
            records.append(dict(public,visit=b['label']['id'],arrivalClockJump={f:b['candidates'][arm][f]-a['candidates'][arm][f]+sec for f in ('eta','low','high')},
                deployedArrivalClockJump={f:b['deployed'][f]-a['deployed'][f]+sec for f in ('eta','low','high')}))
    return dict(records=records,excluded=excluded,firstChronologicalExamples=examples)

def transition_summary(policy,rid,generated,arm):
    result=transitions(generated,arm);records=result.pop('records')
    write(OUT/policy,f'transitions-{rid}-{arm}',records)
    return dict(result,observed=len(records),flags=dict(collections.Counter(flag for r in records for flag in r['flags'])),
        clockJumps={field:shared.distribution([r['arrivalClockJump'][field] for r in records]) for field in ('eta','low','high')})

def score():
    canonical.configure();result=dict(controls=json.loads((OUT/'verification.json').read_text()),policies={},
        note='Fixed 45/90 retention; reused development dates; all Ks; observed provider IDs do not prove physical vehicle identity; no promotion')
    for policy in POLICIES:
        rows=read(OUT/policy/'forecasts.jsonl.gz');allrows=read(OUT/policy/'enriched.jsonl.gz');routes={}
        for rid in ev.ROUTES:
            rs=[r for r in rows if r['route']==rid];gs=[r for r in allrows if r['route']==rid]
            if rid not in tr.TARGETS:
                assert all(f==r['deployed'] for r in gs for f in r['candidates'].values())
                routes[rid]=dict(name=ev.ROUTES[rid]['name'],denominator=scope_counts(rs),exactDeployed=True);continue
            fixed=[r for r in rs if any(r['rawCandidates'][a+'_cap45']!=r['deployed'] for a in BASE_ARMS)]
            union=[r for r in rs if any(f!=r['deployed'] for f in r['rawCandidates'].values())]
            routes[rid]=dict(name=ev.ROUTES[rid]['name'],generated=len(gs),denominator=scope_counts(rs),
                usableSourceGates=source_breakdown(gs,rs),fullRoute=splits(rs),fixed45RawAll14Union=splits(fixed),all28RawUnion=splits(union),
                matchedProtectedUnion={a:splits([r for r in rs if any(r['candidates'][a+f'_cap{cap}']!=r['deployed'] for cap in CAPS)],[a+f'_cap{cap}' for cap in CAPS]) for a in BASE_ARMS},
                changedScope={a:splits([r for r in rs if r['candidates'][a]!=r['deployed']],[a]) for a in ARMS},
                supportedScope={a:splits([r for r in rs if r['rawCandidateReasons'][a]=='checkpoint'],[a]) for a in ARMS},
                handoffs={a:dict(protected=shared.handoff_summary(rr.handoffs(gs,a)),raw=shared.handoff_summary(rr.handoffs([tr.raw_row(r) for r in gs],a))) for a in ARMS},
                transitions={a:transition_summary(policy,rid,gs,a) for a in ARMS})
        result['policies'][policy]=routes
    (OUT/'summary.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps(dict(scoredPolicies=list(result['policies']),allArms=ARMS)))

if __name__=='__main__':generate() if '--generate' in sys.argv else score()
