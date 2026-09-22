"""Full-route first. Reused dates; no model selection or causal benefit claims."""
import argparse
import collections
import json
import math
import statistics as st
import study as s
from covariance import covariance_report

def scope(rows):return dict(snapshots=len(rows),visits=len({r['label']['id'] for r in rows}),dates=sorted({s.date(r['at']) for r in rows}))
def visit_mean(rows,fun):
    groups=collections.defaultdict(list)
    for r in rows:groups[r['label']['id']].append(fun(r))
    return st.mean(st.mean(v) for v in groups.values()) if groups else None
def metrics(rows,arm,printed):
    m=s.rr.metrics(rows,arm)
    m['printedWidth']=visit_mean(rows,lambda r:printed[s.key(r)]['deployed' if arm=='deployed' else 'candidates'][arm]['spanSec'] if arm!='deployed' else printed[s.key(r)]['deployed']['spanSec']) if rows and all((printed[s.key(r)]['deployed'] if arm=='deployed' else printed[s.key(r)]['candidates'][arm])['spanSec'] is not None for r in rows) else None
    m['printedPointFallbacks']=sum((printed[s.key(r)]['deployed'] if arm=='deployed' else printed[s.key(r)]['candidates'][arm])['spanSec'] is None for r in rows)
    return m
def tables(rows,printed):return dict(deployed=metrics(rows,'deployed',printed),arms={a:metrics(rows,a,printed) for a in s.ARMS})
def point_metrics(rows,arm):
    return dict(scope(rows),mae=visit_mean(rows,lambda r:abs(r['pointCandidates'][arm]['eta']-r['truth'])),
        bias=visit_mean(rows,lambda r:r['pointCandidates'][arm]['eta']-r['truth']),
        outsideServedEnvelope=sum(not r['deployed']['low']<=r['pointCandidates'][arm]['eta']<=r['deployed']['high'] for r in rows),
        changed=sum(r['pointCandidates'][arm]['eta']!=r['deployed']['eta'] for r in rows),referenceBoundsUnchanged=True)
def distribution(values):
    if not values:return dict(n=0)
    vs=sorted(values);return dict(n=len(vs),mean=st.mean(vs),min=vs[0],max=vs[-1],p50=vs[len(vs)//2],p95=vs[min(len(vs)-1,math.floor(.95*len(vs)))])
def handoffs(rows,arm):
    groups=collections.defaultdict(list);records=[];excluded=collections.Counter()
    for r in rows:groups[r['bus'],r['route'],r['target']].append(r)
    for rs in groups.values():
        rs.sort(key=lambda r:r['at'])
        for a,b in zip(rs,rs[1:]):
            ae,be=a['candidateEvidence'][arm],b['candidateEvidence'][arm]
            fields=('supported','journey','origin','wait','regime','mask','reason')
            flags=[f for f in fields if ae.get(f)!=be.get(f)]
            if arm.startswith('rolling_') and s.date(a['at'])!=s.date(b['at']):flags.append('daily refresh')
            if not flags or not(ae.get('supported',ae.get('changed')) or be.get('supported',be.get('changed'))):continue
            if not a.get('label') or not b.get('label'):excluded['unlabelled']+=1;continue
            if a['label']['id']!=b['label']['id']:excluded['next physical occurrence']+=1;continue
            if not 0<b['at']-a['at']<=30000:excluded['snapshot gap']+=1;continue
            sec=(b['at']-a['at'])/1000
            records.append(dict(at=b['at'],bus=b['bus'],target=b['target'],visit=b['label']['id'],flags=flags,
                jumps={f:b['candidates'][arm][f]-a['candidates'][arm][f]+sec for f in ('eta','low','high')},
                deployedJumps={f:b['deployed'][f]-a['deployed'][f]+sec for f in ('eta','low','high')}))
    return dict(observed=len(records),excluded=excluded,jumps={f:distribution([r['jumps'][f] for r in records]) for f in ('eta','low','high')},records=records)

def run(policy):
    s.canonical.configure();directory=s.OUT/policy;allrows=s.read(directory/'enriched.jsonl.gz');rows=[r for r in allrows if r.get('label')]
    printed={tuple(r['key']):r for r in s.stream(directory/'printed.jsonl.gz')};assert set(printed)=={s.key(r) for r in rows}
    result=dict(policy=policy,controls=json.loads((directory/'verification.json').read_text()),routes={},note='Reused development dates; no automatic promotion. Joint intervals are empirical duration-vector diagnostics, not calibrated coverage claims.')
    covariance=[];seen=set()
    for r in rows:
        for base,g in r['pointDiagnostics'].items():
            if not g['supported']:continue
            mode=base.split('_')[0];identity=(s.key(r),mode,g['k'],g['regime'],tuple(g['mask']))
            if identity in seen:continue
            seen.add(identity)
            covariance.append(dict(quality=policy,route=r['route'],wait=g['wait'],k=g['k'],mode=mode,regime=g['regime'],mask=g['mask'],
                at=r['at'],date=s.date(r['at']),visit=r['label']['id'],journey=g['journey'],truthAbs=r['at']/1000+r['truth'],pointAbs=g['pointAbs'],components={int(j):a for j,a in g['components'].items()}))
    for rid,route in s.ev.ROUTES.items():
        rs=[r for r in rows if r['route']==rid];gs=[r for r in allrows if r['route']==rid]
        union=[r for r in rs if any(g['supported'] for g in r['pointDiagnostics'].values())]
        scopes={'fullRoute':rs,'commonAllArmSupportUnion':union,'original22':[r for r in rs if r['originalCohort']],'highwayAdded':[r for r in rs if not r['originalCohort']]}
        entry=dict(name=route['name'],generated=len(gs),labelled=scope(rs),unlabelled=len(gs)-len(rs),
            unknownOutcomeReasons=dict(collections.Counter(r.get('outcomeReason','unknown') for r in gs if not r.get('label'))),
            scopes={name:tables(v,printed) for name,v in scopes.items()},points={a:point_metrics(rs,a) for a in s.POINT_ARMS},
            generatedPointReasons={b:dict(collections.Counter(r['pointDiagnostics'][b]['reason'] for r in gs)) for b in s.BASES},matched={},handoffs={})
        for base in s.BASES:
            a=base+'_ensemble_joint_raw';b=base+'_single_joint_raw'
            selected=[r for r in rs if r['candidateEvidence'][a]['supported']]
            assert all(r['candidateEvidence'][a]['supported']==r['candidateEvidence'][b]['supported'] for r in rs)
            arms=[base+f'_{e}_joint_{p}' for e in s.ESTIMATORS for p in ('raw','protected')]
            selected_multi=[r for r in selected if len(r['pointDiagnostics'][base]['mask'])>1]
            selected_post=[r for r in selected if r['pointDiagnostics'][base]['regime']=='post-wait']
            entry['matched'][base]={name:dict(scope(v),deployed=metrics(v,'deployed',printed),arms={a:metrics(v,a,printed) for a in arms},
                points={base+'_'+e:point_metrics(v,base+'_'+e) for e in s.ESTIMATORS},
                sources=len({r['pointDiagnostics'][base]['journey'] for r in v})) for name,v in (('all',selected),('multisource',selected_multi),('postWait',selected_post))}
        for arm in s.ARMS:
            hand=handoffs(gs,arm);s.write(directory/f'handoffs-{rid}-{arm}.jsonl.gz',hand.pop('records'));entry['handoffs'][arm]=hand
        result['routes'][rid]=entry
    (directory/'covariance.json').write_text(json.dumps(covariance_report(covariance),indent=2,allow_nan=False)+'\n')
    (directory/'summary.json').write_text(json.dumps(result,indent=2,allow_nan=False)+'\n')
    lines=['# Fixed checkpoint ensemble development results','',result['note'],'','Full-route rows include exact deployed fallbacks; narrower widths alone are not a passing rider-risk result.','',
        '| Route | All sampled / labelled / physical visits | Deployed raw / printed width | K5 frozen protected raw / printed | K10 frozen protected raw / printed |',
        '|---|---:|---:|---:|---:|']
    for rid,e in result['routes'].items():
        t=e['scopes']['fullRoute'];fmt=lambda m:'—' if not m['visits'] else f"{m['width']:.1f} / {m['printedWidth']:.1f}" if m['printedWidth'] is not None else f"{m['width']:.1f} / unknown"
        lines.append(f"| {e['name']} | {e['generated']} / {e['labelled']['snapshots']} / {e['labelled']['visits']} | {fmt(t['deployed'])} | {fmt(t['arms']['frozen_K5_primary_ensemble_joint_protected'])} | {fmt(t['arms']['frozen_K10_primary_ensemble_joint_protected'])} |")
    lines+=['','All fixed frozen/rolling K5/K10 primary/extended arms, matched single-K controls, raw/protected widths, original/addition cohorts, support failures and handoffs are in `summary.json`. Actual formatter outputs are in `printed.jsonl.gz`. Covariance is descriptive and cannot establish a shared-break cause.','',
        'Point-only diagnostics retain deployed bounds as reference metadata; their outside-envelope points are not valid displayed interval forecasts. Fixed-visit reminder replay, censoring and paired waiting are reported separately. No production change or fresh-holdout claim.']
    (directory/'REPORT.md').write_text('\n'.join(lines)+'\n')
    print(json.dumps(dict(policy=policy,routes=len(result['routes']),covarianceCases=len(covariance))))

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--policy',required=True);run(p.parse_args().policy)
