import collections
import json
from pathlib import Path

HERE=Path(__file__).resolve().parent
OUT=HERE/'results'
s=json.loads((OUT/'summary.json').read_text())
top=json.loads((HERE.parent/'canonical-windows/results/canonical-topology.json').read_text())
names={str(r['id']):r['name'] for r in top['routes']}
lines=['# Canonical exclusion diagnosis','',s['contract']+'.', '',
       'Counts of conditions overlap. Label columns count forecast snapshots reaching the quality gate; training columns count attempted source-to-target paths at the frozen cutoff. Neither is a count of independent bus trips. Duplicate rows at the exact left boundary follow the pre-existing bisect rule.', '',
       '## Existing label quality exclusions', '',
       '| Route | Quality checked | Pass | Missing boundary | Gap >60s | Speed >22m/s | Route change/boundary | Provider change | Duplicate timestamp |','|---|---:|---:|---:|---:|---:|---:|---:|---:|']
for rid,record in s['labels'].items():
    q=record['qualityReasons']; combinations=record['qualityCombinations']
    lines.append(f"| {names[rid]} | {sum(combinations.values())} | {combinations.get('pass',0)} | {q.get('missing_start_boundary_fix',0)+q.get('missing_end_boundary_fix',0)+q.get('no_bus_fixes',0)} | {q.get('gap_over_60s',0)} | {q.get('speed_over_22mps',0)} | {q.get('route_change',0)}/{q.get('boundary_route_mismatch',0)} | {q.get('provider_change',0)} | {q.get('duplicate_timestamp',0)} |")
lines+=['','## Frozen training-path quality exclusions','','| Route | Accepted | Rejected quality | Gap >60s | Speed >22m/s | Route change | Provider change | Duplicate timestamp |','|---|---:|---:|---:|---:|---:|---:|---:|']
frozen=s['training'][str(min(map(int,s['training'])))]['cells']
for rid,name in names.items():
    cells=[c for c in frozen if str(c['route'])==rid]
    reasons=collections.Counter(); status=collections.Counter()
    for c in cells: reasons.update(c['qualityReasons']); status.update(c['status'])
    lines.append(f"| {name} | {status['accepted']} | {status['quality_rejected']} | {reasons['gap_over_60s']} | {reasons['speed_over_22mps']} | {reasons['route_change']} | {reasons['provider_change']} | {reasons['duplicate_timestamp']} |")
lines+=['','## Unsupported route details','']
for rid,record in s['unsupportedRoutes'].items():
    lines.append(f"### {record['name']}")
    lines+=['',f"Frozen major wait indices: {record['waits']}. All wait-classification statistics, per-cutoff target cells and every observed weighted fitting context are preserved in summary.json.",'']
    groups=record['groups']
    lines+=['| K | Observed unique fitting groups | Groups with failed target | Failing occurrence indices |','|---|---:|---:|---|']
    for k in (1,2,3,5,8,10,15):
        gs=[g for g in groups if g['k']==k]
        bad=collections.Counter(t for g in gs for t in g['blockedTargets'])
        lines.append(f"| {k} | {len(gs)} | {sum(bool(g['blockedTargets']) for g in gs)} | {dict(bad)} |")
    lines.append('')
lines+=['## High-speed observations','','High-speed means only that the existing adjacent-fix calculation exceeds 22 m/s. Stable identity means the adjacent fixes have the same route/provider and positive elapsed time. It does not establish valid physical travel or corruption. The detailed edge artifact contains public bus/time, spacing, distance and neighboring-edge context; no coordinates or rider data.','','| Route | All edges | Stable-identity edges | Stable speed p50/p90/p99 m/s | Stable spacing p50 s | Stable distance p50 m |','|---|---:|---:|---|---:|---:|']
for rid,r in s['highSpeed'].items():
    speed=r['stableIdentitySpeedMps']; gap=r['stableIdentityGapSeconds']; dist=r['stableIdentityDistanceM']
    fmt=lambda x:'—' if x is None else f'{x:.1f}'
    lines.append(f"| {names[rid]} | {r['edges']} | {r['stableIdentityPositiveTimeEdges']} | {' / '.join(fmt(speed.get(k)) for k in ('p50','p90','p99'))} | {fmt(gap.get('p50'))} | {fmt(dist.get('p50'))} |")
lines+=['','## Invariance controls','',json.dumps(s['controls'],indent=2),'','No thresholds, cohorts, estimates or production settings changed.']
(OUT/'REPORT.md').write_text('\n'.join(lines)+'\n')
