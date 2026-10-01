from pathlib import Path
import json,gzip,hashlib,collections,subprocess,math
O=Path(__file__).resolve().parent;E=O.parent;plan=json.loads((O/'PLAN.json').read_text())
for name,h in plan['frozen'].items():assert hashlib.sha256((O/name).read_bytes()).hexdigest()==h
for name,h in plan['inputHashes'].items():assert hashlib.sha256(Path(name).read_bytes()).hexdigest()==h
raw={}
for i,l in enumerate((E/'cycle-14/all-route-raw-frames.jsonl').open()):
 if 5999<=i<9000:raw[i]=json.loads(l)
 if i>=9000:break
from datetime import datetime
ms=lambda f:int(datetime.fromisoformat(f['at'].replace('Z','+00:00')).timestamp()*1000)
assert len(raw)==3001
out={'pairedPolls':0,'arms':{},'frozenHashesVerified':len(plan['frozen']),'inputHashesVerified':len(plan['inputHashes']),'limits':'Native checkpoint/global kernel cache continuity, causal saved input order, wire totals and boundary accounting. No original receipt-time or outcome-identity proof.'}
for arm in ['current','canonical']:
 meta=json.loads((O/(arm+'-resume6000-meta.json')).read_text());assert(meta['start'],meta['end'],meta['polls'])==(6000,9000,3000)
 last=None
 for line in gzip.open(E/'cycle-15'/(arm+'-wire.jsonl.gz'),'rt'):last=json.loads(line)
 assert last['i']==5999 and last['at']==ms(raw[5999]);(O/(arm+'-boundary5999.json')).write_text(json.dumps(last)+'\n');previous=last;counts=collections.Counter();routes=set();boundary=[]
 for i,line in enumerate(gzip.open(O/(arm+'-resume6000-wire.jsonl.gz'),'rt'),6000):
  f=json.loads(line);assert f['i']==i and f['at']==ms(raw[i]) and previous['at']<f['at'];assert f['sample']==(previous['at']//60000!=f['at']//60000)
  if f['sample']:assert len(f['stateSha256'])==64
  else:assert 'stateSha256' not in f
  counts['polls']+=1;counts['minuteSamples']+=f['sample'];counts['rows']+=len(f['wire']['rows']) if f['wire'] else 0
  for t in f['tracking'].values():routes.add(t[0]);assert t[5]>=0 and (t[7] is None or t[7]<=f['at'])
  if i==6000:
   # Preserve the transition omitted by a scorer whose previous-row map begins at6000.
   for key,t in f['tracking'].items():
    prev=previous['tracking'].get(key)
    if prev:
     N=len(meta['routeMeta'][str(t[0])]['stops']);delta=(t[1]-prev[1])%N
     boundary.append({'bus':key,'previousLead':prev[1],'lead':t[1],'numericallyBackward':delta>N/2,'warmupMs':t[5]})
  previous=f
 assert counts['polls']==3000 and counts['rows']==meta['rows'] and counts['minuteSamples']==meta['samples'];assert previous['i']==8999
 # Native serializer reads only the copied research checkpoints.
 js="const fs=require('fs'),v8=require('v8');const p=process.argv[1];const s=v8.deserialize(fs.readFileSync(p));console.log(JSON.stringify({n:s.n,last:s.last,kernels:s.kernelCache.size,buses:s.perBus.size,steps:s.server.steps,failures:s.server.failures}));"
 checks={}
 for n in [6000,9000]:
  c=json.loads(subprocess.check_output(['node','-e',js,str(O/f'{arm}-checkpoint-{n}.v8')],text=True));assert c['n']==n and c['last']==ms(raw[n-1]) and c['kernels']>0 and c['failures']==0;checks[str(n)]=c
 out['arms'][arm]={'counts':counts,'routes':sorted(routes),'firstAt':ms(raw[6000]),'lastAt':previous['at'],'checkpointChecks':checks,'boundaryTracking':boundary}
for aa,bb in zip(gzip.open(O/'current-resume6000-wire.jsonl.gz','rt'),gzip.open(O/'canonical-resume6000-wire.jsonl.gz','rt'),strict=True):
 a,b=json.loads(aa),json.loads(bb);assert(a['i'],a['at'],a['sample'])==(b['i'],b['at'],b['sample']);out['pairedPolls']+=1
assert out['pairedPolls']==3000
(O/'capture-verification.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(out,indent=2))
