"""Integrity, occurrence identity and cross-artifact checks for the research slice."""
import hashlib,json,subprocess
from pathlib import Path
O=Path(__file__).resolve().parent
read=lambda name:json.loads((O/name).read_text())
checks=0
for group in [read('PLAN.json')['inputs'],read('state-summary.json')['inputHashes']]:
    for p,h in group.items():assert hashlib.sha256(Path(p).read_bytes()).hexdigest()==h,p;checks+=1
src=Path('services/shuttle-v2/web/src/TransitMap.tsx').read_text()
a=src.index('    return stableOptions.map((o) => {',src.index('const options: TripOption[] | null = useMemo'))
b=src.index('    // eslint-disable-next-line react-hooks/exhaustive-deps',a)
assert src[a:b] in (O/'shell-baseline.generated.mts').read_text()
tr=read('ordered-transform.json');assert src.count(tr['needle'])==1
assert (O/'shell-ordered.generated.mts').read_text()==(O/'shell-baseline.generated.mts').read_text().replace(tr['needle'],tr['replacement'])
states=read('observed-states.json');assert (states['frames'],states['matched'],states['rows'])==(11081,1172,160496)
assert len(states['states'])==34 and all(not s['leadSituation']['standing'] for s in states['states'])
cases=read('missing-cases.json');assert len(cases)==68
summary=read('counterfactual-summary.json');assert summary['baselineExact']==4688
assert summary['arms']['ordered']==dict(available=4650,gained=30,lost=0,changed=30,busChanged=0,orderChanged=0,journeyBusDifferent=742)
base={(r['session'],r['at']):r for r in map(json.loads,(O/'baseline-decisions.jsonl').open())}
ordered=list(map(json.loads,(O/'ordered-decisions.jsonl').open()))
for r in ordered:
    old=base[r['session'],r['at']]
    if not r['changed']:assert r['option']==old['option'];continue
    jt=next(t for t in r['trace'] if t['kind']=='journey');j=r['option']['journeyArrival']
    assert jt['board']['stopsAhead']==1 and jt['destination']['stopsAhead']>1
    assert jt['board']['busName']==jt['destination']['busName']==r['option']['busName']==j['busName']
    assert j['distributionMs']==[r['at']+(x+r['option']['walkFromSec'])*1000 for x in jt['destination']['distribution']]
    assert not old['option'].get('journeyArrival')
    checks+=1
pairs=read('paired-outcomes.json');changed=[r for r in pairs if r['changed']]
assert len(pairs)==1400 and len(changed)==30 and len({r['sourceId'] for r in changed})==8
scores=read('counterfactual-scores.json')
for arm in ['baseline','ordered']:
    assert abs(sum(abs(r[arm]['errorSec']) for r in changed)/30-scores['pairedChanged'][arm]['mae'])<1e-10
assert scores['largestRegressions'][0]['sourceId']==63523
assert abs(scores['largestRegressions'][0]['absErrorIncreaseSec']-442.82701916224846)<1e-8
browser_checks=0
for name in ['browser-parity.json','ordered-browser-parity.json','ordered-browser-transitions.json']:
    x=read(name);assert x['errors']==[];browser_checks+=x['checks']
    if name.endswith('transitions.json'):assert x['sessions'][0]['transitions']['staleMissingRecovery']
head=subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip();assert head==read('PLAN.json')['head']
assert subprocess.check_output(['git','status','--porcelain'],text=True)==''
result=dict(inputHashChecks=13,identityAndDistributionChecks=30,pairedConnectedOutcomes=1400,restoredPairs=30,
    completeWireRows=160496,nativeMissingStatePolls=34,browserChecks=browser_checks,head=head,worktreeClean=True,
    limits='No application change or deployment. Artifact overlay is exploratory; normal code-review/typecheck/full-tests and folded-route integration remain required for any future release.')
(O/'verification.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))
