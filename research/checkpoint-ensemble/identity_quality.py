"""Additional experimental identity proof from complete causal raw polls."""
import bisect
import collections

class IdentityQuality:
    def __init__(self,base,raw,cutoff):
        self.base=base;self.breaks=collections.defaultdict(list);self.events=[];self.rejections=collections.Counter()
        providers={};names={};grouped=collections.defaultdict(list)
        for r in raw:
            assert r['collected_at']<cutoff
            grouped[r['collected_at']].append(r)
        for at,rows in sorted(grouped.items()):
            pn=collections.defaultdict(set);np=collections.defaultdict(set)
            for r in rows:pn[r['bus_id']].add(r['bus_name']);np[r['bus_name']].add(r['bus_id'])
            bad=set()
            for provider,current in pn.items():
                previous=providers.get(provider)
                if previous is not None and previous!=current:bad|=previous|current
                if len(current)>1:bad|=current
                providers[provider]=current
            for name,current in np.items():
                previous=names.get(name)
                if len(current)>1 or previous is not None and previous!=current:bad.add(name)
                names[name]=current
            for name in sorted(bad):self.breaks[name].append(at);self.events.append((name,at))
    def ok(self,bus,rid,start,end):
        old=self.base.ok(bus,rid,start,end)
        ts=self.breaks.get(bus,());i=bisect.bisect_left(ts,start)
        broken=i<len(ts) and ts[i]<=end
        if old and broken:self.rejections[rid]+=1
        return old and not broken
    def audit(self):return dict(fullPollIdentityTransitions=len(self.events),additionalRejectedCalls=dict(self.rejections))
