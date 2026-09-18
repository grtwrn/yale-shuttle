"""Independent read-only gate/transition audit of the simple wire hazard switch."""
import bisect,collections,datetime,hashlib,json,math,pathlib,sqlite3,statistics
D=pathlib.Path(__file__).resolve().parent;R=D.parent/'conditional-replay-data';P=D/'release-wire-shadow.json';x=json.loads(P.read_text());series=json.loads((D/'release-wire-shadow-series.json').read_text())
frames={}
for line in (R/'raw-frames.jsonl').open():
 f=json.loads(line);at=datetime.datetime.fromisoformat(f['at'].replace('Z','+00:00')).timestamp()*1000
 assert at==round(at)
 for b in f['buses']:frames[b['bus_name'],at]=b
c=sqlite3.connect('file:'+str(R/'outcomes.db')+'?mode=ro',uri=True);c.row_factory=sqlite3.Row
vis={r['id']:dict(r)for r in c.execute('select * from stop_visits where route_id=3')};c.close()
def distance(b):return 6371000*math.hypot(math.radians(b['lat']-41.324661),math.radians(b['lon']+72.928677)*math.cos(math.radians(41.324661)))
freshTimes=collections.defaultdict(list)
for (bus,at),b in frames.items():
 if b.get('observed_at')==at:freshTimes[bus].append(at)
for ts in freshTimes.values():ts.sort()
def finalMovementTime(v):
 ts=freshTimes[v['bus_name']];i=bisect.bisect_right(ts,v['departed_at'])-1
 if i<0 or v['departed_at']-ts[i]>15000:return None
 base=frames[v['bus_name'],ts[i]]
 for t in ts[i+1:]:
  if t>v['departed_at']+60000:break
  b=frames[v['bus_name'],t]
  if (b['lat'],b['lon'])!=(base['lat'],base['lon']):return t
 return None
finalMotion={i:finalMovementTime(v)for i,v in vis.items()if v['stop_id']==11 and v['departed_at']is not None}
def gates(r):
 b=frames.get((r['bus'],r['at']));bad=[]
 if not b:return ['missing raw frame']
 if r['warmMs']<600000:bad.append('cold')
 if r['at']-b.get('observed_at',r['at'])>=45000:bad.append('stale')
 if b.get('at_stop_id')!=11:bad.append('collector stop not Winchester')
 if not b.get('stationary'):bad.append('collector pinned flag false')
 if not b.get('at_stop_since'):bad.append('no pin clock')
 if distance(b)>75:bad.append('outside75m')
 if r['stopsAhead']!={48:3,4:6}[r['target']]:bad.append('lead hops different')
 return bad
trans=[]
for s in series:
 for r in s['rows']:
  if r['mode']=='wire_pin_hazard':assert not gates(r)
 for a,b in zip(s['rows'],s['rows'][1:]):
  dt=(b['at']-a['at'])/1000
  if not 0<dt<=15:continue
  trans.append(dict(id=s['id'],target=s['target'],bus=s['bus'],at=b['at'],dt=dt,beforeMode=a['mode'],afterMode=b['mode'],beforeGateFailures=gates(a),afterGateFailures=gates(b),production=b['production']['eta']-a['production']['eta'],shadow=b['shadow']['eta']-a['shadow']['eta'],secondsSincePin=(b['at']-s['pin'])/1000,secondsSinceDeparture=(b['at']-s['departure'])/1000))
out=[]
for target in[48,4]:
 rr=[r for r in trans if r['target']==target];types=[]
 for mode in sorted({(r['beforeMode'],r['afterMode'])for r in rr}):
  ts=[r for r in rr if(r['beforeMode'],r['afterMode'])==mode]
  types.append(dict(beforeMode=mode[0],afterMode=mode[1],n=len(ts),shadowUp60=sum(r['shadow']>60 for r in ts),shadowUp120=sum(r['shadow']>120 for r in ts),absoluteShadowUp60=sum(r['shadow']+r['dt']>60 for r in ts),productionUp60=sum(r['production']>60 for r in ts),episodesWithShadowUp60=len({r['id']for r in ts if r['shadow']>60}),maxShadowUpSec=max(r['shadow']for r in ts),gateFailuresBeforeEntry=dict(collections.Counter(reason for r in ts for reason in r['beforeGateFailures']))if mode[0]!=mode[1]else None,gateFailuresAfterExit=dict(collections.Counter(reason for r in ts for reason in r['afterGateFailures']))if mode[0]!=mode[1]else None))
 out.append(dict(target=target,transitions=len(rr),types=types))
dep=[]
for target in [48,4]:
 for age in[0,5,15,30]:
  rr=[r for r in x['checkpoints']if r['target']==target and r['phase']=='departure'and r['age']==age]
  early=[r for r in rr if r['truth']<r['shadow']['low']]
  dep.append(dict(target=target,age=age,n=len(rr),changed=sum(r['mode']=='wire_pin_hazard'for r in rr),shadowEarly=len(early),earlyWithFinalRunCoordinateChangeObserved=sum(finalMotion.get(r['id'])is not None and finalMotion[r['id']]<=r['at']for r in early),allWithFinalRunCoordinateChangeObserved=sum(finalMotion.get(r['id'])is not None and finalMotion[r['id']]<=r['at']for r in rr),earlyLowerExcessSec=[r['shadow']['low']-r['truth']for r in early]))
# Independently recompute reported checkpoint MAE/WIS and counts.
for z in x['scores']:
 rr=[r for r in x['checkpoints']if(r['target'],r['phase'],r['age'])==(z['target'],z['phase'],z['age'])]
 for arm in ['production','shadow']:
  mae=statistics.mean(abs(r[arm]['eta']-r['truth'])for r in rr);wis=statistics.mean((.5*abs(r[arm]['eta']-r['truth'])+.1*(r[arm]['high']-r[arm]['low'])+max(0,r[arm]['low']-r['truth'])+max(0,r['truth']-r[arm]['high']))/1.5 for r in rr)
  assert len(rr)==z[arm]['n'] and abs(mae-z[arm]['mae'])<1e-8 and abs(wis-z[arm]['WIS'])<1e-8
report=dict(method=__doc__,inputSha256=hashlib.sha256(P.read_bytes()).hexdigest(),checks='Fresh-frame timestamps integral; every selected hazard row satisfies visible gate; checkpoint MAE/WIS/counts recomputed; every transition classified; retrospective departure endpoint distinguished from first subsequent raw coordinate change (first_moved_at is not a final-run availability timestamp).',originCount=len(x['originEvidence']),missingLapOriginCount=sum(not r['lapAvailable']for r in x['originEvidence']),transitions=out,departureMovement=dep,newUpwardJumps=sorted([r for r in trans if r['shadow']>60 and r['shadow']>r['production']],key=lambda r:r['shadow'],reverse=True))
(D/'release-wire-review.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({k:v for k,v in report.items()if k!='newUpwardJumps'},indent=2))
