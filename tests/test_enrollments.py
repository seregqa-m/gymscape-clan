import json
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from build_data import build


def player(name, count=None, status='ok', extra=None, identity=None, captured_at=None):
    values = {} if count is None else {'pushUps': count}
    values.update(extra or {})
    result = {'username': name, 'canonical_username': name, 'status': status,
              'values': values, 'profile': {'id': identity or name, 'username': name}}
    if captured_at:
        result['captured_at'] = captured_at
    return result


def event(when, players, kind='daily'):
    return {'kind': kind, 'captured_at': when, 'players': players,
            'boundary_date': datetime.fromisoformat(when).astimezone(ZoneInfo('Europe/Moscow')).date().isoformat()
            if kind == 'daily' else None}


def period_row(data, period, name):
    return next(r for p in data['periods'] if p['id'] == period for r in p['rows'] if r['username'] == name)


class EnrollmentTests(unittest.TestCase):
    def make_dashboard(self, names, events):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'history/daily').mkdir(parents=True)
            (root / 'history/enrollments').mkdir()
            baseline = next(e for e in events if e['kind'] == 'baseline')
            original = json.dumps(baseline)
            (root / 'history/baseline.json').write_text(original)
            for index, e in enumerate(events):
                if e['kind'] == 'daily':
                    path = root / 'history/daily' / f'{e["boundary_date"]}.json'
                elif e['kind'] == 'enrollment':
                    path = root / 'history/enrollments' / f'{index}.json'
                else:
                    continue
                path.write_text(json.dumps(e))
            (root / 'players.json').write_text(json.dumps(names))
            (root / 'exercises.json').write_text('[]')
            result = build(root)
            self.assertEqual((root / 'history/baseline.json').read_text(), original)
            return result

    def test_addition_updates_totals_without_creating_activity(self):
        baseline = event('2026-11-20T10:00:00+00:00', [player('alice', 100)], 'baseline')
        enrollment = event('2026-11-20T13:00:00+00:00', [player('bob', 500)], 'enrollment')
        data = self.make_dashboard(['alice', 'bob'], [baseline, enrollment])
        self.assertEqual(data['history'], [])
        self.assertEqual(period_row(data, 'baseline', 'bob')['values']['pushUps'], 500)
        self.assertEqual(period_row(data, 'total', 'alice')['values']['pushUps'], 100)
        self.assertEqual(period_row(data, 'total', 'bob')['values']['pushUps'], 500)
        self.assertEqual(data['latest_at'], enrollment['captured_at'])
        self.assertFalse(next(p for p in data['periods'] if p['id'] == 'day')['available'])

    def test_daily_after_enrollment_uses_personal_start_and_partial(self):
        baseline = event('2026-11-20T10:00:00+00:00', [player('alice', 100)], 'baseline')
        first = event('2026-11-20T21:00:00+00:00', [player('alice', 120)])
        enrollment = event('2026-11-21T12:00:00+00:00', [player('bob', 500)], 'enrollment')
        second = event('2026-11-21T21:00:00+00:00', [player('alice', 140), player('bob', 525)])
        data = self.make_dashboard(['alice', 'bob'], [baseline, first, enrollment, second])
        self.assertEqual(len(data['history']), 2)
        bob = period_row(data, 'day', 'bob')
        self.assertEqual(bob['values']['pushUps'], 25)
        self.assertEqual(bob['from'], enrollment['captured_at'])
        self.assertTrue(bob['partial'])
        self.assertEqual(period_row(data, 'week', 'bob')['values']['pushUps'], 25)
        self.assertTrue(period_row(data, 'week', 'bob')['partial'])
        self.assertEqual(period_row(data, 'day', 'alice')['values']['pushUps'], 20)
        self.assertFalse(period_row(data, 'day', 'alice')['partial'])

    def test_first_appearance_in_daily_is_baseline_not_activity(self):
        baseline = event('2026-11-20T10:00:00+00:00', [player('alice', 100)], 'baseline')
        first = event('2026-11-20T21:00:00+00:00', [player('alice', 120), player('bob', 900)])
        data = self.make_dashboard(['alice', 'bob'], [baseline, first])
        self.assertEqual(period_row(data, 'baseline', 'bob')['values']['pushUps'], 900)
        self.assertEqual(period_row(data, 'day', 'bob')['status'], 'no_baseline')
        second = event('2026-11-21T21:00:00+00:00', [player('alice', 140), player('bob', 910)])
        data = self.make_dashboard(['alice', 'bob'], [baseline, first, second])
        self.assertEqual(period_row(data, 'week', 'bob')['values']['pushUps'], 10)
        self.assertTrue(period_row(data, 'week', 'bob')['partial'])

    def test_previously_missing_player_gets_personal_first_success(self):
        baseline = event('2026-11-20T10:00:00+00:00', [player('bob', status='missing')], 'baseline')
        first = event('2026-11-20T21:00:00+00:00', [player('bob', 900)])
        data = self.make_dashboard(['bob'], [baseline, first])
        self.assertEqual(period_row(data, 'baseline', 'bob')['values']['pushUps'], 900)
        self.assertEqual(period_row(data, 'day', 'bob')['status'], 'no_baseline')
        self.assertEqual(period_row(data, 'day', 'bob')['values'], {})

    def test_reenrollment_excludes_outside_tracking_progress(self):
        baseline = event('2026-11-20T10:00:00+00:00', [player('bob', 100)], 'baseline')
        first = event('2026-11-20T21:00:00+00:00', [player('bob', 110)])
        absent = event('2026-11-21T21:00:00+00:00', [])
        enrollment = event('2026-11-22T12:00:00+00:00', [player('bob', 1000)], 'enrollment')
        after = event('2026-11-22T21:00:00+00:00', [player('bob', 1007)])
        data = self.make_dashboard(['bob'], [baseline, first, absent, enrollment, after])
        self.assertEqual(period_row(data, 'baseline', 'bob')['values']['pushUps'], 100)
        self.assertEqual(period_row(data, 'day', 'bob')['values']['pushUps'], 7)
        self.assertEqual(period_row(data, 'week', 'bob')['values']['pushUps'], 17)
        self.assertTrue(period_row(data, 'week', 'bob')['partial'])
        self.assertTrue(data['history'][1]['rows'][0]['inactive'])

    def test_reenrollment_between_same_boundaries_resets_reference(self):
        baseline = event('2026-11-20T10:00:00+00:00', [player('bob', 100)], 'baseline')
        first = event('2026-11-20T21:00:00+00:00', [player('bob', 110)])
        enrollment = event('2026-11-21T12:00:00+00:00', [player('bob', 300)], 'enrollment')
        after = event('2026-11-21T21:00:00+00:00', [player('bob', 305)])
        data = self.make_dashboard(['bob'], [baseline, first, enrollment, after])
        self.assertEqual(period_row(data, 'day', 'bob')['values']['pushUps'], 5)
        self.assertEqual(period_row(data, 'week', 'bob')['values']['pushUps'], 15)
        self.assertEqual(len(data['history']), 2)

    def test_missing_is_not_treated_as_absence_from_roster(self):
        baseline = event('2026-11-20T10:00:00+00:00', [], 'baseline')
        enrollment = event('2026-11-20T12:00:00+00:00', [player('bob', 300)], 'enrollment')
        missing = event('2026-11-20T21:00:00+00:00', [player('bob', status='missing')])
        recovered = event('2026-11-21T21:00:00+00:00', [player('bob', 310)])
        data = self.make_dashboard(['bob'], [baseline, enrollment, missing, recovered])
        self.assertEqual(period_row(data, 'day', 'bob')['status'], 'no_baseline')
        self.assertEqual(period_row(data, 'week', 'bob')['status'], 'no_baseline')
        self.assertNotIn('inactive', data['history'][0]['rows'][0])

    def test_disappearing_counter_stays_unknown_across_enrollment(self):
        baseline = event('2026-11-20T10:00:00+00:00', [player('bob', 100)], 'baseline')
        enrollment = event('2026-11-20T12:00:00+00:00', [player('bob', extra={'tutorial': 2})], 'enrollment')
        after = event('2026-11-20T21:00:00+00:00', [player('bob', 110)])
        data = self.make_dashboard(['bob'], [baseline, enrollment, after])
        self.assertIsNone(period_row(data, 'day', 'bob')['values']['pushUps'])

    def test_latest_enrollment_does_not_move_daily_period_end(self):
        baseline = event('2026-11-20T10:00:00+00:00', [player('alice', 100)], 'baseline')
        daily = event('2026-11-20T21:00:00+00:00', [player('alice', 120)])
        enrollment = event('2026-11-21T12:00:00+00:00', [player('bob', 500)], 'enrollment')
        data = self.make_dashboard(['alice', 'bob'], [baseline, daily, enrollment])
        self.assertEqual(data['latest_at'], enrollment['captured_at'])
        self.assertEqual(next(p for p in data['periods'] if p['id'] == 'day')['to'], daily['captured_at'])
        self.assertEqual(period_row(data, 'total', 'alice')['captured_at'], daily['captured_at'])
        self.assertEqual(period_row(data, 'total', 'bob')['captured_at'], enrollment['captured_at'])
        self.assertEqual(len(data['history']), 1)

    def test_current_roster_excludes_removed_players_without_deleting_history(self):
        baseline = event('2026-11-20T10:00:00+00:00', [player('alice', 100), player('bob', 200)], 'baseline')
        data = self.make_dashboard(['alice'], [baseline])
        self.assertEqual([p['username'] for p in data['players']], ['alice'])
        self.assertEqual([r['username'] for r in data['periods'][0]['rows']], ['alice'])

    def test_week_and_month_count_only_enrolled_intervals_in_their_windows(self):
        start = datetime(2026, 11, 1, 10, tzinfo=timezone.utc)
        events = [event(start.isoformat(), [player('alice', 100), player('bob', 100)], 'baseline')]
        for day in range(1, 36):
            moment = start.replace(hour=21) + timedelta(days=day - 1)
            if day == 33:
                events.append(event(moment.replace(hour=12).isoformat(), [player('bob', 1000)], 'enrollment'))
            people = [player('alice', 100 + day)]
            if day <= 2:
                people.append(player('bob', 100 + day))
            elif day >= 33:
                people.append(player('bob', 1000 + (day - 32) * 10))
            events.append(event(moment.isoformat(), people))
        data = self.make_dashboard(['alice', 'bob'], events)
        self.assertEqual(len(data['history']), 35)
        self.assertEqual(period_row(data, 'day', 'bob')['values']['pushUps'], 10)
        self.assertEqual(period_row(data, 'week', 'bob')['values']['pushUps'], 30)
        self.assertEqual(period_row(data, 'month', 'bob')['values']['pushUps'], 30)
        self.assertTrue(period_row(data, 'week', 'bob')['partial'])
        self.assertEqual(period_row(data, 'week', 'alice')['values']['pushUps'], 7)
        self.assertEqual(period_row(data, 'month', 'alice')['values']['pushUps'], 30)

    def test_empty_roster_builds_without_recovering_removed_users(self):
        baseline = event('2026-11-20T10:00:00+00:00', [player('alice', 100)], 'baseline')
        daily = event('2026-11-20T21:00:00+00:00', [])
        data = self.make_dashboard([], [baseline, daily])
        self.assertEqual(data['players'], [])
        self.assertTrue(all(p['rows'] == [] for p in data['periods']))

    def test_reused_name_baseline_belongs_to_current_identity(self):
        baseline = event('2026-11-20T10:00:00+00:00', [player('bob', 100, identity='original')], 'baseline')
        old_daily = event('2026-11-20T21:00:00+00:00', [player('bob', 130, identity='original')])
        enrollment = event('2026-11-21T12:00:00+00:00', [player('Bob', 500, identity='new')], 'enrollment')
        daily = event('2026-11-21T21:00:00+00:00', [player('Bob', 510, identity='new')])
        data = self.make_dashboard(['Bob'], [baseline, old_daily, enrollment, daily])
        self.assertEqual(period_row(data, 'baseline', 'Bob')['values']['pushUps'], 500)
        self.assertEqual(period_row(data, 'day', 'Bob')['values']['pushUps'], 10)
        self.assertEqual(period_row(data, 'week', 'Bob')['values']['pushUps'], 10)

    def test_today_reference_is_personal_latest_capture(self):
        baseline = event('2026-11-20T10:00:00+00:00', [player('alice', 100)], 'baseline')
        daily = event('2026-11-20T21:05:00+00:00', [player('alice', 120)])
        enrollment = event('2026-11-21T12:00:00+00:00', [player('bob', 500)], 'enrollment')
        data = self.make_dashboard(['alice', 'bob'], [baseline, daily, enrollment])
        references = {r['username']: r for r in data['day_references']}
        self.assertEqual(references['alice']['kind'], 'daily')
        self.assertEqual(references['alice']['boundary_date'], '2026-11-21')
        self.assertEqual(references['bob']['kind'], 'enrollment')
        self.assertEqual(references['bob']['values']['pushUps'], 500)
        self.assertIsNone(data['source'])

    def test_public_identity_is_preserved_when_latest_profile_is_missing(self):
        baseline = event('2026-11-20T10:00:00+00:00', [player('alice', 100, identity='stable-id')], 'baseline')
        missing = player('alice', status='missing')
        missing['profile'] = None
        daily = event('2026-11-20T21:05:00+00:00', [missing])
        data = self.make_dashboard(['alice'], [baseline, daily])
        self.assertEqual(data['players'][0]['id'], 'stable-id')
        self.assertEqual(data['day_references'][0]['profile_id'], 'stable-id')
        self.assertEqual(data['day_references'][0]['status'], 'missing')


if __name__ == '__main__':
    unittest.main()
