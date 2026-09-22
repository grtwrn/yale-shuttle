import json
from pathlib import Path
OUT=Path(__file__).resolve().parent/'results'
s=json.loads((OUT/'summary.json').read_text());road=json.loads((OUT/'road-summary.json').read_text())
fmt=lambda x:'—' if x is None else f'{x:.1f}'
lines=['# Frozen speed sample: route and interstate context','',
 'The existing >22 m/s flag, eligible cohorts and estimates remain unchanged. This report localizes the exact prior flagged edges and matched controls against the pinned canonical route and an independent CTDOT interstate-mainline snapshot. Proximity is descriptive and does not establish valid GPS, actual lane, sensor observation time or legal speed.','',
 '## Published route context','','| Line | Flagged edges | Intercampus leg candidates only | Mixed leg candidates | Other legs | Distance to published route p50 / p99 m |','|---|---:|---:|---:|---:|---|']
for rid,r in s['routes'].items():
 c=r['categories'];d=r['distanceM']
 lines.append(f"| {r['name']} | {r['sameHighEdgeSample']} | {c.get('intercampus',0)} | {c.get('mixed',0)} | {c.get('other_route_legs',0)} | {fmt(d.get('p50'))} / {fmt(d.get('p99'))} |")
lines += ['','Intercampus categories were fixed by stop-to-stop occurrence indices before localization. Candidate legs within10m of the nearest projection are all retained; overlapping directions are not resolved by force. Category counts alone do not require proximity—distance bands in summary.json distinguish that.','',
 '## Independent interstate context','',
 '[CTDOT roadway basemap](https://gisportal.dot.ct.gov/server/rest/services/OpenData/CTDOT_Roadway_Basemap/MapServer/5) supplies eight I-91/I-95 mainline features, marked2025, queried using static area bounds. The original response, query, timestamps and SHA256 are preserved. No OpenStreetMap geometry was used.','',
 '| Line / cohort | Rows / unique edges | Endpoint distance p50 / p99 m | Both endpoints within25m | All five chord samples within25m | All five within50m |','|---|---:|---|---:|---:|---:|']
for rid,r in road['routes'].items():
 for kind in ('flagged','matched_low','matched_moving_low'):
  if rid not in ('9','10') and kind!='flagged':continue
  q=r[kind];d=q['endpointDistanceM']
  lines.append(f"| {r['name']} / {kind} | {q['n']} / {q['uniqueEdges']} | {fmt(d.get('p50'))} / {fmt(d.get('p99'))} | {q['bands']['25']['bothEndpoints']} | {q['bands']['25']['allFiveSamples']} | {q['bands']['50']['allFiveSamples']} |")
lines += ['','Controls are matched per flagged edge, so repeated use is explicit in the unique-edge count. Segment proximity samples0%,25%,50%,75%,100% of the fix-to-fix chord, rather than asserting the entire continuous travel path stays in the corridor. Full25/50/100/250/500/1000m bins and alignment distributions are in road-summary.json.','',
 '## Predeclared examples','',
 '| Line / example | Bus | Published leg candidates | Endpoint distances to interstate m | Midpoint nearest mainline |','|---|---|---|---|---|']
for r in road['selections']:
 if r['route'] not in (9,10):continue
 candidates='; '.join(f"{c['fromStop']} → {c['toStop']} ({c['distanceM']:.1f}m)" for c in r['routeLegCandidates'])
 lines.append(f"| {road['routes'][str(r['route'])]['name']} / {'/'.join(r['selection'])} | {r['bus']} | {candidates} | {' / '.join(fmt(x) for x in r['endpointDistancesM'])} | {r['nearestRoads'][2]} |")
lines += ['','![Green public route and flagged observations](route-9.png)','',
 '![Purple public route and flagged observations](route-10.png)','',
 f"Invariance: {road['sameFlaggedEdgeChecks']} unchanged flagged edges; exact prior matched-control speeds verified; raw and road-source hashes checked. No quality threshold changed."]
(OUT/'REPORT.md').write_text('\n'.join(lines)+'\n')
