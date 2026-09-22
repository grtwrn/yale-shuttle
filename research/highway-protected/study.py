"""Hosted protected-window generation and common-cohort descriptive evaluation."""
import collections
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import transform as tr

HERE=Path(__file__).resolve().parent;IN=HERE/'input';OUT=HERE/'results'
sys.path.insert(0,str(HERE.parent/'useful-windows'))
import rolling as rr
ev=rr.ev
spec=importlib.util.spec_from_file_location('shared_report',HERE.parent/'highway-report/report.py')
shared=importlib.util.module_from_spec(spec);spec.loader.exec_module(shared)
POLICIES=('highway25','highway50')
RAW_HASH='3990d06ebdab596cfebdd7f03c528f7efcbb46fd3f6af68a9d64ede648e220b9'
PRED_HASH='5bcc9927337564067af7eabc6c667ff44eeb7c3cba05619cc57cb0a3cf5b12de'


def key(r):return r['at'],r['bus'],r['route'],r['target']


def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()


def write(directory,name,rows):
    directory.mkdir(parents=True,exist_ok=True)
    with gzip.open(directory/(name+'.jsonl.gz'),'wt') as f:
        for row in rows:f.write(json.dumps(row,separators=(',',':'))+'\n')


def files():
    return [p for p in IN.rglob('*') if p.is_file() and p.name in ('unscored.jsonl.gz','enriched.jsonl.gz','forecasts.jsonl.gz','rider-risk-records.jsonl.gz','rider-risk-cohort.jsonl.gz','rider-risk-summary.json','verification.json','summary.json')]


def generate():
    OUT.mkdir(exist_ok=True)
    metadata=json.loads((IN/'artifact-metadata.json').read_text());run=json.loads((IN/'run-metadata.json').read_text())
    assert metadata['id']==10678256735 and metadata['digest']=='sha256:b153fdd8de2b259692f90a6b46619be45cba7356342154d65f132cee3f4159e3'
    assert run['id']==35688081446 and run['head_sha']=='a15928c15184e49c8ca01790f09b2b81a3e16343' and run['conclusion']=='success'
    source_hashes={str(p.relative_to(IN)):sha(p) for p in files()}
    raw=HERE.parent/'k-sweep/results/raw_positions.jsonl.gz';pred=HERE.parent/'k-sweep/results/predictions_log.jsonl.gz'
    assert sha(raw)==RAW_HASH
    assert sha(pred)==PRED_HASH
    controls=dict(sourceRun=run['id'],sourceArtifactDigest=metadata['digest'],sourceFileHashes=source_hashes,planSha256=sha(HERE/'PLAN.md'),
        transformedRows=0,forecastChecks=0,unchangedOtherRouteForecasts=0,prefixChecks=[],labelsExact=0)
    generated={}
    for policy in POLICIES:
        rows=ev.read(IN/policy/'unscored.jsonl.gz');assert len({key(r) for r in rows})==len(rows)
        transformed=[]
        for r in rows:
            result=tr.row(r)
            assert result['deployed']==r['deployed']
            assert {k:v for k,v in result.items() if k not in ('candidates','candidateEvidence','candidateReasons','rawCandidates','rawCandidateEvidence','rawCandidateReasons')}=={k:v for k,v in r.items() if k not in ('candidates','candidateEvidence','candidateReasons','label','truth','originalCohort','outcomeReason')}
            for arm,f in result['candidates'].items():
                assert f['eta']==r['deployed']['eta'] and f['low']<=r['deployed']['low'] and tr.valid(f)
                if r['route'] not in tr.TARGETS:
                    assert f==r['deployed'];controls['unchangedOtherRouteForecasts']+=1
                if f!=r['deployed']:assert r['candidates'][arm]!=r['deployed']
                controls['forecastChecks']+=1
            transformed.append(result);controls['transformedRows']+=1
        for day in sorted({ev.date(r['at']) for r in rows})[:-1]:
            prefix=[r for r in rows if ev.date(r['at'])<=day]
            assert [tr.row(r) for r in prefix]==[r for r in transformed if ev.date(r['at'])<=day]
            controls['prefixChecks'].append(dict(policy=policy,throughDay=day,rows=len(prefix),identical=True))
        write(OUT/policy,'unscored',transformed);generated[policy]=transformed
    # Every policy stream is persisted before any outcome artifact is opened.
    for policy,rows in generated.items():
        enriched=ev.read(IN/policy/'enriched.jsonl.gz');outcomes={key(r):r for r in enriched}
        expected={key(r):r for r in ev.read(IN/policy/'forecasts.jsonl.gz')}
        assert len(outcomes)==len(enriched)==len(rows) and set(outcomes)=={key(r) for r in rows}
        labelled=[];allrows=[]
        for r in rows:
            original=outcomes[key(r)]
            joined=dict(r,**{field:original[field] for field in ('label','truth','originalCohort','outcomeReason') if field in original})
            if joined.get('label'):
                reference=expected[key(r)]
                assert all(joined.get(field)==reference.get(field) for field in ('label','truth','originalCohort','outcomeReason','deployed'))
                labelled.append(joined);controls['labelsExact']+=1
            allrows.append(joined)
        assert {key(r) for r in labelled}==set(expected)
        write(OUT/policy,'forecasts',labelled);write(OUT/policy,'enriched',allrows)
        write(OUT/policy/'original-cohort','forecasts',[r for r in labelled if r['originalCohort']])
        for directory in (OUT/policy,OUT/policy/'original-cohort'):(directory/'raw_positions.jsonl.gz').symlink_to(raw.resolve())
    assert source_hashes=={str(p.relative_to(IN)):sha(p) for p in files()}
    (OUT/'verification.json').write_text(json.dumps(controls,indent=2)+'\n')
    print(json.dumps({k:v for k,v in controls.items() if k!='sourceFileHashes'}))


def metrics(rows,arms=None):
    if arms is None:arms=rr.ARMS
    raw=[tr.raw_row(r) for r in rows]
    result=dict(deployed=rr.metrics(rows,'deployed'),protected={},raw={})
    for arm in arms:
        result['protected'][arm]=dict(metrics=rr.metrics(rows,arm),movements=shared.movements(rows,arm),ordering=rr.ordering(rows,arm))
        result['raw'][arm]=dict(metrics=rr.metrics(raw,arm),movements=shared.movements(raw,arm),ordering=rr.ordering(raw,arm))
        if rows:
            assert result['protected'][arm]['metrics']['mae']==result['deployed']['mae']
            assert result['protected'][arm]['metrics']['introducedFalseNowSnapshots']==0
            assert result['protected'][arm]['metrics']['introducedSevereEarlyVisits']==0
    return result


def splits(rows,arms=None):
    return dict(all=metrics(rows,arms),original=metrics([r for r in rows if r['originalCohort']],arms),additions=metrics([r for r in rows if not r['originalCohort']],arms))


def score():
    controls=json.loads((OUT/'verification.json').read_text())
    result=dict(note='Fixed protected transform; reused dates, no model selection or deployment',controls=controls,policies={},betweenPolicies={})
    loaded={}
    for policy in POLICIES:
        rows=ev.read(OUT/policy/'forecasts.jsonl.gz');allrows=ev.read(OUT/policy/'enriched.jsonl.gz');loaded[policy]=rows;routes={}
        for rid in ev.ROUTES:
            rs=[r for r in rows if r['route']==rid];generated=[r for r in allrows if r['route']==rid]
            originalids={r['label']['id'] for r in rs if r['originalCohort']};addedids={r['label']['id'] for r in rs if not r['originalCohort']}
            if rid not in tr.TARGETS:
                assert all(f==r['deployed'] for r in generated for f in r['candidates'].values())
                routes[rid]=dict(name=ev.ROUTES[rid]['name'],generated=len(generated),labelled=len(rs),physicalVisits=len(originalids|addedids),exactDeployed=True)
                continue
            protectedunion=[r for r in rs if any(f!=r['deployed'] for f in r['candidates'].values())]
            rawunion=[r for r in rs if any(f!=r['deployed'] for f in r['rawCandidates'].values())]
            assert {key(r) for r in protectedunion}<={key(r) for r in rawunion}
            routes[rid]=dict(name=ev.ROUTES[rid]['name'],generated=len(generated),labelled=len(rs),physicalVisits=len(originalids|addedids),
                originalPhysicalVisits=len(originalids),addedSnapshotPhysicalVisits=len(addedids),overlapPhysicalVisits=len(originalids&addedids),entirelyNewPhysicalVisits=len(addedids-originalids),
                fullRoute=splits(rs),protectedAll14ChangedUnion=splits(protectedunion),fixedRawAll14ChangedUnion=splits(rawunion),
                individualRawChanged={arm:splits([r for r in rs if r['rawCandidates'][arm]!=r['deployed']],[arm]) for arm in rr.ARMS},
                individualProtectedChanged={arm:splits([r for r in rs if r['candidates'][arm]!=r['deployed']],[arm]) for arm in rr.ARMS},
                refreshUnion={k:splits([r for r in rs if any(r[family][f'{mode}_K{k}']!=r['deployed'] for family in ('rawCandidates','candidates') for mode in ('frozen','rolling'))],[f'frozen_K{k}',f'rolling_K{k}']) for k in ev.KS},
                handoffs={arm:dict(protected=shared.handoff_summary(rr.handoffs(generated,arm)),raw=shared.handoff_summary(rr.handoffs([tr.raw_row(r) for r in generated],arm))) for arm in rr.ARMS},
                generatedReasons={arm:dict(collections.Counter(r['candidateReasons'][arm] for r in generated)) for arm in rr.ARMS},
                days={day:splits([r for r in rs if ev.date(r['at'])==day]) for day in sorted({ev.date(r['at']) for r in rs})})
        result['policies'][policy]=routes
    sensitivity={key(r):r for r in loaded['highway50']}
    for rid in tr.TARGETS:
        primary=[r for r in loaded['highway25'] if r['route']==rid];keys={key(r) for r in primary}
        assert keys<=sensitivity.keys()
        for r in primary:assert r['label']==sensitivity[key(r)]['label']
        commonunion=[r for r in primary if any(f!=r['deployed'] for family in ('rawCandidates','candidates') for f in list(r[family].values())+list(sensitivity[key(r)][family].values()))]
        result['betweenPolicies'][rid]=dict(common=metrics(primary),sameUnionPrimary=metrics(commonunion),sameUnionSensitivity=metrics([sensitivity[key(r)] for r in commonunion]),
            sensitivityOnly=splits([r for r in loaded['highway50'] if r['route']==rid and key(r) not in keys]))
    (OUT/'summary.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps(dict(scored=list(result['policies']),noFit=True)))


if __name__=='__main__':generate() if '--generate' in sys.argv else score()
