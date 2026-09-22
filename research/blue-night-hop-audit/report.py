"""Render small hosted diagnostic artifacts; never read raw observations."""
import json
from pathlib import Path

out=Path(__file__).resolve().parent/'results'
s=json.loads((out/'summary.json').read_text())
t=json.loads((out/'trace-summary.json').read_text())
examples=json.loads((out/'examples.json').read_text())
lines=['# Blue Night forward-hop audit','',
    'Diagnostic only. Original candidate paths, labels, thresholds and production source remain unchanged. Inputs end September20 ET.', '',
    'Published and canonical runtime sequences match, with20 unique physical stop IDs. The serialized topology is one frozen snapshot, not a historical sequence-vintage log.', '',
    '| Population | Index transition | Modulo hop | Rows | Distinct next visits | Source trips | Source-path quality | First-step anchor/phase disagreement |',
    '|---|---|---:|---:|---:|---:|---|---:|']
for r in s['transitions']:
    lines.append(f"| {r['population']} | {r['fromIndex']}→{r['toIndex']} | {r['hop']} | {r['rows']} | {r['events']} | {r['sourceTrips']} | {r['sourceToFailureQuality']} | {r['initialAnchorPhaseDisagreementRows']} |")
lines+=['','Counts across transitions need not represent distinct physical trips. Label rows are repeated forecast snapshots, not independent arrivals.','',
    '## Predeclared chronological examples','',
    '| Population | Bus | Transition | Start UTC | End UTC | Routes/providers | Max gap seconds | Max speed m/s |',
    '|---|---|---|---|---|---|---:|---:|']
for r in examples:
    g=r['gps']
    lines.append(f"| {r['population']} | {r['bus']} | {r['previousIndex']}→{r['nextIndex']} | {r['startUtc']} | {r['endUtc']} | {g['routes']}/{g['providers']} | {g['maxGapSec']:.3f} | {g['maxSpeedMps']:.2f} |")
lines+=['','Detailed before/after detector anchors, global/forward distances, emitted visits and provider last-stop hints are in reducer-traces.jsonl.gz and trace-summary.json. Physical proximity is not a proof that a stop was served.','',
    '## Controls','', '```json',json.dumps({**s['controls'],'canonicalVisitSignaturesIdentical':t['canonicalBlueNightVisitSignaturesIdentical']},indent=2),'```','']
(out/'REPORT.md').write_text('\n'.join(lines))
