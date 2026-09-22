"""Render every supported arm without selecting a production winner."""
import json
from pathlib import Path

out = Path(__file__).parent / 'results'
summary = json.loads((out / 'summary.json').read_text())
preparation = json.loads((out / 'preparation.json').read_text())
lines = ['# Canonical occurrence study', '',
    'Reused development dates with a new reconstructed-label cohort. Every arm and the deployed overlay share that cohort. No production promotion.', '',
    '## Availability', '',
    '| Line | Forecast snapshots | Resolved occurrence | Labelled | Physical visits | Frozen wait indices |',
    '|---|---:|---:|---:|---:|---|']
for rid, row in summary['availability'].items():
    lines.append(f"| {row['name']} | {row['generated']} | {row['resolvedOccurrences']} | {row['labelled']} | {row['physicalVisits']} | {preparation['waits'][rid]} |")
lines += ['', '## Changed forecast subsets', '',
    'Values are visit-weighted. Different arms change different subsets; compare each row with its paired deployed comparator, or use refreshComparisons in JSON for the same frozen/rolling union.', '',
    '| Line | Arm | Visits / source trips | MAE deployed → candidate, s | Width deployed → candidate, s | Coverage deployed → candidate | New early >60s visits | New false-now snapshots |',
    '|---|---|---:|---:|---:|---:|---:|---:|']
for rid, arms in summary['routes'].items():
    for arm, values in arms.items():
        a, b = values['changed']['candidate'], values['changed']['deployed']
        if not a['snapshots']:
            continue
        lines.append(f"| {summary['availability'][rid]['name']} | {arm} | {a['visits']} / {a['sourceTrips']} | {b['mae']:.1f} → {a['mae']:.1f} | {b['width']:.1f} → {a['width']:.1f} | {b['coverage']:.1%} → {a['coverage']:.1%} | {a['introducedSevereEarlyVisits']} | {a['introducedFalseNowSnapshots']} |")
lines += ['', '## Occurrence and outcome exclusions', '']
for rid, row in summary['availability'].items():
    lines += [f"- {row['name']}: occurrence={json.dumps(row['occurrenceReasons'],sort_keys=True)}; outcomes={json.dumps(row['outcomeReasons'],sort_keys=True)}"]
lines += ['', '## Controls and limitations', '',
    '- Control checks: ' + json.dumps(summary['controls'], sort_keys=True),
    '- Historical label comparison: ' + json.dumps(summary['labelCohortChange']['counts'], sort_keys=True),
    '- Canonical wait classification and causal reconstruction intentionally differ from the old published-order fit. This study does not reproduce the exact historical live-model fit.',
    '- Missing archived GPS and sparse screen telemetry limit route/day support. A zero supported arm is an availability finding, not evidence that no better estimator exists.',
    '- Ambiguous repeated-stop anchors and an intervening physical pickup are excluded explicitly; future outcomes never resolve a feature.',
    '- Action-risk results are hypothetical fixed-visit simulations, not measured human missed-shuttle rates. See rider-risk artifacts and rendered parity evidence.',
    '- Fresh unseen dates and all accuracy/early-tail/action gates remain required before any rollout.']
(out / 'REPORT.md').write_text('\n'.join(lines) + '\n')
