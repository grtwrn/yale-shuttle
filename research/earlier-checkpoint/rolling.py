"""Freshness sensitivity: identical algorithms, history through the prior day.

Added after the frozen-history results. No within-day outcomes enter a forecast;
no tuning or candidate selection. This is robustness on reused evaluation days.
"""
import datetime as dt
import json
from evaluate import ARMS, Labels, OUT, Predictor, TZ, bootstrap, metrics, read, write

labels=Labels()
rows=read(OUT/'primary-scored.jsonl.gz')
calibration=json.loads((OUT/'frozen-calibration.json').read_text())
pads={a:r['padSeconds'] for a,r in calibration['arms'].items()}
test=[r for r in rows if r['day']>'2026-09-16']
models={}
for day in sorted(set(r['day'] for r in test)):
    cutoff=int(dt.datetime.fromisoformat(day).replace(tzinfo=TZ).timestamp()*1000)
    models[day]=Predictor(labels.episodes,cutoff=cutoff)
new=[]
for r in test:
    forecast={a:models[r['day']].predict(r,a) for a in ARMS}
    forecast['logged_production']=r['forecasts']['logged_production']
    new.append({**r,'forecasts':forecast})
write('rolling-scored',new)
results={'method':'The same frozen model families with training expanded through midnight before each test day. September16 interval padding retained. No same-day target outcomes, tuning or model selection. This sensitivity was added after initial scores, and reuses those evaluation days.','days':{},'pairs':{},'division':{}}
for day,model in models.items():
    results['days'][day]={'cutoff':model.cutoff,'historyByOriginTarget':{str(k):len(v) for k,v in model.paths.items()}}
for arm in ARMS:
    paired=[r for r in new if r['forecasts']['logged_production']['forecast'] and r['forecasts'][arm]['forecast']]
    results['pairs'][arm]={'production':metrics(paired,'logged_production'),'candidate':metrics(paired,arm,True,pads),'deltaBootstrap':bootstrap(paired,arm,pads)}
    results['division'][arm]={}
    for day in ['all']+sorted(models):
        rs=[r for r in paired if r['target']==48 and (day=='all' or r['day']==day)]
        results['division'][arm][day]={'production':metrics(rs,'logged_production'),'candidate':metrics(rs,arm,True,pads)}
# Replay-feature and outcome-independent history deletion verification by day.
for day,model in models.items():
    prefix=Predictor([e for e in labels.episodes if e['end']<model.cutoff],cutoff=model.cutoff)
    for r in [r for r in test if r['day']==day][::71]:
        for arm in ARMS:assert model.predict(r,arm)==prefix.predict(r,arm)
results['futureDeletionInvariant']=True
(OUT/'rolling-summary.json').write_text(json.dumps(results,indent=2))
print(json.dumps(results['division'],indent=2))
