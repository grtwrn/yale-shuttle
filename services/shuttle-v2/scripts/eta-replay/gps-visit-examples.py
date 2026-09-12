"""Illustrative GPS visit-order checks, not an ETA accuracy score.
First changed decision per route and UTC 3-hour bucket; report at most four
usable examples per route. Missing 45m curb hits and >90min horizons are
unscorable. A 100m exit is required to count a subsequent visit. The source
GPS is shared with the estimator, so this is corroboration, not independent truth.
"""
import json,math,bisect,sys
from collections import defaultdict
from pathlib import Path
# Usage: python3 gps-visit-examples.py PAYLOAD CAPTURE CHANGES OUTPUT
payload,capture,changes_path,output=sys.argv[1:]
base=json.load(open(payload)); coords=base['stop_coords'];changes=[json.loads(x) for x in open(changes_path)]
frames=[json.loads(x) for x in open(capture)]
need=defaultdict(set)
for x in changes:
 if x['route'] in [9,10]: need[x['before']['bus']].update([x['board'],x['alight']])
visits=defaultdict(list);inside={};prev={}
for f in frames:
 for b in f['buses']:
  bus=b['bus_name'].lstrip('#');t=f['t']
  for stop in need[bus]:
   c=coords.get(str(stop));key=(bus,stop)
   if not c:continue
   d=math.hypot((b['lat']-c['lat'])*111195,(b['lon']-c['lon'])*111195*math.cos(math.radians(c['lat'])))
   if t-prev.get(key,t)>60000:inside[key]=False
   if d<=45 and not inside.get(key,False):visits[key].append(t);inside[key]=True
   if d>100:inside[key]=False
   prev[key]=t
from datetime import datetime,timezone
def iso(t):return datetime.fromtimestamp(t/1000,timezone.utc).isoformat()
out=[];seen=set()
for x in changes:
 if x['route'] not in [9,10]:continue
 key=(x['route'],x['board'],x['alight'],x['before']['bus'])
 bucket=(x['route'],int(datetime.fromisoformat(x['at'].replace('Z','+00:00')).timestamp()//10800))
 if bucket in seen:continue
 seen.add(bucket)
 t=datetime.fromisoformat(x['at'].replace('Z','+00:00')).timestamp()*1000
 bv=visits[(key[3],key[1])];dv=visits[(key[3],key[2])];i=bisect.bisect_left(bv,t-15000)
 if i+1>=len(bv):continue
 p=bv[i];j=bisect.bisect_right(dv,p)
 if j>=len(dv) or max(bv[i+1],dv[j])-t>5400000:continue
 if True:
  out.append({**{k:x[k] for k in ['at','route','board','alight','before','after','why']},'supportsOrder':bv[i+1]<dv[j],'gpsPickup':iso(p),'gpsPickupAgain':iso(bv[i+1]),'gpsDestination':iso(dv[j])})
 # inspect one prespecified first change per UTC 3-hour bucket
out=[x for r in [9,10] for x in [y for y in out if y['route']==r][:4]]
Path(output).write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(out,indent=2))
