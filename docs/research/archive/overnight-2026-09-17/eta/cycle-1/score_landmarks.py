"""Report every frozen arm without selecting a winner on reused outcomes."""
import collections
import json
from pathlib import Path
from fit_landmarks import ARMS, metrics

OUT=Path(__file__).resolve().parent
rows=[json.loads(x) for x in (OUT/'predictions.jsonl').read_text().splitlines()]
base=json.loads((OUT/'comparator.json').read_text())['forecasts']
base_by={(r['id'],r['elapsed']):r for r in base}
assert len(base_by)==len(base)
for r in rows:
    b=base_by[r['id'],r['elapsed']]
    assert (b['forecastAt'],b['truthRemaining'])==(r['forecastAt'],r['truthRemaining'])
for regime in ('arrival15','completed120'):
    candidate=[r for r in rows if r['regime']==regime and r['arm']==ARMS[0]]
    for r in candidate:
        rows.append(dict(r,**{k:v for k,v in base_by[r['id'],r['elapsed']].items() if k not in ('regime',)},regime=regime))
all_arms=(*ARMS,'current_code_component')
scores=[]
for stop in (11,121):
    for regime in ('arrival15','completed120'):
        for arm in all_arms:
            rs=[r for r in rows if (r['stop'],r['regime'],r['arm'])==(stop,regime,arm)]
            assert len(rs)==len([r for r in base if r['stop']==stop])
            groups={'all':rs,
                    'lap_supported':[r for r in rs if r['lapSupported']],
                    'lap_unsupported':[r for r in rs if not r['lapSupported']],
                    'follower_unknown':[r for r in rs if not r['followerKnown']],
                    'follower_same_as_ahead':[r for r in rs if r['followerKnown'] and r['sameAsAhead']],
                    'follower_distinct':[r for r in rs if r['followerKnown'] and not r['sameAsAhead']]}
            groups.update({d:[r for r in rs if r['day']==d] for d in sorted({r['day'] for r in rs})})
            groups.update({f'elapsed_{s}':[r for r in rs if r['elapsed']==s] for s in (0,60,180,300,480)})
            for group,ss in groups.items():
                if ss:
                    for weighted in (False,True):
                        scores.append(dict(stop=stop,regime=regime,arm=arm,group=group,
                            weighting='visit' if weighted else 'checkpoint',**metrics(ss,weighted)))
# Top regressions by VISIT-averaged proper score, not cherry-picked checkpoints.
by=collections.defaultdict(list)
for r in rows:by[r['stop'],r['regime'],r['arm'],r['id']].append(r)
regressions=[]
for stop in (11,121):
    for regime in ('arrival15','completed120'):
        for arm,comparator in ((ARMS[1],'current_code_component'),(ARMS[2],'current_code_component'),
                               (ARMS[1],ARMS[0]),(ARMS[2],ARMS[1])):
            changes=[]
            for (s,reg,a,vid),rr in by.items():
                if (s,reg,a)!=(stop,regime,arm):continue
                bb=by[s,reg,comparator,vid]
                cm,bm=metrics(rr,True),metrics(bb,True)
                changes.append(dict(id=vid,day=rr[0]['day'],bus=rr[0]['bus'],stop=stop,regime=regime,arm=arm,
                    comparator=comparator,deltaWIS=cm['wis80']-bm['wis80'],deltaMAE=cm['mae']-bm['mae'],
                    current=bm,candidate=cm,forecasts=[dict(elapsed=r['elapsed'],truth=r['truthRemaining'],candidate=r['q'],
                    baseline=next(b['q'] for b in bb if b['elapsed']==r['elapsed'])) for r in rr]))
            regressions.extend(sorted(changes,key=lambda x:-x['deltaWIS'])[:5])
(OUT/'scores.json').write_text(json.dumps(scores,indent=2)+'\n')
(OUT/'top-regressions.json').write_text(json.dumps(regressions,indent=2)+'\n')
lines=['# Frozen landmark remaining-wait screen','',
 'All development dates were previously inspected. This is a conditional true-rest component comparison, not a full rider ETA replay. Quantities are seconds; early means the bus departed before the lower predicted remaining-wait bound.',
 '', '## Visit-weighted primary totals','',
 '| Stop | Contract | Arm | Visits/checkpoints | MAE | p90 abs | WIS80 | Width80 | Early | Late |',
 '|---|---|---|---:|---:|---:|---:|---:|---:|---:|']
for s in scores:
    if s['group']=='all' and s['weighting']=='visit':
        lines.append(f"| {s['stop']} | {s['regime']} | {s['arm']} | {s['visits']}/{s['landmarks']} | {s['mae']:.1f} | {s['p90Abs']:.1f} | {s['wis80']:.1f} | {s['width80']:.1f} | {s['earlyRate']:.1%} | {s['lateRate']:.1%} |")
lines+=['','## Primary contract by date','',
 '| Stop | Date | Arm | Visits/checkpoints | MAE | WIS80 | Early | Late |',
 '|---|---|---|---:|---:|---:|---:|---:|']
for s in scores:
    if s['group'].startswith('2026') and s['weighting']=='visit' and s['regime']=='arrival15':
        lines.append(f"| {s['stop']} | {s['group']} | {s['arm']} | {s['visits']}/{s['landmarks']} | {s['mae']:.1f} | {s['wis80']:.1f} | {s['earlyRate']:.1%} | {s['lateRate']:.1%} |")
lines+=['','All checkpoint-weighted scores, per-landmark, lap availability and follower-identity strata are in `scores.json`. All five worst visit-averaged regressions for each predeclared comparison/stop/contract are in `top-regressions.json`. No cases were deleted.',
 '', 'Production comparator scope: exact current Winchester release functions with preSep10 fit, plus current marginal/lap code with preSep14 tables for Union and unsupported Winchester. This deliberately freezes historical calibration; it does not reproduce the current six-hour refit schedule, live belief mixtures, 30s absolute-arrival pooling, endpoints, repeated occurrences or ranking. Full rider validation remains mandatory before promotion.']
(OUT/'SCORES.md').write_text('\n'.join(lines)+'\n')
print('\n'.join(lines[:26]))
