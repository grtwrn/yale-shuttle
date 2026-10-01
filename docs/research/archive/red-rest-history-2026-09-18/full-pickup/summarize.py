from pathlib import Path
import collections,json,statistics

out=Path(__file__).resolve().parent
result={}
fresh={r['id'] for r in json.loads((out/'../own-history/extension-cohort.json').read_text())}
for comparator in ['core','union']:
    data=json.loads((out/f'score-{comparator}.json').read_text())
    supported=set(json.loads((out/'history-meta.json').read_text())['historyAudit']['counts']['history']['overrideIds'])
    rows=data['checkpoints']
    groups=collections.defaultdict(list)
    for r in rows:
        for scope in ['all']+(['intervened_visits'] if r['sourceId'] in supported else []):
            splits=['all',r['day'],'bus'+r['bus']]
            if r['day']=='2026-09-18':splits.append('Sep18_fresh' if r['sourceId'] in fresh else 'Sep18_morning')
            for split in splits:
                groups[(scope,split,r['target'],r['phase'],'all')].append(r)
                groups[(scope,split,r['target'],r['phase'],str(r['checkpointSec']))].append(r)
    summaries=[]
    for key,rs in groups.items():
        visits=collections.Counter(r['sourceId'] for r in rs)
        w=[1/(len(visits)*visits[r['sourceId']]) for r in rs]
        arms={}
        for arm in ['baseline','candidate']:
            errors=[abs(r[arm]['eta']-r['truthSec']) for r in rs]
            widths=[r[arm]['high']-r[arm]['low'] for r in rs]
            early=[max(0,r[arm]['low']-r['truthSec']) for r in rs]
            late=[max(0,r['truthSec']-r[arm]['high']) for r in rs]
            wis=[(.5*e+.1*width+lo+hi)/1.5 for e,width,lo,hi in zip(errors,widths,early,late)]
            arms[arm]={'maeSec':sum(a*b for a,b in zip(w,errors)), 'wis80Sec':sum(a*b for a,b in zip(w,wis)),
                'widthSec':sum(a*b for a,b in zip(w,widths)),'earlyCheckpoints':sum(x>0 for x in early),
                'lateCheckpoints':sum(x>0 for x in late),'maxEarlySec':max(early),'maxLateSec':max(late)}
        summaries.append(dict(zip(['scope','split','target','phase','age'],key),visits=len(visits),checkpoints=len(rs),arms=arms))
    result[comparator]={'counts':data['counts'],'jumpScores':data['jumpScores'],'summaries':summaries}
    for s in summaries:
        if s['scope']=='intervened_visits' and s['split'] in ['all','2026-09-16','2026-09-17','2026-09-18','Sep18_fresh','Sep18_morning'] and s['phase']=='standing' and s['age']=='all':
            print(comparator,json.dumps(s))
(out/'summary.json').write_text(json.dumps(result,indent=2)+'\n')
