import copy
import datetime as dt
import json
from pathlib import Path
import unittest
from zoneinfo import ZoneInfo

from runtime import CELLS, FROZEN, VALID_FROM, VALID_UNTIL, available, canonical, exact_fit_class, from_pools

SOURCE = (Path(__file__).resolve().parents[1] / 'k-sweep/evaluate.py').read_text()


def example_pools():
    dates = [dt.datetime(2026, 9, day, 12, tzinfo=ZoneInfo('America/New_York')) for day in (8, 9, 10)]
    paths = []
    for day in dates:
        for i in range(5):
            start = int(day.timestamp()*1000) + i * 1000
            duration = 600.123 + i
            paths.append(dict(start=start, end=start + duration*1000, duration=duration,
                              day=day.strftime('%Y-%m-%d'), weekend=False, bus='fixture',
                              sourceId=f'{day.day}/{i}/s', targetId=f'{day.day}/{i}/t'))
    return dict(schema=1, cells=[dict(key=list(cell), paths=copy.deepcopy(paths) if cell == CELLS[0] else []) for cell in CELLS])


class RuntimeTests(unittest.TestCase):
    def test_original_ast_and_fractional_serialization(self):
        pool = example_pools()
        model, hashes = from_pools(SOURCE, pool)
        reloaded, other_hashes = from_pools(SOURCE, json.loads(canonical(pool)))
        self.assertEqual(set(hashes), {'clock', 'weekend', 'q', 'fit'})
        self.assertEqual(hashes, other_hashes)
        query = (*CELLS[0], pool['cells'][0]['paths'][0]['start'])
        self.assertIsNotNone(model.fit(*query))
        self.assertEqual(model.fit(*query), reloaded.fit(*query))
        self.assertEqual(model.paths, reloaded.paths)

    def test_empty_and_insufficient_material_days(self):
        pool = example_pools()
        pool['cells'][0]['paths'] = [pool['cells'][0]['paths'][0]] * 15
        model, _ = from_pools(SOURCE, pool)
        self.assertIsNone(model.fit(*CELLS[0], pool['cells'][0]['paths'][0]['start']))
        self.assertIsNone(model.fit(*CELLS[-1], pool['cells'][0]['paths'][0]['start']))

    def test_weekend_query_excludes_weekday_paths(self):
        model, _ = from_pools(SOURCE, example_pools())
        saturday = int(dt.datetime(2026, 9, 12, 12, tzinfo=ZoneInfo('America/New_York')).timestamp()*1000)
        self.assertIsNone(model.fit(*CELLS[0], saturday))

    def test_invalid_or_foreign_pool_refused(self):
        for mutate in (
            lambda p: p['cells'].pop(),
            lambda p: p['cells'][0]['key'].__setitem__(0, 3),
            lambda p: p['cells'][0]['paths'][0].__setitem__('end', FROZEN),
            lambda p: p['cells'][0]['paths'][0].__setitem__('duration', float('nan')),
            lambda p: p['cells'][0]['paths'][0].__setitem__('weekend', True),
        ):
            pool = example_pools()
            mutate(pool)
            with self.assertRaises(AssertionError):
                from_pools(SOURCE, pool)

    def test_original_helper_changes_are_fingerprinted(self):
        _, old = exact_fit_class(SOURCE)
        _, new = exact_fit_class(SOURCE.replace('diff/120', 'diff/121'))
        self.assertNotEqual(old['fit'], new['fit'])
        self.assertEqual(old['q'], new['q'])

    def test_actual_build_and_validity_boundaries(self):
        manifest = dict(builtAt=VALID_FROM + 1000, validFrom=VALID_FROM, validUntil=VALID_UNTIL)
        for at in (VALID_FROM-1, VALID_FROM, VALID_FROM+999, VALID_UNTIL, float('nan'), True):
            self.assertFalse(available(manifest, at))
        self.assertTrue(available(manifest, VALID_FROM+1000))
        self.assertTrue(available(manifest, VALID_UNTIL-1))


if __name__ == '__main__':
    unittest.main()
