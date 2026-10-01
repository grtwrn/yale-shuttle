"""Verify the completed first-occurrence sampled-lap score; no fitting."""
import hashlib,json,pathlib,statistics
D=pathlib.Path(__file__).resolve().parent;out={}
for name in ['sampled_marginal-score.json','sampled_conditional-score.json']:
 p=D/name;d=json.loads(p.read_text());allrows=d['checkpoints'];assert d['input']['minWarmSec']==600
 for s in d['scores']:
  key=(s['sourceStop'],s['target'],s['phase'],s['checkpointSec']);rs=[r for r in allrows if(r['sourceStop'],r['target'],r['phase'],r['checkpointSec'])==key]
  for a in ['baseline','candidate']:
   m=s['allObserved'][a];assert len(rs)==m['n']
   w=[(.5*abs(r[a]['eta']-r['truthSec'])+.1*(r[a]['high']-r[a]['low'])+max(0,r[a]['low']-r['truthSec'])+max(0,r['truthSec']-r[a]['high']))/1.5 for r in rs]
   assert abs(statistics.mean(w)-m['WIS'])<1e-8
   assert abs(statistics.mean(abs(r[a]['eta']-r['truthSec'])for r in rs)-m['maeSec'])<1e-8
   assert m['early']==sum(r['truthSec']<r[a]['low']for r in rs)
   assert m['late']==sum(r['truthSec']>r[a]['high']for r in rs)
 selected=[]
 for key in [(121,48,'standing',0),(121,48,'standing',60),(121,48,'departure',0),(121,48,'departure',60),(11,48,'standing',60),(11,48,'departure',0)]:
  s=next(s for s in d['scores']if(s['sourceStop'],s['target'],s['phase'],s['checkpointSec'])==key);rs=[r for r in allrows if(r['sourceStop'],r['target'],r['phase'],r['checkpointSec'])==key]
  selected.append({'key':key,'scores':s,'improvedAEgt1':sum(abs(r['candidate']['eta']-r['truthSec'])<abs(r['baseline']['eta']-r['truthSec'])-1 for r in rs),'worseAEgt1':sum(abs(r['candidate']['eta']-r['truthSec'])>abs(r['baseline']['eta']-r['truthSec'])+1 for r in rs),'newLateMisses':[{'sourceId':r['sourceId'],'targetVisitId':r['targetVisitId'],'day':r['day'],'bus':r['bus'],'beyondCandidateSec':r['truthSec']-r['candidate']['high']}for r in rs if r['candidate']['high']<r['truthSec']<=r['baseline']['high']]})
 out[name]={'inputSha256':hashlib.sha256(p.read_bytes()).hexdigest(),'verifiedGroups':len(d['scores']),'checkpointRows':len(allrows),'selected':selected,'jumpScores':d['jumpScores']}
(D/'sampled-result-review.json').write_text(json.dumps(out,indent=2)+'\n');print({n:{k:v for k,v in r.items()if k in ['verifiedGroups','checkpointRows']}for n,r in out.items()})
