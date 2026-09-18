"""Paired descriptive metrics; every development visit/arm stays visible."""
import collections
import json
from pathlib import Path
import numpy as np
from run_role import OUT,OLD,ARMS,CONTRACTS,base,core
from role_state import features

rows=[json.loads(l) for l in (OUT/'predictions.jsonl').read_text().splitlines()]
current={(r['id'],r['elapsed']):r for r in json.loads((OLD/'comparator.json').read_text())['forecasts']}
for r in rows:
    b=current[r['id'],r['elapsed']]
    assert (r['forecastAt'],r['truthRemaining'])==(b['forecastAt'],b['truthRemaining'])
for r in list(rows):
    if r['arm']==ARMS[0]:rows.append(dict(r,q=current[r['id'],r['elapsed']]['q'],arm='current_code_component'))
all_arms=(*ARMS,'current_code_component')
scores=[]
for stop in (11,121):
    for contract in CONTRACTS:
        for arm in all_arms:
            rs=[r for r in rows if (r['stop'],r['regime'],r['arm'])==(stop,contract,arm)]
            assert len(rs)==len([r for r in current.values() if r['stop']==stop])
            groups={'all':rs,'role_supported':[r for r in rs if r['roleSupported']],
                    'fallback':[r for r in rs if not r['roleSupported']],
                    'three_plus_history':[r for r in rs if r['roleSupported'] and r['historyCount']>=3],
                    'same_neighbor':[r for r in rs if r['sameAsAhead']],
                    'other_neighbor':[r for r in rs if not r['sameAsAhead']]}
            groups.update({d:[r for r in rs if r['day']==d] for d in sorted({r['day'] for r in rs})})
            groups.update({f'elapsed_{e}':[r for r in rs if r['elapsed']==e] for e in (0,60,180,300,480)})
            for group,ss in groups.items():
                if ss:
                    for weighted in (False,True):scores.append(dict(stop=stop,contract=contract,arm=arm,group=group,weighting='original_cohort' if weighted else 'equal_checkpoint',**base.metrics(ss,weighted)))

by=collections.defaultdict(list)
for r in rows:by[r['stop'],r['regime'],r['arm'],r['id']].append(r)
paired=[]
for (stop,contract,arm,vid),rr in by.items():
    if arm!=ARMS[2]:continue
    cm=base.metrics(rr,True)
    for comparator in (ARMS[0],ARMS[1],'current_code_component'):
        bb=by[stop,contract,comparator,vid];bm=base.metrics(bb,True)
        paired.append(dict(id=vid,stop=stop,contract=contract,day=rr[0]['day'],bus=rr[0]['bus'],comparator=comparator,deltaWIS=cm['wis80']-bm['wis80'],deltaMAE=cm['mae']-bm['mae'],historyCount=rr[0]['historyCount'],roleSupported=rr[0]['roleSupported'],current=bm,candidate=cm,forecasts=[dict(elapsed=r['elapsed'],truth=r['truthRemaining'],candidate=r['q'],baseline=next(b['q'] for b in bb if b['elapsed']==r['elapsed'])) for r in rr]))
regressions=[]
for stop in (11,121):
    for contract in CONTRACTS:
        for comparator in (ARMS[0],ARMS[1],'current_code_component'):
            rr=[r for r in paired if (r['stop'],r['contract'],r['comparator'])==(stop,contract,comparator)]
            regressions.extend(sorted(rr,key=lambda r:-r['deltaWIS'])[:5])

# State frozen at pin. This is conditional component continuation, NOT real
# GPS arrival jumps; matched landmark core itself is not one total-wait CDF.
landmarks=[json.loads(l) for l in (OUT/'role-landmarks.jsonl').read_text().splitlines()]
fitrows=json.loads((OUT/'fits.json').read_text())['fits']
stability=[]
for r in landmarks:
    if r['split']!='development' or r['regime']!=CONTRACTS[0] or r['elapsed']!=0:continue
    fs={f['history']:f for f in fitrows if f['stop']==r['stop'] and f['contract']==r['regime']}
    coeff=np.array(fs['two']['coreCoefficients']);before={};counts={a:dict(pairs=0,up60=0,down1=0,maxUp=0.,maxDown=0.) for a in ARMS}
    for elapsed in range(0,int(min(r['truthRemaining'],900)),15):
        query=dict(r,elapsed=elapsed);t=(np.arange(120)+.5)*15;offset=core(query,t)@coeff
        for arm,name in zip(ARMS,(None,'two','recursive')):
            logits=offset if name is None else offset+features(query,t,name)@np.array(fs[name]['coefficients'])
            absolute=elapsed+base.quantiles(logits)[1]
            if arm in before:
                delta=absolute-before[arm];s=counts[arm];s['pairs']+=1;s['up60']+=delta>60;s['down1']+=delta < -1;s['maxUp']=max(s['maxUp'],delta);s['maxDown']=min(s['maxDown'],delta)
            before[arm]=absolute
    stability.append(dict(id=r['id'],stop=r['stop'],day=r['day'],counts=counts))

for name,obj in [('scores.json',scores),('paired-visits.json',paired),('top-regressions.json',regressions),('component-continuation.json',stability)]:
    (OUT/name).write_text(json.dumps(obj,indent=2)+'\n')
lines=['# Service-role component screen','',
'Inspected development data only. Original-cohort overall weights give each visit total weight one; restricted groups retain original landmark weights. Early means departure before lower bound; late means after upper bound. Seconds throughout. These are known-continuing-rest component forecasts, not served rider ETAs.','',
'| Stop | Contract | Arm | Visits / checkpoints | MAE | p90 | WIS80 | Width | Early | Late |',
'|---|---|---|---:|---:|---:|---:|---:|---:|---:|']
for s in scores:
    if s['group']=='all' and s['weighting']=='original_cohort':lines.append(f"| {s['stop']} | {s['contract']} | {s['arm']} | {s['visits']} / {s['landmarks']} | {s['mae']:.2f} | {s['p90Abs']:.2f} | {s['wis80']:.2f} | {s['width80']:.2f} | {s['earlyRate']:.1%} | {s['lateRate']:.1%} |")
lines+=['','Date, elapsed, support/history and identity-stratum results with both weightings: scores.json. Every paired visit is retained in paired-visits.json. Continuation is a conditional component diagnostic only; no real movement, pin receipt or two-occurrence rider replay is claimed.']
(OUT/'SCORES.md').write_text('\n'.join(lines)+'\n')
print('\n'.join(lines))
print('continuation',json.dumps({f'{stop}/{a}':{k:sum(s['counts'][a][k] for s in stability if s['stop']==stop) for k in ('pairs','up60','down1')} for stop in (11,121) for a in ARMS}))
