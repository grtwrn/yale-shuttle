from pathlib import Path
import json,collections
O=Path(__file__).resolve().parent;B=O.parent/'cycle-15'
def key(r):return (r['poll'],r['route'],r['bus'],r['targetIndex'],r['occurrence'])
def load(p):
 rows={key(r):r for r in map(json.loads,p.open())};return rows
old=load(B/'connected-pairs.jsonl');new=load(O/'connected-pairs.jsonl');aligned=load(O/'lagged-origin-records.jsonl');transitions=load(O/'post-arrival-transitions.jsonl');counts=collections.Counter();byroute=collections.defaultdict(collections.Counter);examples={};changes=(O/'label-changes.jsonl').open('w')
for k in sorted(old.keys()|new.keys()):
 a,b=old.get(k),new.get(k)
 if a and b:
  if a['targetId']!=b['targetId']:kind='retargeted'
  elif a['sourceId']!=b['sourceId']:kind='same-target-prior-origin'
  else:
   assert a==b,(k,a,b);counts['unchanged']+=1;continue
 elif a:kind='moved-to-transition' if k in transitions else 'now-unresolved'
 else:kind='newly-resolved'
 assert k in aligned,(kind,k)
 if a:
  for field in ['current','canonical','maxBandDelta']:assert a[field]==aligned[k][field]
 if b:
  for field in ['current','canonical','maxBandDelta']:assert b[field]==aligned[k][field]
 counts[kind]+=1;byroute[str(k[1])][kind]+=1
 record={'key':k,'change':kind,'previous':a,'corrected':b,'retainedAlignment':aligned[k]};changes.write(json.dumps(record)+'\n');examples.setdefault(kind,record)
changes.close()
for k,a in old.items():
 if k not in new:assert k in aligned
score=json.loads((O/'score.json').read_text());original=json.loads((B/'score.json').read_text())
for field in ['availability','stability','numericalProgress']:assert score[field]==original[field]
for field in ['polls','currentRows','canonicalRows','minutePairedRows','changedRows','currentNegativeLow','canonicalNegativeLow','largeBandChanges']:assert score['counts'][field]==original['counts'][field]
regressions=score['largestPointRegressions'];retain=[]
for r in original['largestPointRegressions']:
 k=key(r);dest=new.get(k) or aligned.get(k);assert dest is not None
 retain.append({'key':k,'previous':r,'corrected':dest,'sameTarget':r['targetId']==dest['targetId']})
(O/'prior-regressions-retained.json').write_text(json.dumps(retain,indent=2)+'\n')
result={'previousScored':len(old),'correctedScored':len(new),'counts':counts,'byRoute':byroute,'examples':examples,'allRawForecastChangesAvailabilityStabilityProgressPreserved':True,'previousLargestRegressionsRetained':len(retain),'largestPointRegression':regressions[0],'legacyUncertainty':'Only exact lagged-rest subset has new identity proof. Unchanged rows retain prior source-alignment caveats; no complete all-row physical identity certification.'}
(O/'label-comparison.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({k:v for k,v in result.items() if k not in ['examples','largestPointRegression']},indent=2))
