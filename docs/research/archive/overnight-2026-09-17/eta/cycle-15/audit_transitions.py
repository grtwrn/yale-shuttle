from pathlib import Path
import json,gzip,collections
O=Path(__file__).resolve().parent;score=json.loads((O/'score.json').read_text());audit=json.loads((O/'largest-case-audit.json').read_text());meta=json.loads((O/'current-meta.json').read_text());top={int(k):v['stops'] for k,v in meta['routeMeta'].items()}
selected=[];seen=set()
for r in [x['forecast'] for x in audit['selectedAudits']]+score['largestPointRegressions'][:10]:
 k=(r['poll'],r['route'],r['bus'],r['targetIndex'],r['occurrence'])
 if k not in seen:seen.add(k);selected.append(r)
wanted={i for r in selected for i in range(max(0,r['poll']-3),r['poll']+4)};frames={};raw={}
for arm in ['current','canonical']:
 frames[arm]={}
 for line in gzip.open(O/(arm+'-wire.jsonl.gz'),'rt'):
  f=json.loads(line)
  if f['i'] in wanted:frames[arm][f['i']]=f
for i,line in enumerate((O.parent/'cycle-14/all-route-raw-frames.jsonl').open()):
 if i in wanted:raw[i]=json.loads(line)
 if i>max(wanted):break
result=[]
for r in selected:
 rows=[]
 for i in range(max(0,r['poll']-3),r['poll']+4):
  fraw=raw.get(i)
  if fraw is None:continue
  x={'poll':i,'rawBuses':[b for b in fraw['buses'] if b['route_id']==r['route'] and b['bus_name'].lstrip('#')==r['bus']]}
  for arm in ['current','canonical']:
   f=frames[arm].get(i)
   if not f:continue
   buses=f['wire']['buses'];bidx=[j for j,b in enumerate(buses) if b[0]==r['bus'] and b[1]==meta['routeMeta'][str(r['route'])]['label']]
   if len(bidx)!=1:x[arm]={'wireBusAvailable':False};continue
   bi=bidx[0];br=[z for z in f['wire']['rows'] if z[0]==bi];seq=top[r['route']];N=len(seq);origins=[j for j in range(N) if all(seq[(j+z[5])%N]==z[1] for z in br)];assert len(origins)==1
   rr=sorted([z for z in br if (origins[0]+z[5])%N==r['targetIndex']],key=lambda z:z[5]);track=f['tracking'][buses[bi][1]+'|'+r['bus']]
   x[arm]={'at':f['at'],'tracking':track,'pricingOriginIndex':origins[0],'targetRowsBothOccurrences':rr,'wireBusAvailable':True}
  rows.append(x)
 result.append({'focal':r,'window':rows,'interpretation':'Kernel-arm movement belief and pricing-origin/zero-hop changes are observed here. This is descriptive diagnosis, not a proof that either trajectory is physically correct. Original GPS and reconstructed collector flags are distinguished. No tail cap or row exclusion.'})
(O/'transition-audit.json').write_text(json.dumps({'cases':result,'count':len(result),'uniquePolls':len(wanted),'framesBothArms':{a:len(f) for a,f in frames.items()}},indent=2)+'\n');print(json.dumps({'cases':len(result),'uniquePolls':len(wanted),'framesBothArms':{a:len(f) for a,f in frames.items()}}))
