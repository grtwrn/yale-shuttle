"""Print every cell on common cohorts; never choose a winner."""
import json
from study import OUT, ARMS, LEADS
s=json.loads((OUT/'summary.json').read_text())
p=json.loads((OUT/'printed-summary.json').read_text())
h=json.loads((OUT/'handoff-audit.json').read_text())
a=json.loads((OUT/'action-audit.json').read_text())
lines=['# Brown clock lifetime and freshness diagnostic','',s['note'],'',
 'All eight cells use the same union of changed rows, equal weight per physical visit. Original-control union and all rows remain separately reported. Source/date support is descriptive; these are reused development dates.','',
 '| Arm | Visits / sources / dates | Raw narrowing | Printed narrowing | Coverage | Late >120s | Printed narrower / wider | Numeric failures |',
 '|---|---:|---:|---:|---:|---:|---:|---|']
c=s['comparisons']['eightArmUnion'];d=c['deployed']
for arm in ARMS:
 v=c['arms'][arm];printed=next(r for r in p['results'] if r['scope']=='eightArmUnion' and r['ageSec']==0 and r['arm']==arm)
 fail=', '.join(s['armsDetail'][arm]['commonNumericalGateFailures']) or 'none; other gates unresolved'
 lines.append(f"| {arm} | {v['visits']} / {v['sourceTrips']} / {len(v['dates'])} | {d['width']-v['width']:.2f}s | {printed['printedSaving']:.2f}s | {d['coverage']:.2%} → {v['coverage']:.2%} | {v['late120']:.2%} | {printed['printedNarrower']:.1%} / {printed['printedWider']:.1%} | {fail} |")
lines+=['','## Factor contrasts on the same eight-arm union','',
 '| Lead | Reference → alternative | Raw width change | Coverage change | Late-excess change |',
 '|---|---|---:|---:|---:|']
for lead in LEADS:
 for ca,cb in (('h45_f15','h90_f15'),('h45_f45','h90_f45'),('h45_f15','h45_f45'),('h90_f15','h90_f45')):
  x,y=c['arms'][lead+'_'+ca],c['arms'][lead+'_'+cb]
  lines.append(f"| {lead} | {ca} → {cb} | {y['width']-x['width']:+.2f}s | {(y['coverage']-x['coverage'])*100:+.3f}pp | {y['lateExcessSec']-x['lateExcessSec']:+.2f}s |")
lines+=['','## Transition and action costs','',
 '| Arm | Observed handoffs | Causes | 3min rendered common pairs | Added misses | Mean added waiting |',
 '|---|---:|---|---:|---:|---:|']
for arm in ARMS:
 r=next(r for r in a['pairedSamePolicy'] if r['arm']==arm and r['policy']=='rendered_lower' and r['walkSec']==180 and r['responseSec']==0)
 v=r['allEightCommon'];causes=', '.join(f"{k}: {x['count']}" for k,x in h[arm]['causes'].items())
 lines.append(f"| {arm} | {h[arm]['observed']} | {causes} | {v['pairedScored']} / {r['pair']['attempted']} | {v['newlyMissed']} | {v['meanAddedWaitSec']}s |")
lines+=['','Point timing is unchanged by construction; renderer parity, waiting and paired action risk remain independently checked. Small action support and extensive censoring prevent a rider-safety claim. All same-visit handoffs, excluded transition counts, first/largest causes, clock directions and GPS/provider continuity are in handoff-audit.json and handoff-records.jsonl.gz.',
 '', 'K8 phase-return/source-lap ambiguity remains unresolved; neither relaxed lifetime nor freshness repairs it. Every prior gate, including adjacent ordering and genuinely fresh support, remains active. No new dates were scored, no smoothing applied and no production change made.','']
(OUT/'REPORT.md').write_text('\n'.join(lines))
