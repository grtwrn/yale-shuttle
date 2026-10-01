import json,sys,statistics,math
A={x['id']:x for x in map(json.loads,open(sys.argv[1]))}; B={x['id']:x for x in map(json.loads,open(sys.argv[2]))}
keys=sorted(k for k in A.keys() & B.keys() if A[k]['outcome']=='arrived' and B[k]['outcome']=='arrived' and not A[k]['neverShown'] and not B[k]['neverShown'] and not A[k]['busAtStopOnArrival'])
def quant(vals,p):
 vals=sorted(vals); i=(len(vals)-1)*p;lo=math.floor(i);hi=math.ceil(i);return vals[lo]+(vals[hi]-vals[lo])*(i-lo)
flags={'jump180':lambda x:x['worstDriftSec']>=180,'strand':lambda x:x['strand'],'drop':lambda x:x['droppedApproaching']>0,'reversal60':lambda x:x['notableReversals']>0,'pinWrong':lambda x:x['pinCorrect']==False}
out={'paired':len(keys),'flags':{n:{'before':sum(pred(A[k]) for k in keys),'after':sum(pred(B[k]) for k in keys),'fixed':sum(pred(A[k]) and not pred(B[k]) for k in keys),'introduced':sum(pred(B[k]) and not pred(A[k]) for k in keys)} for n,pred in flags.items()}}
for name,S in [('before',A),('after',B)]:
 rows=[S[k] for k in keys]; iv=[r['firstSightInterval'] for r in rows if r.get('firstSightInterval')]
 out[name]={'p90WorstDriftSec':quant([r['worstDriftSec'] for r in rows],.9),'medianIntervalWidthSec':statistics.median(v['hi']-v['lo'] for v in iv),'coveragePct':100*sum(v['where']==0 for v in iv)/len(iv)}
print(json.dumps(out,indent=2))
