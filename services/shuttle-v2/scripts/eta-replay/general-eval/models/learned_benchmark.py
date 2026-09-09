#!/usr/bin/env python3
"""Pooled scikit-learn challenger. Explicit development/freeze/holdout stages.

Run from services/shuttle-v2. Reserved day files are never opened by develop
or freeze. Predictions model only the current stand; downstream integration
must use the same frozen drive model as the comparison arms.
"""
from __future__ import annotations

import argparse
import datetime as dt
import gzip
import hashlib
import json
import os
from pathlib import Path
import sys
import time

os.environ.setdefault('OMP_NUM_THREADS', '2')
os.environ.setdefault('OPENBLAS_NUM_THREADS', '2')

import joblib
import numpy as np
import sklearn
from sklearn.ensemble import HistGradientBoostingRegressor
from threadpoolctl import threadpool_limits

from learned_features import (
    BASIC_FEATURES, HISTORY_FEATURES, LEVELS, features_at_arrival,
    make_moments, read_episodes, remaining_quantiles, score,
)

TRAIN = ['2026-09-03']
VALIDATION = ['2026-09-04']
RESERVED = {'2026-09-05', '2026-09-06', '2026-09-07'}
CAPACITIES = {
    'small': {'max_leaf_nodes': 7, 'min_samples_leaf': 40, 'max_iter': 100,
              'learning_rate': .08, 'l2_regularization': 5.},
    'medium': {'max_leaf_nodes': 15, 'min_samples_leaf': 20, 'max_iter': 150,
               'learning_rate': .06, 'l2_regularization': 5.},
}


def dump(path: Path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, allow_nan=False) + '\n')


def source_hash():
    digest = hashlib.sha256()
    for name in ['learned_benchmark.py', 'learned_features.py']:
        digest.update((Path(__file__).parent / name).read_bytes())
    return digest.hexdigest()


def encode_fit(x):
    maps = [{str(int(v)): i for i, v in enumerate(sorted(set(v for v in x[:, column] if np.isfinite(v))))} for column in range(3)]
    return encode(x, maps), maps


def encode(x, maps):
    result = x.copy()
    for column, mapping in enumerate(maps):
        result[:, column] = [mapping.get(str(int(v)), np.nan) if np.isfinite(v) else np.nan for v in result[:, column]]
    return result


def train_model(config, moments):
    n_features = len(HISTORY_FEATURES) if config['features'] == 'history' else len(BASIC_FEATURES)
    x, y, weights = moments['X'][:, :n_features], moments['y'], moments['weights']
    if config['family'] == 'duration':
        first = np.asarray([m['elapsedSec'] == 0 for m in moments['metadata']])
        x, y, weights = x[first], y[first], np.ones(sum(first))
    # Keep each visit's relative weight, but normalize the global scale so the
    # L2 penalty has the same units for total and expanded remaining models.
    weights = weights * len(weights) / weights.sum()
    x, categories = encode_fit(x)
    models = []
    started = time.monotonic()
    for q in LEVELS:
        model = HistGradientBoostingRegressor(
            loss='quantile', quantile=float(q), early_stopping=False,
            categorical_features=[0, 1, 2], random_state=260908,
            **CAPACITIES[config['capacity']],
        )
        with threadpool_limits(limits=2):
            model.fit(x, y, sample_weight=weights)
        models.append(model)
    return {'config': config, 'models': models, 'categories': categories,
            'features': (HISTORY_FEATURES if config['features'] == 'history' else BASIC_FEATURES),
            'fit_rows': len(y), 'fit_sec': time.monotonic() - started,
            'quantile_levels': LEVELS.tolist(), 'sklearn_version': sklearn.__version__}


def predict(model, moments):
    x = moments['X'][:, :len(model['features'])].copy()
    if model['config']['family'] == 'duration':
        x[:, 5] = 0
    x = encode(x, model['categories'])
    with threadpool_limits(limits=2):
        qs = np.sort(np.maximum(0, np.column_stack([m.predict(x) for m in model['models']])), axis=1)
    if model['config']['family'] == 'duration':
        qs = np.asarray([remaining_quantiles(q, m['elapsedSec']) for q, m in zip(qs, moments['metadata'])])
    return qs


def write_predictions(path, prediction, moments, model_name):
    with gzip.open(path, 'wt') as stream:
        for q, metadata in zip(prediction, moments['metadata']):
            row = {**metadata, 'model': model_name, 'component': 'remaining_stand',
                   'quantileLevels': LEVELS.tolist(), 'quantilesSec': q.tolist()}
            stream.write(json.dumps(row, allow_nan=False) + '\n')


def development(args):
    rows = read_episodes(args.dataset, TRAIN + VALIDATION)
    features = features_at_arrival(rows, TRAIN)
    training = make_moments(rows, features, TRAIN, for_training=True)
    validation = make_moments(rows, features, VALIDATION)
    args.output.mkdir(parents=True, exist_ok=True)
    results = {}
    for family in ['duration', 'remaining']:
        for feature_set in ['basic', 'history']:
            for capacity in CAPACITIES:
                name = f'{family}_{feature_set}_{capacity}'
                config = {'family': family, 'features': feature_set, 'capacity': capacity}
                print(json.dumps({'event': 'fit_start', 'name': name, 'train_rows': len(training['y'])}), flush=True)
                model = train_model(config, training)
                prediction = predict(model, validation)
                result = {'config': config, 'fit_sec': model['fit_sec'], 'fit_rows': model['fit_rows'],
                          'validation': score(prediction, validation)}
                results[name] = result
                joblib.dump(model, args.output / f'dev-{name}.joblib', compress=3)
                write_predictions(args.output / f'dev-{name}-predictions.jsonl.gz', prediction, validation, name)
                dump(args.output / 'development.json', results)
                print(json.dumps({'event': 'fit_complete', 'name': name, 'fit_sec': model['fit_sec'],
                                  'validation': result['validation']['all']}), flush=True)
    selected = min(results, key=lambda name: results[name]['validation']['all']['crps_midpoint19_sec'])
    best_by_family = {family: min((n for n in results if n.startswith(family + '_')),
                                 key=lambda n: results[n]['validation']['all']['crps_midpoint19_sec'])
                      for family in ['duration', 'remaining']}
    selection = {'selected': selected, 'config': results[selected]['config'],
                 'best_by_family': best_by_family,
                 'chosen_at': dt.datetime.now(dt.timezone.utc).isoformat(),
                 'selection_rule': 'lowest September 4 equal-visit midpoint-19 CRPS',
                 'training_days': TRAIN, 'validation_days': VALIDATION,
                 'reserved_outcomes_read': False, 'source_sha256': source_hash(),
                 'capacities': CAPACITIES, 'basic_features': BASIC_FEATURES, 'history_features': HISTORY_FEATURES,
                 'quantile_levels': LEVELS.tolist(), 'sklearn_version': sklearn.__version__,
                 'censoring': 'Primary stand population is pinned stopped visits. Unpinned, passed, unresolved and labels unavailable before fit cutoff excluded; counts retained. Unresolved route patterns excluded from training and reported separately in scoring.',
                 'weighting': 'Each completed episode has equal training and scoring weight; 30-second rows share its weight.',
                 'availability': 'Feature summaries use prior days, except prequential first-discovery-day training; same-day phase references use knownAt.'}
    selection['config_sha256'] = hashlib.sha256(json.dumps(selection, sort_keys=True).encode()).hexdigest()
    dump(args.output / 'selection.json', selection)
    print(json.dumps({'event': 'selected', 'selection': selection}), flush=True)


def freeze(args):
    selection = json.loads((args.output / 'selection.json').read_text())
    if source_hash() != selection['source_sha256']:
        raise ValueError('Source changed after selection; rerun development before freezing')
    rows = read_episodes(args.dataset, TRAIN + VALIDATION)
    features = features_at_arrival(rows, TRAIN + VALIDATION)
    training = make_moments(rows, features, TRAIN + VALIDATION, for_training=True)
    model = train_model(selection['config'], training)
    model['training_days'] = TRAIN + VALIDATION
    path = args.output / 'frozen.joblib'
    joblib.dump(model, path, compress=3)
    manifest = {'selection': selection, 'frozen_at': dt.datetime.now(dt.timezone.utc).isoformat(),
                'model_sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
                'source_sha256': source_hash(), 'training_days': TRAIN + VALIDATION,
                'fit_rows': model['fit_rows'], 'fit_sec': model['fit_sec'],
                'excluded_training': training['excluded'], 'reserved_outcomes_read': False}
    dump(args.output / 'frozen-manifest.json', manifest)
    print(json.dumps({'event': 'frozen', 'manifest': manifest}), flush=True)


def forecast(args):
    days = args.days.split(',')
    if RESERVED.intersection(days) and not args.allow_reserved:
        raise ValueError('Reserved outcomes require explicit --allow-reserved after freezing')
    manifest = json.loads((args.output / 'frozen-manifest.json').read_text())
    if manifest['source_sha256'] != source_hash():
        raise ValueError('Source changed after freeze; reserved evaluation is prohibited')
    model_path = args.output / 'frozen.joblib'
    if hashlib.sha256(model_path.read_bytes()).hexdigest() != manifest['model_sha256']:
        raise ValueError('Model changed after freeze')
    model = joblib.load(model_path)
    training_days = model['training_days']
    rows = read_episodes(args.dataset, sorted(set(training_days + days)))
    features = features_at_arrival(rows, training_days)
    for day in days:
        moments = make_moments(rows, features, [day])
        prediction = predict(model, moments)
        result = {'day': day, 'model_sha256': manifest['model_sha256'],
                  'config_sha256': manifest['selection']['config_sha256'],
                  'frozen_at': manifest['frozen_at'],
                  'evaluated_at': dt.datetime.now(dt.timezone.utc).isoformat(),
                  'scores': score(prediction, moments)}
        dump(args.output / f'frozen-{day}-score.json', result)
        write_predictions(args.output / f'frozen-{day}-predictions.jsonl.gz', prediction, moments,
                          manifest['selection']['selected'])
        print(json.dumps(result), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('stage', choices=['develop', 'freeze', 'predict'])
    parser.add_argument('--dataset', type=Path, default=Path('scripts/.eta-replay/overnight-2026-09-08/dataset'))
    parser.add_argument('--output', type=Path, default=Path('scripts/.eta-replay/overnight-2026-09-08/learned'))
    parser.add_argument('--days', default='2026-09-08')
    parser.add_argument('--allow-reserved', action='store_true')
    args = parser.parse_args()
    {'develop': development, 'freeze': freeze, 'predict': forecast}[args.stage](args)


if __name__ == '__main__':
    main()
