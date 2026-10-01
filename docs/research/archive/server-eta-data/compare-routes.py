import json,sys,collections
A={x['id']:x for x in map(json.loads,open(sys.argv[1]))}
B={x['id']:x for x in map(json.loads,open(sys.argv[2]))}
flags={'jump180':lambda x:x['worstDriftSec']>=180,'strand':lambda x:x['strand'],'dropped':lambda x:x['droppedApproaching']>0,'reversal60':lambda x:x['notableReversals']>0,'pinWrong':lambda x:x['pinCorrect']==False}
out={}
for label in sorted({x['label'] for x in A.values()}):
 keys=[k for k in A.keys() & B.keys() if A[k]['label']==label and A[k]['outcome']=='arrived' and B[k]['outcome']=='arrived' and not A[k]['neverShown'] and not B[k]['neverShown'] and not A[k]['busAtStopOnArrival']]
 row={'pairedScored':len(keys)}
 for name,pred in flags.items():
  row[name]={'fixed':[k for k in sorted(keys) if pred(A[k]) and not pred(B[k])],'introduced':[k for k in sorted(keys) if pred(B[k]) and not pred(A[k])],'both':sum(pred(A[k]) and pred(B[k]) for k in keys)}
 out[label]=row
print(json.dumps(out,indent=2))
