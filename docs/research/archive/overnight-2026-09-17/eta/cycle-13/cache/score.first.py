from pathlib import Path
import json,gzip,math,hashlib,statistics
O=Path(__file__).resolve().parent
load=lambda p:json.loads(p.read_text())
for f,h in load(O/'PLAN.json')['inputs'].items():assert hashlib.sha256(Path(f).read_bytes()).hexdigest()==h
frames={k:json.loads(gzip.decompress((O/(k+'.json.gz')).read_bytes())) for k in ['current-warm','current-cold','canonical-warm','canonical-cold']}
def keyed(w):
 count={};result={}
 for r in sorted(w['rows'],key=lambda r:(r[0],r[1],r[5])):
  bk=(w['buses'][r[0]][0],r[1]);occ=count.get(bk,0);count[bk]=occ+1;result[(*bk,occ)]=r
 return result

def compare(a,b):
 aa,bb=frames[a],frames[b];assert len(aa)==len(bb)==78
 changedFrames=wireBuses=beliefs=0;maxP=0;rows=0;changedRows=0;availability=[];worst=[];occstats={};quantileDiffs=0;maxQ=0
 for x,y in zip(aa,bb):
  assert x['at']==y['at'] and x['buses']==y['buses']
  changedFrames+=x['wire']!=y['wire'];wireBuses+=x['wire']['buses']!=y['wire']['buses'];beliefs+=x['beliefs']!=y['beliefs']
  for (_,bx),(_,by) in zip(x['beliefs'],y['beliefs']):maxP=max(maxP,max(abs(u-v) for u,v in zip(bx['p'],by['p'])))
  kr,kb=keyed(x['wire']),keyed(y['wire'])
  if set(kr)!=set(kb):availability.append({'at':x['at'],'onlyA':[list(k) for k in set(kr)-set(kb)],'onlyB':[list(k) for k in set(kb)-set(kr)]})
  for k in kr.keys()&kb.keys():
   r,s=kr[k],kb[k];rows+=1;changedRows+=r!=s
   diffs=[abs(r[i]-s[i]) for i in [2,3,4,7,8] if r[i] is not None and s[i] is not None]
   largest=max(diffs,default=0);eta=abs(r[2]-s[2]);o=occstats.setdefault(k[2],dict(paired=0,changed=0,maxEtaDeltaSec=0,maxBoundOrAuxDeltaSec=0))
   o['paired']+=1;o['changed']+=r!=s;o['maxEtaDeltaSec']=max(o['maxEtaDeltaSec'],eta);o['maxBoundOrAuxDeltaSec']=max(o['maxBoundOrAuxDeltaSec'],largest)
   if largest:worst.append(dict(at=x['at'],bus=k[0],stop=k[1],occurrence=k[2],maxDeltaSec=largest,etaDeltaSec=s[2]-r[2],before=r,after=s))
  # Full serialized equality above includes distributions; separately quantify same-index quantiles only when complete row keys equal.
  if x['wire']['rows']==y['wire']['rows'] or [r[:2]+r[5:6] for r in x['wire']['rows']]==[r[:2]+r[5:6] for r in y['wire']['rows']]:
   for q1,q2 in zip(x['wire'].get('distributions',[]),y['wire'].get('distributions',[])):
    if q1!=q2:quantileDiffs+=1
    # Distribution shape is [rowIndex, quantiles].
    if len(q1)==2 and isinstance(q1[1],list):maxQ=max(maxQ,max((abs(u-v) for u,v in zip(q1[1],q2[1])),default=0))
 return dict(a=a,b=b,frames=78,changedCompleteWires=changedFrames,changedServedPositionFrames=wireBuses,changedBeliefFrames=beliefs,maxPosteriorCellDifference=maxP,pairedRows=rows,changedRows=changedRows,availabilityDifferences=availability,occurrences=occstats,worst=sorted(worst,key=lambda r:r['maxDeltaSec'],reverse=True)[:20],changedDistributionRows=quantileDiffs,maxQuantileDeltaSec=maxQ)
comparisons=[compare('current-warm','current-cold'),compare('canonical-warm','canonical-cold'),compare('current-warm','canonical-warm')]
# The diagnostic is expected to restore numerical repeatability; fail if anything differs.
assert comparisons[1]['changedCompleteWires']==comparisons[1]['changedBeliefFrames']==0
assert comparisons[0]['changedCompleteWires']>0
kernel={}
for arm in ['current','canonical']:
 a,b=[load(O/f'{arm}-kernel-{mode}.json') for mode in ['low','high']]
 assert a['firstKernel']==a['secondKernel'] and b['firstKernel']==b['secondKernel']
 kernel[arm]=dict(lowFirstLength=len(a['firstKernel']),highFirstLength=len(b['firstKernel']),sameOutputRegardlessOfFirstCaller=a['firstKernel']==b['firstKernel'],maxBinDifference=max(abs(u-v) for u,v in zip(a['firstKernel'],b['firstKernel'])))
assert not kernel['current']['sameOutputRegardlessOfFirstCaller'] and kernel['canonical']['sameOutputRegardlessOfFirstCaller']
report=dict(kernel=kernel,comparisons=comparisons,scope='Current-code restart determinism diagnostic; no outcome error or ETA quality improvement established. Both occurrences retained; no production tracking change.')
(O/'score.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({'kernel':kernel,'comparisons':[{k:v for k,v in c.items() if k!='worst'} for c in comparisons]},indent=2))
