"""Hosted analysis only: no admission or forecast code is modified."""
import bisect
import collections
import gzip
import hashlib
import json
import math
from pathlib import Path
import sys
from geographiclib.geodesic import Geodesic

HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE.parent/'canonical-diagnostics'))
import diagnose as d
ev=d.ev
OUT=HERE/'results'
RAW_HASH='3990d06ebdab596cfebdd7f03c528f7efcbb46fd3f6af68a9d64ede648e220b9'


def geodesic(a,b):
    return Geodesic.WGS84.Inverse(a['lat'],a['lon'],b['lat'],b['lon'])['s12']


def stable(a,b):
    return a['route_id']==b['route_id'] and a['bus_id']==b['bus_id'] and b['collected_at']>a['collected_at']


def vector(a,b):
    return ((b['lat']-a['lat'])*111195,
        (b['lon']-a['lon'])*111195*math.cos(math.radians(a['lat'])))


def reverse(a,b,c):
    x,y=vector(a,b),vector(b,c)
    norm=math.hypot(*x)*math.hypot(*y)
    return norm>1 and sum(p*q for p,q in zip(x,y))/norm<-.8


def matching(indices,times,rows,start):
    if not indices:return None
    j=bisect.bisect_left(times,start)
    return min(indices[max(0,j-1):min(len(indices),j+1)],
        key=lambda i:(abs(rows[i]['collected_at']-start),rows[i]['collected_at']))


def cadence_key(a,b,seconds):
    return a['route_id'],a['bus_id'],ev.date(a['collected_at']),math.floor(seconds+.5)


def summarize(records):
    fields=('seconds','planarMps','geodesicMps','relativeDistanceError','priorIdenticalPolls',
        'firstRepeatedPositionProxyMps','windowNetMps','windowPathMps','matchedLowMps','matchedMovingLowMps',
        'matchedLowSeparationSec','matchedMovingSeparationSec')
    return dict(n=len(records),distributions={f:d.distribution([r[f] for r in records if r[f] is not None]) for f in fields},
        flags=dict(collections.Counter(flag for r in records for flag in r['flags'])),
        geodesicAtOrBelow22=sum(r['geodesicMps']<=22 for r in records),
        matchedLowGeodesicAbove22=sum(r.get('matchedLowGeodesicMps',0)>22 for r in records),
        matchedMovingGeodesicAbove22=sum(r.get('matchedMovingGeodesicMps',0)>22 for r in records))


def main():
    OUT.mkdir(exist_ok=True)
    raw_file=ev.IN/'raw_positions.jsonl.gz'
    assert hashlib.sha256(raw_file.read_bytes()).hexdigest()==RAW_HASH
    raw=ev.read(raw_file)
    groups=collections.defaultdict(list); providers=collections.defaultdict(list)
    for row in raw:
        groups[row['bus_name']].append(row); providers[row['bus_id']].append(row)
    for rows in providers.values(): rows.sort(key=lambda r:r['collected_at'])
    records=[]; concentrations=collections.defaultdict(collections.Counter)
    all_edges=collections.defaultdict(collections.Counter); chosen_groups={}
    for bus,rows in groups.items():
        rows.sort(key=lambda r:r['collected_at'])
        times=[r['collected_at'] for r in rows]
        edges=[d.edge(a,b) for a,b in zip(rows,rows[1:])]
        low=collections.defaultdict(list); moving=collections.defaultdict(list)
        run_start=[]
        for i,row in enumerate(rows):
            run_start.append(run_start[-1] if i and stable(rows[i-1],row) and rows[i-1]['lat']==row['lat'] and rows[i-1]['lon']==row['lon'] else i)
        high=[]
        for i,(a,b) in enumerate(zip(rows,rows[1:])):
            sec,dist,mask=edges[i]; speed=dist/max(.001,sec); rid=a['route_id']
            all_edges[rid]['edges']+=1
            if not stable(a,b):
                all_edges[rid]['unstable_route_provider_or_timestamp']+=1; high.append(False); continue
            high.append(speed>22)
            con=concentrations[rid,bus,a['bus_id'],ev.date(a['collected_at'])]
            con['stableEdges']+=1; con['movingEdges']+=int(dist>1)
            all_edges[rid]['stableEdges']+=1; all_edges[rid]['movingEdges']+=int(dist>1)
            if speed>22:
                con['highEdges']+=1;all_edges[rid]['highEdges']+=1
            else:
                key=cadence_key(a,b,sec); low[key].append(i)
                if dist>1:moving[key].append(i)
        lowtimes={key:[times[i] for i in indices] for key,indices in low.items()}
        movetimes={key:[times[i] for i in indices] for key,indices in moving.items()}
        geocache={}
        def geo(i):
            if i not in geocache:geocache[i]=geodesic(rows[i],rows[i+1])
            return geocache[i]
        for i,is_high in enumerate(high):
            if not is_high:continue
            a,b=rows[i:i+2]; sec,dist,_=edges[i]; rid=a['route_id']; key=cadence_key(a,b,sec)
            control=matching(low[key],lowtimes.get(key,[]),rows,a['collected_at'])
            moving_control=matching(moving[key],movetimes.get(key,[]),rows,a['collected_at'])
            # Surrounding context uses the same simple planar distance only for
            # descriptive totals; center and controls also get WGS84 checks.
            lo=max(0,bisect.bisect_left(times,a['collected_at']-15000)-1)
            hi=min(len(rows)-1,bisect.bisect_left(times,b['collected_at']+15000))
            continuity=all(stable(rows[j],rows[j+1]) and edges[j][0]<=60 for j in range(lo,hi))
            span=(times[hi]-times[lo])/1000
            net=d.metres(rows[lo],rows[hi])/span if continuity and span else None
            path=sum(edges[j][1] for j in range(lo,hi))/span if continuity and span else None
            held_seconds=(b['collected_at']-rows[run_start[i]]['collected_at'])/1000
            proxy=dist/held_seconds
            flags=[]
            if i and i+1<len(high) and not high[i-1] and not high[i+1]:flags.append('isolated_threshold_edge')
            if (i>=2 and high[i-2] and high[i-1]) or (i and high[i-1] and i+1<len(high) and high[i+1]) or (i+2<len(high) and high[i+1] and high[i+2]):flags.append('in_run_of_at_least_3_high_edges')
            if run_start[i]<i:flags.append('identical_position_polled_before')
            if i+2<len(rows) and stable(b,rows[i+2]) and b['lat']==rows[i+2]['lat'] and b['lon']==rows[i+2]['lon']:flags.append('identical_position_polled_after')
            if run_start[i]<i and proxy<=22:flags.append('first_repeated_position_timing_proxy_le22')
            if sec<1:flags.append('collection_interval_below_1s')
            if sec>60:flags.append('collection_gap_over_60s')
            if net is not None and net<=22:flags.append('surrounding_net_speed_le22')
            if path is not None and path<=22:flags.append('surrounding_path_speed_le22')
            if i+2<len(rows) and stable(b,rows[i+2]) and d.metres(a,rows[i+2])<=30:flags.append('next_fix_returns_within_30m_of_start')
            if i+2<len(rows) and stable(b,rows[i+2]) and reverse(a,b,rows[i+2]):flags.append('next_edge_reverses_direction')
            start_same=rows[bisect.bisect_left(times,a['collected_at']):bisect.bisect_right(times,a['collected_at'])]
            end_same=rows[bisect.bisect_left(times,b['collected_at']):bisect.bisect_right(times,b['collected_at'])]
            if len({r['bus_id'] for r in start_same})>1 or len({r['bus_id'] for r in end_same})>1:flags.append('same_poll_name_provider_contention')
            record=dict(route=rid,bus=bus,provider=a['bus_id'],day=ev.date(a['collected_at']),index=i,
                start=a['collected_at'],end=b['collected_at'],seconds=sec,distanceM=dist,
                planarMps=dist/sec,geodesicMps=geo(i)/sec,relativeDistanceError=(dist-geo(i))/geo(i),
                priorIdenticalPolls=i-run_start[i],firstRepeatedPositionProxyMps=proxy,
                windowNetMps=net,windowPathMps=path,windowSpanSec=span,flags=flags,
                matchedLowMps=edges[control][1]/edges[control][0] if control is not None else None,
                matchedLowGeodesicMps=geo(control)/edges[control][0] if control is not None else 0,
                matchedLowSeparationSec=abs(times[control]-times[i])/1000 if control is not None else None,
                matchedMovingLowMps=edges[moving_control][1]/edges[moving_control][0] if moving_control is not None else None,
                matchedMovingGeodesicMps=geo(moving_control)/edges[moving_control][0] if moving_control is not None else 0,
                matchedMovingSeparationSec=abs(times[moving_control]-times[i])/1000 if moving_control is not None else None)
            records.append(record)
        chosen_groups[bus]=(rows,times,edges)
    summary=dict(rawSha256=RAW_HASH,rawRows=len(raw),rawColumns=sorted({key for row in raw for key in row}),
        method='Observations only; no estimate or exclusion changed; WGS84 GeographicLib2.1',routes={},selections=[],concentrations=[])
    for rid in ev.ROUTES:
        rs=[r for r in records if r['route']==rid]
        summary['routes'][rid]=dict(name=ev.ROUTES[rid]['name'],edges=dict(all_edges[rid]),**summarize(rs))
        if not rs:continue
        ordered=sorted(rs,key=lambda r:(r['planarMps'],r['start'],r['bus']))
        selected=[('first',min(rs,key=lambda r:(r['start'],r['bus']))),('median',ordered[(len(ordered)-1)//2]),('max',ordered[-1])]
        for selection,r in selected:
            rows,times,edges=chosen_groups[r['bus']]; i=r['index']
            lo=max(0,bisect.bisect_left(times,r['start']-30000)-1)
            hi=min(len(rows)-1,bisect.bisect_left(times,r['end']+30000))
            origin=rows[i]
            track=[]
            for j in range(lo,hi+1):
                row=rows[j]
                x,y=vector(origin,row)
                entry=dict(at=row['collected_at'],relativeSec=(row['collected_at']-r['start'])/1000,
                    bus=row['bus_name'],provider=row['bus_id'],route=row['route_id'],northM=x,eastM=y,
                    lastStop=row.get('last_stop_id'),heading=row.get('heading'))
                if j>lo:
                    sec,dist,_=edges[j-1]
                    entry.update(seconds=sec,distanceM=dist,planarMps=dist/max(.001,sec),
                        geodesicMps=geodesic(rows[j-1],row)/max(.001,sec),
                        unchangedCoordinates=rows[j-1]['lat']==row['lat'] and rows[j-1]['lon']==row['lon'])
                track.append(entry)
            pr=providers[r['provider']]; pts=[row['collected_at'] for row in pr]
            nearby=pr[bisect.bisect_left(pts,r['start']-30000):bisect.bisect_right(pts,r['end']+30000)]
            summary['selections'].append(dict(selection=selection,edge=r,track=track,
                providerNamesInWindow=sorted({row['bus_name'] for row in nearby})))
    summary['concentrations']=[dict(route=rid,bus=bus,provider=provider,day=day,**dict(counts))
        for (rid,bus,provider,day),counts in sorted(concentrations.items())]
    (OUT/'summary.json').write_text(json.dumps(summary,indent=2))
    with gzip.open(OUT/'all-high-speed-diagnostics.jsonl.gz','wt') as f:
        for r in records:f.write(json.dumps(r,separators=(',',':'))+'\n')
    assert hashlib.sha256(raw_file.read_bytes()).hexdigest()==RAW_HASH
    print(json.dumps(dict(rawRows=len(raw),diagnosedEdges=len(records),selections=len(summary['selections']),inputUnchanged=True)))


if __name__=='__main__':main()
