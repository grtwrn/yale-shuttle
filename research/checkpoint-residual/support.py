"""Necessary source-date/journey ceilings only. No fits or target outcomes."""
import collections
import datetime as dt
import gzip
import hashlib
import json
from pathlib import Path
from zoneinfo import ZoneInfo

HERE=Path(__file__).resolve().parent
TZ=ZoneInfo('America/New_York')
BANK_DAYS=('2026-09-16','2026-09-17','2026-09-18','2026-09-19')
def midnight(day):return int(dt.datetime.fromisoformat(day).replace(tzinfo=TZ).timestamp()*1000)
def date(at):return dt.datetime.fromtimestamp(at/1000,TZ).date().isoformat()
def weekend(at):return dt.datetime.fromtimestamp(at/1000,TZ).weekday()>=5
def stream(path):
    with gzip.open(path,'rt') as f:
        for line in f:
            if line.strip():yield json.loads(line)
def write(path,rows):
    with gzip.open(path,'wt') as f:
        for r in rows:f.write(json.dumps(r,separators=(',',':'),allow_nan=False)+'\n')
def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def targets(routes,waits,rid,w):
    n=len(routes[rid]['stops']);length=min([(v-w)%n for v in waits[str(rid)] if v!=w] or [n-1])
    return tuple((w+i)%n for i in range(1,length+1))
def cell(rid,m,target,source):
    return (rid,m['wait'],tuple(m['targetGroup']),target,m['k'],tuple(m['offsets']),m['regime'],weekend(source['departed']))
def unpack(c):
    return dict(route=c[0],wait=c[1],targetGroup=c[2],targetIndex=c[3],k=c[4],mask=c[5],regime=c[6],sourceWeekend=c[7])
def ceiling(journeys):
    days=sorted({v['sourceDate'] for v in journeys.values()})
    reasons=[]
    if len(journeys)<12:reasons.append('fewer than12 possible distinct source journeys')
    if len(days)<3:reasons.append('fewer than3 possible source dates')
    return dict(status='ruled out by necessary ceiling' if reasons else 'not ruled out; actual support unknown',
                possibleJourneys=len(journeys),possibleSourceDates=days,reasons=reasons,
                knownPhysicalTargetCount=None,admittedResidualCount=None,effectiveSupport=None,materialDates=None)
def new_route():return dict(allSampledKeys=0,calibrationKeys=0,evaluationKeys=0,readyCalibrationKeys=0,
                            membershipReasons=collections.Counter(),compatibleFoldSnapshots=0,incompatibleGroupSnapshots=0,
                            midnightSnapshots=0,midnightJourneys=set(),sourceDates=set(),foldDates=set(),
                            queryArms=collections.defaultdict(lambda:dict(snapshots=0,journeys=set(),masks=collections.Counter())))

def main():
    out=HERE/'results';folds=json.loads((out/'folds.json').read_text())
    top=json.loads((HERE.parent/'canonical-windows/results/canonical-topology.json').read_text())
    routes={r['id']:r for r in top['routes']};waits=folds['fixedEvaluation']['waits']
    sources={s['id']:s for s in stream(out/'physical-sources.jsonl.gz')}
    banks={midnight(d):collections.defaultdict(dict) for d in BANK_DAYS}
    diagnostics={rid:new_route() for rid in routes};queries=collections.Counter();query_days=collections.defaultdict(set);query_groups=collections.Counter()
    potential=[];last=-float('inf');seen=set();all_rows=0
    for r in stream(out/'fold-membership.jsonl.gz'):
        assert r['at']>=last;last=r['at'];key=(r['at'],r['bus'],r['route'],r['target']);assert key not in seen;seen.add(key);all_rows+=1
        rid=r['route'];d=diagnostics[rid];d['allSampledKeys']+=1;day=date(r['at'])
        fold=r['fold']
        if fold:
            d['calibrationKeys']+=1;d['readyCalibrationKeys']+=bool(r['ready']);d['foldDates'].add(day)
            for arm,m in fold['ensemble'].items():
                d['membershipReasons'][arm+' / '+m['reason']]+=1
                if not m['supported']:continue
                far=sources[m['sourceIds'][str(m['k'])]]
                assert far['departed']>fold['cutoff'] and far['knownAt']<=r['at'] and r['at']-far['departed']<=2700000
                compatible=m['wait'] in waits[str(rid)] and tuple(m['targetGroup'])==targets(routes,waits,rid,m['wait'])
                if not compatible:d['incompatibleGroupSnapshots']+=1;continue
                d['compatibleFoldSnapshots']+=1;d['sourceDates'].add(date(far['departed']))
                if date(far['departed'])!=day:d['midnightSnapshots']+=1;d['midnightJourneys'].add(m['journey'])
                c=cell(rid,m,r['targetIndex'],far)
                entry=dict(**unpack(c),forecastAt=r['at'],forecastDate=day,foldCutoff=fold['cutoff'],sourceId=far['id'],sourceDate=date(far['departed']),
                           sourceDeparted=far['departed'],sourceKnownAt=far['knownAt'],journey=m['journey'],arm=arm,sourceIds=m['sourceIds'],physicalTargetId=None)
                potential.append(entry)
                for bank,index in banks.items():
                    if r['at']>=bank:continue
                    prior=index[c].get(m['journey'])
                    identity=dict(sourceId=far['id'],sourceDate=date(far['departed']),sourceDeparted=far['departed'])
                    if prior is not None:assert prior==identity
                    index[c][m['journey']]=identity
        if not '2026-09-17'<=day<='2026-09-20':continue
        d['evaluationKeys']+=1
        for arm,m in r['fixed'].items():
            if not m['supported']:continue
            far=sources[m['sourceIds'][str(m['k'])]]
            a=d['queryArms'][arm];a['snapshots']+=1;a['journeys'].add(m['journey']);a['masks'][','.join(map(str,m['offsets']))]+=1
            for mode,bank in [('frozen',midnight('2026-09-16')),('rolling',midnight(day)-86400000)]:
                group=(rid,m['wait'],tuple(m['targetGroup']),m['k'],tuple(m['offsets']),m['regime'],weekend(far['departed']))
                query_groups[mode,arm,bank,group]+=1
                for target in m['targetGroup']:
                    c=cell(rid,m,target,far);q=(mode,arm,bank,c)
                    queries[q]+=1;query_days[q].add(day)
    assert all_rows==133435
    write(out/'potential-residual-membership.jsonl.gz',potential)
    exposed=[];route_exposed=collections.defaultdict(lambda:collections.Counter())
    for (mode,arm,bank,c),n in sorted(queries.items()):
        result=ceiling(banks[bank].get(c,{}));entry=dict(mode=mode,arm=arm,bankCutoff=bank,bankDate=date(bank),**unpack(c),
                   requiredByGroupQuerySnapshots=n,evaluationDates=sorted(query_days[mode,arm,bank,c]),**result)
        exposed.append(entry);route_exposed[c[0]][result['status']]+=1
    write(out/'query-ceilings.jsonl.gz',exposed)
    group_rows=[];group_counts=collections.defaultdict(collections.Counter)
    for (mode,arm,bank,g),n in sorted(query_groups.items()):
        rid,w,tg,k,mask,regime,is_weekend=g;checks={}
        for target in tg:checks[target]=ceiling(banks[bank].get((rid,w,tg,target,k,mask,regime,is_weekend),{}))
        impossible=[t for t,v in checks.items() if v['status'].startswith('ruled out')]
        status='whole group ruled out by necessary ceiling' if impossible else 'whole group not ruled out; actual support unknown'
        group_rows.append(dict(mode=mode,arm=arm,bankDate=date(bank),route=rid,wait=w,targetGroup=tg,k=k,mask=mask,regime=regime,
                               sourceWeekend=is_weekend,querySnapshots=n,status=status,impossibleTargets=impossible,targetCeilings=checks))
        group_counts[rid][status]+=1
    write(out/'query-group-ceilings.jsonl.gz',group_rows)
    # Enumerate hypothetical exact cells independently of observed query masks.
    # Missing groups/routes and K>=loop remain explicit in route summaries.
    hypothetical=[];hyp_counts=collections.defaultdict(collections.Counter)
    for rid in sorted(routes):
        n=len(routes[rid]['stops'])
        for w in waits[str(rid)]:
            tg=targets(routes,waits,rid,w)
            for k in (5,10):
                if k>=n:continue
                for regime,masks in [('pre-wait',[tuple(range(m,k+1)) for m in range(1,k+1)]),('post-wait',[tuple(range(k+1))])]:
                    for mask in masks:
                        for is_weekend in (False,True):
                            for t in tg:
                                c=(rid,w,tg,t,k,mask,regime,is_weekend)
                                for bank,index in banks.items():
                                    info=ceiling(index.get(c,{}));hypothetical.append(dict(bankDate=date(bank),**unpack(c),**info))
                                    hyp_counts[rid][info['status']]+=1
    write(out/'all-fixed-stratum-ceilings.jsonl.gz',hypothetical)
    summary={}
    for rid,d in diagnostics.items():
        d['routeName']=routes[rid].get('name',str(rid));d['evaluationWaits']=waits[str(rid)];d['noQualifiedEvaluationWait']=not waits[str(rid)]
        d['loopLength']=len(routes[rid]['stops']);d['unsupportedKByLoop']=[k for k in (5,10) if k>=d['loopLength']]
        for f in ('midnightJourneys','sourceDates','foldDates'):d[f]=sorted(d[f]) if f!='midnightJourneys' else len(d[f])
        for k in (5,10):
            for regime in ('primary','extended'):
                a=d['queryArms'][f'K{k}_{regime}'];a['journeys']=len(a['journeys'])
        d['queryCeilingCells']=dict(route_exposed[rid]);d['allFixedStratumCells']=dict(hyp_counts[rid]);summary[rid]=d
        d['wholeQueryGroups']=dict(group_counts[rid])
    report=dict(stage='A only; necessary ceilings, no fitted forecasts or admitted residuals',
                policies=['highway25','highway50'],policyInterpretation='Shared upper bound before both policy-specific path/outcome gates; no quality validity claim',
                estimators=['ensemble','matched single'],countInterpretation='Estimator/primary-extension copies do not add source journeys',
                allRows=all_rows,potentialMembershipRows=len(potential),queryCeilingCells=len(exposed),hypotheticalCells=len(hypothetical),
                notRuledOutQueryCells=sum(x['status'].startswith('not ruled') for x in exposed),
                wholeQueryGroups=len(group_rows),notRuledOutWholeQueryGroups=sum(x['status'].startswith('whole group not ruled') for x in group_rows),
                knownPhysicalTargets=None,admittedResiduals=None,readEvaluationLabels=False,routes=summary,
                materializationAudit=json.loads((out/'materialization-audit.json').read_text()),
                hashes={p.name:sha(p) for p in (out/'fold-membership.jsonl.gz',out/'physical-sources.jsonl.gz',out/'folds.json')})
    (out/'support-summary.json').write_text(json.dumps(report,indent=2)+'\n')
    lines=['# Chronological residual support: Stage A', '',
           'Necessary source-date/journey ceilings only. No model fit, calibration outcome admission, residual interval or accuracy score was computed.', '',
           '| Route | All keys | Calibration keys | Evaluation keys | Compatible fold snapshots | Whole groups not ruled out / total | Midnight journeys |',
           '|---|---:|---:|---:|---:|---:|---:|']
    for rid,d in sorted(summary.items()):
        possible=d['wholeQueryGroups'].get('whole group not ruled out; actual support unknown',0);total=sum(d['wholeQueryGroups'].values())
        lines.append(f"| {rid}: {d['routeName']} | {d['allSampledKeys']} | {d['calibrationKeys']} | {d['evaluationKeys']} | {d['compatibleFoldSnapshots']} | {possible} / {total} | {d['midnightJourneys']} |")
    lines.extend(['','A cell not ruled out has not passed model, countdown, outcome, physical-target deduplication, effective-count or material-date gates. Every group target is required; one impossible target prevents that query group. Counts describe sampled forecast surfaces, not independent riders or full fleet exposure.',
                  '',f"All {all_rows:,} original memberships and source proofs were checked against the immutable source artifact. Full exact cells and missing reasons remain in hosted gzip ledgers; no evaluation labels were opened.",''])
    (out/'REPORT.md').write_text('\n'.join(lines));print(json.dumps({k:report[k] for k in ('stage','allRows','potentialMembershipRows','queryCeilingCells','notRuledOutQueryCells')}))

if __name__=='__main__':main()
