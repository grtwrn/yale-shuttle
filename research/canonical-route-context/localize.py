import collections
import gzip
import hashlib
import json
import math
from pathlib import Path
import sys

HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE.parent/'canonical-diagnostics'))
import diagnose as d
ev=d.ev
OUT=HERE/'results'
TRANSFER={9:{10,11,19,20},10:{3,4,13,14}}
RAW_HASH='3990d06ebdab596cfebdd7f03c528f7efcbb46fd3f6af68a9d64ede648e220b9'
TOPO_HASH='eb753d58c4ace616e844b3a54842978c4ec46833373560e1b236d7b5d61b40bc'


def xy(lat,lon):
    return ((lon+72.94)*111195*math.cos(math.radians(41.3)),(lat-41.3)*111195)


def segment(point,a,b):
    dx,dy=b[0]-a[0],b[1]-a[1]; norm=dx*dx+dy*dy
    t=max(0,min(1,((point[0]-a[0])*dx+(point[1]-a[1])*dy)/norm)) if norm else 0
    return math.hypot(point[0]-a[0]-t*dx,point[1]-a[1]-t*dy),(dx,dy)


def locate(a,b,segments):
    start,end=xy(a['lat'],a['lon']),xy(b['lat'],b['lon'])
    middle=((start[0]+end[0])/2,(start[1]+end[1])/2)
    movement=(end[0]-start[0],end[1]-start[1]); move=math.hypot(*movement)
    per_leg={}
    for index,p,q in segments:
        distance,direction=segment(middle,p,q)
        denominator=move*math.hypot(*direction)
        cosine=sum(x*y for x,y in zip(movement,direction))/denominator if denominator else None
        if index not in per_leg or distance<per_leg[index]['distanceM']:
            per_leg[index]=dict(index=index,distanceM=distance,directionCos=cosine)
    best=min(v['distanceM'] for v in per_leg.values()) if per_leg else None
    candidates=[v for v in per_leg.values() if v['distanceM']<=best+10] if best is not None else []
    return dict(midpointXY=middle,bestDistanceM=best,candidates=candidates)


def main():
    rawfile=ev.IN/'raw_positions.jsonl.gz'
    assert hashlib.sha256(rawfile.read_bytes()).hexdigest()==RAW_HASH
    assert hashlib.sha256((HERE.parent/'canonical-windows/results/canonical-topology.json').read_bytes()).hexdigest()==TOPO_HASH
    geometry=json.loads((OUT/'geometry.json').read_text())
    routes={r['id']:r for r in geometry['routes']}
    prior=json.loads((HERE.parent/'speed-frozen/summary.json').read_text())
    selections={(s['edge']['route'],s['edge']['bus'],s['edge']['start'],s['edge']['end']):[] for s in prior['selections']}
    for s in prior['selections']:selections[s['edge']['route'],s['edge']['bus'],s['edge']['start'],s['edge']['end']].append(s['selection'])
    segments={}
    for rid,r in routes.items():
        segments[rid]=[(leg['index'],xy(*a),xy(*b)) for leg in r['legs'] if not leg['bridged']
            for a,b in zip(leg['slice'],leg['slice'][1:])]
    groups=collections.defaultdict(list)
    for r in ev.read(rawfile):groups[r['bus_name']].append(r)
    records=[]
    for bus,rs in groups.items():
        rs.sort(key=lambda r:r['collected_at'])
        for a,b in zip(rs,rs[1:]):
            sec,dist,mask=d.edge(a,b)
            rid=a['route_id']
            if rid not in routes or not sec>0 or a['route_id']!=b['route_id'] or a['bus_id']!=b['bus_id'] or dist/sec<=22:continue
            location=locate(a,b,segments[rid]); candidates=location['candidates']
            transfer=TRANSFER.get(rid,set());indices={c['index'] for c in candidates}
            category='unavailable' if not candidates else 'intercampus' if indices<=transfer else 'mixed' if indices&transfer else 'other_route_legs'
            records.append(dict(route=rid,bus=bus,provider=a['bus_id'],start=a['collected_at'],end=b['collected_at'],
                seconds=sec,speedMps=dist/sec,selection=selections.get((rid,bus,a['collected_at'],b['collected_at']),[]),
                category=category,**location))
    result=dict(rawSha256=RAW_HASH,topologySha256=TOPO_HASH,thresholdsUnchanged=True,routes={},selections=[])
    for rid,r in routes.items():
        rs=[row for row in records if row['route']==rid]
        assert len(rs)==prior['routes'][str(rid)]['n']
        result['routes'][rid]=dict(name=r['name'],sameHighEdgeSample=len(rs),
            bridgedLegs=[leg['index'] for leg in r['legs'] if leg['bridged']],
            distanceM=d.distribution([row['bestDistanceM'] for row in rs if row['bestDistanceM'] is not None]),
            categories=dict(collections.Counter(row['category'] for row in rs)),
            bands={str(m):dict(collections.Counter(row['category'] for row in rs if row['bestDistanceM'] is not None and row['bestDistanceM']<=m)) for m in (25,75,150)},
            nearestLegCandidates=dict(collections.Counter(c['index'] for row in rs for c in row['candidates'])),
            ambiguousLegs=sum(len(row['candidates'])>1 for row in rs),
            atLeastOneForwardCandidate=sum(any(c['directionCos'] is not None and c['directionCos']>0 for c in row['candidates']) for row in rs),
            intercampusLegs=[dict(index=leg['index'],fromStop=leg['from']['name'],toStop=leg['to']['name'],metres=leg['metres'])
                for leg in r['legs'] if leg['index'] in TRANSFER.get(rid,set())])
        for row in rs:
            if row['selection']:
                entry=dict(row)
                entry['candidates']=[dict(c,fromStop=r['legs'][c['index']]['from']['name'],toStop=r['legs'][c['index']]['to']['name']) for c in row['candidates']]
                result['selections'].append(entry)
    assert sum(len(s['selection']) for s in result['selections'])==len(prior['selections'])
    (OUT/'summary.json').write_text(json.dumps(result,indent=2))
    with gzip.open(OUT/'located-high-edges.jsonl.gz','wt') as f:
        for row in records:f.write(json.dumps(row,separators=(',',':'))+'\n')
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    for rid in (9,10):
        route=routes[rid];rs=[r for r in records if r['route']==rid]
        fig,ax=plt.subplots(figsize=(9,8),layout='constrained')
        line=[xy(*p) for p in route['path']]
        ax.plot([p[0]/1000 for p in line],[p[1]/1000 for p in line],color='#777777',lw=1,label='Published route')
        for leg in route['legs']:
            if leg['index'] in TRANSFER[rid] and not leg['bridged']:
                pts=[xy(*p) for p in leg['slice']]
                ax.plot([p[0]/1000 for p in pts],[p[1]/1000 for p in pts],color='#e49d26',lw=3,alpha=.65)
        ax.scatter([r['midpointXY'][0]/1000 for r in rs],[r['midpointXY'][1]/1000 for r in rs],s=2,c='#9747a1',alpha=.15,label='Flagged edge midpoints')
        for row in rs:
            if row['selection']:
                x,y=row['midpointXY'];label='/'.join(row['selection'])+' '+row['bus']
                ax.scatter([x/1000],[y/1000],s=45,c='#d32f2f',zorder=5)
                ax.annotate(label,(x/1000,y/1000),xytext=(7,7),textcoords='offset points',fontsize=9,weight='bold')
        for stopid in (22,127,84,122,72):
            if stopid not in route['stops']:continue
            stop=next(s for s in geometry['stops'] if s['id']==stopid);x,y=xy(stop['lat'],stop['lon'])
            ax.scatter([x/1000],[y/1000],s=25,c='black');ax.annotate(stop['name'],(x/1000,y/1000),xytext=(5,-13),textcoords='offset points',fontsize=8)
        ax.set(title=route['name']+': public route geometry and unchanged >22 m/s sample',
            xlabel='East from reference, km',ylabel='North from reference, km',aspect='equal')
        ax.text(.01,.01,'Orange: predeclared intercampus transfer legs.\nPublished route geometry; no road-speed-limit inference.',transform=ax.transAxes,fontsize=8,bbox=dict(facecolor='white',alpha=.85))
        ax.legend(loc='upper left',fontsize=8);fig.savefig(OUT/f'route-{rid}.png',dpi=160);plt.close(fig)
    print(json.dumps(dict(sameHighEdges=len(records),sameSelections=len(prior['selections']),inputUnchanged=True)))


if __name__=='__main__':main()
