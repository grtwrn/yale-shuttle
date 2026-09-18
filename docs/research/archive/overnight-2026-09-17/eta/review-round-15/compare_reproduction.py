from pathlib import Path
import json,hashlib,collections
O=Path(__file__).resolve().parent;B=O.parent/'cycle-16'
def signatures(p):
 c=collections.Counter()
 with p.open() as f:
  for line in f:c[hashlib.sha256(json.dumps(json.loads(line),sort_keys=True,separators=(',',':')).encode()).digest()]+=1
 return c
counts={}
for name in ['connected-pairs.jsonl','lagged-origin-records.jsonl','post-arrival-transitions.jsonl','unpaired-arrivals.jsonl','tracking-changes.jsonl','large-tail-changes.jsonl','unresolved-source-identities.jsonl','label-changes.jsonl']:
 x,y=signatures(O/name),signatures(B/name);assert x==y,name;counts[name]=sum(x.values())
a=json.loads((O/'score.json').read_text());b=json.loads((B/'score.json').read_text());aw=a.pop('largestPointRegressions');bw=b.pop('largestPointRegressions');assert a==b
assert sorted(r['errorIncrease'] for r in aw)==sorted(r['errorIncrease'] for r in bw)
for name in ['alignment-verification.json','verification.json','semantic-verification.json','remaining-zero-hop-inventory.json']:
 x=json.loads((O/name).read_text());y=json.loads((B/name).read_text())
 if name=='remaining-zero-hop-inventory.json':
  xx=x.pop('cases');yy=y.pop('cases');assert collections.Counter(json.dumps(r,sort_keys=True) for r in xx)==collections.Counter(json.dumps(r,sort_keys=True) for r in yy)
 assert x==y,name
for arm in ['current','canonical']:
 assert (O/(arm+'-rider-outcomes.jsonl')).read_bytes()==(B/(arm+'-rider-outcomes.jsonl')).read_bytes()
# Independent retention/denominator assertions, including the two occurrences.
rows=list(map(json.loads,(O/'label-changes.jsonl').open()));k=collections.Counter(r['change'] for r in rows)
assert k=={'same-target-prior-origin':5335,'newly-resolved':216,'retargeted':8,'moved-to-transition':11}
prior=json.loads((O/'prior-regressions-retained.json').read_text());assert len(prior)==25 and all(r['sameTarget'] for r in prior)
retargeted=[r for r in rows if r['change']=='retargeted'];assert all(r['corrected']['occurrence']==1 for r in retargeted)
new=[r['corrected'] for r in rows if r['change']=='newly-resolved'];maxerror=max(abs(max(0,r[arm][0])-r['truthSec']) for r in new for arm in ['current','canonical'])
assert abs(maxerror-1574.321)<1e-6
report={'recordMultisetsReproduced':counts,'allSummaryFieldsEqualExceptTieOrder':True,'verificationFilesEqual':True,'riderInputsByteIdentical':True,'labelAccounting':k,'retainedPriorRegressions':25,'largestNewlyResolvedErrorSec':maxerror,'largestPointRegressionSec':max(r['errorIncrease'] for r in aw),'limits':'Reproduction proves arithmetic and record preservation; legacy visit identity remains provisional.'}
(O/'reproduction-comparison.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2))
