"""Descriptive provenance only. Never access outcome times/errors or fit models."""
import collections
import gzip
import hashlib
import json
from pathlib import Path
import statistics

HERE=Path(__file__).resolve().parent
OUT=HERE/'results';CANON=HERE/'canonical/canonical-windows/results';HIGHWAY=HERE/'highway'
KS=(1,2,3,5,8,10,15)
ARMS=[f'{mode}_K{k}' for mode in ('frozen','rolling') for k in KS]

def rows(path):
    with gzip.open(path,'rt') as f:
        for line in f:yield json.loads(line)

def sha(path):
    h=hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda:f.read(1024*1024),b''):h.update(block)
    return h.hexdigest()

def key(r):return r['at'],r['bus'],r['route'],r['target']

def dist(values):
    values=sorted(values)
    if not values:return {'n':0}
    def q(p):
        i=(len(values)-1)*p;a=int(i);b=min(a+1,len(values)-1)
        return values[a]+(values[b]-values[a])*(i-a)
    return dict(n=len(values),min=values[0],median=q(.5),mean=statistics.mean(values),p95=q(.95),max=values[-1])

def counts(rs,labels):
    labelled=[r for r in rs if key(r) in labels]
    return dict(snapshots=len(rs),labelledSnapshots=len(labelled),physicalVisits=len({labels[key(r)] for r in labelled}))

def counter_groups(rs,labels,fn):
    grouped=collections.defaultdict(list)
    for r in rs:grouped[fn(r)].append(r)
    return {name:counts(v,labels) for name,v in sorted(grouped.items())}

def example(r,d):
    return {**{f:r[f] for f in ('at','bus','route','target')},**d}

def detail(rs,labels,k):
    ds=[r['diagnostic']['ks'][str(k)] for r in rs]
    categories=counter_groups(rs,labels,lambda r:r['diagnostic']['ks'][str(k)]['category'])
    flags=collections.Counter();reset_reasons=collections.Counter();reset_combinations=collections.Counter();identity=collections.Counter();warm=collections.Counter()
    for r,d in zip(rs,ds):
        flags.update(d.get('filterFlags',[]));warm.update(r['diagnostic']['readinessFlags'])
        for cause in d.get('clearedBy',[]):
            reset_reasons.update(cause['reasons']);reset_combinations[' + '.join(cause['reasons'])]+=1
        identity.update(d.get('historyContext',d.get('context'))['flags'] if d.get('historyContext',d.get('context')) else [])
    examples={}
    for r,d in zip(rs,ds):examples.setdefault(d['category'],example(r,d))
    verified=[d for d in ds if d.get('historyPhysicalProof')=='unique strict emission']
    expired=[d for d in ds if d['category']=='strict physical source expired solely by45min cap']
    return dict(denominator=counts(rs,labels),categories=categories,filterFlags=flags,observedClearReasons=reset_reasons,
        observedClearCombinations=reset_combinations,identityFlags=identity,readinessFlags=warm,
        strictHistorySourceAgeSec=dist([d['historyAgeSec'] for d in verified]),
        capOnlyExpiredAgeSec=dist([d['historyAgeSec'] for d in expired]),
        uniqueCapOnlyPhysicalEmissions=len({tuple(d['matchingStrictEmissionIds']) for d in expired}),
        capOnlyWithIdentityAmbiguity=sum(d['historyContext']['identityAmbiguous'] for d in expired),
        capOnlyWithSequentialProviderReissue=sum(d['historyContext']['sequentialProviderReissues']>0 for d in expired),
        capOnlyWithAnyIdentityTransition=sum(bool(d['historyContext']['transitionIds']) for d in expired),
        firstChronologicalExamples=examples)

def main():
    verification=json.loads((OUT/'verification.json').read_text())
    assert verification['originalFeaturesExact']>0 and len(verification['prefixChecks'])==3
    meta=json.loads((HIGHWAY/'artifact-metadata.json').read_text());run=json.loads((HIGHWAY/'run-metadata.json').read_text())
    assert meta['id']==10678256735 and meta['digest']=='sha256:b153fdd8de2b259692f90a6b46619be45cba7356342154d65f132cee3f4159e3'
    assert run['id']==35688081446 and run['head_sha']=='a15928c15184e49c8ca01790f09b2b81a3e16343' and run['conclusion']=='success'
    paths=[CANON/'unscored.jsonl.gz',CANON/'forecasts.jsonl.gz']+[HIGHWAY/p/f for p in ('highway25','highway50') for f in ('unscored.jsonl.gz','forecasts.jsonl.gz')]
    immutable={str(p.relative_to(HERE)):sha(p) for p in paths}
    diagnostics={key(r):r for r in rows(OUT/'diagnostics.jsonl.gz')}
    features={key(r):r for r in rows(OUT/'features-control.jsonl.gz')}
    assert features.keys()==diagnostics.keys()
    topology=json.loads((CANON/'canonical-topology.json').read_text());routes={r['id']:r for r in topology['routes']}
    result=dict(descriptiveOnly=True,controls=verification,immutableStoredForecastAndLabelHashes=immutable,policies={},limits=[
        'Source-filter diagnostics are shared by frozen/refreshed arms; duplicate rows across arms are not independent evidence.',
        'Physical source means a strictly pinned causally emitted visit; it does not prove provider identifiers are physical vehicle identities.',
        'Expired solely by cap means every other ORIGINAL source-filter condition passed. Identity flags remain separate and do not authorize recovery.',
        'No observed strict source is left-censored/unknown, never proof the bus did not physically visit the stop before the replay began.',
        'A known source cleared by a reset is observed evidence loss, not permission to bridge a route/gap/identity discontinuity.',
        'Every input stream starts with the original one-hour lead-in, not full archival history. Invalid emissions and open pins are not physical sources.',
        'Snapshot categories partition each arm; visit counts can overlap between categories. Repeated source evidence is not an independent source trip.',
        'Only immutable saved labels IDs are used for denominators; no outcome times, ETA accuracy, width, action or model score is calculated.',
        'Original inputs and model forecasts remain unchanged. This study neither refits nor asserts an improved model or app safety.'])
    checked=0;expected_keys=None
    for policy,base in [('original22',CANON),('highway25',HIGHWAY/'highway25'),('highway50',HIGHWAY/'highway50')]:
        # Outcome fields are deliberately discarded at the read boundary.
        labels={key(r):r['label']['id'] for r in rows(base/'forecasts.jsonl.gz')}
        data=[]
        for r in rows(base/'unscored.jsonl.gz'):
            f=features[key(r)]
            assert all(r[field]==value for field,value in f.items())
            checked+=1
            # Keep only identifiers and existing reason strings, not predicted values.
            data.append({**{name:r[name] for name in ('at','bus','route','target')},'reasons':r['candidateReasons'],'diagnostic':diagnostics[key(r)]})
        actual_keys={key(r) for r in data}
        assert len(actual_keys)==len(data)
        if expected_keys is None:expected_keys=actual_keys
        assert actual_keys==expected_keys and len(data)==verification['originalForecastInputJoins']
        assert labels.keys()<=features.keys()
        report={}
        for rid,route in routes.items():
            rs=[r for r in data if r['route']==rid];ks={};arms={}
            for k in KS:ks[k]=detail(rs,labels,k)
            for arm in ARMS:
                k=int(arm.split('_K')[1]);reason_groups=collections.defaultdict(list)
                for r in rs:reason_groups[r['reasons'][arm]].append(r)
                missing=reason_groups.get('source departure unavailable',[])
                for r in missing:
                    d=r['diagnostic']['ks'][str(k)]
                    assert r['diagnostic']['ready'] and not d.get('retained') and 'reason' not in d
                arms[arm]=dict(reasons={reason:counts(v,labels) for reason,v in sorted(reason_groups.items())},
                    sourceUnavailable=detail(missing,labels,k),
                    reasonBySourceCategory={reason:counter_groups(v,labels,lambda r:r['diagnostic']['ks'][str(k)]['category']) for reason,v in sorted(reason_groups.items())})
            report[rid]=dict(name=route['name'],denominator=counts(rs,labels),sourceDiagnosticsSharedByK=ks,arms=arms)
        result['policies'][policy]=report
    assert immutable=={str(p.relative_to(HERE)):sha(p) for p in paths}
    result['joinedUnchangedFeatureRows']=checked
    emissions=list(rows(OUT/'emissions.jsonl.gz'));resets=list(rows(OUT/'resets.jsonl.gz'));transitions=list(rows(OUT/'identity-transitions.jsonl.gz'))
    result['evidence']={}
    for rid,route in routes.items():
        es=[e for e in emissions if e['route']==rid];strict=[e for e in es if e['physical']];rr=[e for e in resets if e['route']==rid]
        result['evidence'][rid]=dict(name=route['name'],emissions=len(es),strictPhysicalEmissions=len(strict),
            strictModelAccepted=sum(e['modelAccepted'] for e in strict),modelAcceptedButUnproven=sum(e['modelAccepted'] and not e['physical'] for e in es),
            invalidReasons=dict(collections.Counter(reason for e in es for reason in e['physicalRejections'])),
            physicalModelRejections=dict(collections.Counter(reason for e in strict for reason in e['modelRejections'])),
            resets=len(rr),resetReasons=dict(collections.Counter(reason for e in rr for reason in e['reasons'])))
    result['identityTransitionCounts']=dict(collections.Counter(e['kind'] for e in transitions))
    (OUT/'summary.json').write_text(json.dumps(result,indent=2)+'\n')
    lines=['# Causal source-discard diagnostic','',*['- '+v for v in result['limits']],'',
        f"Exact original features: {verification['originalFeaturesExact']}; immutable model-input joins: {checked}; three deleted-future prefix checks passed. No fits, scores, new labels, or EOF closures.",'',
        '## All-route control evidence','', '| Route | Strict emissions | Accepted without strict proof | Initial/other reset observations |', '|---|---:|---:|---:|']
    for r in result['evidence'].values():
        first=r['resetReasons'].get('first observed warm epoch / left boundary unknown',0)
        lines.append(f"| {r['name']} | {r['strictPhysicalEmissions']} | {r['modelAcceptedButUnproven']} | {first} / {r['resets']-first} |")
    for policy,report in result['policies'].items():
        for rid in (9,10):
            route=report[rid]
            lines += ['',f"## {policy}: {route['name']}",'',json.dumps(route['denominator']),'',
                '| Arm | Source unavailable snapshots / labelled / visits | Cap-only expired | Observed reset loss | No strict emission / identity ambiguous / other |',
                '|---|---:|---:|---:|---:|']
            for arm,a in route['arms'].items():
                d=a['sourceUnavailable'];den=d['denominator'];cats=d['categories'];n=lambda cat:cats.get(cat,{}).get('snapshots',0)
                expired=n('strict physical source expired solely by45min cap');reset=n('known physical source cleared by observed model reset')
                unknown=sum(v['snapshots'] for cat,v in cats.items() if cat.startswith('no physical'))
                ambiguous=sum(v['snapshots'] for cat,v in cats.items() if 'ambiguous' in cat)
                other=den['snapshots']-expired-reset-unknown-ambiguous
                lines.append(f"| {arm} | {den['snapshots']} / {den['labelledSnapshots']} / {den['physicalVisits']} | {expired} | {reset} | {unknown} / {ambiguous} / {other} |")
            lines += ['', 'See summary.json for every category, readiness/reset/identity combination, cap-only age distribution, unique emission count and first chronological examples, including all-route and all-policy controls.']
    (OUT/'REPORT.md').write_text('\n'.join(lines)+'\n')
    print(json.dumps(dict(joinedUnchangedFeatureRows=checked,policies=list(result['policies']),newFits=0,newScores=0)))

if __name__=='__main__':main()
