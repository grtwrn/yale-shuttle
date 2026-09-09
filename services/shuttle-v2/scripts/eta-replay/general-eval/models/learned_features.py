"""Causal features and distribution arithmetic for the offline library challenger."""
from __future__ import annotations

import bisect
import datetime as dt
import gzip
import json
import math
from collections import defaultdict
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np

ET = ZoneInfo('America/New_York')
LEVELS = (np.arange(19) + .5) / 19
BASIC_FEATURES = ['route_id', 'stop_id', 'stop_index', 'hour_sin', 'hour_cos', 'elapsed_sec']
HISTORY_FEATURES = BASIC_FEATURES + [
    'prior_cell_median', 'prior_cell_p90', 'prior_cell_n', 'period_sec',
    'period_iqr', 'period_n', 'time_away_sec', 'phase_slack_sec',
    'own_departures_today', 'previous_own_hold_sec',
]


def day_start(day: str) -> int:
    return round(dt.datetime.fromisoformat(day).replace(tzinfo=ET).timestamp() * 1000)


def read_episodes(dataset: Path, days: list[str]) -> list[dict]:
    """Read only explicit day files: never glob held-out outcomes into training."""
    rows = []
    for day in days:
        choices = [dataset / day / 'episodes.jsonl.gz', dataset / f'episodes-{day}.jsonl.gz',
                   dataset / f'{day}-episodes.jsonl.gz']
        path = next((p for p in choices if p.exists()), choices[0])
        with gzip.open(path, 'rt') as stream:
            for line in stream:
                if line.strip():
                    row = json.loads(line)
                    if row['day'] != day:
                        raise ValueError(f'Day mismatch in {path}: {row["day"]}')
                    rows.append(row)
    return sorted(rows, key=lambda r: (start_at(r), r['id']))


def start_at(row: dict) -> int:
    return row['pinnedAt'] if row['pinnedAt'] is not None else row['anchoredAt']


def duration(row: dict) -> float | None:
    if row['pinnedAt'] is None:
        return None
    if row['outcome'] == 'passed':
        return 0.
    if row['outcome'] != 'stopped' or row['pinnedAt'] is None or row['departedAt'] is None:
        return None
    value = (row['departedAt'] - row['pinnedAt']) / 1000
    return value if value >= 0 else None


def known_at(row: dict) -> float:
    return row['knownAt'] if row['knownAt'] is not None else math.inf


def cell(row: dict) -> tuple:
    return row['routePatternId'], row['stopId'], row['stopIndex']


class HistoryPool:
    def __init__(self):
        self.durations = defaultdict(list)
        self.departures = defaultdict(list)
        self.cycle_samples = defaultdict(list)
        self.global_durations = []
        self.cache = {}

    def add(self, row: dict):
        if row.get('patternResolved') is False:
            return
        value = duration(row)
        if value is None or row['departedAt'] is None:
            return
        key = cell(row)
        self.durations[key].append(value)
        self.global_durations.append(value)
        group_key = key, row['day'], row['busKey']
        group = self.departures[group_key]
        departure = row['departedAt']
        insertion = bisect.bisect_left(group, departure)
        # Arrival availability proxies can reorder completed observations.
        # Replace the old surrounding interval when inserting an earlier one.
        samples = self.cycle_samples[key]
        if 0 < insertion < len(group):
            samples.remove((group[insertion] - group[insertion - 1]) / 1000)
        if insertion > 0 and departure > group[insertion - 1]:
            samples.append((departure - group[insertion - 1]) / 1000)
        if insertion < len(group) and group[insertion] > departure:
            samples.append((group[insertion] - departure) / 1000)
        group.insert(insertion, departure)
        self.cache.pop(key, None)

    def summary(self, key: tuple) -> list[float]:
        if key in self.cache:
            return self.cache[key]
        values = self.durations[key]
        cycles = self.cycle_samples[key]
        if values:
            med, p90 = np.quantile(values, [.5, .9])
        else:
            med = p90 = math.nan
        if len(cycles) >= 3:
            p25, period, p75 = np.quantile(cycles, [.25, .5, .75])
            spread = p75 - p25
        else:
            period = spread = math.nan
        result = [float(med), float(p90), len(values), float(period), float(spread), len(cycles)]
        self.cache[key] = result
        return result


def features_at_arrival(rows: list[dict], train_days: list[str]) -> dict[str, np.ndarray]:
    """Global fit summaries use prior days; discovery-day features are prequential.

    Phase references use only the bus's already-known departures today. The
    current episode's departure, outcome and future route are never features.
    """
    train_set = set(train_days)
    first_day = min(train_days)
    final_fit_cut = day_start(max(train_days)) + 24 * 3600_000
    training_history = sorted((r for r in rows if r['day'] in train_set), key=known_at)
    available_history = sorted(rows, key=known_at)
    train_index = available_index = 0
    pool = HistoryPool()
    current = defaultdict(list)
    result = {}
    previous_cut = -math.inf
    for row in rows:
        issued = start_at(row)
        # The first captured day has no earlier-day labels. Its expanding
        # history is a legitimate training-only prequential feature source.
        fit_cut = min(issued, day_start(first_day) + 24 * 3600_000) if row['day'] == first_day else min(day_start(row['day']), final_fit_cut)
        if fit_cut < previous_cut:
            raise ValueError('Feature rows must be chronological')
        previous_cut = fit_cut
        while train_index < len(training_history) and known_at(training_history[train_index]) < fit_cut:
            past = training_history[train_index]
            if past['departedAt'] is not None and past['departedAt'] < fit_cut:
                pool.add(past)
            train_index += 1
        while available_index < len(available_history) and known_at(available_history[available_index]) <= issued:
            past = available_history[available_index]
            if duration(past) is not None and past['departedAt'] is not None and past.get('patternResolved') is not False:
                key = cell(past), past['day'], past['busKey']
                current[key].append(past)
            available_index += 1
        timestamp = dt.datetime.fromtimestamp(issued / 1000, ET)
        hour = timestamp.hour + timestamp.minute / 60 + timestamp.second / 3600
        angle = 2 * math.pi * hour / 24
        basic = [row['routeId'], row['stopId'], row['stopIndex'] if row.get('patternResolved') is not False else math.nan,
                 math.sin(angle), math.cos(angle), 0.]
        summary = pool.summary(cell(row))
        prior = sorted((p for p in current[(cell(row), row['day'], row['busKey'])]
                        if p['departedAt'] < issued), key=lambda p: p['departedAt'])
        away = slack = previous_hold = math.nan
        if prior:
            latest = prior[-1]['departedAt']
            away = (issued - latest) / 1000
            previous_hold = duration(prior[-1])
            period = summary[3]
            if math.isfinite(period) and period > 0:
                projected = [p['departedAt'] / 1000 +
                             (math.floor((latest - p['departedAt']) / 1000 / period + .5) + 1) * period
                             for p in prior]
                slack = float(np.median(projected)) - issued / 1000
        result[row['id']] = np.asarray(basic + summary + [away, slack, len(prior), previous_hold], dtype=float)
    return result


def make_moments(rows: list[dict], features: dict, days: list[str], step_sec=30, *, for_training=False) -> dict:
    xs, ys, weights, metadata = [], [], [], []
    excluded = defaultdict(int)
    for row in rows:
        if row['day'] not in days:
            continue
        if row['pinnedAt'] is None:
            excluded['unpinned'] += 1
            continue
        if row['outcome'] != 'stopped':
            excluded[row['outcome']] += 1
            continue
        if for_training and row.get('patternResolved') is False:
            excluded['unresolved_pattern'] += 1
            continue
        if for_training and known_at(row) >= day_start(max(days)) + 24 * 3600_000:
            excluded['label_unavailable_at_fit_cutoff'] += 1
            continue
        total = duration(row)
        if total is None:
            excluded[row['outcome']] += 1
            continue
        times = list(np.arange(0, max(1, total), step_sec))
        for elapsed in times:
            x = features[row['id']].copy()
            x[5] = elapsed
            xs.append(x)
            ys.append(max(0, total - elapsed))
            weights.append(1 / len(times))
            metadata.append({'episodeId': row['id'], 'day': row['day'], 'routeId': row['routeId'],
                             'routePatternId': row['routePatternId'], 'stopId': row['stopId'],
                             'patternResolved': row.get('patternResolved', True),
                             'stopIndex': row['stopIndex'], 'busKey': row['busKey'],
                             'issuedAt': round(start_at(row) + elapsed * 1000),
                             'elapsedSec': float(elapsed), 'totalSec': total,
                             'targetDepartureAt': row['departedAt'],
                             'nextPhysicalArrivalAt': row['nextPhysicalArrivalAt'],
                             'nextPhysicalArrivalId': row['nextPhysicalArrivalId'],
                             'targetCensoring': row['targetCensoring']})
    return {'X': np.asarray(xs), 'y': np.asarray(ys), 'weights': np.asarray(weights),
            'metadata': metadata, 'excluded': dict(excluded)}


def remaining_quantiles(knots: np.ndarray, elapsed: float) -> np.ndarray:
    """Same log-linear survival convention, with a stable exponential tail."""
    q = np.maximum(0, np.sort(knots))
    # At arrival, a zero-duration pass is still possible. Positive elapsed
    # waiting is the observation that permits conditioning out that mass.
    if elapsed == 0:
        return q
    if q[0] == q[-1]:
        if elapsed < q[0]:
            return np.full(len(LEVELS), q[0] - elapsed)
        return -np.log1p(-LEVELS) * 5
    xs, ps = [], []
    if q[0] > 0:
        xs.append(0.)
        ps.append(0.)
    for x, p in zip(q, LEVELS):
        if xs and x == xs[-1]:
            ps[-1] = p
        else:
            xs.append(float(x))
            ps.append(float(p))
    xs, ps = np.asarray(xs), np.asarray(ps)
    tail_hazard = np.clip(math.log((1 - ps[-2]) / (1 - ps[-1])) / (xs[-1] - xs[-2]), 1 / 1800, 1 / 5)
    if elapsed >= xs[-1]:
        return -np.log1p(-LEVELS) / tail_hazard
    log_survivals = np.log1p(-ps)
    log_rest = float(np.interp(elapsed, xs, log_survivals))
    log_targets = log_rest + np.log1p(-LEVELS)
    out = np.interp(log_targets, log_survivals[::-1], xs[::-1])
    tail = log_targets < log_survivals[-1]
    out[tail] = xs[-1] + (log_survivals[-1] - log_targets[tail]) / tail_hazard
    return np.maximum(0, out - elapsed)


def score(prediction: np.ndarray, moments: dict) -> dict:
    truth = moments['y']
    error = prediction[:, len(LEVELS) // 2] - truth
    residual = truth[:, None] - prediction
    crps = 2 * np.mean(np.maximum(LEVELS * residual, (LEVELS - 1) * residual), axis=1)
    lo = np.asarray([np.interp(.1, LEVELS, q) for q in prediction])
    hi = np.asarray([np.interp(.9, LEVELS, q) for q in prediction])
    metrics = np.column_stack([np.abs(error), error, crps, error < -120, error > 120,
                               (lo <= truth) & (truth <= hi), hi - lo])
    names = ['mae_sec', 'bias_sec', 'crps_midpoint19_sec', 'early_120_rate', 'late_120_rate',
             'coverage_80', 'width_80_sec']

    def aggregate(indices):
        groups = defaultdict(list)
        for i in indices:
            groups[moments['metadata'][i]['episodeId']].append(i)
        if not groups:
            return {'episodes': 0, 'moments': 0}
        mean = np.mean([np.mean(metrics[ids], axis=0) for ids in groups.values()], axis=0)
        return {'episodes': len(groups), 'moments': len(indices), **dict(zip(names, map(float, mean)))}

    all_indices = list(range(len(truth)))
    return {'all': aggregate(all_indices),
            'first': aggregate([i for i, m in enumerate(moments['metadata']) if m['elapsedSec'] == 0]),
            'long_300': aggregate([i for i, m in enumerate(moments['metadata']) if m['totalSec'] >= 300]),
            'long_480': aggregate([i for i, m in enumerate(moments['metadata']) if m['totalSec'] >= 480]),
            'resolved_pattern': aggregate([i for i, m in enumerate(moments['metadata']) if m['patternResolved']]),
            'unresolved_pattern': aggregate([i for i, m in enumerate(moments['metadata']) if not m['patternResolved']]),
            'by_route': {str(route): aggregate([i for i, m in enumerate(moments['metadata']) if m['routeId'] == route])
                         for route in sorted({m['routeId'] for m in moments['metadata']})},
            'excluded': moments['excluded']}
