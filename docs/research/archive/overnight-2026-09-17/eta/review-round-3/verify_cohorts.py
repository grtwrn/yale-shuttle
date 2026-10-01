import collections,json
from pathlib import Path
OUT=Path(__file__).resolve().parent;P=OUT.parent/'cycle-3';OLD=OUT.parent/'cycle-1'
read=lambda p:[json.loads(s) for s in p.read_text().splitlines()]
original={(r['id'],r['elapsed']):r for r in read(OLD/'landmarks.jsonl') if r['regime']=='arrival15'}
rows=read(P/'role-landmarks.jsonl');preds=read(P/'predictions.jsonl');plan=json.loads((P/'PLAN.json').read_text())
current={(r['id'],r['elapsed']):r for r in json.loads((OLD/'comparator.json').read_text())['forecasts']}
assert len(rows)==2*len(original)==3898
contracts=('confirmed120','confirmed240');identity_checks=0
for contract in contracts:
    subset={(r['id'],r['elapsed']):r for r in rows if r['regime']==contract}
    assert set(subset)==set(original)
    for key,r in subset.items():
        clean=lambda x:{k:v for k,v in x.items() if k not in ('regime','role')}
        assert clean(r)==clean(original[key]);identity_checks+=1
    development={k for k,r in subset.items() if r['split']=='development'}
    assert development==set(current)
    for arm in plan['arms']:
        rs=[r for r in preds if r['regime']==contract and r['arm']==arm]
        assert len(rs)==len(development)==722
        assert {(r['id'],r['elapsed']) for r in rs}==development
        for r in rs:
            c=current[r['id'],r['elapsed']]
            assert (r['forecastAt'],r['truthRemaining'],r['stop'],r['bus'])==(c['forecastAt'],c['truthRemaining'],c['stop'],c['bus'])
primary={(r['id'],r['elapsed']):r['role'] for r in rows if r['regime']==contracts[0]}
delayed={(r['id'],r['elapsed']):r['role'] for r in rows if r['regime']==contracts[1]}
for k,s in primary.items():
    assert {name:v for name,v in s.items() if name!='knownTimes'}=={name:v for name,v in delayed[k].items() if name!='knownTimes'}
counts=collections.Counter((r['stop'],r['split']) for r in original.values() if r['elapsed']==0)
result=dict(originalLandmarkParity=identity_checks,uniqueDevelopmentCheckpoints=len(current),identicalArmContractCohorts=6,latencyFeatureEqualities=len(primary),maxTrainingHoldSec=max(r['truthRemaining'] for r in original.values() if r['split']=='train'),cohorts={str(k):v for k,v in counts.items()})
(OUT/'cohort-check.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))
