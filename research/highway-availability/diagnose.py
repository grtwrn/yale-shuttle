"""Hosted, descriptive availability counts; never fit or infer missing history."""
import collections
import gzip
import hashlib
import json
import math
from pathlib import Path
import statistics as st
import datetime as dt
from zoneinfo import ZoneInfo

HERE=Path(__file__).resolve().parent;IN=HERE/'input';OUT=HERE/'results'
CANON=HERE/'canonical/canonical-windows/results'
ARMS=[f'{mode}_K{k}' for mode in ('frozen','rolling') for k in (1,2,3,5,8,10,15)]


def read(path):
 with gzip.open(path,'rt') as f:return [json.loads(line) for line in f]


def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()


def key(r):return r['at'],r['bus'],r['route'],r['target']


def dist(values):
 values=sorted(values)
 if not values:return dict(n=0)
 def q(p):
  i=(len(values)-1)*p;a=int(i);b=min(a+1,len(values)-1);return values[a]+(values[b]-values[a])*(i-a)
 return dict(n=len(values),mean=st.mean(values),min=values[0],median=q(.5),p95=q(.95),max=values[-1])


def counts(rows,labels):
 labelled=[r for r in rows if key(r) in labels]
 return dict(generatedSnapshots=len(rows),labelledSnapshots=len(labelled),physicalVisits=len({labels[key(r)] for r in labelled}))


def printed_metrics(rows,family,arm=None):
 groups=collections.defaultdict(list);missing=0;texts=collections.Counter()
 for r in rows:
  f=r['deployed'] if family=='deployed' else r[family][arm]
  texts[f['text']]+=1
  if f['spanSec'] is None:missing+=1
  else:groups[r['visit']].append(f['spanSec'])
 return dict(snapshots=len(rows),physicalVisits=len({r['visit'] for r in rows}),windows=sum(map(len,groups.values())),pointFallbackSnapshots=missing,
  visitWeightedPrintedSpanSec=st.mean(st.mean(v) for v in groups.values()) if groups else None,
  snapshotPrintedSpanSec=dist([v for values in groups.values() for v in values]),printedTextCounts=dict(texts))


def printed_scope(rows):
 return dict(deployed=printed_metrics(rows,'deployed'),raw={a:printed_metrics(rows,'raw',a) for a in ARMS},protected={a:printed_metrics(rows,'protected',a) for a in ARMS})


def main():
 OUT.mkdir(exist_ok=True)
 assert sha(CANON/'canonical-topology.json')=='eb753d58c4ace616e844b3a54842978c4ec46833373560e1b236d7b5d61b40bc'
 assert sha(CANON/'preparation.json')=='2edd09127b7d41357ef6ecb6bf461f75c4f0b59c33d37ad2dd11cff24269df0d'
 routes={r['id']:r for r in json.loads((CANON/'canonical-topology.json').read_text())['routes']}
 waits=json.loads((CANON/'preparation.json').read_text())['waits']
 hashes={str(p.relative_to(IN)):sha(p) for p in IN.rglob('*') if p.is_file() and p.name in ('unscored.jsonl.gz','forecasts.jsonl.gz','action-comparisons.json','summary.json','verification.json')}
 output=dict(sourceRun=35690386363,descriptiveOnly=True,sourceHashes=hashes,policies={},limits=[
  'Missing filtered origins cannot distinguish age expiry, never-emitted source, route/identity reset or warmup.',
  'Not-ready rows retain observation age and index, but not warm first/last or full state-route evidence.',
  'Physical-visit reason counts are nonexclusive across snapshots; unlabelled rows have no physical-visit attribution.',
  'Printed span uses exact displayed minute endpoints; <1 starts at zero. Point fallbacks are counted, never assigned zero width.',
  'No new outcome or ETA accuracy score is computed. Full-app route selection is outside fixed-visit action controls.'])
 actions=json.loads((IN/'action-comparisons.json').read_text())
 for policy in ('highway25','highway50'):
  rows=read(IN/policy/'unscored.jsonl.gz');labelled=read(IN/policy/'forecasts.jsonl.gz')
  labels={key(r):r['label']['id'] for r in labelled};printed=read(OUT/f'{policy}-printed.jsonl.gz');report={}
  for rid in (9,10):
   rs=[r for r in rows if r['route']==rid];ps=[r for r in printed if r['route']==rid];n=len(routes[rid]['stops']);arms={}
   for arm in ARMS:
    k=int(arm.split('_K')[1]);reasons=collections.defaultdict(list);notready=collections.Counter();ages=[];missing=0;support=collections.defaultdict(list);release=collections.Counter();phase=collections.Counter()
    categories=collections.defaultdict(list)
    for r in rs:
     reason=r['rawCandidateReasons'][arm];reasons[reason].append(r);phase[r['phase']]+=1
     raw=r['rawCandidates'][arm];fixed=r['candidates'][arm];base=r['deployed']
     for prefix,f in (('raw',raw),('protected',fixed)):
      if f==base:category='exact deployed'
      else:
       delta=f['high']-f['low']-(base['high']-base['low'])
       category='narrower' if delta<0 else 'wider' if delta>0 else 'changed equal width'
      categories[prefix+' '+category].append(r)
     if raw!=base and fixed==base:categories['protection eliminated raw change'].append(r)
     if not r['ready']:
      lag=r['asof']-r['observedAt']
      # Nonexclusive directly observable features, never an inferred warmup cause.
      observed=False
      if r['observedAt']<=0:notready['missing observation timestamp']+=1;observed=True
      elif lag<0:notready['observation after asof']+=1;observed=True
      elif lag>15000:notready['observation older than15s']+=1;observed=True
      if r['index']<0:notready['unknown phase/index']+=1;observed=True
      if not observed:notready['warmup or state-route prerequisite not distinguishable']+=1
     ti=r.get('targetIndex');ws=waits[str(rid)]
     if ti is None or not ws:continue
     wait=min(ws,key=lambda w:(ti-w)%n or n);source=(wait-k)%n;origin=r['origins'].get(str(source))
     if origin:
      age=(r['at']-origin['departed'])/1000;assert age<=2700 and origin['knownAt']<=r['asof'];ages.append(age)
     elif reason=='source departure unavailable':missing+=1
     if reason=='group lacks historical support':
      assert origin is not None
      target=r['rawCandidateEvidence'][arm].get('unsupportedTargetIndex')
      support[str(target)].append(r)
     if reason=='released/live':
      assert origin is not None
      observed=False;end=r['origins'].get(str(wait))
      if r.get('releasedOrigins',{}).get(f'{k}/{wait}')==origin['departed']:release['latched source release']+=1;observed=True
      if end and end['departed']>origin['departed']:release['later wait departure present']+=1;observed=True
      if (r['index']-source)%n>k:release['phase progressed past wait segment']+=1;observed=True
      if r['index']==wait and r['phase']=='drive':release['departing wait phase']+=1;observed=True
      assert observed
    assert sum(len(v) for v in reasons.values())==len(rs)
    assert sum(len(v) for key_,v in categories.items() if key_.startswith('raw '))==len(rs)
    assert sum(len(v) for key_,v in categories.items() if key_.startswith('protected '))==len(rs)
    arms[arm]=dict(reasons={key_:counts(v,labels) for key_,v in reasons.items()},widthCategories={key_:counts(v,labels) for key_,v in categories.items()},
     notReadyObservableFlags=notready,availableRequestedOriginAgeSec=dist(ages),missingRequestedSourceSnapshots=missing,
     sourceAbsenceCause='not identifiable from filtered origins',unsupportedTargetOccurrences={key_:counts(v,labels) for key_,v in support.items()},
     releasedLiveObservableFlags=release,phaseCounts=phase)
   scopes={'fullRoute':ps,'fixedRawAll14Union':[r for r in ps if r['rawChanged']], 'protectedAll14Union':[r for r in ps if r['protectedChanged']]}
   report[rid]=dict(name=routes[rid]['name'],denominator=counts(rs,labels),arms=arms,
    printed={name:dict(all=printed_scope(v),original=printed_scope([r for r in v if r['original']]),additions=printed_scope([r for r in v if not r['original']])) for name,v in scopes.items()})
  action_report={}
  for cohort,a in actions[policy].items():
   cells=[c for c in a['againstDeployed'] if c['candidatePolicy']==c['baselinePolicy']]
   riskpath=IN/policy/('rider-risk' if cohort=='all' else 'original-cohort/rider-risk')/'rider-risk-summary.json'
   statusgroups={}
   for cell in json.loads(riskpath.read_text())['cells']:
    if cell['route'] not in (9,10):continue
    group=tuple(cell[k] for k in ('route','arm','policy','walkSec','responseSec'))
    if group not in statusgroups:statusgroups[group]=dict(records=0,scored=0,missed=0,statuses=collections.Counter(),censorReasons=collections.Counter())
    aggregate=statusgroups[group];aggregate['records']+=cell['records'];aggregate['scored']+=cell['scored'];aggregate['missed']+=cell['hypotheticalMissedBoardings']
    aggregate['statuses'].update(cell['statuses']);aggregate['censorReasons'].update(cell['censorReasons'])
   statuses=[dict(route=k[0],arm=k[1],policy=k[2],walkSec=k[3],responseSec=k[4],**v) for k,v in sorted(statusgroups.items())]
   action_report[cohort]=dict(allSamePolicyCells=cells,positiveExtraWaitingCells=[c for c in cells if c['pairedWaitDeltaSeconds'].get('max',0)>0],
    newMissCells=[c for c in cells if c['newlyMissed']],fullActionStatusCells=statuses,cohort=a['actionSummary'])
  output['policies'][policy]=dict(routes=report,action=action_report)
 assert hashes=={str(p.relative_to(IN)):sha(p) for p in IN.rglob('*') if p.is_file() and p.name in ('unscored.jsonl.gz','forecasts.jsonl.gz','action-comparisons.json','summary.json','verification.json')}
 (OUT/'diagnostic.json').write_text(json.dumps(output,indent=2)+'\n')
 lines=['# Protected-window availability and actual displayed spans','',*['- '+v for v in output['limits']],'']
 for policy,p in output['policies'].items():
  for rid,route in p['routes'].items():
   lines += [f"## {policy}: {route['name']}",'',json.dumps(route['denominator']),'',
    '| Arm | Generated checkpoint | Support fallback | Source unavailable | Released/live | Not ready | Labelled protected narrow / wider snapshots |','|---|---:|---:|---:|---:|---:|---:|']
   for arm,r in route['arms'].items():
    count=lambda reason:r['reasons'].get(reason,{}).get('generatedSnapshots',0)
    narrow=r['widthCategories'].get('protected narrower',{}).get('labelledSnapshots',0);wide=r['widthCategories'].get('protected wider',{}).get('labelledSnapshots',0)
    lines.append(f"| {arm} | {count('checkpoint')} | {count('group lacks historical support')} | {count('source departure unavailable')} | {count('released/live')} | {count('not warm/fresh')} | {narrow} / {wide} |")
   for name,scopes in route['printed'].items():
    r=scopes['all'];base=r['deployed'];fmt=lambda v:'unavailable' if v is None else f'{v:.1f}'
    lines += ['',f"### Actual printed span: {name}",'',f"{base['snapshots']} snapshots / {base['physicalVisits']} visits; deployed printed span {fmt(base['visitWeightedPrintedSpanSec'])}s; point fallbacks {base['pointFallbackSnapshots']}.",'',
     '| Arm | Raw printed span s | Protected printed span s | Point fallback snapshots |','|---|---:|---:|---:|']
    for arm in ARMS:
     lines.append(f"| {arm} | {fmt(r['raw'][arm]['visitWeightedPrintedSpanSec'])} | {fmt(r['protected'][arm]['visitWeightedPrintedSpanSec'])} | {r['protected'][arm]['pointFallbackSnapshots']} |")
   lines.append('')
 (OUT/'REPORT.md').write_text('\n'.join(lines)+'\n')
 print(json.dumps(dict(sourceRun=output['sourceRun'],policies=list(output['policies']),descriptiveOnly=True)))


if __name__=='__main__':main()
