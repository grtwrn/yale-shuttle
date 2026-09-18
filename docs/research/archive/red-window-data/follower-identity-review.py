"""Independent causal identity audit; no fitting and no reserved-afternoon data.

Departure-order follower at focal pin is distinguished from the bus with the
nearest backward stop-index displacement in sparse already-known anchors.
Neither identity is called verified physical fleet order.
"""
import bisect, collections, datetime, hashlib, json, pathlib, sqlite3
from zoneinfo import ZoneInfo

D = pathlib.Path(__file__).resolve().parent
ROOT = D.parent
END = 1789665240913
TZ = ZoneInfo('America/New_York')
def day(at): return datetime.datetime.fromtimestamp(at / 1000, TZ).date().isoformat()
def partition(r): return 'train' if r['day'] < '2026-09-10' else 'calibration' if r['day'] < '2026-09-14' else 'development'
source = D / 'operating-pattern-screen.json'
cohort = [r for r in json.loads(source.read_text())['featureRows'] if r['ready'] <= END]
db = sqlite3.connect('file:' + str(ROOT / 'conditional-replay-data/outcomes.db') + '?mode=ro', uri=True)
db.row_factory = sqlite3.Row
seq = json.loads(db.execute('select stops_json from routes where id=3').fetchone()[0])
visits = [dict(v) for v in db.execute('select * from stop_visits where anchored_at<=? order by anchored_at,id', (END,))]
legacy = [dict(v) for v in db.execute('select * from arrivals where route_id=3 and stop_id in(11,121) and departed_at<=?', (END,))]
db.close()
N = len(seq)
assert len(set(seq)) == N  # This route has no duplicated stop IDs in the recorded topology.
indices = {s:i for i,s in enumerate(seq)}
departures = {kind: collections.defaultdict(list) for kind in ['modern', 'legacy']}
for v in visits:
    if v['route_id'] != 3 or v['stop_id'] not in [11,121] or v['departed_at'] is None or v['how'] == 'gap' or v['pinned_at'] is None or v['closest_m'] > 75:
        continue
    known = max(v['departed_at'] + 120000, (v['first_moved_at'] or v['departed_at']) + (v['confirm_sec'] or 0) * 1000)
    if known <= END:
        departures['modern'][v['stop_id'], day(v['departed_at'])].append(dict(bus=v['bus_name'], id=v['id'], departed=v['departed_at'], known=known))
for v in legacy:
    known = v['departed_at'] + 120000
    if known <= END:
        departures['legacy'][v['stop_id'], day(v['departed_at'])].append(dict(bus=v['bus_name'], id=v['id'], departed=v['departed_at'], known=known))
anchors = collections.defaultdict(list)
for v in visits:
    known = v['anchored_at'] + 15000
    if known <= END:
        anchors[v['bus_name']].append(dict(bus=v['bus_name'], id=v['id'], route=v['route_id'], index=v['stop_index'], stop=v['stop_id'], physical=v['anchored_at'], known=known))
times = {bus:[v['known'] for v in vs] for bus,vs in anchors.items()}

def ordered(r, kind):
    known = [v for v in departures[kind][r['stop'],r['day']] if v['known'] <= r['a'] and r['a'] - 5400000 <= v['departed']]
    own = max((v for v in known if v['bus'] == r['bus']), key=lambda v:v['departed'], default=None)
    earlier = [v for v in known if v['bus'] != r['bus']]
    pred = max(earlier, key=lambda v:v['departed'], default=None)
    following = [v for v in earlier if own and v['departed'] > own['departed']]
    first_time = min((v['departed'] for v in following), default=None)
    tied = [v for v in following if v['departed'] == first_time]
    follower = tied[0] if len({v['bus'] for v in tied}) == 1 else None
    other = [v for v in departures[kind][121 if r['stop']==11 else 11,r['day']] if own and v['bus']==r['bus'] and own['departed']<v['departed']<r['a'] and v['known']<=r['a']]
    return dict(own=own, follower=follower, predecessor=pred, distinctOtherDepartingBuses=len({v['bus'] for v in following}), sameAsPredecessor=bool(follower and pred and follower['bus']==pred['bus']), hasInterveningOpposite=bool(other), tiedFollower=len({v['bus'] for v in tied})>1)

def geometric(r, freshness):
    observations=[]
    for bus,vs in anchors.items():
        if bus==r['bus']: continue
        k=bisect.bisect_right(times[bus],r['a'])
        if not k: continue
        v=vs[k-1]
        if v['route'] != 3 or r['a']-v['physical'] > freshness*1000 or day(v['physical']) != r['day'] or not 0<=v['index']<N or seq[v['index']]!=v['stop']: continue
        backward=(indices[r['stop']]-v['index'])%N
        observations.append(dict(v,backward=backward,forward=(-backward)%N,ageSec=(r['a']-v['physical'])/1000))
    positive=[v for v in observations if v['backward']>0]
    closest=min((v['backward'] for v in positive),default=None)
    tied=[v for v in positive if v['backward']==closest]
    pick=tied[0] if len(tied)==1 else None
    return dict(follower=pick,freshOtherBuses=len(observations),colocated=sum(v['backward']==0 for v in observations),tiedClosest=len(tied)>1,observations=observations)

output=[]
for r in cohort:
    o={kind:ordered(r,kind) for kind in departures}
    g={str(age):geometric(r,age) for age in [300,600,900]}
    for item in o.values():
        for v in [item['own'],item['follower'],item['predecessor']]:
            if v: assert v['known']<=r['a'] and v['departed']<r['a']<=END
    for item in g.values():
        assert all(v['known']<=r['a'] for v in item['observations'])
    output.append(dict(id=r['id'],stop=r['stop'],day=r['day'],bus=r['bus'],pin=r['a'],partition=partition(r),ordered=o,sparseAnchor=g))

summaries=[]
for stop in [11,121]:
 for split in ['train','calibration','development']:
    rs=[r for r in output if r['stop']==stop and r['partition']==split]
    count=collections.Counter()
    for r in rs:
        m=r['ordered']['modern'];l=r['ordered']['legacy'];g=r['sparseAnchor']['600']
        count['modernOwnKnown']+=m['own'] is not None
        count['modernFollowerKnown']+=m['follower'] is not None
        count['followerSameAsPredecessor']+=m['sameAsPredecessor']
        count['oneOtherBusDepartedSinceOwn']+=m['distinctOtherDepartingBuses']==1
        count['modernFollowerWithOppositeGuard']+=bool(m['follower'] and m['hasInterveningOpposite'])
        count['legacyFollowerKnown']+=l['follower'] is not None
        both=bool(m['follower'] and l['follower'])
        count['modernLegacyBothKnown']+=both
        count['modernLegacyAgree']+=bool(both and m['follower']['bus']==l['follower']['bus'])
        count['sparseBackwardKnown10min']+=g['follower'] is not None
        count['sparseColocatedOther']+=g['colocated']>0
        count['sparseTiedClosest']+=g['tiedClosest']
        count['sparseOnlyOneFreshOther']+=g['freshOtherBuses']==1
        both=bool(m['follower'] and g['follower'])
        count['departureAndSparseBothKnown']+=both
        count['departureAndSparseAgree']+=bool(both and m['follower']['bus']==g['follower']['bus'])
        for age in ['300','600','900']:
            count['sparseKnown'+age]+=r['sparseAnchor'][age]['follower'] is not None
    summaries.append(dict(stop=stop,partition=split,n=len(rs),dates=len({r['day']for r in rs}),counts=dict(count)))
cohortById={r['id']:r for r in cohort}
reassigned=[];selected=0
for r in output:
    follower=r['ordered']['modern']['follower']
    if not follower: continue
    selected+=1
    vs=anchors[follower['bus']];ts=times[follower['bus']]
    k=bisect.bisect_right(ts,r['pin'])
    active=([vs[k-1]] if k else [])+[v for v in vs[k:] if v['known']<=cohortById[r['id']]['d']]
    wrong=[v for v in active if v['route']!=3]
    if wrong: reassigned.append(dict(sourceId=r['id'],partition=r['partition'],follower=follower['bus'],otherRouteEvidence=wrong))
reassignment=dict(method='Latest already-known all-route anchor at pin and every new anchor during the hold for each selected departure-order follower.',cutoff=END,selectedFocalHolds=selected,reassignmentCases=len(reassigned),cases=reassigned)
(D/'follower-route-reassignment-check.json').write_text(json.dumps(reassignment,indent=2)+'\n')
out=dict(method=__doc__,developmentEnd=END,cohortSha256=hashlib.sha256(source.read_bytes()).hexdigest(),scriptSha256=hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(),summaries=summaries,episodes=output,routeReassignment=reassignment,
 limitations=['Completed+120s and unconditional anchor+15s are availability proxies, not exact receipt timestamps.',
 'Modern stopped/pinned departure order and legacy dwell departure order can differ. Only latest known departures enter identity; no current or future outcome defines neighbor identity.',
 'Latest known all-route anchor is used to reject buses last observed on another route. An anchor up to10min old is not proof of current physical location or live membership.',
 'A 29-stop index ring is nonuniform geographical distance. Nearest backward index is a different definition from verified nearest physical follower.',
 'Current focal pin is the observation point; complete focal holds define the inherited study cohort. No reserved-afternoon rows or GPS were read.',
 'The geometry sensitivity reports colocated peers separately and excludes them from its positive-distance ranking. This does not prove a unique physical order when colocated buses exist.'])
(D/'follower-identity-review.json').write_text(json.dumps(out,indent=2)+'\n')
print(json.dumps(summaries,indent=2))
