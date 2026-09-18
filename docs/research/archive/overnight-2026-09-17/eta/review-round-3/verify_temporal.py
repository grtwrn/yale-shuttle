"""Adversarial feature-time checks; no fitting or result mutation."""
import collections, importlib.util, json, random
from pathlib import Path
OUT=Path(__file__).resolve().parent; P=OUT.parent/'cycle-3';ROOT=Path('/home/gwarren/projects/yale-shuttle-watcher')
spec=importlib.util.spec_from_file_location('reviewed_role_state',P/'role_state.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
deps,anchors=module.load_events(ROOT/'conditional-replay-data/outcomes.db')
thresholds={int(k):v for k,v in json.loads((P/'extraction.json').read_text())['thresholdsSec'].items()}
rows=[json.loads(l) for l in (P/'role-landmarks.jsonl').read_text().splitlines() if json.loads(l)['elapsed']==0]
count=0
for r in rows:
    at=r['pinAt'];delay=120000 if r['regime']=='confirmed240' else 0
    ds=[dict(e,known=e['known']+delay) for e in deps if e['known']+delay<=at];aa=[a for a in anchors if a['known']<=at]
    # Make unavailable evidence maximally tempting: same bus/stop, earlier
    # physical timestamps, and contradictory route, all first known after pin.
    ds += [dict(id=-1,bus=r['bus'],stop=r['stop'],physical=at-1000,known=at+1),
           dict(id=-2,bus=r['bus'],stop=121 if r['stop']==11 else 11,physical=at-500,known=at+1)]
    aa += [dict(id=-3,bus=r['bus'],route=8,physical=at-100,known=at+1)]
    random.Random(r['id']).shuffle(ds);random.Random(r['id']+1).shuffle(aa)
    assert module.History(ds,aa).snapshot(r,thresholds)==r['role'];count+=1
# Training-only scale must ignore arbitrary completed development events.
pre=[d for d in deps if d['known']<module.FIT];prea=[a for a in anchors if a['known']<module.FIT]
t1,p1=module.History(deps,anchors).thresholds();t2,p2=module.History(pre,prea).thresholds()
assert t1==t2 and sorted(p1,key=lambda p:(p['stop'],p['current']))==sorted(p2,key=lambda p:(p['stop'],p['current']))
result=dict(shuffledTruncatedFuturePoisonChecks=count,trainingOnlyThresholdPairs=len(p1),changesToBuilderEvidence=False)
(OUT/'temporal-check.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))
