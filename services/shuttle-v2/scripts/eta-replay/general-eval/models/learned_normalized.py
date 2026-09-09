#!/usr/bin/env python3
"""One development-only, prior-normalized challenger; no reserved data access."""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import math
from collections import defaultdict
from pathlib import Path

import joblib
import numpy as np

from learned_benchmark import CAPACITIES, dump, encode_fit, write_predictions
from learned_features import (HISTORY_FEATURES, LEVELS, cell, day_start, duration,
                              features_at_arrival, known_at, make_moments,
                              read_episodes, score, start_at)
from sklearn.ensemble import HistGradientBoostingRegressor
from threadpoolctl import threadpool_limits

ROOT = Path('scripts/.eta-replay/overnight-2026-09-08')
OUTPUT = ROOT / 'learned'


def scales_at_arrival(rows, train_days):
    """The scale is frozen at arrival, from prior-known positive stands only."""
    training = sorted((r for r in rows if r['day'] in train_days), key=known_at)
    first_day, final_cut = min(train_days), day_start(max(train_days)) + 86400_000
    by_cell, pooled, cache, result = defaultdict(list), [], {}, {}
    index = 0
    for row in rows:
        issued = start_at(row)
        cut = min(issued, day_start(first_day) + 86400_000) if row['day'] == first_day else min(day_start(row['day']), final_cut)
        changed = False
        while index < len(training) and known_at(training[index]) < cut:
            past = training[index]
            value = duration(past)
            if value is not None and value > 0 and past.get('patternResolved') is not False and past['departedAt'] < cut:
                by_cell[cell(past)].append(value)
                pooled.append(value)
                changed = True
            index += 1
        if changed:
            cache.clear()
        key = cell(row)
        if key not in cache:
            global_median = float(np.median(pooled)) if pooled else 1.
            values = by_cell[key]
            n = len(values)
            weight = n / (n + 20)
            typical = float(np.median(values)) if values else global_median
            cache[key] = max(1., weight * typical + (1 - weight) * global_median)
        result[row['id']] = cache[key]
    return result


def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    name = 'remaining_history_medium_normalized'
    trial = {
        'name': name, 'declared_at': dt.datetime.now(dt.timezone.utc).isoformat(),
        'training_days': ['2026-09-03'], 'development_days': ['2026-09-04'],
        'reserved_outcomes_read': False, 'capacity': CAPACITIES['medium'],
        'features': HISTORY_FEATURES + ['causal_stand_scale'],
        'scale': 'max(1, n/(n+20)*cell_positive_median + 20/(n+20)*pooled_positive_median); all labels prior-known, frozen at arrival',
        'target': 'remaining_sec / scale',
        'sample_weight': 'equal-visit moment weight * scale, globally normalized, preserving seconds pinball objective',
        'source_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
    }
    dump(OUTPUT / 'normalized-trial.json', trial)
    print(json.dumps({'event': 'trial_declared', **trial}), flush=True)
    rows = read_episodes(ROOT / 'dataset', ['2026-09-03', '2026-09-04'])
    features = features_at_arrival(rows, ['2026-09-03'])
    scales = scales_at_arrival(rows, ['2026-09-03'])
    training = make_moments(rows, features, ['2026-09-03'], for_training=True)
    validation = make_moments(rows, features, ['2026-09-04'])
    train_scale = np.asarray([scales[m['episodeId']] for m in training['metadata']])
    valid_scale = np.asarray([scales[m['episodeId']] for m in validation['metadata']])
    train_x, categories = encode_fit(np.column_stack([training['X'], train_scale]))
    from learned_benchmark import encode
    valid_x = encode(np.column_stack([validation['X'], valid_scale]), categories)
    train_y = training['y'] / train_scale
    weights = training['weights'] * train_scale
    weights *= len(weights) / weights.sum()
    models = []
    predictions = []
    for level in LEVELS:
        model = HistGradientBoostingRegressor(loss='quantile', quantile=float(level),
                                             categorical_features=[0, 1, 2],
                                             early_stopping=False, random_state=260908,
                                             **CAPACITIES['medium'])
        with threadpool_limits(limits=2):
            model.fit(train_x, train_y, sample_weight=weights)
            predictions.append(model.predict(valid_x) * valid_scale)
        models.append(model)
    prediction = np.sort(np.maximum(0, np.column_stack(predictions)), axis=1)
    fitted = {'config': {'family': 'remaining', 'features': 'history_normalized', 'capacity': 'medium'},
              'models': models, 'categories': categories,
              'features': trial['features'], 'quantile_levels': LEVELS.tolist(), 'trial': trial}
    joblib.dump(fitted, OUTPUT / f'dev-{name}.joblib', compress=3)
    write_predictions(OUTPUT / f'dev-{name}-predictions.jsonl.gz', prediction, validation, name)
    result = {'trial': trial, 'completed_at': dt.datetime.now(dt.timezone.utc).isoformat(),
              'validation': score(prediction, validation)}
    dump(OUTPUT / 'normalized-development.json', result)
    print(json.dumps({'event': 'fit_complete', **result}), flush=True)


if __name__ == '__main__':
    main()
