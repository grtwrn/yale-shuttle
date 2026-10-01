"""Independent read-only checks/summaries for the frozen full-path experiment.
Run from the workspace root. Does not fit a model or change application files.
"""
import collections,datetime,hashlib,json,math,pathlib,sqlite3,statistics
D=pathlib.Path(__file__).resolve().parent
F=['raw-score.json','raw-unclamped-score.json','raw-baseline-floor-score.json','raw-candidate-floor-score.json']
selected=[(11,48,'standing',0),(11,48,'standing',60),(11,48,'standing',180),(11,48,'standing',300),(11,48,'departure',0),(11,48,'departure',30),(11,4,'standing',0),(11,4,'standing',60),(121,48,'standing',0),(121,48,'standing',60),(121,48,'departure',0),(121,48,'departure',60)]
def wis(r,a):
 p=r[a];y=r['truthSec'];return (.5*abs(p['eta']-y)+.1*(p['high']-p['low']+10*max(0,p['low']-y)+10*max(0,y-p['high'])))/1.5
out={'note':'Retrospective, two dates, provider-derived outcomes. Checkpoints are repeated within visits; no independence or calibration guarantee. Signed error is prediction minus observed remaining time.','files':{},'summaries':{},'checks':[]}
for file in F:
 p=D/file
 if not p.exists():continue
 d=json.loads(p.read_text());rs=d['checkpoints'];assert d['input']['minWarmSec']==600
 out['files'][file]=hashlib.sha256(p.read_bytes()).hexdigest()
 for s in d['scores']:
  group=[r for r in rs if(r['sourceStop'],r['target'],r['phase'],r['checkpointSec'])==(s['sourceStop'],s['target'],s['phase'],s['checkpointSec'])]
  for a in ['baseline','candidate']:
   m=s['allObserved'][a];assert len(group)==m['n'];assert abs(statistics.mean(wis(r,a)for r in group)-m['WIS'])<1e-8
   assert all(0<=r[a]['low']<=r[a]['high'] for r in group)
   assert m['early']==sum(r['truthSec']<r[a]['low']for r in group)
   assert m['late']==sum(r['truthSec']>r[a]['high']for r in group)
   assert abs(statistics.mean(abs(r[a]['eta']-r['truthSec'])for r in group)-m['maeSec'])<1e-8
 table=[]
 for key in selected:
  s=next(s for s in d['scores']if(s['sourceStop'],s['target'],s['phase'],s['checkpointSec'])==key)
  group=[r for r in rs if(r['sourceStop'],r['target'],r['phase'],r['checkpointSec'])==key]
  delta=[abs(r['candidate']['eta']-r['truthSec'])-abs(r['baseline']['eta']-r['truthSec'])for r in group]
  table.append(dict(key=key,allObserved=s['allObserved'],stoppedTargetsOnly=s['stoppedTargetsOnly'],byDate=s['byDate'],candidateAEWorseByGT1=sum(x>1 for x in delta),candidateAEBetterByGT1=sum(x< -1 for x in delta),candidatePointLaterByGT1=sum(r['candidate']['eta']-r['baseline']['eta']>1 for r in group)))
 out['summaries'][file]={'input':d['input'],'counts':d['counts'],'actualScoredSources':len({r['sourceId']for r in rs}),'actualScoredTargets':len({r['targetVisitId']for r in rs}),'dates':sorted({r['day']for r in rs}),'buses':sorted({r['bus']for r in rs}),'selected':table,'jumpScores':d['jumpScores']}
 out['checks'].append({'file':file,'checkpointRows':len(rs),'scoreGroups':len(d['scores']),'allMAE_WIS_tailCountsVerified':True})
# Match fixed first-standing checkpoints to the actual filter clock and raw lap.
d=json.loads((D/'raw-score.json').read_text());frames={}
for line in (D/'raw-frames.jsonl').open():
 f=json.loads(line);at=round(datetime.datetime.fromisoformat(f['at'].replace('Z','+00:00')).timestamp()*1000)
 for b in f['buses']:frames[(at,b['bus_name'].lstrip('#'))]=b
conn=sqlite3.connect('file:'+str(D/'outcomes.db')+'?mode=ro',uri=True);conn.row_factory=sqlite3.Row
clocks=[]
for r in d['checkpoints']:
 if r['target']!=48 or r['phase']!='standing' or r['checkpointSec']!=0:continue
 s=dict(conn.execute('SELECT * FROM stop_visits WHERE id=?',(r['sourceId'],)).fetchone());b=frames[(r['at'],r['bus'])]
 clocks.append({k:r[k]for k in ['sourceId','sourceStop','day','bus','at','rested','since','source']}|{'pinnedAt':s['pinned_at'],'anchoredAt':s['anchored_at'],'departedAt':s['departed_at'],'ownLapAvailable':str(r['sourceStop'])in b.get('lap',{}),'currentClockMinusPinSec':(r['since']-s['pinned_at'])/1000 if r.get('rested')and r.get('source')==r['sourceStop'] else None})
out['clockAudit']=clocks
out['clockSummary']={}
for source in [11,121]:
 rs=[r for r in clocks if r['sourceStop']==source];deltas=[r['currentClockMinusPinSec']for r in rs if r['currentClockMinusPinSec']is not None]
 out['clockSummary'][source]={'n':len(rs),'ownLapAvailable':sum(r['ownLapAvailable']for r in rs),'establishedAtSource':len(deltas),'originMinusPinMedianSec':statistics.median(deltas),'largeMismatchSourceIds':[r['sourceId']for r in rs if r['currentClockMinusPinSec']is not None and abs(r['currentClockMinusPinSec'])>120]}
conn.close();(D/'full-path-review-audit.json').write_text(json.dumps(out,indent=2)+'\n')
print(json.dumps({'checks':out['checks'],'clockSummary':out['clockSummary'],'output':str(D/'full-path-review-audit.json')},indent=2))
