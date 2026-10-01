import collections, hashlib, json, pathlib
p=pathlib.Path(__file__).resolve().parent
legacy=json.loads((p/'legacy-followup.json').read_text())['arrivals']
groups=collections.defaultdict(list)
for r in legacy:
    assert r['stop_id'] in (11,121)
    assert r['departed_at'] >= r['arrived_at']
    groups[r['bus_name'],r['stop_id']].append(r['departed_at'])
assert all(v==sorted(v) for v in groups.values())
records=[json.loads(l) for l in (p/'features-predictions.jsonl').read_text().splitlines()]
weights=collections.defaultdict(float)
for r in records:
    weights[r['id'],r['regime']]+=r['weight']
    for peer in ('ahead','follower'):
        s=r['snapshots'][peer]
        if not s['usable']:
            assert all(v==0 for k,v in r['features'].items() if k.startswith(peer+'_'))
    if r['features']['own_union_missing']==0:
        assert r['features']['own_union_age']*600 >=120
assert all(abs(w-1)<1e-10 for w in weights.values())
result=json.loads((p/'results.json').read_text())
for split in ('train','development'):
    n=sum(r['visits'] for r in result['descriptive'] if r['split']==split)
    actual=len({r['id'] for r in records if r['split']==split})
    assert n==actual,(split,n,actual)
summary={'legacyRows':len(legacy),'legacySortedGroups':len(groups),'landmarks':len(records),'weightSums':len(weights),
 'legacyRouteFilter':'route_id=3, stop_id IN(11,121), ORDER BY departed_at in capture-legacy.py',
 'captureScriptSha256':{f:hashlib.sha256((p/f).read_bytes()).hexdigest() for f in ['capture.py','capture-legacy.py']},'passed':True}
(p/'input-audit.json').write_text(json.dumps(summary,indent=2)+'\n')
print(json.dumps(summary))
