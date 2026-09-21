import collections, json, math, statistics as st
from prepare import HERE, OUT, ROUTES, read, date
TEST=1789617600000 # 2026-09-17 00:00 ET
ARMS=['K10','K5','K10_first10','K5_first10']
stop_names={s['id']:s['name'] for s in json.loads((HERE/'data/topology.json').read_text())['stops']}
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
def main():
    visits=read(OUT/'stop_visits.jsonl.gz');bybus=collections.defaultdict(list)
    for v in visits:bybus[v['bus_name'],v['route_id']].append(v)
    expected=json.loads((HERE/'reference-35651990480.json').read_text())
    current=json.loads((OUT/'legacy-nearest/summary.json').read_text())
    for rid,arms in expected.items():
        for arm,sections in arms.items():
            for section,metrics in sections.items():
                if section=='all':continue # New explicit later-lap exclusion affects fallback-only rows.
                for key,value in metrics.items():assert current['routes'][rid][arm][section][key]==value,(rid,arm,section,key)
    for directory in (OUT,OUT/'long90'):
        rows=[r for r in read(directory/'scored.jsonl.gz') if r['at']>=TEST]
        forecasts=[r for r in read(directory/'forecasts.jsonl.gz') if r['at']>=TEST]
        audit=dict(originalPrimaryReproduced=True,routes={},ordering={},boundaries={},worstPhysical={})
        for arm in ARMS:
            for r in forecasts:
                p=r['forecasts'][arm];f=p['forecast']
                assert all(math.isfinite(f[k]) for k in ('eta','low','high'))
                assert f['low']<=f['eta']<=f['high']
                if p['changed']:assert f['eta']>60
                if p['reason']=='released/live':assert f==r['baseline']
            audit['ordering'][arm]=order(rows,arm);audit['boundaries'][arm]=boundaries(rows,arm)
        for rid in ROUTES:
            rs=[r for r in rows if r['route']==rid];audit['routes'][rid]={}
            for arm in ARMS:
                changed=[r for r in rs if r['forecasts'][arm]['changed']]
                unique={r['label']['id']:r for r in changed}
                journeys=collections.defaultdict(list)
                for r in changed:journeys[r['bus'],r['forecasts'][arm]['origin']].append(r)
                audit['routes'][rid][arm]=dict(changedSnapshots=len(changed),physicalTargetVisits=len(unique),sourceDepartures=len(journeys),sourceToTargetOver45min=sum(r['label']['arrival']-r['forecasts'][arm]['origin']>2700000 for r in unique.values()),unsupportedTargets=dict(collections.Counter(stop_names.get(r['forecasts'][arm].get('unsupportedTarget'),'unknown') for r in rs if r['forecasts'][arm]['reason']=='group lacks historical support')))
                # Average snapshots within each physical target, then average
                # those targets within a source trip to avoid pseudo-replication.
                trip_deltas=[]
                for key,group in journeys.items():
                    byvisit=collections.defaultdict(list)
                    for r in group:
                        f=r['forecasts'][arm]['forecast'];b=r['baseline'];y=r['truth']
                        byvisit[r['label']['id']].append((abs(f['eta']-y)-abs(b['eta']-y),(f['high']-f['low'])-(b['high']-b['low']),int(f['low']<=y<=f['high'])-int(b['low']<=y<=b['high'])))
                    trip_deltas.append(dict(bus=key[0],origin=key[1],day=date(key[1]),visits=len(byvisit),**{name:st.mean(st.mean(m[i] for m in ms) for ms in byvisit.values()) for i,name in enumerate(('maeDelta','widthDelta','coverageDelta'))}))
                audit['routes'][rid][arm]['tripDeltas']=trip_deltas
                # Physical visits, not duplicate snapshots, for worst examples.
                worst=sorted(unique.values(),key=lambda r:abs(r['forecasts'][arm]['forecast']['eta']-r['truth']),reverse=True)[:3]
                physical=[]
                for r in worst:
                    p=r['forecasts'][arm];span=[v for v in bybus[r['bus'],rid] if v['arrived_at'] is not None and p['origin']<=v['arrived_at']<=r['label']['arrival']]
                    physical.append(dict(bus=r['bus'],at=r['at'],target=stop_names[r['target']],sourceDeparture=p['origin'],wholeJourneySeconds=(r['label']['arrival']-p['origin'])/1000,truth=r['truth'],candidate=p['forecast'],usual=r['baseline'],waits=[dict(stop=stop_names[v['stop_id']],arrival=v['arrived_at'],departure=v['departed_at'],stand=v['stand_sec']) for v in span if (v['stand_sec'] or 0)>=180]))
                audit['worstPhysical'][str(rid)+'/'+arm]=physical
        (directory/'audit.json').write_text(json.dumps(audit,indent=2))
        print(json.dumps(dict(experiment=directory.name,ordering={k:{a:b for a,b in v.items() if a!='examples'} for k,v in audit['ordering'].items()},routes={rid:{a:{k:v for k,v in result.items() if k not in ('tripDeltas','unsupportedTargets')} for a,result in arms.items()} for rid,arms in audit['routes'].items()})))
if __name__=='__main__':main()
