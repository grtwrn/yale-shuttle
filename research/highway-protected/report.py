import json
from pathlib import Path
OUT=Path(__file__).resolve().parent/'results'
s=json.loads((OUT/'summary.json').read_text());actions=json.loads((OUT/'action-comparisons.json').read_text())
lines=['# Protected highway windows','',s['note']+'. All fixed arms retained. No production promotion.','',
    'The transform keeps the deployed point and prevents a later lower endpoint. Structural point/action invariance does not establish calibration. Raw, protected, and deployed are compared on identical cohorts; original/addition snapshot cohorts can overlap physical visits.','']
for policy,routes in s['policies'].items():
    for rid in ('9','10'):
        r=routes[rid]
        lines += [f"## {policy}: {r['name']}",'',f"{r['generated']} generated snapshots; {r['labelled']} labelled / {r['physicalVisits']} physical visits. Original {r['originalPhysicalVisits']} visits; added snapshots cover {r['addedSnapshotPhysicalVisits']} visits ({r['overlapPhysicalVisits']} overlap; {r['entirelyNewPhysicalVisits']} entirely new).",'']
        for scope in ('fullRoute','fixedRawAll14ChangedUnion','protectedAll14ChangedUnion'):
            for split in ('all','original','additions'):
                record=r[scope][split];base=record['deployed']
                lines += [f"### {scope} / {split}",'',f"{base['snapshots']} snapshots / {base['visits']} visits; deployed width {base.get('width',0):.1f}s, coverage {base.get('coverage',0):.1%}, MAE {base.get('mae',0):.1f}s.",'',
                    '| Arm | Raw → protected width s | Raw → protected coverage | Raw → protected early >60s | Raw → protected late | Used source trips |','|---|---:|---:|---:|---:|---:|']
                for arm,a in record['protected'].items():
                    a=a['metrics'];b=record['raw'][arm]['metrics']
                    if not a['visits']:continue
                    lines.append(f"| {arm} | {b['width']:.1f} → {a['width']:.1f} | {b['coverage']:.1%} → {a['coverage']:.1%} | {b['early60']:.1%} → {a['early60']:.1%} | {b['late']:.1%} → {a['late']:.1%} | {a['sourceTrips']} |")
                lines.append('')
lines+=['## Action and renderer controls','',
    'All walks/responses, point/raw-lower/rendered-lower comparisons, raw/protected paired outcomes, exact censor counts, and conditional paired waiting differences are retained in action-comparisons.json and the per-cohort rider-risk summaries.','']
for policy,cohorts in actions.items():
    for cohort,r in cohorts.items():
        path=OUT/policy/('rider-risk' if cohort=='all' else 'original-cohort/rider-risk')
        parity=json.loads((path/'rendered-parity.json').read_text());assert parity['mismatches']==0
        lines.append(f"- {policy} / {cohort}: controls {json.dumps(r['controls'],sort_keys=True)}; renderer {json.dumps(parity,sort_keys=True)}.")
lines+=['','Freshness and origin clocks were unchanged. Handoffs and all missing-transition categories remain in summary.json. These reused dates and sparse scored actions cannot establish prospective safety or justify deployment.']
(OUT/'REPORT.md').write_text('\n'.join(lines)+'\n')
