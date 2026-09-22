"""Render every fixed arm on common cohorts, without selecting a winner."""
import json
from pathlib import Path

out = Path(__file__).parent / 'results'
s = json.loads((out / 'summary.json').read_text())
lines = ['# Window-only hybrid diagnostic', '',
    'Unchanged deployed point ETA; lower bound never later; empirical candidate upper bound floored at the deployed point. Every fixed frozen/rolling K is retained. These reused dates cannot support production promotion, and this hybrid does not define a coherent 50-quantile distribution.', '',
    '## Common route cohorts', '',
    'Each route uses the same union of rows changed by any hybrid arm. All values are visit-balanced. See JSON for all-row and per-K common cohorts; per-arm changed subsets must not be used to rank Ks.', '',
    '| Line | Arm | Visits / sources / dates | Width deployed → hybrid, s | Coverage deployed → hybrid | Late rate deployed → hybrid | Numeric gate failures |',
    '|---|---|---:|---:|---:|---:|---|']
for rid, comparison in s['commonComparisons'].items():
    d = comparison['deployed']
    if not d['snapshots']:
        lines.append(f"| {s['availability'][rid]['name']} | all | 0 | — | — | — | no changed support |")
        continue
    for arm, c in comparison['arms'].items():
        failures = ', '.join(s['routes'][rid][arm]['commonNumericalGateFailures']) or 'none; action/handoff/fresh-date gates still required'
        lines.append(f"| {s['availability'][rid]['name']} | {arm} | {c['visits']} / {c['sourceTrips']} / {len(c['dates'])} | {d['width']:.2f} → {c['width']:.2f} | {d['coverage']:.2%} → {c['coverage']:.2%} | {d['late']:.2%} → {c['late']:.2%} | {failures} |")
lines += ['', '## Red K10 scope', '',
    'Identical frozen/rolling hybrid union within each slice. Actual deployed activation is separate from target geometry. Visits may span activation/fallback states and counts are not additive.', '',
    '| Slice | Arm | Snapshots / visits / sources / dates | Width deployed → hybrid, s | Coverage deployed → hybrid | Early rate | Late rate |',
    '|---|---|---:|---:|---:|---:|---:|']
for name, comparison in s['redScope']['10'].items():
    d = comparison['deployed']
    if not d['snapshots']:
        continue
    for arm, c in comparison['arms'].items():
        lines.append(f"| {name} | {arm} | {c['snapshots']} / {c['visits']} / {c['sourceTrips']} / {len(c['dates'])} | {d['width']:.2f} → {c['width']:.2f} | {d['coverage']:.2%} → {c['coverage']:.2%} | {d['early']:.2%} → {c['early']:.2%} | {d['late']:.2%} → {c['late']:.2%} |")
lines += ['', '## Limits', '',
    '- Point ETA and MAE are unchanged by construction, including exact unsupported fallback. This does not certify the new upper bound or interval coverage.',
    '- Bounds, ordering and handoffs must be evaluated independently. Additional waiting is a real cost even when earlier reminders reduce a missed-boarding proxy.',
    '- Canonical labels/baseline and original raw hashes are invariant; no new model is fitted and no outcomes are excluded for poor performance.',
    '- Recorded snapshots are sparse, with extensive action censoring. Fixed-visit hypothetical decisions are not measured rider misses or a full app journey replay.',
    '- All prior promotion gates and independent fresh-date support remain required. No automatic production winner is selected.',
    '- See audit.json, action-audit.json, rider-risk files and record-level forecasts for reproducibility.']
(out / 'REPORT.md').write_text('\n'.join(lines) + '\n')
