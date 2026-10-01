"""Additional frozen-design checks; never refits or changes emitted forecasts."""
import collections, hashlib, json, math
import numpy as np
import screen as s

OUT=s.OUT;frozen=json.loads((OUT/'fits.json').read_text())
episodes,origins,_,tables,extractor=s.load()
rows=[json.loads(line) for f in ['predictions.jsonl','extension-predictions.jsonl'] for line in (OUT/f).read_text().splitlines()]
ordered=0;tail_checks=0;no_gate=0
for r in rows:
    for arm,p in r['predictions'].items():
        q=p['q'];assert len(q)==7 and all(math.isfinite(x) and x>=0 for x in q) and q==sorted(q)
        assert math.isfinite(p['p120']) and 0<=p['p120']<=1
        ordered+=1
    if not r['gateActive']:
        assert r['predictions'][s.ARMS[0]]==r['predictions'][s.ARMS[2]];no_gate+=1
    # Reconstruct every arm's tail and check probability and inverse far beyond the scored quantiles.
    core=s.core_design(r,(np.arange(120)+.5)*15,frozen['referenceLap'])@np.array(frozen['fits'][s.ARMS[0]]['coefficients'])
    gate,_=s.gate_features(r['snapshot'],frozen['supports']['regimes'])
    for arm in s.ARMS:
        z=core.copy()
        if arm!=s.ARMS[0]:
            f=frozen['fits'][arm];raw=r['snapshot']['spaceFeatures'] if arm==s.ARMS[1] else gate
            z+=np.array(raw)[f['columns']]@np.array(f['coefficients'])
        logs=np.r_[0,-np.cumsum(np.logaddexp(0,z))]
        tail=min(1/5,max(1/1800,(logs[-2]-logs[-1])/15))
        assert np.isfinite(logs).all() and np.all(np.diff(logs)<=0) and math.isfinite(tail) and tail>0
        target=math.log1p(-(1-1e-12));beyond=1800+max(0,logs[-1]-target)/tail
        assert math.isfinite(beyond) and beyond>=1800
        survival=math.exp(logs[-1]-tail*(beyond-1800))
        assert 0<=survival<=1e-12*(1+1e-3)
        tail_checks+=1

# A deterministic, outcome-independent sample plus every co-anchor origin and the two
# already-known early-hold examples. No future anchors or future outcome fields can affect selection.
selected=[r for i,r in enumerate(origins) if i%11==0 or r['id'] in [64318,65347] or
          any(r['snapshots'][str(d)]['coAnchors'] for d in [15,120])]
all_anchors=[v for vs in extractor.anchors.values() for v in vs]
checks=0
for r in selected:
    for delay in [15,120]:
        boundary=r['forecastAt']-delay*1000
        historical=[dict(v,departed_at=-12345,stand_sec=999999,outcome='invented-future-outcome')
                    for v in all_anchors if v['anchored_at']<=boundary]
        cut=s.Extractor(historical,tables['sequence'],tables['edgeCosts'])
        expected=extractor.snapshot(r,delay)
        assert cut.snapshot(r,delay)==expected
        # Add deliberately different future route assignments and endpoints at original future timestamps.
        future=[dict(v,route_id=999,stop_id=999,stop_index=-1) for v in all_anchors if v['anchored_at']>boundary]
        changed=s.Extractor(historical+future,tables['sequence'],tables['edgeCosts'])
        assert changed.snapshot(r,delay)==expected
        altered=dict(r,truthRemaining=99999,holdSec=99999)
        assert s.predict(r,expected,frozen['referenceLap'],frozen['fits'],frozen['supports'])==s.predict(altered,expected,frozen['referenceLap'],frozen['fits'],frozen['supports'])
        checks+=1
result=dict(fitSha256=hashlib.sha256((OUT/'fits.json').read_bytes()).hexdigest(),
    orderedQuantileAndProbabilityChecks=ordered,continuedTailChecks=tail_checks,exactGateFallbackChecks=no_gate,
    sampledOrigins=len(selected),futureDeletionAndPerturbationChecks=checks,
    passed=True,scope='Every emitted base+fresh arm checked for finite ordered quantiles, probability range, and continued tail. Future-delete/perturbation tests cover deterministic one-in-eleven origins plus all co-anchor origins and both known early-hold cases, each at15/120s.')
(OUT/'validation.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result,indent=2))
