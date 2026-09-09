#!/usr/bin/env python3
"""Correct only the frozen duration representation, preserving original outputs."""
import datetime as dt
import gzip
import hashlib
import json
from pathlib import Path
import numpy as np

from learned_benchmark import dump, write_predictions
from learned_distribution import atom_remaining_quantiles
from learned_features import score

ROOT = Path('scripts/.eta-replay/overnight-2026-09-08/learned')


def main():
    declaration = {'declared_at': dt.datetime.now(dt.timezone.utc).isoformat(),
                   'correction': 'Preserve repeated positive quantile atoms and condition known-standing at r=0; stable log-survival tail',
                   'source_sha256': hashlib.sha256(Path(__file__).with_name('learned_distribution.py').read_bytes()).hexdigest(),
                   'training_unchanged': True, 'reserved_outcomes_read': False}
    dump(ROOT / 'atom-correction.json', declaration)
    fixture = []
    for name in ['duration_history_small', 'duration_history_medium']:
        path = ROOT / f'dev-{name}-predictions.jsonl.gz'
        rows = [json.loads(line) for line in gzip.open(path, 'rt')]
        first = {row['episodeId']: row['quantilesSec'] for row in rows if row['elapsedSec'] == 0}
        predictions = np.asarray([atom_remaining_quantiles(first[row['episodeId']], row['elapsedSec']) for row in rows])
        moments = {'metadata': rows, 'y': np.asarray([r['totalSec'] - r['elapsedSec'] for r in rows]), 'excluded': {}}
        result = {'declaration': declaration, 'model': name, 'validation': score(predictions, moments)}
        dump(ROOT / f'dev-{name}-atom-score.json', result)
        write_predictions(ROOT / f'dev-{name}-atom-predictions.jsonl.gz', predictions, moments, name + '_atoms')
        fixture += [{'q': first[row['episodeId']], 'elapsed': row['elapsedSec'], 'expected': prediction.tolist()}
                    for row, prediction in zip(rows[::19], predictions[::19])]
        print(json.dumps({'model': name, 'all': result['validation']['all'], 'first': result['validation']['first']}), flush=True)
    for q in [[600.] * 19, [0.] * 12 + [120.] * 7, list(np.linspace(0, 500, 19))]:
        for elapsed in [0, .000000001, 100, 119.999999, 120, 600, 1e9]:
            fixture.append({'q': q, 'elapsed': elapsed, 'expected': atom_remaining_quantiles(q, elapsed).tolist()})
    dump(ROOT / 'atom-parity-fixture.json', fixture)


if __name__ == '__main__':
    main()
