import collections,json,statistics as st
from prepare import HERE,OUT,ROUTES,read,date
def order(rows,arm):
    groups=collections.defaultdict(dict)
    for r in rows:groups[r['bus'],r['route'],r['at']][r['target']]=r
    pairs=0;rev=0;new=0;examples=[]
    for group in groups.values():
        rs=sorted(group.values(),key=lambda r:r['stopsAhead'])
        for a,b in zip(rs,rs[1:]):
            if a['stopsAhead']<=0 or a['stopsAhead']>=b['stopsAhead']:continue
            pairs+=1
            bad=a['forecasts'][arm]['forecast']['eta']>b['forecasts'][arm]['forecast']['eta']+30
            old=a['baseline']['eta']>b['baseline']['eta']+30
            rev+=bad;new+=bad and not old
            if bad and not old and len(examples)<10:examples.append(dict(bus=a['bus'],route=a['route'],at=a['at'],earlier=a['target'],later=b['target'],a=a['forecasts'][arm],b=b['forecasts'][arm]))
    return dict(pairs=pairs,reversalsOver30=rev,introduced=new,examples=examples)
def boundaries(rows,arm):
    groups=collections.defaultdict(list)
    for r in rows:groups[r['bus'],r['route'],r['target'],r['label']['id']].append(r)
    changes=[];handoffs=[]
    for rs in groups.values():
        rs.sort(key=lambda r:r['at'])
        for a,b in zip(rs,rs[1:]):
            elapsed=(b['at']-a['at'])/1000
            if not 0<elapsed<=30:continue
            if a['forecasts'][arm]['changed']!=b['forecasts'][arm]['changed']:
                jump=b['forecasts'][arm]['forecast']['eta']-a['forecasts'][arm]['forecast']['eta']+elapsed
                row=dict(bus=b['bus'],route=b['route'],target=b['target'],at=b['at'],jump=jump,fromReason=a['forecasts'][arm]['reason'],toReason=b['forecasts'][arm]['reason'])
                changes.append(row)
                if b['forecasts'][arm]['reason']=='released/live':handoffs.append(row)
    return dict(changes=len(changes),upOver60=sum(r['jump']>60 for r in changes),downOver60=sum(r['jump']<-60 for r in changes),observedReleaseHandoffs=len(handoffs),maxReleaseAbsJump=max([abs(r['jump']) for r in handoffs],default=None),worst=sorted(changes,key=lambda r:abs(r['jump']),reverse=True)[:8])

rows=[r for r in read(OUT/'long90/scored.jsonl.gz') if r['at']>=1789617600000]
summary=json.loads((OUT/'long90/summary.json').read_text())
result={};selected={}
for rid,route in ROUTES.items():
 rs=[r for r in rows if r['route']==rid];result[rid]={}
 for arm,metrics in summary['routes'][str(rid)].items():
  changed=[r for r in rs if r['forecasts'][arm]['changed']]
  c,b=metrics['changed'],metrics['usualOnChanged']
  ordering=order(rs,arm)
  passed=bool(c['visits']>=12 and c['days']>=2 and c['mae']<=b['mae']+20 and c['width']<=b['width']-60 and c['coverage']>=max(.8,b['coverage']-.1) and c['falseNowSnapshots']<=b['falseNowSnapshots'] and ordering['introduced']==0)
  trips=collections.Counter((r['bus'],r['forecasts'][arm]['origin']) for r in changed)
  result[rid][arm]=dict(passed=passed,ordering=ordering,boundaries=boundaries(rs,arm),sourceTrips=len(trips),largestSourceSnapshotShare=max(trips.values(),default=0)/max(1,len(changed)),sourceDates=sorted({date(r['forecasts'][arm]['origin']) for r in changed}),usual=b,candidate=c)
 passing=[a for a,v in result[rid].items() if v['passed']]
 if passing and rid not in (1,3,16):selected[rid]=min(passing,key=lambda a:result[rid][a]['candidate']['width'])
(OUT/'long90/audit.json').write_text(json.dumps(result,indent=2))
(OUT/'long90/selection.json').write_text(json.dumps(dict(selected=selected,preservedExisting=[1,3,16],note='Reused development dates; not fresh holdout validation'),indent=2))
print(json.dumps(dict(selected=selected,audits={rid:result[rid][a] for rid,a in selected.items()})))
