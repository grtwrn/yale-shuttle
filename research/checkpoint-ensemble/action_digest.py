"""Hosted reduction of existing action summaries, never a new replay/score."""
import collections
import hashlib
import json
from pathlib import Path
HERE=Path(__file__).resolve().parent;ROOT=HERE/'action-digest-input'
PINS={'highway25':(10702211566,'fe1e5d25fc76a5d473c4a03c3fcedfe44071eeda3a2c7bb55a5637e4c4e25f92'),
      'highway50':(10702581319,'67b2c438763f021d3bd08b459a32a3df27b8b8fd0bb1a688bb522fe4d04a35af')}
def sha(p):
    h=hashlib.sha256()
    with p.open('rb') as f:
        for block in iter(lambda:f.read(1048576),b''):h.update(block)
    return h.hexdigest()
def span(v):
    v=[x for x in v if x is not None];return [min(v),max(v)] if v else None
def summarize(rows,comparand):
    groups=collections.defaultdict(list)
    for r in rows:
        if '_ensemble' in r['arm']:groups[r['route'],r['arm'],r['policy']].append(r)
    result=[]
    ak,bk={'againstDeployed':('deployed','candidate'),'againstMatchedSingle':('single','ensemble'),'againstOriginalSingle':('originalSingle','ensemble')}[comparand]
    for (route,arm,policy),rs in sorted(groups.items()):
        assert len(rs)==8 and len({(r['walkSec'],r['responseSec']) for r in rs})==8
        result.append(dict(route=route,arm=arm,policy=policy,settings=8,
            attempts=span([r['attempts'] for r in rs]),scoredPairs=span([r['scoredPairs'] for r in rs]),
            maximumNewMissesInOneSetting=max(r['newlyMissed'] for r in rs),maximumRescuesInOneSetting=max(r['rescued'] for r in rs),
            newlyMissedSettings=[[r['walkSec'],r['responseSec'],r['newlyMissed'],r['rescued'],r['scoredPairs']] for r in rs if r['newlyMissed']],
            meanPairedWaitDeltaRange=span([r['waitDelta'].get('mean') for r in rs]),pairedWaitingCountRange=span([r['waitDelta']['n'] for r in rs]),
            meanPairedLeaveDeltaRange=span([r.get('leaveDelta',{}).get('mean') for r in rs]),
            censoredComparatorRange=span([r[ak]['statuses'].get('censored',0) for r in rs]),
            censoredCandidateRange=span([r[bk]['statuses'].get('censored',0) for r in rs]),
            alreadyTooLateComparatorRange=span([r[ak]['statuses'].get('already-too-late-at-arm',0) for r in rs]),
            alreadyTooLateCandidateRange=span([r[bk]['statuses'].get('already-too-late-at-arm',0) for r in rs])))
    return result
def main():
    metadata=json.loads((ROOT/'artifacts.json').read_text())['artifacts'];out={}
    for policy,(ident,digest) in PINS.items():
        a=next(a for a in metadata if a['id']==ident);assert a['digest']=='sha256:'+digest
        base=ROOT/policy/'results'/policy;path=base/'action-comparisons.json';before=sha(path)
        source=json.loads(path.read_text());cells={}
        for cohort,s in source.items():
            cells[cohort]=dict(cohort=s['cohort'],exactDeployedActions=s['exactDeployedActions'],
                comparisons={name:summarize(s[name],name) for name in ('againstDeployed','againstMatchedSingle','againstOriginalSingle')})
        assert sha(path)==before
        audit=json.loads((base/'reuse-audit.json').read_text());assert audit['afterExact'] is True
        out[policy]=dict(sourceSha256=before,sourceArtifact=a,cohorts=cells,immutableFitForecastFiles=len(audit['before']))
        del source
    result=dict(sourceRun=35743388426,sourceCode='1d440774030495999309c2c8c181ed5f9013852b',
        note='Descriptive reduction of existing paired summaries. Eight walk/response settings are repeated scenarios, not independent riders; maxima and ranges are across settings, never summed misses. No new scoring or replay.',policies=out)
    (HERE/'action-digest.json').write_text(json.dumps(result,separators=(',',':'))+'\n')
    print(json.dumps({p:{k:v['exactDeployedActions'] for k,v in r['cohorts'].items()} for p,r in out.items()}))
if __name__=='__main__':main()
