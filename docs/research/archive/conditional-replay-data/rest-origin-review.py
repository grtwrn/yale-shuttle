"""Read-only four-visit duration-origin audit. No database or application edits."""
import datetime,hashlib,json,math,pathlib,sqlite3
from zoneinfo import ZoneInfo
D=pathlib.Path(__file__).resolve().parent;TZ=ZoneInfo('America/New_York');IDS=[59602,59805,65237,66278]
db=sqlite3.connect('file:'+str(D/'outcomes.db')+'?mode=ro',uri=True);db.row_factory=sqlite3.Row
clocks={r['sourceId']:r for r in json.loads((D/'full-path-review-audit.json').read_text())['clockAudit']}
stop=dict(db.execute('SELECT * FROM stops WHERE id=11').fetchone())
def dist(r):
 a,b=math.radians(r['lat']),math.radians(stop['lat']);dl=math.radians(stop['lon']-r['lon']);return 6371000*2*math.asin(min(1,math.sqrt(math.sin((b-a)/2)**2+math.cos(a)*math.cos(b)*math.sin(dl/2)**2)))
def et(t):return datetime.datetime.fromtimestamp(t/1000,TZ).isoformat()
report={'method':'Four deliberately selected clock mismatches, not prevalence estimate. Exact repeated GPS coordinates are feed evidence of a plateau, not independent verification of doors or zero motion below deadband.','stop':stop,'visits':[]}
for id in IDS:
 v=dict(db.execute('SELECT * FROM stop_visits WHERE id=?',(id,)).fetchone());origin=clocks[id]['since']
 raw=[dict(r)for r in db.execute('SELECT * FROM raw_positions WHERE route_id=3 AND bus_name=? AND collected_at BETWEEN ? AND ? ORDER BY collected_at,id',(v['bus_name'],origin-60000,v['departed_at']+60000))];runs=[]
 for r in raw:
  if runs and (runs[-1]['lat'],runs[-1]['lon'])==(r['lat'],r['lon']):runs[-1]['end']=r['collected_at'];runs[-1]['n']+=1
  else:runs.append({'lat':r['lat'],'lon':r['lon'],'start':r['collected_at'],'end':r['collected_at'],'n':1,'distanceToStopM':dist(r),'initialLastStopId':r['last_stop_id']})
 for r in runs:r.update(durationSec=(r['end']-r['start'])/1000,startET=et(r['start']),endET=et(r['end']))
 plateaus=[r for r in runs if r['durationSec']>=15 and r['start']>=origin and r['start']<v['departed_at']]
 gap=max(({'after':a['collected_at'],'before':b['collected_at'],'sec':(b['collected_at']-a['collected_at'])/1000}for a,b in zip(raw,raw[1:])),key=lambda r:r['sec'])
 legs=[dict(r)for r in db.execute('SELECT * FROM legs WHERE route_id=3 AND bus_name=? AND to_stop_id=11 AND arrived_at BETWEEN ? AND ?',(v['bus_name'],origin-120000,v['pinned_at']+120000))]
 legacy=[dict(r)for r in db.execute('SELECT * FROM arrivals WHERE route_id=3 AND bus_name=? AND stop_id=11 AND arrived_at BETWEEN ? AND ? ORDER BY arrived_at',(v['bus_name'],origin-120000,v['departed_at']+60000))]
 report['visits'].append({'visit':v,'filterOrigin':origin,'filterOriginET':et(origin),'pinET':et(v['pinned_at']),'departureET':et(v['departed_at']),'pinMinusFilterOriginSec':(v['pinned_at']-origin)/1000,'departureMinusOriginSec':(v['departed_at']-origin)/1000,'pinnedDurationSec':(v['departed_at']-v['pinned_at'])/1000,'firstSustainedPlateauLagSec':(plateaus[0]['start']-origin)/1000,'longestPlateau':max(plateaus,key=lambda r:r['durationSec']),'maxRawGap':gap,'inboundLegs':legs,'legacyArrivals':legacy,'gpsRuns':runs})
# Actual served clocks around the truncated record, independently of raw reconstruction.
served=[]
for line in(D/'watcher17.jsonl').open():
 f=json.loads(line);at=round(datetime.datetime.fromisoformat(f['at'].replace('Z','+00:00')).timestamp()*1000)
 if 1789656280000<=at<=1789656370000:
  for b in f['buses']:
   if b['bus_name']=='#316':served.append({'at':at,'atET':et(at),'bus':b})
report['actualWatcher65237']=served
replay=json.loads((D/'rest-origin-replay.json').read_text());got=next(v for v in replay['runs']['restart_on_fresh_fix']['visitEvents']if v['kind']=='visit')
stored=replay['sourceVisit'];mapping={'anchoredAt':'anchored_at','pinnedAt':'pinned_at','arrivedAt':'arrived_at','departedAt':'departed_at','standSec':'stand_sec','insideSec':'inside_sec','outcome':'outcome','how':'how','confidence':'confidence','firstStepM':'first_step_m','steps':'steps','farM':'far_m','confirmSec':'confirm_sec','restPolls':'rest_polls','shuffles':'shuffles','firstMovedAt':'first_moved_at','lastAtRestAt':'last_at_rest_at','closestM':'closest_m'}
assert all(got[k]==stored[v]for k,v in mapping.items());report['restartReproduction']={'sourceId':65237,'matchedStoredFields':mapping,'allEqual':True,'seed':replay['inspectedSeed']}
report['inputHashes']={n:hashlib.sha256((D/n).read_bytes()).hexdigest()for n in['full-path-review-audit.json','rest-origin-replay.json','watcher17.jsonl']}
(D/'rest-origin-review.json').write_text(json.dumps(report,indent=2)+'\n')
for v in report['visits']:print(v['visit']['id'],v['filterOriginET'],v['pinET'],'pin/episode',round(v['pinnedDurationSec'],1),round(v['departureMinusOriginSec'],1),'longestfreeze',round(v['longestPlateau']['durationSec'],1),'m',round(v['longestPlateau']['distanceToStopM'],1),'startlag',round(v['firstSustainedPlateauLagSec'],1))
print('All',len(mapping),'stored65237fields exactly reproduced')
