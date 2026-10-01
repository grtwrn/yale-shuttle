"""Audit saved follower scores, identity/date overlap, and raw fallback parity."""
import collections, hashlib, json, pathlib, statistics
D=pathlib.Path(__file__).resolve().parent
path=D/'follower-progress-screen.json';x=json.loads(path.read_text())
counts=collections.Counter()
for r in x['identityRows']:
    if r['day']<'2026-09-14': continue
    p=r['followers']['departure_order']
    counts[r['stop'],r['day'],'unknown' if p is None else 'same' if p['sameAsAhead'] else 'distinct']+=1
byDate=[dict(stop=s,day=d,counts={g:counts[s,d,g]for g in ['same','distinct','unknown']})for s in [11,121]for d in ['2026-09-14','2026-09-15','2026-09-16','2026-09-17']]
baseline={}
for p in x['perEpisode']:
    if p['arm']=='baseline': baseline[p['identity'],p['regime'],p['stop'],p['offset'],p['calibrated']]={e['id']:e for e in p['episodes']}
checked=0;withinDate=[]
for p in x['perEpisode']:
    b=baseline[p['identity'],p['regime'],p['stop'],p['offset'],p['calibrated']]
    assert len(p['episodes'])==len(b) and len({e['id']for e in p['episodes']})==len(b)
    for e in p['episodes']:
        if not p['calibrated'] and not e['known']:
            assert abs(e['logLoss']-b[e['id']]['logLoss'])<1e-12
            checked+=1
    if p['identity']=='departure_order' and p['regime']=='arrival15_clear30_proxy' and p['stop']==121 and p['offset']=='lap_clock_ahead' and not p['calibrated'] and p['arm']in['progress_clock','reached_clock']:
        groups=collections.defaultdict(list)
        for e in p['episodes']:
            g='unknown' if not e['known'] else 'same' if e['sameAsAhead'] else 'distinct'
            groups[e['day'],g].append((b[e['id']]['logLoss'],e['logLoss']))
        for (day,group),vs in sorted(groups.items()):
            before=statistics.mean(a for a,b in vs);after=statistics.mean(b for a,b in vs)
            withinDate.append(dict(arm=p['arm'],day=day,group=group,n=len(vs),baseline=before,candidate=after,percentImprovement=100*(before-after)/before))
compact=[s for s in x['scores']if s['identity']=='departure_order'and s['regime']=='arrival15_clear30_proxy'and not s['calibrated']and s['arm']in['baseline','progress_clock','reached_clock']and s['group']in['all','same_as_ahead','distinct_from_ahead']]
out=dict(sourceSha256=hashlib.sha256(path.read_bytes()).hexdigest(),rawUnknownFallbackChecks=checked,identityByDate=byDate,unionIncrementalWithinDate=withinDate,mainScores=compact,
verdict='No future-feature leakage identified by code inspection. Small exploratory Union follower signal remains after predecessor adjustment; Winchester adds little. Date and identity overlap are confounded. Sequential log-loss gain does not imply calibrated probabilities or ETA gains.')
(D/'follower-results-review.json').write_text(json.dumps(out,indent=2)+'\n')
print(json.dumps(dict(rawUnknownFallbackChecks=checked,identityByDate=byDate,unionIncrementalWithinDate=withinDate),indent=2))
