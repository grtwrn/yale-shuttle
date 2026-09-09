#!/usr/bin/env python3
"""Export fitted HistGB prediction trees to portable JSON, without retraining.

Traversal semantics follow scikit-learn 1.8.0's primary implementation:
https://github.com/scikit-learn/scikit-learn/blob/1.8.0/sklearn/ensemble/_hist_gradient_boosting/_predictor.pyx
The JSON contains fitted values, not copied library implementation code.
"""
import argparse
import datetime as dt
import gzip
import hashlib
import json
import math
from pathlib import Path

import joblib
import numpy as np


def export(model_path, output):
    bundle = joblib.load(model_path)
    if bundle['config']['features'] not in ['basic', 'history']:
        raise ValueError('Portable exporter supports the original seconds-target models only')
    first = bundle['models'][0]
    categories = first._preprocessor.named_transformers_['encoder'].categories_
    expected_mask = np.asarray([True] * 3 + [False] * (len(bundle['features']) - 3))
    if not np.array_equal(first._is_categorical_remapped, expected_mask):
        raise ValueError('Exporter requires categorical-first feature layout')
    category_maps = []
    for mapping, category_values in zip(bundle['categories'], categories):
        positions = {float(v): i for i, v in enumerate(category_values) if np.isfinite(v)}
        category_maps.append({raw: positions[float(encoded)] for raw, encoded in mapping.items()})
    quantile_models = []
    node_count = 0
    for estimator in bundle['models']:
        fitted_categories = estimator._preprocessor.named_transformers_['encoder'].categories_
        if not all(np.array_equal(a, b, equal_nan=True) for a, b in zip(categories, fitted_categories)):
            raise ValueError('Quantile estimators have different categorical encoders')
        known_bitsets, feature_map = estimator._bin_mapper.make_known_categories_bitsets()
        trees = []
        for iteration in estimator._predictors:
            if len(iteration) != 1:
                raise ValueError('Only scalar quantile regression is supported')
            predictor = iteration[0]
            nodes = []
            for node in predictor.nodes:
                if node['is_leaf']:
                    nodes.append([-1, float(node['value'])])
                else:
                    threshold = float(node['num_threshold'])
                    if math.isnan(threshold) or threshold == -math.inf:
                        raise ValueError('Unexpected threshold')
                    nodes.append([int(node['feature_idx']), threshold if math.isfinite(threshold) else None,
                                  int(node['left']), int(node['right']), int(node['missing_go_to_left']),
                                  int(node['is_categorical']), int(node['bitset_idx'])])
            node_count += len(nodes)
            trees.append({'nodes': nodes, 'leftCategories': predictor.raw_left_cat_bitsets.tolist()})
        quantile_models.append({'baseline': float(estimator._baseline_prediction[0, 0]),
                                'knownCategories': known_bitsets.tolist(), 'categoryFeatureMap': feature_map.tolist(),
                                'trees': trees})
    artifact = {'format': 'sklearn-histgb-quantiles-v1', 'sklearnVersion': bundle['sklearn_version'],
                'modelSha256': hashlib.sha256(Path(model_path).read_bytes()).hexdigest(),
                'config': bundle['config'], 'features': bundle['features'],
                'quantileLevels': bundle['quantile_levels'], 'categoryMaps': category_maps,
                'quantileModels': quantile_models}
    raw = json.dumps(artifact, separators=(',', ':'), allow_nan=False).encode()
    Path(output).write_bytes(raw)
    compressed = gzip.compress(raw, mtime=0)
    Path(str(output) + '.gz').write_bytes(compressed)
    metadata = {'exported_at': dt.datetime.now(dt.timezone.utc).isoformat(), 'nodes': node_count,
                'trees': sum(len(m['trees']) for m in quantile_models), 'json_bytes': len(raw),
                'gzip_bytes': len(compressed), 'export_sha256': hashlib.sha256(raw).hexdigest(),
                'model_sha256': artifact['modelSha256']}
    Path(str(output) + '.meta.json').write_text(json.dumps(metadata, indent=2) + '\n')
    print(json.dumps(metadata, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    export(args.model, args.output)
