import json
from pathlib import Path
OUT=Path(__file__).resolve().parent/'results'
s=json.loads((OUT/'summary.json').read_text());v=json.loads((OUT/'verification.json').read_text())
f=lambda x:f'{x:.1f}'
lines=['# Highway-context quality study','',s['note']+'. No production promotion.','',
 'The primary highway25 policy and prespecified highway50 sensitivity share all other gates. Every policy compares candidate arms with the exact deployed comparator on its own common labelled cohort. Original-cohort, addition-only, and cross-policy common-cohort results are separate in summary.json. Introduced-risk metrics use deployed as their reference.','',
 '## Invariance controls','',json.dumps(v['controls'],indent=2),'',
 '## Label availability','','| Policy | Line | Labelled snapshots | Physical visits | Added snapshots | Entirely new physical visits, all routes |','|---|---|---:|---:|---:|---:|']
for policy,routes in s['policies'].items():
 for rid in ('9','10'):
  r=routes[rid]
  lines.append(f"| {policy} | {r['name']} | {r['labelled']} | {r['physicalVisits']} | {r['addedSnapshots']} | {v['outcomes'][policy]['entirelyNewPhysicalVisits']} |")
lines+=['','The last column is a policy total repeated for context; newly labelled snapshots can extend coverage of a previously labelled physical visit. Detailed per-route original/addition metrics remain separate.','',
 '## All changed-arm comparisons on each policy cohort','',
 '| Policy | Line | Arm | Changed visits / source trips / dates | MAE deployed→candidate s | Width deployed→candidate s | Coverage deployed→candidate | New early >60s visits | New false-now snapshots |','|---|---|---|---|---|---|---|---:|---:|']
for policy,routes in s['policies'].items():
 for rid in ('9','10'):
  r=routes[rid]
  for arm,record in r['all'].items():
   a,b=record['changed']['deployed'],record['changed']['candidate']
   if not b.get('visits'):continue
   lines.append(f"| {policy} | {r['name']} | {arm} | {b['visits']} / {b['sourceTrips']} / {b['days']} | {f(a['mae'])}→{f(b['mae'])} | {f(a['width'])}→{f(b['width'])} | {a['coverage']:.1%}→{b['coverage']:.1%} | {b['introducedSevereEarlyVisits']} | {b['introducedFalseNowSnapshots']} |")
lines+=['','Arms change different subsets. Read each row with its paired deployed comparator; use the preserved same-union comparisons to assess frozen versus rolling or primary versus sensitivity. The sensitivity is not selected by these scores.','',
 '## Rider-action availability','',
 '| Policy / cohort | Physical visits | Included common arms | Exclusions |','|---|---:|---:|---|']
for policy in ('original22','highway25','highway50'):
 for cohort in ('all','original-cohort'):
  if policy=='original22' and cohort=='original-cohort':continue
  directory=OUT/policy if cohort=='all' else OUT/policy/cohort
  r=json.loads((directory/'rider-risk/rider-risk-summary.json').read_text())
  c=r['cohort']
  lines.append(f"| {policy} / {cohort} | {c['visits']} | {c['included']} | {json.dumps(c['exclusions'],sort_keys=True)} |")
lines+=['','Action results are hypothetical fixed-visit simulations. Full attempted/scored pair counts, newly missed/rescued visits, raw-lower versus rendered-lower comparisons and renderer parity artifacts accompany every cohort. Sparse snapshot coverage remains explicit.','',
 '## Limits','',
 '- Road proximity and35m/s are prespecified physical-context guards, not a legal-speed claim or proof of a valid GPS measurement.',
 '- Shared subsecond extreme-speed bursts remain rejected. Provider/gap/duplicate/occurrence/support checks are unchanged.',
 '- Original causal features, waits, raw bytes and deployed forecasts are preserved; all new training raw is restricted before cutoff.',
 '- These reused dates cannot justify rollout; all early-tail/action gates and future uninspected-date requirements remain in force.']
(OUT/'REPORT.md').write_text('\n'.join(lines)+'\n')
