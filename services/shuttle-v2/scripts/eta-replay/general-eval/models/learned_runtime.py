#!/usr/bin/env python3
"""Offline runtime adapter with no current-episode label lookup.

Profiles are built from training days only. Query JSONL supplies a route/stop,
the observed rest clock, and prior completed visits. No target or episode ID is
needed to generate a forecast. A long-lived process can import FrozenRuntime
and call predict_many to avoid loading the model for every GPS observation.
"""
from __future__ import annotations

import argparse
import datetime as dt
import gzip
import hashlib
import json
import math
from pathlib import Path

import joblib
import numpy as np

from learned_benchmark import encode, predict
from learned_distribution import atom_remaining_quantiles
from learned_features import ET, LEVELS, HistoryPool, day_start, duration, known_at, read_episodes
from threadpoolctl import threadpool_limits


def profile_key(pattern, stop, index):
    return json.dumps([pattern, stop, index], separators=(',', ':'))


def read_jsonl(path):
    opener = gzip.open if str(path).endswith('.gz') else open
    with opener(path, 'rt') as stream:
        return [json.loads(line) for line in stream if line.strip()]


def build_profiles(dataset, model_path, train_days, output):
    rows = read_episodes(dataset, train_days)
    cutoff = day_start(max(train_days)) + 24 * 3600_000
    pool = HistoryPool()
    for row in sorted(rows, key=known_at):
        if known_at(row) < cutoff and row['departedAt'] is not None and row['departedAt'] < cutoff:
            pool.add(row)
    profiles = {profile_key(*key): [None if not math.isfinite(x) else x for x in pool.summary(key)]
                for key in pool.durations}
    artifact = {'training_days': train_days, 'fit_cutoff': cutoff,
                'model_sha256': hashlib.sha256(model_path.read_bytes()).hexdigest(),
                'profiles': profiles,
                'generated_at': dt.datetime.now(dt.timezone.utc).isoformat(),
                'source_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
    output.write_text(json.dumps(artifact, indent=2, allow_nan=False) + '\n')
    return artifact


class FrozenRuntime:
    def __init__(self, model_path, profile_path):
        self.model = joblib.load(model_path)
        self.profiles = json.loads(Path(profile_path).read_text())
        if self.profiles['model_sha256'] != hashlib.sha256(Path(model_path).read_bytes()).hexdigest():
            raise ValueError('Profiles and model hashes do not match')

    def features(self, query):
        start = query['visitStartMs']
        issued = query['issuedAt']
        if not math.isfinite(start) or not math.isfinite(issued) or issued < start:
            raise ValueError('Invalid observed rest clock')
        if start < self.profiles['fit_cutoff']:
            raise ValueError('Profile training cutoff is after this visit began')
        timestamp = dt.datetime.fromtimestamp(start / 1000, ET)
        hour = timestamp.hour + timestamp.minute / 60 + timestamp.second / 3600
        angle = 2 * math.pi * hour / 24
        basic = [query['routeId'], query['stopId'],
                 query['stopIndex'] if query.get('patternResolved') is not False else math.nan,
                 math.sin(angle), math.cos(angle), (issued - start) / 1000]
        key = profile_key(query['routePatternId'], query['stopId'], query['stopIndex'])
        summary = [math.nan if x is None else x for x in self.profiles['profiles'].get(key, [None, None, 0, None, None, 0])]
        # A visit anchored just before midnight may pin just after midnight.
        # The caller can preserve that causally observed anchor's service day.
        day = query.get('serviceDay', timestamp.date().isoformat())
        # Only complete PRIOR observations, known before the rest began, can
        # establish phase. The current visit's eventual departure is excluded
        # even if a caller accidentally includes its future record.
        prior = sorted((row for row in query.get('priorDepartures', [])
                        if row['busKey'] == query['busKey'] and row['routeId'] == query['routeId']
                        and row['routePatternId'] == query['routePatternId']
                        and row['stopId'] == query['stopId'] and row['stopIndex'] == query['stopIndex']
                        and row['day'] == day and row.get('patternResolved') is not False
                        and duration(row) is not None and row['departedAt'] is not None
                        and row['departedAt'] < start and known_at(row) <= start),
                       key=lambda row: row['departedAt'])
        away = slack = previous_hold = math.nan
        if prior:
            latest = prior[-1]['departedAt']
            away = (start - latest) / 1000
            previous_hold = duration(prior[-1])
            period = summary[3]
            if math.isfinite(period) and period > 0:
                projected = [row['departedAt'] / 1000 +
                             (math.floor((latest - row['departedAt']) / 1000 / period + .5) + 1) * period
                             for row in prior]
                slack = float(np.median(projected)) - start / 1000
        return np.asarray(basic + summary + [away, slack, len(prior), previous_hold], dtype=float)

    def predict_many(self, queries):
        if not queries:
            return []
        matrix = np.asarray([self.features(query) for query in queries])
        metadata = [{'elapsedSec': (query['issuedAt'] - query['visitStartMs']) / 1000} for query in queries]
        initial = matrix.copy()
        initial[:, 5] = 0
        if self.model['config']['family'] == 'duration':
            encoded = encode(initial[:, :len(self.model['features'])], self.model['categories'])
            with threadpool_limits(limits=2):
                raw = np.sort(np.maximum(0, np.column_stack([m.predict(encoded) for m in self.model['models']])), axis=1)
            remaining = [atom_remaining_quantiles(q, meta['elapsedSec']) for q, meta in zip(raw, metadata)]
            totals = [atom_remaining_quantiles(q, 0) for q in raw]
        else:
            remaining = predict(self.model, {'X': matrix, 'metadata': metadata})
            totals = predict(self.model, {'X': initial, 'metadata': [{'elapsedSec': 0}] * len(queries)})
        return [{'id': query.get('id'), 'issuedAt': query['issuedAt'], 'visitStartMs': query['visitStartMs'],
                 'quantileLevels': LEVELS.tolist(), 'quantilesSec': q.tolist(),
                 'totalAtArrivalQuantilesSec': total.tolist()}
                for query, q, total in zip(queries, remaining, totals)]


def convert(input_path, output_path):
    rows = read_jsonl(input_path)
    with gzip.open(output_path, 'wt') as stream:
        for row in rows:
            row = {**row, 'id': f'{row["episodeId"]}@{row["issuedAt"]}', 'target': 'remaining_stand',
                   'targetAt': row['targetDepartureAt'],
                   'actualSec': row['totalSec'] - row['elapsedSec']}
            stream.write(json.dumps(row, allow_nan=False) + '\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('stage', choices=['profiles', 'predict', 'convert'])
    parser.add_argument('--model', type=Path)
    parser.add_argument('--profiles', type=Path)
    parser.add_argument('--dataset', type=Path, default=Path('scripts/.eta-replay/overnight-2026-09-08/dataset'))
    parser.add_argument('--train-days', default='2026-09-03,2026-09-04')
    parser.add_argument('--input', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.stage == 'profiles':
        artifact = build_profiles(args.dataset, args.model, args.train_days.split(','), args.output)
        print(json.dumps({'profiles': len(artifact['profiles']), 'output': str(args.output)}))
    elif args.stage == 'convert':
        convert(args.input, args.output)
    else:
        runtime = FrozenRuntime(args.model, args.profiles)
        result = runtime.predict_many(read_jsonl(args.input))
        opener = gzip.open if str(args.output).endswith('.gz') else open
        with opener(args.output, 'wt') as stream:
            for row in result:
                stream.write(json.dumps(row, allow_nan=False) + '\n')


if __name__ == '__main__':
    main()
