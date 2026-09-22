"""Pair unchanged point decisions and same-policy bounds against deployed."""
import collections
import gzip
import hashlib
import json
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent
OUT = HERE / 'results'
sys.path.insert(0, str(HERE.parent / 'useful-windows'))
import rider_risk as risk


def stream(file):
    with gzip.open(file, 'rt') as source:
        for line in source:
            if line.strip():
                yield json.loads(line)


def key(row):
    return tuple(row[k] for k in ('route', 'bus', 'target', 'visit', 'walkSec', 'responseSec', 'policy'))


def main():
    records = list(stream(OUT / 'rider-risk/rider-risk-records.jsonl.gz'))
    baseline = {key(r): r for r in records if r['arm'] == 'deployed'}
    canonical = [r for r in stream(HERE / 'input/canonical-windows/results/rider-risk/rider-risk-records.jsonl.gz') if r['arm'] == 'deployed']
    assert len(canonical) == len(baseline)
    identity = hashlib.sha256()
    for row in canonical:
        assert baseline[key(row)] == row, 'Canonical deployed action or cohort changed'
        identity.update((json.dumps(row, sort_keys=True, separators=(',', ':')) + '\n').encode())
    decisions = ('status', 'reason', 'at', 'latestLeaveAt', 'leaveNowAt', 'forecastAt', 'reachStopAt',
                 'hypotheticalMissedBoarding', 'lateToArrival', 'lateToArrivalSec', 'waitAtStopSec')
    point_checks = 0
    groups = collections.defaultdict(list)
    for row in records:
        if row['arm'] == 'deployed':
            continue
        base = baseline[key(row)]
        if row['policy'] == 'point':
            assert {k: row.get(k) for k in decisions} == {k: base.get(k) for k in decisions}
            point_checks += 1
        groups[(row['route'], row['arm'], row['policy'], row['walkSec'], row['responseSec'])].append((base, row))
    pairs = []
    for k, rows in sorted(groups.items()):
        scored = [(d, r) for d, r in rows if d['status'] in ('triggered', 'no-timely-reminder') and r['status'] in ('triggered', 'no-timely-reminder')]
        triggered = [(d, r) for d, r in scored if d['status'] == r['status'] == 'triggered']
        pairs.append(dict(route=k[0], arm=k[1], policy=k[2], walkSec=k[3], responseSec=k[4],
            attemptedPairs=len(rows), scoredPairs=len(scored),
            newlyMissed=sum(not d['hypotheticalMissedBoarding'] and r['hypotheticalMissedBoarding'] for d, r in scored),
            rescued=sum(d['hypotheticalMissedBoarding'] and not r['hypotheticalMissedBoarding'] for d, r in scored),
            bothTriggered=len(triggered), laterReminders=sum(r['leaveNowAt'] > d['leaveNowAt'] for d, r in triggered),
            meanAddedWaitSec=risk.mean([r['waitAtStopSec']-d['waitAtStopSec'] for d, r in triggered]),
            deployed=risk.summary([d for d, r in scored]), hybrid=risk.summary([r for d, r in scored]),
            deployedStatuses=dict(collections.Counter(d['status'] for d, r in rows)),
            hybridStatuses=dict(collections.Counter(r['status'] for d, r in rows))))
    assert point_checks > 0
    result = dict(canonicalDeployedActionRows=len(canonical), canonicalDeployedActionsSha256=identity.hexdigest(),
        canonicalDeployedActionsIdentical=True, pointDecisionChecks=point_checks, pointDecisionMismatches=0,
        pairedSamePolicy=pairs, note='Fixed physical visit, common arming. Point decisions unchanged; interval policies may change waiting/censoring. Not actual rider misses.')
    (OUT / 'action-audit.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({k: v for k, v in result.items() if k != 'pairedSamePolicy'}))


if __name__ == '__main__':
    main()
