"""Read-only raw GPS audit of the two largest held-out Winchester regressions."""
import collections, datetime, json, math, pathlib, sqlite3
D=pathlib.Path(__file__).resolve().parent
c=sqlite3.connect('file:'+str(D/'outcomes-complete.db')+'?mode=ro',uri=True);c.row_factory=sqlite3.Row
visits=[dict(r) for r in c.execute('SELECT * FROM stop_visits WHERE id IN (67957,68304)')]
score=json.loads((D/'final-holdout-score.json').read_text()); raw=collections.defaultdict(list)
for line in (D/'raw-complete-frames.jsonl').open():
 f=json.loads(line);t=round(datetime.datetime.fromisoformat(f['at'].replace('Z','+00:00')).timestamp()*1000)
 for v in visits:
  if not v['pinned_at']-15000<=t<=v['departed_at']+60000:continue
  for b in f['buses']:
   if b['bus_name']==v['bus_name'] and b['observed_at']==t:raw[v['id']].append(dict(at=t,**b))
report=[]
for v in visits:
 rr=raw[v['id']]; runs=[]
 for r in rr:
  if runs and (runs[-1]['lat'],runs[-1]['lon'])==(r['lat'],r['lon']):runs[-1]['end']=r['at'];runs[-1]['n']+=1
  else:runs.append(dict(start=r['at'],end=r['at'],lat=r['lat'],lon=r['lon'],n=1))
 final=next(r for r in runs if r['end']==v['departed_at'])
 move=next(r for r in rr if r['at']>v['departed_at'] and (r['lat'],r['lon'])!=(final['lat'],final['lon']))
 pins=sorted({r.get('at_stop_since') for r in rr if r['at']<=v['departed_at'] and r.get('at_stop_id')==11 and r.get('at_stop_since')})
 paths=[{k:j[k] for k in ['sourceId','target','targetVisitId','targetOutcome','targetClosestM','legIds'] if k in j} for j in score['journeys'] if j['sourceId']==v['id']]
 gaps=[(b['at']-a['at'])/1000 for a,b in zip(rr,rr[1:])]
 case=dict(id=v['id'],bus=v['bus_name'],hour=v['hour'],holdSec=(v['departed_at']-v['pinned_at'])/1000,polls=len(rr),maxGapSec=max(gaps),pins=pins,plateaus=[dict(**r,seconds=(r['end']-r['start'])/1000) for r in runs if r['end']-r['start']>=10000],finalPlateauSec=(final['end']-final['start'])/1000,firstFinalMoveLagSec=(move['at']-v['departed_at'])/1000,connectedTargets=paths,decision='retain: continuous recorded stop and onward movement; no proven measurement error')
 assert max(gaps)<15 and len(pins)==1 and 0<case['firstFinalMoveLagSec']<10 and len(paths)==2
 report.append(case)
(D/'final-regression-audit.json').write_text(json.dumps(report,indent=2)+'\n')
for r in report: print(json.dumps(r))
