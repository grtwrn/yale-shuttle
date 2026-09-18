"""Standalone causal landmark extraction. Never imports/executes old research scripts.

Outputs are conditional true-rest component data, not forecasts the live server
actually published. Event known-times are documented conservative proxies.
"""
import argparse
import bisect
import collections
import datetime as dt
import hashlib
import json
import math
from pathlib import Path
import sqlite3
from zoneinfo import ZoneInfo

ROOT = Path('/home/gwarren/projects/yale-shuttle-watcher')
OUT = Path(__file__).resolve().parent
DB = ROOT / 'conditional-replay-data/outcomes.db'
COHORT = ROOT / 'red-window-data/operating-pattern-screen.json'
TZ = ZoneInfo('America/New_York')
END = 1789665240913
FIT = int(dt.datetime(2026, 9, 10, tzinfo=TZ).timestamp() * 1000)
CAL = int(dt.datetime(2026, 9, 14, tzinfo=TZ).timestamp() * 1000)
LANDMARKS = (0, 60, 180, 300, 480)
REGIMES = ('arrival15', 'completed120')
BASE = '40af3c0bb8e2522972b4e9f0222b1756fbd3c227'
AUDITED = (64318, 58224, 65347, 48550, 51469, 54002, 52633, 52168, 54777, 53429)


def sha(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def day(at):
    return dt.datetime.fromtimestamp(at / 1000, TZ).date().isoformat()


def ready(v):
    d = v['departed_at']
    if d is None or v['how'] == 'gap':
        return None
    return max(d + 120000, (v['first_moved_at'] or d) + (v['confirm_sec'] or 0) * 1000)


def partition(r):
    if r['ready'] < FIT:
        return 'train'
    if r['a'] >= FIT and r['ready'] < CAL:
        return 'calibration'
    if r['a'] >= CAL:
        return 'development'
    return 'boundary_unavailable'


class Events:
    """Indexes primitive events by bus; only known-time slices reach features."""
    def __init__(self, visits, sequence):
        self.seq = sequence
        self.n = len(sequence)
        assert len(sequence) == len(set(sequence)), 'This extractor is Red-only, which has unique stop IDs'
        self.index = {s: i for i, s in enumerate(sequence)}
        self.anchors = collections.defaultdict(list)
        self.arrivals = {r: collections.defaultdict(list) for r in REGIMES}
        self.progress = {r: collections.defaultdict(list) for r in REGIMES}
        self.departures = collections.defaultdict(list)
        for v in visits:
            # ALL routes, and unconditional anchor: eventual pin/outcome must
            # never decide whether an early anchor observation exists.
            anchor = dict(id=v['id'], bus=v['bus_name'], route=v['route_id'],
                          stop=v['stop_id'], index=v['stop_index'],
                          physical=v['anchored_at'], known=v['anchored_at'] + 15000)
            self.anchors[v['bus_name']].append(anchor)
            if v['route_id'] != 3:
                continue
            si = v['stop_index']
            if not (0 <= si < self.n and sequence[si] == v['stop_id']):
                continue
            self.progress['arrival15'][v['bus_name']].append(dict(anchor))
            rd = ready(v)
            if rd is not None:
                self.progress['completed120'][v['bus_name']].append(dict(anchor, known=rd))
            if v['pinned_at'] is not None:
                arrived = dict(anchor, physical=v['pinned_at'], known=v['pinned_at'] + 15000)
                self.arrivals['arrival15'][v['bus_name']].append(arrived)
                if rd is not None:
                    self.arrivals['completed120'][v['bus_name']].append(dict(arrived, known=rd))
                if rd is not None and v['stop_id'] in (11, 121) and v['closest_m'] <= 75:
                    self.departures[(v['stop_id'], day(v['departed_at']))].append(
                        dict(id=v['id'], bus=v['bus_name'], physical=v['departed_at'], known=rd))
        self.times = {}
        for mapping in [self.anchors, *self.arrivals.values(), *self.progress.values(), self.departures]:
            for key, values in mapping.items():
                values.sort(key=lambda e: (e['known'], e['physical'], e['id']))
                self.times[id(values)] = [e['known'] for e in values]

    def known(self, mapping, key, at):
        es = mapping.get(key, [])
        if not es:
            return []
        return es[:bisect.bisect_right(self.times[id(es)], at)]

    def latest(self, bus, at):
        es = self.known(self.anchors, bus, at)
        return es[-1] if es else None

    def red_fresh(self, e, at):
        return bool(e and e['route'] == 3 and day(e['physical']) == day(at)
                    and 0 <= at - e['physical'] <= 600000
                    and 0 <= e['index'] < self.n and self.seq[e['index']] == e['stop'])

    def identities(self, r):
        at = r['a']
        ds = [v for v in self.known(self.departures, (r['stop'], r['day']), at)
              if at - 5400000 <= v['physical']]
        peers = [v for v in ds if v['bus'] != r['bus'] and at - 3600000 <= v['physical']]
        ahead = max(peers, key=lambda v: (v['physical'], v['id']), default=None)
        # Unlike a retrospective sort of whole visits, all decisions are at pin.
        ahead_reason = 'known'
        if ahead and len({p['bus'] for p in peers if p['physical'] == ahead['physical']}) > 1:
            ahead = None
            ahead_reason = 'departure_order_tie'
        elif not ahead:
            ahead_reason = 'no_confirmed_predecessor'
        own = max((v for v in ds if v['bus'] == r['bus']), key=lambda v: v['physical'], default=None)
        follower, reason = None, 'known'
        if not own:
            reason = 'no_prior_own_confirmed_source_departure'
        else:
            anchors = self.known(self.anchors, r['bus'], at)
            after_own = [e for e in anchors if e['physical'] > own['physical'] and e['route'] == 3]
            if any(e['stop'] == r['stop'] and e['id'] != r['id'] for e in after_own):
                reason = 'intervening_known_focal_source_return'
            elif not any(e['stop'] == (121 if r['stop'] == 11 else 11) for e in after_own):
                reason = 'no_observed_intervening_opposite_stop'
            else:
                after = [v for v in ds if v['bus'] != r['bus'] and v['physical'] > own['physical']]
                chosen = min(after, key=lambda v: (v['physical'], v['id']), default=None)
                if not chosen:
                    reason = 'no_confirmed_follower_yet'
                elif len({v['bus'] for v in after if v['physical'] == chosen['physical']}) > 1:
                    reason = 'departure_order_tie'
                else:
                    origin = max((v for v in ds if v['bus'] == chosen['bus']), key=lambda v: v['physical'])
                    follower = dict(chosen, origin=origin['physical'], originId=origin['id'],
                                    originKnown=origin['known'], ownPrevious=own['id'])
        if ahead:
            ahead = dict(ahead, origin=ahead['physical'], originId=ahead['id'], originKnown=ahead['known'])
        for p in (ahead, follower):
            if p:
                assert p['known'] <= at and p['originKnown'] <= at and p['bus'] != r['bus']
        fresh = {b: self.latest(b, at) for b in self.anchors}
        fresh = {b: e for b, e in fresh.items() if self.red_fresh(e, at)}
        return dict(ahead=ahead, follower=follower, aheadReason=ahead_reason,
                    followerReason=reason, freshOtherBuses=sum(b != r['bus'] for b in fresh),
                    sameAsAhead=bool(ahead and follower and ahead['bus'] == follower['bus']))

    def snapshot(self, peer, source_stop, at, regime):
        empty = dict(usable=False, reason='identity_unknown', latestAllRoute=None,
                     progress=None, reached=[], features=[0.0] * (6 + self.n))
        if not peer:
            return empty
        latest = self.latest(peer['bus'], at)
        empty['latestAllRoute'] = latest
        if not latest or day(latest['physical']) != day(at):
            empty['reason'] = 'no_same_day_anchor'
            return empty
        if latest['route'] != 3:
            empty['reason'] = 'latest_anchor_other_route'
            return empty
        if not self.red_fresh(latest, at):
            empty['reason'] = 'stale_or_invalid_anchor'
            return empty
        origin = peer['origin']
        progress = [e for e in self.known(self.progress[regime], peer['bus'], at)
                    if e['physical'] >= origin and day(e['physical']) == day(at)]
        progress = progress[-1] if progress else None
        if progress and at - progress['physical'] > 600000:
            progress = None
        reached = [e for e in self.known(self.arrivals[regime], peer['bus'], at)
                   if e['physical'] >= origin and day(e['physical']) == day(at)]
        flags = [float(any(e['index'] == i for e in reached)) for i in range(self.n)]
        angle = 2 * math.pi * ((progress['index'] - self.index[source_stop]) % self.n) / self.n if progress else 0
        feats = [1.0, float(progress is not None), math.sin(angle) if progress else 0.0,
                 math.cos(angle) if progress else 0.0,
                 math.log1p((at - progress['physical']) / 60000) if progress else 0.0,
                 (at - origin) / 3600000, *flags]
        assert all(e['known'] <= at for e in [latest, *reached] + ([progress] if progress else []))
        return dict(usable=True, reason='known', latestAllRoute=latest,
                    progress=progress, reached=reached, features=feats)


def load():
    original = json.loads(COHORT.read_text())
    rows = [{k: r[k] for k in ('id', 'bus', 'stop', 'a', 'd', 'ready', 'y', 'day', 'hour', 'lap')}
            for r in original['featureRows'] if r['ready'] <= END]
    refs = {r['stop']: r['referenceLap'] for r in original['results']}
    db = sqlite3.connect(f'file:{DB}?mode=ro', uri=True)
    db.row_factory = sqlite3.Row
    seq = json.loads(db.execute('SELECT stops_json FROM routes WHERE id=3').fetchone()[0])
    visits = [dict(v) for v in db.execute('SELECT * FROM stop_visits WHERE anchored_at <= ? ORDER BY anchored_at,id', (END,))]
    db.close()
    return rows, refs, seq, visits


def extract(rows, refs, events):
    outputs, ineligible = [], []
    for r in rows:
        identities = events.identities(r)
        landmarks = [e for e in LANDMARKS if e < r['y']]
        for elapsed in LANDMARKS:
            if elapsed not in landmarks:
                ineligible.append(dict(id=r['id'], elapsed=elapsed, reason='hold_not_still_continuing'))
        for elapsed in landmarks:
            at = r['a'] + elapsed * 1000
            for regime in REGIMES:
                snapshots = {k: events.snapshot(identities[k], r['stop'], at, regime) for k in ('ahead', 'follower')}
                valid_lap = r['lap'] is not None and .65 * refs[r['stop']] <= r['lap'] <= 1.65 * refs[r['stop']]
                outputs.append(dict(id=r['id'], bus=r['bus'], stop=r['stop'], day=r['day'],
                                    split=partition(r), pinAt=r['a'], forecastAt=at, elapsed=elapsed,
                                    outcomeReady=r['ready'], truthRemaining=r['y'] - elapsed,
                                    lap=r['lap'], referenceLap=refs[r['stop']], lapSupported=valid_lap,
                                    landmarkWeight=1 / len(landmarks), regime=regime,
                                    identities=identities, snapshots=snapshots))
    return outputs, ineligible


def freeze_plan():
    plan = dict(createdAtUTC=dt.datetime.now(dt.timezone.utc).isoformat(), baseCommit=BASE,
        status='frozen before landmark extraction or new candidate scoring',
        inputs={str(p): sha(p) for p in (DB, COHORT, Path(__file__))},
        fitBefore=FIT, calibrationBefore=CAL, developmentEnd=END,
        chronology='Sep3/4/8/9 training; Sep10/11 calibration; Sep14–17 13:14 ET reused development. No later afternoon or fresh holdout.',
        landmarksSec=LANDMARKS, regimes=REGIMES, stepSec=15, penaltyL2=10,
        family='Landmark residual discrete survival with snapshot frozen for EVERY future risk row in BOTH training and inference.',
        arms=['landmark_lap_elapsed_clock', 'plus_ahead_snapshot', 'plus_ahead_follower_snapshot'],
        baselineFeatures=['intercept','log1p(total_elapsed/60)','total_elapsed/600','positive(total_elapsed-300)/600',
                          'positive(total_elapsed-600)/600','centered_supported_lap/600','lap_missing',
                          'sin(future_clock15)','cos(future_clock15)','landmark_elapsed/600'],
        peerFeatures=['usable_identity','progress_available','sin(relative_stop_index)','cos(relative_stop_index)',
                      'log1p(snapshot_progress_age_minutes)','snapshot_origin_age_hours','persistent_reached_flags_for_every_route_stop'],
        interactions='Each frozen peer feature multiplied by deterministic future clock sin and cos; no future peer observation or origin-age updates.',
        support='Minimum five training visits across two training dates per added nonzero column; exact duplicates removed using training only; no development-based stop selection.',
        fallback='All snapshots retained. Absent, stale >600s, other-route or invalid peer has zero added features; unsupported lap uses landmark core baseline in ALL candidate arms. Production comparison must report its own fallback.',
        weighting='Each visit contributes total landmark weight one per regime; each future risk row retains that landmark weight. This normalizes repeated landmark likelihoods, not risk-bin exposure. Scores show visit-weighted and checkpoint-weighted summaries.',
        tail='Train residual likelihood to1800s with longer remaining waits right-censored, never deleted or labeled a departure at1800. Extend constant final-bin hazard beyond1800; bound hazard to[1/1800,1/5] persecond as production does. Quantiles have no time cap.',
        availability='Pin-latched prior confirmed departure order; completed+120 known-time for identity. Arrival15 uses pin+15 arrival and unconditional anchor+15 progress; completed120 delays each event to completion. Latest all-route anchor checked at pin/landmark. These are availability proxies, not exact receipts.',
        calibration='Primary raw fitted coefficients. Optional intercept-only sensitivity trained on Sep10/11 with same landmark weighting, reported separately; no penalty search.',
        productionComparator='Current release ON implementation at40af3c0; Winchester actual release CDF and Union actual marginal/lap fallback. Extraction alone is not a production ETA comparison. Export exact runtime comparator before model promotion.',
        requiredMetrics=['MAE','median/p90 absolute error','WIS80','width80','bus arrives before lower bound','bus arrives after upper bound','availability','per date','same/distinct/unknown identity'],
        exclusions='Only previously proved restart truncation65237. Keep all legitimate short/long outcomes. Landmark past actual departure is ineligible by landmark definition, recorded explicitly.',
        limitations=['Conditional on true continuing pinned rest, not first-published pin receipt or live state.',
                     'No connected rider, repeated target occurrence, stability or full-server claims until later paired replay.'])
    p = OUT / 'PLAN.json'
    if p.exists():
        existing = json.loads(p.read_text())
        assert all(existing[k] == json.loads(json.dumps(v)) for k, v in plan.items() if k != 'createdAtUTC'), 'Frozen plan mismatch'
    else:
        p.write_text(json.dumps(plan, indent=2) + '\n')


def audit(rows, seq, visits, records):
    counts = collections.Counter((r['stop'], partition(r)) for r in rows)
    assert counts == {(11, 'train'):102, (11,'calibration'):58, (11,'development'):99,
                      (121,'train'):112, (121,'calibration'):61, (121,'development'):103}, counts
    assert 65237 not in {r['id'] for r in rows}
    assert set(AUDITED) <= {r['id'] for r in rows}
    weights = collections.defaultdict(float)
    for r in records:
        weights[r['id'],r['regime']] += r['landmarkWeight']
        assert r['truthRemaining'] > 0 and r['forecastAt'] < r['outcomeReady'] <= END
    assert all(abs(w - 1) < 1e-12 for w in weights.values())
    # Audits use every unique landmark. Censor FUTURE primitive event fields
    # before building indexes; earlier snapshots must remain exactly identical.
    # Sample all five landmarks, both sources, all dates, and both contracts.
    samples = []
    selected = set()
    for r in records:
        key = r['day'], r['stop'], r['elapsed'], r['regime']
        if key not in selected:
            selected.add(key)
            samples.append(r)
    row_by_id = {r['id']: r for r in rows}
    for sample in samples:
        at = sample['forecastAt']
        truncated = []
        for v in visits:
            if v['anchored_at'] + 15000 > at:
                continue
            z = dict(v)
            # Changing unknown future pin/completion, including outcome, cannot
            # change earlier unconditional progress (the earlier audited leak).
            if z['pinned_at'] is not None and z['pinned_at'] + 15000 > at:
                z['pinned_at'] = None
            if ready(z) is not None and ready(z) > at:
                z.update(departed_at=None, outcome='unknown', how=None,
                         first_moved_at=None, confirm_sec=None)
            truncated.append(z)
        censored = Events(truncated, seq)
        ids = censored.identities(row_by_id[sample['id']])
        assert ids == sample['identities'], ('identity_future_leak', sample['id'], sample['elapsed'])
        for peer in ('ahead','follower'):
            got = censored.snapshot(ids[peer], sample['stop'], at, sample['regime'])
            assert got == sample['snapshots'][peer], ('snapshot_future_leak', sample['id'], sample['elapsed'],peer)
    groups = []
    for stop in (11,121):
        for split in ('train','calibration','development'):
            for regime in REGIMES:
                rs = [r for r in records if (r['stop'],r['split'],r['regime']) == (stop,split,regime)]
                groups.append(dict(stop=stop,split=split,regime=regime,visits=len({r['id'] for r in rs}),
                    landmarks=len(rs),dates=sorted({r['day'] for r in rs}),
                    unsupportedLap=sum(not r['lapSupported'] for r in rs),
                    followerReasons=dict(collections.Counter(r['identities']['followerReason'] for r in rs)),
                    aheadSnapshotReasons=dict(collections.Counter(r['snapshots']['ahead']['reason'] for r in rs)),
                    followerSnapshotReasons=dict(collections.Counter(r['snapshots']['follower']['reason'] for r in rs)),
                    sameAsAhead=sum(r['identities']['sameAsAhead'] for r in rs)))
    return dict(cohortCounts=[dict(stop=s,split=p,visits=n) for (s,p),n in sorted(counts.items())],
                temporalCensorComparisons=len(samples),weightSumsChecked=len(weights),
                retainedAuditedEpisodes=[r for r in rows if r['id'] in AUDITED],groups=groups,
                rows=len(records),uniqueVisits=len({r['id'] for r in records}),
                limitations=['No fitted forecasts or remaining-wait score yet. Full causal invariance uses one deterministic case per date/stop/landmark/regime, not every row.',
                             'Actual physical rest pin can precede first published pin: component dataset only.'])


def main():
    freeze_plan()
    rows, refs, seq, visits = load()
    records, ineligible = extract(rows, refs, Events(visits,seq))
    report = audit(rows,seq,visits,records)
    (OUT/'landmarks.jsonl').write_text(''.join(json.dumps(r,separators=(',',':'))+'\n' for r in records))
    (OUT/'ineligible-landmarks.json').write_text(json.dumps(ineligible,indent=2)+'\n')
    (OUT/'cohort.json').write_text(json.dumps(rows,indent=2)+'\n')
    (OUT/'extraction-audit.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps({k:report[k] for k in ('cohortCounts','temporalCensorComparisons','weightSumsChecked','rows','uniqueVisits')},indent=2))


if __name__ == '__main__':
    main()
