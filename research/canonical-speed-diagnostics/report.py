import collections
import datetime as dt
import json
from pathlib import Path

OUT=Path(__file__).resolve().parent/'results'
s=json.loads((OUT/'summary.json').read_text())
fmt=lambda x:'—' if x is None else f'{x:.2f}'
lines=['# Speed and collection-time diagnosis','',s['method']+'.','',
 'This report reuses frozen development data. “High” is the existing planar adjacent-fix speed >22 m/s. Counts below use stable route/provider identity and positive elapsed time. GeographicLib independently calculates WGS84 distance; it does not supply a missing measurement timestamp. Matching uses the same bus/provider/route/date and rounded cadence bin, nearest in collection time.','',
 '## All-line comparison','','| Line | High / stable edges | Median high speed: planar / WGS84 m/s | Distance-error p99 | Prior identical-position polls | Proxy ≤22 m/s | Surrounding path ≤22 m/s | Isolated high edge |','|---|---:|---|---:|---:|---:|---:|---:|']
for rid,r in s['routes'].items():
 d=r['distributions'];f=r['flags'];e=r['edges']
 lines.append(f"| {r['name']} | {r['n']} / {e.get('stableEdges',0)} | {fmt(d['planarMps'].get('p50'))} / {fmt(d['geodesicMps'].get('p50'))} | {fmt(100*d['relativeDistanceError'].get('p99',0))}% | {f.get('identical_position_polled_before',0)} | {f.get('first_repeated_position_timing_proxy_le22',0)} | {f.get('surrounding_path_speed_le22',0)} | {f.get('isolated_threshold_edge',0)} |")
lines+=['','The repeated-position proxy divides the jump by elapsed collection time since that same position was first seen. It is descriptive: the true measurement timestamp remains unknown. Surrounding path speed uses a roughly35–45second bracket, only when every included edge preserves route/provider continuity and gaps ≤60seconds. None of these values changes eligibility.','',
 '## Green and Purple concentration','']
for rid in ('9','10'):
 r=s['routes'][rid];cs=[c for c in s['concentrations'] if str(c['route'])==rid]
 dates=collections.defaultdict(collections.Counter);buses=collections.defaultdict(collections.Counter)
 for c in cs:
  for field in ('stableEdges','movingEdges','highEdges'):
   dates[c['day']][field]+=c.get(field,0);buses[c['bus']][field]+=c.get(field,0)
 lines += [f"### {r['name']}",'',f"Flags: {json.dumps(r['flags'],sort_keys=True)}",'',
  f"Matched low-speed distributions: {json.dumps({k:v for k,v in r['distributions'].items() if k.startswith('matched')},sort_keys=True)}",'',
  '| Date | High / stable edges |','|---|---:|']
 for day,c in sorted(dates.items()):lines.append(f"| {day} | {c['highEdges']} / {c['stableEdges']} |")
 lines+=['','| Bus | High / stable edges |','|---|---:|']
 for bus,c in sorted(buses.items()):lines.append(f"| {bus} | {c['highEdges']} / {c['stableEdges']} |")
 lines.append('')
lines+=['## Predeclared example tracks','','First chronological, median planar speed and maximum planar speed were selected before examining any estimate accuracy. Full selections for all lines are in summary.json. Relative positions are metre offsets from the selected edge start; no absolute coordinates or rider data are published.','']
for sample in s['selections']:
 r=sample['edge']
 if r['route'] not in (9,10):continue
 when=dt.datetime.fromtimestamp(r['start']/1000,dt.timezone.utc).isoformat()
 lines += [f"### {s['routes'][str(r['route'])]['name']} {sample['selection']}: {r['bus']} {when}",'',
  f"Center: {fmt(r['seconds'])}seconds, {fmt(r['distanceM'])}m, planar {fmt(r['planarMps'])}m/s, WGS84 {fmt(r['geodesicMps'])}m/s. Provider names in this window: {sample['providerNamesInWindow']}.",'',
  '| Relative time s | North/east m | Distance from prior fix m | Interval s | Planar / WGS84 m/s | Same coordinates |','|---:|---|---:|---:|---|---|']
 for row in sample['track']:
  lines.append(f"| {fmt(row['relativeSec'])} | {fmt(row['northM'])} / {fmt(row['eastM'])} | {fmt(row.get('distanceM'))} | {fmt(row.get('seconds'))} | {fmt(row.get('planarMps'))} / {fmt(row.get('geodesicMps'))} | {row.get('unchangedCoordinates','—')} |")
 lines.append('')
lines += ['## Limits','',
 '- No archived upstream measurement timestamp: repeated polls and a later coordinate change can overstate speed calculated over one collection interval.',
 '- Stable adjacent names/providers are evidence against a simple identity-switch explanation for those edges; they cannot prove the upstream vehicle assignment or coordinates are correct.',
 '- The collector copies upstream coordinates without interpolation before raw persistence. Upstream interpolation/caching semantics remain unobserved.',
 '- First/median/maximum tracks and matched controls are descriptive, not ground-truth adjudication. No speed threshold, quality gate, model or production schedule changed.',
 '',f"Raw SHA256: `{s['rawSha256']}`; rows: {s['rawRows']}."]
(OUT/'REPORT.md').write_text('\n'.join(lines)+'\n')
