"""Pure endpoint/static-geometry highway clause; original quality rules retained."""
from array import array
import bisect
import collections
import hashlib
import json
import math
from pathlib import Path
import sys
import numpy as np

HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE.parent/'canonical-diagnostics'))
import diagnose as diag
rr,ev=diag.rr,diag.ev
POLICIES=('original22','highway25','highway50')
ROAD_BOUNDS={'highway25':25,'highway50':50}
TRANSFER={9:{10,11,19,20},10:{3,4,13,14}}
GEOMETRY_HASH='a51695be4548c855af0de70d22a41b72e007e5b78a16f5cbabb60e732d82f477'
ROAD_HASH='aaeccc535103efcbc23ac092f544894a506167224b160d47ae1a7118ef2dd2fa'


def xy(lat,lon):
    return ((lon+72.94)*111195*math.cos(math.radians(41.3)),(lat-41.3)*111195)


class Projection:
    def __init__(self,lines):
        starts=[];ends=[]
        for line in lines:
            for a,b in zip(line,line[1:]):starts.append(xy(*a));ends.append(xy(*b))
        self.starts=np.asarray(starts,dtype=float).reshape(-1,2)
        self.delta=np.asarray(ends,dtype=float).reshape(-1,2)-self.starts
        self.squared=np.maximum((self.delta*self.delta).sum(axis=1),1e-12)

    def distances(self,points):
        if not len(self.starts):return [math.inf]*len(points)
        out=[]
        for start in range(0,len(points),512):
            p=np.asarray(points[start:start+512]);offset=p[:,None,:]-self.starts[None,:,:]
            t=np.clip((offset*self.delta[None,:,:]).sum(axis=2)/self.squared[None,:],0,1)
            squared=((offset-t[:,:,None]*self.delta[None,:,:])**2).sum(axis=2)
            out.extend(np.sqrt(squared.min(axis=1)).tolist())
        return out


def explicit_identity(value):
    return isinstance(value,(int,float)) and not isinstance(value,bool) and math.isfinite(value)


def eligible_pair(a,b):
    sec,metres,_=diag.edge(a,b)
    return (a['route_id'] in TRANSFER and a['route_id']==b['route_id']
        and explicit_identity(a.get('bus_id')) and explicit_identity(b.get('bus_id'))
        and a['bus_id']==b['bus_id'] and 0<sec<=60 and 22<metres/sec<=35)


def clause_decision(a,b,policy,context):
    if policy=='original22' or not eligible_pair(a,b):return False
    return context['maxRoadM']<=ROAD_BOUNDS[policy] and context['maxDeclaredRouteM']<=75


def edge_key(a,b):
    return tuple(a.get(k) for k in ('bus_name','bus_id','route_id','collected_at','lat','lon'))+tuple(b.get(k) for k in ('bus_name','bus_id','route_id','collected_at','lat','lon'))


class HighwayClause:
    """Cache contains only deterministic geometry of an exact two-fix pair."""
    def __init__(self,geometry_file=None):
        if geometry_file is None:geometry_file=HERE.parent/'highway-geometry/geometry.json'
        payload=Path(geometry_file).read_bytes()
        assert hashlib.sha256(payload).hexdigest()==GEOMETRY_HASH
        routes={r['id']:r for r in json.loads(payload)['routes']}
        roadfile=HERE.parent/'canonical-route-context/data/ctdot-interstates-20260922-original.json'
        payload=roadfile.read_bytes();assert hashlib.sha256(payload).hexdigest()==ROAD_HASH
        roads=json.loads(payload)
        self.road=Projection([[(p[1],p[0]) for p in path] for f in roads['features'] for path in f['geometry']['paths']])
        self.route={rid:Projection([leg['slice'] for leg in routes[rid]['legs'] if leg['index'] in indices and not leg['bridged']]) for rid,indices in TRANSFER.items()}
        self.cache={};self.queries=collections.Counter()

    def prepare(self,pairs):
        needed={edge_key(a,b):(a,b) for a,b in pairs if eligible_pair(a,b) and edge_key(a,b) not in self.cache}
        by_route=collections.defaultdict(list)
        for key,(a,b) in needed.items():by_route[a['route_id']].append((key,a,b))
        for rid,entries in by_route.items():
            points=[]
            for _,a,b in entries:
                start,end=np.asarray(xy(a['lat'],a['lon'])),np.asarray(xy(b['lat'],b['lon']))
                points.extend((start+(end-start)*fraction).tolist() for fraction in (0,.25,.5,.75,1))
            road=self.road.distances(points);route=self.route[rid].distances(points)
            for i,(key,a,b) in enumerate(entries):
                self.cache[key]=dict(maxRoadM=max(road[5*i:5*i+5]),maxDeclaredRouteM=max(route[5*i:5*i+5]))

    def permitted(self,a,b,policy):
        if policy=='original22' or not eligible_pair(a,b):return False
        key=edge_key(a,b)
        if key not in self.cache:self.prepare([(a,b)])
        self.queries[policy]+=1
        return clause_decision(a,b,policy,self.cache[key])

    def warm(self,raw):
        groups=collections.defaultdict(list)
        for r in raw:groups[r['bus_name']].append(r)
        pairs=[]
        for rows in groups.values():
            rows.sort(key=lambda r:r['collected_at'])
            pairs.extend((a,b) for a,b in zip(rows,rows[1:]) if eligible_pair(a,b))
        self.prepare(pairs)
        return len(pairs)


def old_ok(groups,identities,bus,rid,start,end):
    ts,ids,bad=groups.get(bus,([],[],[]))
    if not ts or end<=start:return False
    lo=max(0,bisect.bisect_right(ts,start)-1);hi=min(len(ts)-1,bisect.bisect_left(ts,end))
    if not (ts[lo]<=start+10000 and ts[hi]>=end-10000 and ids[lo]==rid and ids[hi]==rid and bad[hi]==bad[lo]):return False
    times,provider=identities[bus]
    lo=max(0,bisect.bisect_right(times,start)-1);hi=min(len(times)-1,bisect.bisect_left(times,end))
    return provider[hi]==provider[lo]


class Quality(rr.TrainingQuality):
    def __init__(self,raw,policy,clause,cutoff=None):
        assert policy in POLICIES
        if cutoff is not None:assert all(r['collected_at']<cutoff for r in raw)
        super().__init__(raw)
        self.policy=policy;self.clause=clause;self.cutoff=cutoff
        self.original_groups=self.groups
        self.counts=collections.Counter();self.promoted=set();self.permitted_edges=[];self.exempt_prefix={}
        grouped=collections.defaultdict(list)
        for r in raw:grouped[r['bus_name']].append(r)
        updated={}
        for bus,rows in grouped.items():
            rows.sort(key=lambda r:r['collected_at'])
            bad=[0];exempt=array('I',[0])
            for a,b in zip(rows,rows[1:]):
                sec,metres,mask=diag.edge(a,b)
                permit=clause.permitted(a,b,policy)
                if permit:
                    # The clause cannot erase a gap, duplicate, provider or route failure.
                    assert mask==4 and sec<=60 and a['bus_id']==b['bus_id']
                    self.permitted_edges.append(dict(bus=bus,route=a['route_id'],start=a['collected_at'],end=b['collected_at'],
                        speedMps=metres/sec,**clause.cache[edge_key(a,b)]))
                broken=(sec<=0 or sec>60 or (metres/max(.001,sec)>22 and not permit) or a['route_id']!=b['route_id'])
                bad.append(bad[-1]+int(broken));exempt.append(exempt[-1]+int(permit))
            times,ids,_=self.groups[bus]
            updated[bus]=(times,ids,bad);self.exempt_prefix[bus]=exempt
        self.groups=updated
        if policy=='original22':assert self.groups==self.original_groups

    def ok(self,bus,rid,start,end):
        result=super().ok(bus,rid,start,end)
        original=old_ok(self.original_groups,self.identities,bus,rid,start,end)
        self.counts['checks']+=1
        assert not original or result, 'quality policy excluded an original interval'
        if rid not in TRANSFER:assert result==original, 'non-target route changed'
        if result and not original:
            assert self.policy!='original22' and rid in TRANSFER
            self.promoted.add((bus,rid,start,end));self.counts['newlyAdmittedCalls']+=1
        times,_,_=self.groups.get(bus,([],[],[]))
        if times and end>start:
            lo=max(0,bisect.bisect_right(times,start)-1);hi=min(len(times)-1,bisect.bisect_left(times,end))
            if self.exempt_prefix[bus][hi]>self.exempt_prefix[bus][lo] and not result:self.counts['allowedEdgePresentButOtherConditionRejects']+=1
        return result

    def audit(self):
        return dict(policy=self.policy,cutoff=self.cutoff,calls=dict(self.counts),
            permittedEdges=len(self.permitted_edges),permittedEdgesByRoute=dict(collections.Counter(e['route'] for e in self.permitted_edges)),
            newlyAdmittedUniqueIntervals=len(self.promoted),newlyAdmittedByRoute=dict(collections.Counter(k[1] for k in self.promoted)))
