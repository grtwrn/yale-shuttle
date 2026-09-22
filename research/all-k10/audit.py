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
result={}
for rid,route in ROUTES.items():
 rs=[r for r in rows if r['route']==rid]
 changed=[r for r in rs if r['forecasts']['K10']['changed']]
 result[rid]=dict(name=route['name'],ordering=order(rs,'K10'),boundaries=boundaries(rs,'K10'),
     sourceTrips=len({(r['bus'],r['forecasts']['K10']['origin']) for r in changed}),
     sourceDates=sorted({date(r['forecasts']['K10']['origin']) for r in changed}))
(OUT/'long90/audit.json').write_text(json.dumps(result,indent=2))
print(json.dumps(result))
