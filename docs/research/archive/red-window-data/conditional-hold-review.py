"""Independent read-only consistency/provenance audit of the component screen."""
import collections, datetime, hashlib, json, math, pathlib, sqlite3, statistics
from zoneinfo import ZoneInfo
import numpy as np
ROOT=pathlib.Path('/home/gwarren/projects/yale-shuttle-watcher'); HERE=ROOT/'red-window-data'
inp=json.loads((HERE/'conditional-hold-input.json').read_text())
screen=json.loads((HERE/'conditional-hold-screen.json').read_text())
patch=json.loads((HERE/'prior-model-0914.json').read_text())
cut=int(datetime.datetime(2026,9,14,tzinfo=ZoneInfo('America/New_York')).timestamp()*1000)
db=sqlite3.connect('file:'+str(ROOT/'red-eta-data/replay-lap.db')+'?mode=ro',uri=True);db.row_factory=sqlite3.Row
out={'inputHashes':{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in [HERE/'conditional-hold-prepare.py',HERE/'conditional-hold-input.json',HERE/'conditional-hold-screen.mts',HERE/'conditional-hold-screen.json',HERE/'prior-model-0914.json']},'cutoffMs':cut,'stops':[]}
for m,r in zip(inp['models'],screen['reports']):
    assert m['stop']==r['stop']; stop=m['stop']; fit=patch['dwells']['3'][str(stop)]
    priorIds={v['id'] for v in m['prior']}; testIds={v['id'] for v in m['test']}
    assert not priorIds&testIds
    assert all(v['ready']<cut for v in m['prior']) and all(v['a']>=cut for v in m['test'])
    rs=[dict(v) for v in db.execute("""SELECT * FROM stop_visits WHERE route_id=3 AND stop_id=? AND anchored_at>=? AND anchored_at<=?
      AND (CASE WHEN departed_at IS NULL AND outcome='passed' THEN MAX(anchored_at,COALESCE(first_moved_at,anchored_at)) ELSE MAX(departed_at,COALESCE(first_moved_at,departed_at)) END)+MAX(0,COALESCE(confirm_sec,0))*1000<=?
      AND pinned_at IS NOT NULL AND ((outcome='stopped' AND departed_at IS NOT NULL AND departed_at>=pinned_at) OR outcome='passed')""",(stop,cut-30*86400000,cut,cut))]
    vals=[0 if v['outcome']=='passed' else (v['departed_at']-v['pinned_at'])/1000 for v in rs]
    rounded=np.rint(np.quantile(vals,[(i+.5)/10 for i in range(10)])).tolist()
    assert len(rs)==fit['qn'] and rounded==fit['q']
    assert not {v['id'] for v in rs}&testIds
    def factor(v):
        lap=v['lap']
        return 1 if lap is None or not .65*fit['lapM']<=lap<=1.65*fit['lapM'] else min(2,max(.35,1+fit['lapN']/(fit['lapN']+19)*fit['lapB']*(lap-fit['lapM'])))
    eligible=[v for v in m['prior'] if v['lap'] is not None and .65*fit['lapM']<=v['lap']<=1.65*fit['lapM']]
    checked=0
    for summary in r['summaries']:
        elapsed=summary['elapsed']; ids={v['id'] for v in m['test'] if v['y']>elapsed}
        for arm,saved in summary['arms'].items():
            rec=[v for v in r['records'] if v['arm']==arm and v['elapsed']==elapsed]
            assert len(rec)==len(ids) and {v['id'] for v in rec}==ids
            if not rec:continue
            expected={'n':len(rec),'covered':sum(v['low']<=v['truth']<=v['high'] for v in rec),'early':sum(v['truth']<v['low'] for v in rec),'late':sum(v['truth']>v['high'] for v in rec),
             'maeSec':statistics.mean(abs(v['point']-v['truth']) for v in rec),'widthSec':statistics.mean(v['high']-v['low'] for v in rec),
             'WIS':statistics.mean((.5*abs(v['point']-v['truth'])+.1*(v['high']-v['low']+10*max(0,v['low']-v['truth'])+10*max(0,v['truth']-v['high'])))/1.5 for v in rec),
             'earlyPoint120':sum(v['point']-v['truth']>120 for v in rec),'latePoint120':sum(v['truth']-v['point']>120 for v in rec),'fallback':sum(v['fallback'] for v in rec)}
            for k,v in expected.items():assert math.isclose(v,saved[k],abs_tol=1e-8), (stop,elapsed,arm,k)
            for v in rec:
                assert all(math.isfinite(v[k]) for k in ['low','point','high']) and 0<=v['low']<=v['point']<=v['high']
                if v['fallback']:
                    base=next(b for b in r['records'] if b['id']==v['id'] and b['elapsed']==elapsed and b['arm']=='current_scaled_marginal')
                    assert all(v[k]==base[k] for k in ['low','point','high'])
            checked+=len(rec)
    effects={day:{str(s['elapsed']):{arm:{k:round(v[k]-s['arms']['current_scaled_marginal'][k],3) for k in ['maeSec','widthSec','WIS']} for arm,v in s['arms'].items() if arm!='current_scaled_marginal' and v['n']} for s in rows} for day,rows in r['byDate'].items()}
    out['stops'].append({'stop':stop,'baselineN':len(rs),'pinnedPassN':sum(v['outcome']=='passed' for v in rs),'candidatePriorN':len(m['prior']),'normalizedN':len(eligible),'baselineQuantilesExact':True,'latestBaselineDepartureMs':max(v['departed_at'] or 0 for v in rs),'legacyPivotSec':fit['lapM'],'modernEligiblePriorLapMedianSec':statistics.median(v['lap'] for v in eligible),'modernEligiblePriorFactorMedian':statistics.median(factor(v) for v in eligible),'modernPriorHoldMedianSec':statistics.median(v['y'] for v in m['prior']),'normalizedShapeMedianSec':statistics.median(v['y']/factor(v) for v in eligible),'auditedPredictionRecords':checked,'byDateDifferences':effects})
(HERE/'conditional-hold-review-audit.json').write_text(json.dumps(out,indent=2)+'\n')
print(json.dumps([{k:v for k,v in x.items() if k!='byDateDifferences'} for x in out['stops']],indent=2))
