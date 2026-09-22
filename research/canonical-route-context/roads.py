"""Independent descriptive highway proximity; never changes a quality gate."""
import collections
import gzip
import hashlib
import json
import math
from pathlib import Path
import sys
import numpy as np
import localize as l

HERE=Path(__file__).resolve().parent
OUT=HERE/'results'
d,ev=l.d,l.ev
BINS=(25,50,100,250,500,1000)


class Roads:
    def __init__(self,features):
        self.starts=[];self.ends=[];self.ids=[]
        for feature in features:
            for path in feature['geometry']['paths']:
                for a,b in zip(path,path[1:]):
                    self.starts.append(l.xy(a[1],a[0]));self.ends.append(l.xy(b[1],b[0]));self.ids.append(feature['attributes']['ROUTE_ID'])
        self.starts=np.asarray(self.starts);self.delta=np.asarray(self.ends)-self.starts
        self.squared=np.maximum((self.delta*self.delta).sum(axis=1),1e-12)

    def query(self,points):
        distances=[];indices=[]
        for start in range(0,len(points),512):
            p=np.asarray(points[start:start+512]);offset=p[:,None,:]-self.starts[None,:,:]
            t=np.clip((offset*self.delta[None,:,:]).sum(axis=2)/self.squared[None,:],0,1)
            squared=((offset-t[:,:,None]*self.delta[None,:,:])**2).sum(axis=2)
            idx=squared.argmin(axis=1);rows=np.arange(len(p))
            distances.extend(np.sqrt(squared[rows,idx]).tolist());indices.extend(idx.tolist())
        return distances,indices


def match(indices,times,rows,at):
    if not indices:return None
    import bisect
    j=bisect.bisect_left(times,at)
    return min(indices[max(0,j-1):min(len(indices),j+1)],key=lambda i:(abs(rows[i]['collected_at']-at),rows[i]['collected_at']))


def key(a,b):
    return a['bus_name'],a['collected_at'],b['collected_at']


def cadence(a,sec):
    return a['route_id'],a['bus_id'],ev.date(a['collected_at']),math.floor(sec+.5)


def main():
    manifest=json.loads((HERE/'data/manifest.json').read_text())
    roadbytes=(HERE/'data'/manifest['file']).read_bytes()
    assert hashlib.sha256(roadbytes).hexdigest()==manifest['sha256']
    features=json.loads(roadbytes)['features'];roads=Roads(features)
    prior={}
    with gzip.open(HERE.parent/'speed-frozen/all-high-speed-diagnostics.jsonl.gz','rt') as f:
        for line in f:
            r=json.loads(line);prior[r['bus'],r['start'],r['end']]=r
    rawfile=ev.IN/'raw_positions.jsonl.gz'
    assert hashlib.sha256(rawfile.read_bytes()).hexdigest()==l.RAW_HASH
    groups=collections.defaultdict(list)
    for r in ev.read(rawfile):groups[r['bus_name']].append(r)
    records=[];checked=0
    for bus,rs in groups.items():
        rs.sort(key=lambda r:r['collected_at'])
        edges=[d.edge(a,b) for a,b in zip(rs,rs[1:])]
        low=collections.defaultdict(list);moving=collections.defaultdict(list)
        for i,(a,b) in enumerate(zip(rs,rs[1:])):
            sec,dist,_=edges[i]
            if sec>0 and a['route_id']==b['route_id'] and a['bus_id']==b['bus_id'] and dist/sec<=22:
                k=cadence(a,sec);low[k].append(i)
                if dist>1:moving[k].append(i)
        lowtimes={k:[rs[i]['collected_at'] for i in ix] for k,ix in low.items()}
        movingtimes={k:[rs[i]['collected_at'] for i in ix] for k,ix in moving.items()}
        for i,(a,b) in enumerate(zip(rs,rs[1:])):
            old=prior.get(key(a,b))
            if old is None:continue
            checked+=1;sec,dist,_=edges[i];k=cadence(a,sec)
            control=match(low[k],lowtimes.get(k,[]),rs,a['collected_at'])
            control_moving=match(moving[k],movingtimes.get(k,[]),rs,a['collected_at'])
            for kind,j in (('flagged',i),('matched_low',control),('matched_moving_low',control_moving)):
                if kind!='flagged':
                    field='matchedLowMps' if kind=='matched_low' else 'matchedMovingLowMps'
                    assert (edges[j][1]/edges[j][0] if j is not None else None)==old[field]
                if j is None:continue
                start,end=rs[j:j+2];startxy=np.asarray(l.xy(start['lat'],start['lon']));endxy=np.asarray(l.xy(end['lat'],end['lon']))
                records.append(dict(route=start['route_id'],kind=kind,bus=bus,provider=start['bus_id'],
                    start=start['collected_at'],end=end['collected_at'],speedMps=edges[j][1]/edges[j][0],
                    anchorFlaggedStart=a['collected_at'],startXY=startxy.tolist(),endXY=endxy.tolist()))
    assert checked==len(prior)
    points=[]
    for r in records:
        a,b=np.asarray(r['startXY']),np.asarray(r['endXY'])
        points.extend((a+(b-a)*fraction).tolist() for fraction in (0,.25,.5,.75,1))
    distances,indices=roads.query(points)
    for i,r in enumerate(records):
        ds=distances[5*i:5*i+5];ix=indices[5*i:5*i+5]
        delta=np.asarray(r['endXY'])-np.asarray(r['startXY']);road_delta=roads.delta[ix[2]]
        denominator=np.linalg.norm(delta)*np.linalg.norm(road_delta)
        r.update(endpointDistancesM=[ds[0],ds[4]],midpointDistanceM=ds[2],sampledDistancesM=ds,
            maxSampledDistanceM=max(ds),nearestRoads=[roads.ids[j] for j in ix],
            absDirectionCos=float(abs(np.dot(delta,road_delta))/denominator) if denominator else None)
    summary=dict(roadManifest=manifest,roadSegments=len(roads.ids),sameFlaggedEdgeChecks=checked,
        sameMatchedControls=True,thresholdsUnchanged=True,routes={},selections=[])
    for rid in ev.ROUTES:
        groups={}
        for kind in ('flagged','matched_low','matched_moving_low'):
            rs=[r for r in records if r['route']==rid and r['kind']==kind]
            groups[kind]=dict(n=len(rs),uniqueEdges=len({(r['bus'],r['start'],r['end']) for r in rs}),
                endpointDistanceM=d.distribution([v for r in rs for v in r['endpointDistancesM']]),
                midpointDistanceM=d.distribution([r['midpointDistanceM'] for r in rs]),
                maxSampledDistanceM=d.distribution([r['maxSampledDistanceM'] for r in rs]),
                absDirectionCos=d.distribution([r['absDirectionCos'] for r in rs if r['absDirectionCos'] is not None]),
                nearestMidpointRoads=dict(collections.Counter(r['nearestRoads'][2] for r in rs)),
                bands={str(m):dict(bothEndpoints=sum(max(r['endpointDistancesM'])<=m for r in rs),
                    midpoint=sum(r['midpointDistanceM']<=m for r in rs),allFiveSamples=sum(r['maxSampledDistanceM']<=m for r in rs)) for m in BINS})
        summary['routes'][rid]=dict(name=ev.ROUTES[rid]['name'],**groups)
    selected=json.loads((OUT/'summary.json').read_text())['selections']
    found={(r['route'],r['bus'],r['start'],r['end']):r for r in records if r['kind']=='flagged'}
    for row in selected:
        summary['selections'].append(dict(selection=row['selection'],routeLegCandidates=row['candidates'],
            **found[row['route'],row['bus'],row['start'],row['end']]))
    (OUT/'road-summary.json').write_text(json.dumps(summary,indent=2))
    with gzip.open(OUT/'road-proximities.jsonl.gz','wt') as f:
        for row in records:f.write(json.dumps(row,separators=(',',':'))+'\n')
    assert hashlib.sha256(rawfile.read_bytes()).hexdigest()==l.RAW_HASH
    print(json.dumps(dict(flaggedCohortIdentical=checked,proximityRows=len(records),roadsUnchanged=True)))


if __name__=='__main__':main()
