"""Artifact-only causal service-role state; no app imports or mutations."""
import bisect
import cmath
import collections
import datetime as dt
import math
import sqlite3
from zoneinfo import ZoneInfo

TZ = ZoneInfo('America/New_York')
FIT = int(dt.datetime(2026, 9, 10, tzinfo=TZ).timestamp()*1000)
END = 1789665240913

def day(t):
    return dt.datetime.fromtimestamp(t/1000, TZ).date().isoformat()

def ready(v):
    d=v['departed_at']
    if d is None or v['how']=='gap': return None
    return max(d+120000,(v['first_moved_at'] or d)+(v['confirm_sec'] or 0)*1000)

def unit(t):
    return cmath.exp(2j*math.pi*((t/1000)%3600)/3600)

def phase_error(a,b):
    return abs(cmath.phase(a/b))*3600/(2*math.pi)

def load_events(path, extra_delay=0):
    con=sqlite3.connect(f'file:{path}?mode=ro',uri=True)
    con.row_factory=sqlite3.Row
    rows=[dict(v) for v in con.execute('SELECT * FROM stop_visits WHERE anchored_at <= ?', (END,))]
    con.close()
    anchors=[];departures=[]
    for v in rows:
        anchors.append(dict(id=v['id'],bus=v['bus_name'],route=v['route_id'],physical=v['anchored_at'],known=v['anchored_at']+15000))
        known=ready(v)
        if v['route_id']==3 and v['stop_id'] in (11,121) and v['pinned_at'] is not None and known is not None and v['closest_m']<=75 and v['id']!=65237:
            departures.append(dict(id=v['id'],bus=v['bus_name'],stop=v['stop_id'],physical=v['departed_at'],known=known+extra_delay))
    return departures,anchors

class History:
    def __init__(self,departures,anchors):
        self.deps=collections.defaultdict(list);self.anchors=collections.defaultdict(list)
        for e in departures:self.deps[e['bus'],e['stop'],day(e['physical'])].append(e)
        for e in anchors:self.anchors[e['bus'],day(e['physical'])].append(e)
        self.times={}
        for mapping in (self.deps,self.anchors):
            for key,es in mapping.items():
                es.sort(key=lambda e:(e['known'],e['physical'],e['id']))
                self.times[id(es)]=[e['known'] for e in es]

    def known(self,mapping,key,t):
        es=mapping.get(key,[])
        return es[:bisect.bisect_right(self.times[id(es)],t)] if es else []

    def opposite(self,bus,stop,date,left,right,known):
        es=self.known(self.deps,(bus,121 if stop==11 else 11,date),known)
        return [e for e in es if left<e['physical']<right]

    def thresholds(self):
        """Training-only reset scale, pooled per stop; no evaluation outcomes."""
        import numpy as np
        values=collections.defaultdict(list);pairs=[]
        for (bus,stop,date),es in self.deps.items():
            prior=None
            for e in sorted((e for e in es if e['known']<FIT),key=lambda e:e['physical']):
                if prior and 1800000<=e['physical']-prior['physical']<=5400000 and self.opposite(bus,stop,date,prior['physical'],e['physical'],e['known']):
                    anchors=self.known(self.anchors,(bus,date),e['known'])
                    if not any(a['route']!=3 and prior['physical']<a['physical']<e['physical'] for a in anchors):
                        delta=phase_error(unit(e['physical']),unit(prior['physical']))
                        values[stop].append(delta);pairs.append(dict(stop=stop,previous=prior['id'],current=e['id'],known=e['known'],deltaSec=delta))
                prior=e
        assert set(values)=={11,121}
        return {s:float(np.quantile(v,.95)) for s,v in values.items()},pairs

    def snapshot(self,r,thresholds):
        at=r['pinAt'];date=day(at);bus=r['bus'];stop=r['stop']
        anchors=self.known(self.anchors,(bus,date),at)
        latest=max(anchors,key=lambda e:(e['physical'],e['known']),default=None)
        nonred=[a for a in anchors if a['route']!=3]
        reset_at=max((a['physical'] for a in nonred),default=0)
        es=sorted((e for e in self.known(self.deps,(bus,stop,date),at) if reset_at<e['physical']<at),key=lambda e:(e['physical'],e['id']))
        z=0j;weight=0.;chain=[];resets=[];previous=None
        for e in es:
            why=None
            if previous:
                gap=e['physical']-previous['physical']
                if not 1800000<=gap<=5400000:why='gap_outside_30_90min'
                elif not self.opposite(bus,stop,date,previous['physical'],e['physical'],e['known']):why='missing_opposite_at_update'
                elif abs(z)>0 and phase_error(unit(e['physical']),z)>thresholds[stop]:why='phase_innovation'
                if why:
                    resets.append(dict(atId=e['id'],reason=why));z=0j;weight=0.;chain=[]
                else:
                    discount=2**(-gap/7200000)
                    z*=discount;weight*=discount
            z+=unit(e['physical']);weight+=1;chain.append(e);previous=e
        reason='known'
        if not r['lapSupported']:reason='unsupported_lap'
        elif latest and latest['route']!=3:reason='latest_route_not_red'
        elif not chain:reason='no_confirmed_history'
        elif at-chain[-1]['physical']>5400000:reason='stale_history'
        elif not self.opposite(bus,stop,date,chain[-1]['physical'],at,at):reason='missing_opposite_at_pin'
        elif len(chain)<2:reason='fewer_than_two_histories'
        two=sum((unit(e['physical']) for e in chain[-2:]),0j)
        supported=reason=='known'
        return dict(reason=reason,supported=supported,count=len(chain),ids=[e['id'] for e in chain],
                    knownTimes=[e['known'] for e in chain],physicalTimes=[e['physical'] for e in chain],
                    routeResetAt=reset_at,resets=resets,
                    recursive=dict(phase=cmath.phase(z),confidence=abs(z)/(weight+2) if supported else 0,weight=weight),
                    two=dict(phase=cmath.phase(two),confidence=abs(two)/(min(2,len(chain))+2) if supported else 0))

def features(r,t,which):
    import numpy as np
    state=r['role'][which]
    phi=2*np.pi*(((r['pinAt']/1000)%3600)+r['elapsed']+np.asarray(t))/3600-state['phase']
    c=state['confidence']
    return np.column_stack([c*np.sin(phi),c*np.cos(phi),np.full_like(phi,c)])
