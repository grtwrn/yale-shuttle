"""Freeze the tested K10 prior and audit the live-trial expiry safeguard.

This is a post-selection sensitivity check on the SAME research dates, not a
fresh holdout. A countdown <=60s while upstream falls back to the live model:
45s snapshot expiry + 15s 'now' threshold. No floor is fitted to test outcomes.
"""
import collections
import gzip
import hashlib
import json
from pathlib import Path
from evaluate import Labels, TRAIN_END, clock, metrics
from hybrid import observed_exit_gate

HERE = Path(__file__).resolve().parent
OUT = HERE/'trial-results'
OUT.mkdir(exist_ok=True)
targets = json.loads((HERE/'data/topology.json').read_text())['route']['stops'][15:]
labels = Labels(source_indices=[4], target_ids=targets)
episodes = [e for e in labels.episodes if e['end'] < TRAIN_END]
model = {'version':'k10-20260921', 'trainBefore':TRAIN_END,
         'validUntil':1790568000000, # Sep 28, 2026 00:00 ET: bounded opt-in trial
         'sequence':json.loads((HERE/'data/topology.json').read_text())['route']['stops'],
         'paths':{str(t):[[e['day'],clock(e['start']),e['duration']] for e in episodes if e['target']==t] for t in targets}}
(OUT/'k10-model.json').write_text(json.dumps(model,separators=(',',':'))+'\n')
arm='wait_minus10_departure_mean/after_observed_exit'
raw='wait_minus10_departure_mean/no_switch'
paired=[];fixtures=[];counts=collections.Counter()
with gzip.open(HERE/'results/multistop/scored.jsonl.gz','rt') as stream:
    for line in stream:
        r=json.loads(line)
        if r['day']<='2026-09-16':continue
        p=r['forecasts'][arm]
        base=r['forecasts']['logged_production']
        expired=p['supported'] and p['forecast']['eta']<=60
        guarded=dict(base, reason='expired upstream countdown') if expired else p
        r['forecasts']['k10_guarded']=guarded
        if base['forecast']:
            paired.append(r)
            counts['guardedSnapshots']+=int(expired)
            if p.get('switched'):assert guarded['forecast']==base['forecast']
        # Every paired reading, plus a spaced dense sample for all destinations.
        q=r['forecasts'][raw]
        if q['supported'] and (base['forecast'] or r['at']%300000==0):
            origin=r['checkpointOrigins']['4']
            fixtures.append({'now':r['at'],'target':r['target'],'origin':origin,
                'index':r['index'],'phase':r['phase'],'observedAt':r['observedAt'],
                'released':bool(observed_exit_gate(r)), 'expected':q['forecast']})
def result(rows):
    out={a:metrics(rows,a) for a in ['logged_production',arm,'k10_guarded']}
    for a,m in out.items():
        bad=[r for r in rows if r['forecasts'][a]['forecast']['eta']<=15 and r['truth']>120]
        m['falseNowSnapshots']=len(bad)
        m['falseNowVisits']=len({(r['target'],r['episode']['targetId']) for r in bad})
    return out
summary={'note':__doc__,'division':result([r for r in paired if r['target']==48]),
         'all14':result(paired),'other12':result([r for r in paired if r['target'] not in [48,4]]),
         'targets':{str(t):result([r for r in paired if r['target']==t]) for t in targets},
         'counts':dict(counts), 'paths':{k:len(v) for k,v in model['paths'].items()},
         'fixtureCount':len(fixtures), 'modelSha256':hashlib.sha256((OUT/'k10-model.json').read_bytes()).hexdigest()}
(OUT/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
with gzip.open(OUT/'k10-parity.json.gz','wt') as f:json.dump(fixtures,f,separators=(',',':'))
print(json.dumps({k:summary[k] for k in ['division','all14','counts','paths','fixtureCount']},indent=2))
