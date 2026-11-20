import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from build_data import build, difference, interval, window_rows, normalize_chain
from collect import collect


def snap(when, count, kind='daily', status='ok', extra=None):
    return {'kind': kind, 'captured_at': when, 'boundary_date': when[:10],
            'players': [{'username': 'alice', 'status': status,
                         'values': dict({'pushUps': count}, **(extra or {}))}]}


class DeltaTests(unittest.TestCase):
    def test_baseline_not_counted_as_activity(self):
        baseline = snap('2026-11-20T10:00:00+00:00', 2000, 'baseline')
        after = snap('2026-11-20T21:05:00+00:00', 2030)
        self.assertEqual(difference(baseline, after, ['alice'])[0]['values']['pushUps'], 30)
        first = interval(baseline, after, ['alice'])
        self.assertTrue(first['partial'])
        self.assertEqual(first['date'], '2026-11-20')

    def test_empty_baseline_has_no_daily_results(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / 'history').mkdir()
            (root / 'history/baseline.json').write_text(json.dumps(snap('2026-11-20T10:00:00+00:00', 2000, 'baseline')))
            (root / 'players.json').write_text('["alice"]')
            (root / 'exercises.json').write_text('[]')
            data = build(root)
            self.assertEqual(data['history'], [])
            self.assertFalse(next(p for p in data['periods'] if p['id'] == 'day')['available'])
            self.assertEqual(data['periods'][0]['rows'][0]['values']['pushUps'], 2000)
            # Re-running bootstrap must never replace the baseline.
            original = (root / 'history/baseline.json').read_text()
            collect('baseline', root)
            self.assertEqual((root / 'history/baseline.json').read_text(), original)

    def test_missing_player_is_not_zero(self):
        a = snap('2026-11-20T21:00:00+00:00', 100)
        b = snap('2026-11-21T21:00:00+00:00', 0, status='missing')
        self.assertEqual(difference(a, b, ['alice'])[0]['status'], 'missing')
        self.assertEqual(difference(b, a, ['alice'])[0]['status'], 'no_baseline')

    def test_counter_reset_is_unknown_not_negative_or_zero(self):
        a = snap('2026-11-20T21:00:00+00:00', 100)
        b = snap('2026-11-21T21:00:00+00:00', 10)
        row = difference(a, b, ['alice'])[0]
        self.assertIsNone(row['values']['pushUps'])
        self.assertEqual(row['anomalies'], ['pushUps'])

    def test_reset_is_not_hidden_by_later_growth(self):
        chain = [snap('2026-11-20T21:00:00+00:00', 100),
                 snap('2026-11-21T21:00:00+00:00', 10),
                 snap('2026-11-22T21:00:00+00:00', 120)]
        self.assertIsNone(window_rows(chain, ['alice'])[0]['values']['pushUps'])

    def test_missed_day_stays_one_partial_interval(self):
        a = snap('2026-11-20T21:04:00+00:00', 100)
        b = snap('2026-11-22T21:08:00+00:00', 130)
        row = interval(a, b, ['alice'])
        self.assertTrue(row['partial'])
        self.assertEqual(row['gap_days'], 2)
        self.assertEqual(row['rows'][0]['values']['pushUps'], 30)

    def test_new_exercise_and_seconds_remain_separate(self):
        a = snap('2026-11-20T21:00:00+00:00', 100, extra={'highPlank': 300})
        b = snap('2026-11-21T21:00:00+00:00', 120, extra={'highPlank': 360, 'squats': 30})
        self.assertEqual(difference(a, b, ['alice'])[0]['values'],
                         {'pushUps': 20, 'highPlank': 60, 'squats': 30})

    def test_reappearing_counter_does_not_count_lifetime_total(self):
        a = snap('2026-11-20T21:00:00+00:00', 100)
        b = snap('2026-11-21T21:00:00+00:00', 0)
        b['players'][0]['values'] = {'tutorial': 2}
        c = snap('2026-11-22T21:00:00+00:00', 110)
        d = snap('2026-11-23T21:00:00+00:00', 115)
        chain = normalize_chain([a, b, c, d])
        self.assertIsNone(difference(chain[1], chain[2], ['alice'])[0]['values']['pushUps'])
        self.assertEqual(difference(chain[2], chain[3], ['alice'])[0]['values']['pushUps'], 5)
        self.assertIsNone(window_rows(chain, ['alice'])[0]['values']['pushUps'])

    def test_different_account_cannot_inherit_nickname_history(self):
        a = snap('2026-11-20T21:00:00+00:00', 100)
        b = snap('2026-11-21T21:00:00+00:00', 1000)
        a['players'][0]['profile'] = {'id': 'old-account'}
        b['players'][0]['profile'] = {'id': 'different-account'}
        self.assertEqual(difference(a, b, ['alice'])[0]['status'], 'no_baseline')


if __name__ == '__main__':
    unittest.main()
