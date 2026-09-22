"""Controls and usable sources first; all fixed numeric/printed/risk results follow."""
import collections
import json
import statistics
import retention as study

def printed(rows,family,arm=None):
    groups=collections.defaultdict(list);fallback=0
    for r in rows:
        value=r['deployed'] if family=='deployed' else r[family][arm]
        if value['spanSec'] is None:fallback+=1
        else:groups[r['visit']].append(value['spanSec'])
    return dict(snapshots=len(rows),visits=len({r['visit'] for r in rows}),pointFallbackSnapshots=fallback,
        visitWeightedSpanSec=statistics.mean(statistics.mean(v) for v in groups.values()) if groups else None)

def printed_metrics(rows,arms=study.ARMS):
    return dict(deployed=printed(rows,'deployed'),raw={a:printed(rows,'raw',a) for a in arms},protected={a:printed(rows,'protected',a) for a in arms})

def printed_splits(rows,arms=study.ARMS):
    return dict(all=printed_metrics(rows,arms),original=printed_metrics([r for r in rows if r['original']],arms),additions=printed_metrics([r for r in rows if not r['original']],arms))

def main():
    summary=json.loads((study.OUT/'summary.json').read_text());actions=json.loads((study.OUT/'action-comparisons.json').read_text())
    display={};lines=['# Fixed causal source retention:45 versus90 minutes','',summary['note'],
        '','Provider continuity refers to observed IDs, not proven physical vehicle identity. Same-visit point controls do not establish route-selection or whole-app safety.','',
        '## Validity controls','',json.dumps({k:v for k,v in summary['controls'].items() if k not in ('sourceHashes','featureControls','gateCounts','trainingPathHashes')},sort_keys=True),'']
    for policy in study.POLICIES:
        pr=study.read(study.OUT/f'{policy}-printed.jsonl.gz');printed_bykey={tuple(r['key']):r for r in pr};display[policy]={}
        for rid in ('9','10'):
            route=summary['policies'][policy][rid];rs=[r for r in pr if str(r['route'])==rid]
            fixed=[r for r in rs if any(a.endswith('_cap45') for a in r['rawChanged'])]
            union=[r for r in rs if r['rawChanged']]
            scopes=dict(fullRoute=printed_splits(rs),fixed45RawAll14Union=printed_splits(fixed),all28RawUnion=printed_splits(union),
                matchedProtectedUnion={a:printed_splits([r for r in rs if any(a+f'_cap{cap}' in r['protectedChanged'] for cap in study.CAPS)],
                    [a+f'_cap{cap}' for cap in study.CAPS]) for a in study.BASE_ARMS})
            transitions={}
            for arm in study.ARMS:
                samples=[]
                for t in study.read(study.OUT/policy/f'transitions-{rid}-{arm}.jsonl.gz'):
                    a=printed_bykey[t['previousAt'],t['bus'],int(rid),t['target']]['protected'][arm]
                    b=printed_bykey[t['at'],t['bus'],int(rid),t['target']]['protected'][arm]
                    samples.append(dict(at=t['at'],previousAt=t['previousAt'],bus=t['bus'],target=t['target'],visit=t['visit'],flags=t['flags'],
                        before=a,after=b,printedSpanJumpSec=b['spanSec']-a['spanSec'] if a['spanSec'] is not None and b['spanSec'] is not None else None))
                study.write(study.OUT/policy,f'printed-transitions-{rid}-{arm}',samples)
                transitions[arm]=dict(observed=len(samples),spanJumpSec=study.shared.distribution([r['printedSpanJumpSec'] for r in samples if r['printedSpanJumpSec'] is not None]),
                    pointFallbackTransitions=sum(r['printedSpanJumpSec'] is None for r in samples))
            display[policy][rid]=dict(scopes=scopes,transitions=transitions)
            lines += [f"## {policy}: {route['name']} — usable-source gates first",'',json.dumps(route['denominator']),
                '', '| Arm | Newly retained snapshots / strict source emissions | Checkpoint | Released/live | Support fallback | Countdown expired | Other |',
                '|---|---:|---:|---:|---:|---:|---:|']
            for arm,g in route['usableSourceGates'].items():
                n=lambda name:g['reasons'].get(name,{}).get('snapshots',0)
                known=('checkpoint','released/live','group lacks historical support','group countdown expired')
                lines.append(f"| {arm} | {g['newlyRetained']} / {g['strictEmissions']} | {n('checkpoint')} | {n('released/live')} | {n('group lacks historical support')} | {n('group countdown expired')} | {g['newlyRetained']-sum(n(name) for name in known)} |")
            for scope in ('fullRoute','fixed45RawAll14Union','all28RawUnion'):
                for split in ('all','original','additions'):
                    record=route[scope][split];base=record['deployed'];ps=scopes[scope][split];pv=ps['deployed']['visitWeightedSpanSec']
                    lines += ['',f'### {scope} / {split}','',f"{base['snapshots']} snapshots / {base['visits']} visits; deployed numeric width {base.get('width',0):.1f}s, printed {pv if pv is not None else 'unavailable'}s; coverage {base.get('coverage',0):.1%}.",
                        '', '| Arm | Numeric protected45 →90 s | Printed protected45 →90 s | Coverage45 →90 | Early>60s45 →90 | Late45 →90 | Raw numeric45 →90 s |',
                        '|---|---:|---:|---:|---:|---:|---:|']
                    for a in study.BASE_ARMS:
                        old=a+'_cap45';new=a+'_cap90';x=record['protected'][old]['metrics'];y=record['protected'][new]['metrics'];rx=record['raw'][old]['metrics'];ry=record['raw'][new]['metrics']
                        pp=lambda name:ps['protected'][name]['visitWeightedSpanSec']
                        lines.append(f"| {a} | {x.get('width',0):.1f} → {y.get('width',0):.1f} | {pp(old)} → {pp(new)} | {x.get('coverage',0):.1%} → {y.get('coverage',0):.1%} | {x.get('early60',0):.1%} → {y.get('early60',0):.1%} | {x.get('late',0):.1%} → {y.get('late',0):.1%} | {rx.get('width',0):.1f} → {ry.get('width',0):.1f} |")
    lines += ['', '## Fixed-visit action and renderer controls','']
    for policy,cohorts in actions.items():
        for cohort,r in cohorts.items():
            directory=study.OUT/policy/('rider-risk' if cohort=='all' else 'original-cohort/rider-risk')
            parity=json.loads((directory/'rendered-parity.json').read_text());assert parity['mismatches']==0
            newmiss=[c for c in r['cap90Against45'] if c['newlyMissed']]
            extra=[c for c in r['cap90Against45'] if c['pairedWaitDeltaSeconds'].get('max',0)>0]
            lines.append(f"- {policy} / {cohort}: {json.dumps(r['controls'])}; renderer {json.dumps(parity)}; cap90-versus45 new-miss cells {len(newmiss)}, positive-extra-wait cells {len(extra)}.")
    lines += ['','All walks/responses, misses, waiting and censoring cells are preserved in action-comparisons.json; physical-visit tails, same-pickup handoffs, unmatched/next-occurrence transitions, matched-arm unions and zero-change cells remain in summary.json. Exact printed endpoints/spans are in printed-summary.json and per-arm transition files.','',
        'No cap/K selection, new dates/outcomes, or production change. A retained source that fails phase/release/support/countdown gates is not a usable forecast. Reused development results cannot establish prospective or whole-app safety.']
    (study.OUT/'printed-summary.json').write_text(json.dumps(display,indent=2)+'\n')
    (study.OUT/'REPORT.md').write_text('\n'.join(lines)+'\n')
    print(json.dumps(dict(report='REPORT.md',allFixedArms=len(study.ARMS),policies=study.POLICIES)))

if __name__=='__main__':main()
