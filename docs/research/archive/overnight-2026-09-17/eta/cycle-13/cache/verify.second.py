"""Independent compact checks of checkpoint comparison and numerical-tail evidence."""
from pathlib import Path
import json,gzip,hashlib,subprocess,math
O=Path(__file__).resolve().parent;P=O.parents[1]
load=lambda p:json.loads(p.read_text())
plan=load(O/'PLAN.json');provenance=load(O/'build-provenance.json')
for f,h in plan['inputs'].items():assert hashlib.sha256(Path(f).read_bytes()).hexdigest()==h
assert provenance['substitutions']==1
for arm in ['current','canonical']:assert hashlib.sha256((O/f'{arm}.mjs').read_bytes()).hexdigest()==provenance['bundles'][arm]
first=json.loads((P/'cycle-4/regression-frames.json').read_text());assert len(first)==78
out={k:json.loads(gzip.decompress((O/f'{k}.json.gz').read_bytes())) for k in ['current-warm','current-cold','canonical-warm','canonical-cold']}
negativeBounds={}
for k,fs in out.items():
 negativeBounds[k]=[]
 assert len(fs)==78
 for f,old in zip(fs,first):
  assert f['at']==old['at'] and f['buses']==old['buses']
  w=f['wire'];assert len(w['rows'])==len(w['distributions'])
  for r,q in zip(w['rows'],w['distributions']):
   assert r[3]<=r[2]<=r[4]
   if r[3]<0:negativeBounds[k].append({'at':f['at'],'bus':w['buses'][r[0]][0],'stop':r[1],'hops':r[5],'low':r[3],'lowFloor':r[8]})
   assert len(q)==50 and all(math.isfinite(v) and v>=0 for v in q)
   assert sorted(q)==q
  for key,b in f['beliefs']:assert abs(sum(b['p'])-1)<1e-10
assert all(v==negativeBounds['current-warm'] for v in negativeBounds.values())
assert len(negativeBounds['current-warm'])==8
(O/'retained-negative-bounds.json').write_text(json.dumps(negativeBounds,indent=2)+'\n')
assert out['canonical-warm']==out['canonical-cold']
assert all(a['wire']['buses']==b['wire']['buses'] for a,b in zip(out['current-warm'],out['current-cold']))
fields={2:'eta',3:'low',4:'high',7:'departNow',8:'lowFloor'}
checks={}
for arm in ['current','canonical']:
 warm,cold=out[arm+'-warm'],out[arm+'-cold'];diffs={v:0 for v in fields.values()};changed=0;quantile=0
 for a,b in zip(warm,cold):
  wa,wb=a['wire'],b['wire'];assert [(r[0],r[1],r[5]) for r in wa['rows']]==[(r[0],r[1],r[5]) for r in wb['rows']]
  for ra,rb,qa,qb in zip(wa['rows'],wb['rows'],wa['distributions'],wb['distributions']):
   changed+=ra!=rb
   for i,name in fields.items():
    if ra[i] is not None and rb[i] is not None:diffs[name]=max(diffs[name],abs(ra[i]-rb[i]))
   quantile=max(quantile,max(abs(x-y) for x,y in zip(qa,qb)))
 checks[arm]=dict(changedRows=changed,maxDeltaSec=diffs,maxQuantileDeltaSec=quantile)
assert checks['current']['changedRows']==1817 and checks['current']['maxDeltaSec']['high']==3768
assert checks['canonical']['changedRows']==0 and checks['canonical']['maxQuantileDeltaSec']==0
for arm in ['current','canonical']:
 a,b=[load(O/f'{arm}-kernel-{mode}.json') for mode in ['low','high']]
 assert a['first']==b['second']==1.951 and b['first']==a['second']==2.049
 assert a['firstKernel']==a['secondKernel'] and b['firstKernel']==b['secondKernel']
 for k in [a['firstKernel'],b['firstKernel']]:assert abs(sum(k)-1)<1e-12 and k[0]==0 and min(k)>=0
 assert (a['firstKernel']==b['firstKernel'])==(arm=='canonical')
 for mode in ['warm','cold']:
  meta=load(O/f'{arm}-{mode}-meta.json');assert meta['frames']==(2178 if mode=='warm' else 78)
  assert meta['sameProcessMatches']==(78 if mode=='warm' else None)
repo=Path('/home/gwarren/projects/yale-shuttle-watcher/overnight-eta-2026-09-17')
assert subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo,text=True).strip()==plan['base']
assert subprocess.check_output(['git','status','--porcelain'],cwd=repo,text=True)==''
report=dict(currentBase=plan['base'],identicalInputWindows=4,framesPerWindow=78,rowsPerWindow=sum(len(f['wire']['rows']) for f in first) if 'wire' in first[0] else sum(len(f['expected']['rows']) for f in first),checks=checks,canonicalExactFullStateAndWire=True,allBandsAndQuantilesOrdered=True,unchangedNegativeLowerBoundsPerArm=8,allBeliefsNormalized=True,cleanCheckout=True)
(O/'verification.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2))
