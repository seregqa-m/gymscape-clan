import json
import sys
import tempfile
import unittest
from unittest.mock import patch
from datetime import datetime
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from manage_roster import apply_request, parse_request
from collect import collect


def body(action, username):
    return json.dumps({'gymscape_roster': 1, 'action': action, 'username': username})


class RosterTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / 'history').mkdir()
        (self.root / 'players.json').write_text('["alice"]')
        (self.root / 'public_client.json').write_text('{}')
        self.baseline = {'kind': 'baseline', 'captured_at': '2026-11-20T10:00:00+00:00',
                         'players': [{'username': 'alice', 'status': 'ok', 'values': {'pushUps': 100},
                                      'profile': {'id': 'alice-id'}}]}
        (self.root / 'history/baseline.json').write_text(json.dumps(self.baseline))

    def fetcher(self, name, config, identity):
        return {'username': name, 'canonical_username': name, 'status': 'ok',
                'values': {'pushUps': 500}, 'profile': {'id': name + '-id'},
                'captured_at': '2026-11-20T11:00:00+00:00'}

    def test_add_writes_enrollment_and_keeps_original_baseline(self):
        result = apply_request(1, body('add', 'bob'), self.root, self.fetcher)
        self.assertTrue(result['changed'])
        self.assertEqual(json.loads((self.root / 'players.json').read_text()), ['alice', 'bob'])
        self.assertTrue((self.root / 'history/enrollments/1.json').exists())
        self.assertEqual(json.loads((self.root / 'history/baseline.json').read_text()), self.baseline)

    def test_remove_keeps_history_and_can_remove_last_member(self):
        result = apply_request(2, body('remove', 'ALICE'), self.root, self.fetcher)
        self.assertTrue(result['changed'])
        self.assertEqual(json.loads((self.root / 'players.json').read_text()), [])
        self.assertEqual(json.loads((self.root / 'history/baseline.json').read_text()), self.baseline)

    def test_duplicate_and_retried_issue_are_idempotent(self):
        result = apply_request(3, body('add', ' ALICE '), self.root, self.fetcher)
        self.assertFalse(result['changed'])
        replay = apply_request(3, body('remove', 'alice'), self.root, self.fetcher)
        self.assertEqual(result, replay)
        self.assertEqual(json.loads((self.root / 'players.json').read_text()), ['alice'])

    def test_readding_member_creates_fresh_comparison_reference(self):
        apply_request(4, body('remove', 'alice'), self.root, self.fetcher)
        def current_holder(name, config, identity):
            self.assertIsNone(identity)
            player = self.fetcher(name, config, identity)
            player['profile']['id'] = 'new-owner-id'
            return player
        apply_request(5, body('add', 'alice'), self.root, current_holder)
        self.assertEqual(json.loads((self.root / 'history/enrollments/5.json').read_text())['kind'], 'enrollment')

    def test_untrusted_input_is_only_validated_data(self):
        for nick in ['x; curl evil', '$(whoami)', '../player', 'a\nb', '<script>', 'a' * 65, '_bad']:
            with self.assertRaises(ValueError):
                parse_request(body('add', nick))
        for value in ['not json', '{}', '["add"]', json.dumps({'gymscape_roster': True, 'action': 'add', 'username': 'bob'})]:
            with self.assertRaises(ValueError):
                parse_request(value)
        rejected = apply_request(6, body('add', '$(secret)'), self.root, self.fetcher)
        self.assertEqual(rejected['status'], 'rejected')
        self.assertNotIn('$(secret)', json.dumps(rejected))

    def test_spaces_and_literal_nickname_are_preserved(self):
        self.assertEqual(parse_request(body('add', ' millennial falcon ')), ('add', 'millennial falcon'))

    def test_unfound_profile_does_not_add_a_mistyped_name(self):
        def missing(name, config, identity):
            return {'username': name, 'status': 'missing', 'values': {}, 'profile': None}
        result = apply_request(7, body('add', 'bob'), self.root, missing)
        self.assertEqual(result['status'], 'rejected')
        self.assertEqual(json.loads((self.root / 'players.json').read_text()), ['alice'])

    def test_auto_capture_fills_midnight_once_and_preserves_actual_time(self):
        with patch('collect.datetime') as clock, patch('collect.fetch_player') as fetch:
            when = datetime.fromisoformat('2026-11-20T21:05:00+00:00')
            clock.now.return_value = when
            fetch.return_value = self.fetcher('alice', {}, 'alice-id')
            fetch.return_value['captured_at'] = when.isoformat()
            collect('auto', self.root)
            path = self.root / 'history/daily/2026-11-21.json'
            original = path.read_text()
            snapshot = json.loads(original)
            self.assertEqual(snapshot['captured_at'], when.isoformat())
            self.assertEqual(snapshot['boundary_date'], '2026-11-21')
            self.assertFalse(snapshot['late_capture'])
            self.assertEqual(snapshot['capture_delay_seconds'], 300)
            collect('auto', self.root)
            self.assertEqual(fetch.call_count, 1)
            self.assertEqual(path.read_text(), original)

    def test_delayed_scheduled_runs_and_manual_afternoon_save_real_captures(self):
        cases = [('auto', '2026-11-24T05:02:00+00:00', 8 * 3600 + 2 * 60),
                 ('auto', '2026-11-25T03:51:00+00:00', 6 * 3600 + 51 * 60),
                 ('daily', '2026-11-25T10:47:00+00:00', 13 * 3600 + 47 * 60)]
        for index, (mode, timestamp, delay) in enumerate(cases):
            with self.subTest(mode=mode, timestamp=timestamp):
                root = self.root / str(index)
                (root / 'history').mkdir(parents=True)
                (root / 'history/baseline.json').write_text(json.dumps(self.baseline))
                (root / 'players.json').write_text('["alice"]')
                (root / 'public_client.json').write_text('{}')
                baseline_before = (root / 'history/baseline.json').read_text()
                when = datetime.fromisoformat(timestamp)
                with patch('collect.datetime') as clock, patch('collect.fetch_player') as fetch:
                    clock.now.return_value = when
                    fetch.return_value = self.fetcher('alice', {}, 'alice-id')
                    fetch.return_value['captured_at'] = timestamp
                    collect(mode, root)
                    path = root / 'history/daily' / (timestamp[:10] + '.json')
                    original = path.read_text()
                    snapshot = json.loads(original)
                    self.assertEqual(snapshot['kind'], 'daily')
                    self.assertEqual(snapshot['boundary_date'], timestamp[:10])
                    self.assertEqual(snapshot['captured_at'], timestamp)
                    self.assertEqual(snapshot['started_at'], timestamp)
                    self.assertEqual(snapshot['players'][0]['captured_at'], timestamp)
                    self.assertTrue(snapshot['late_capture'])
                    self.assertEqual(snapshot['capture_delay_seconds'], delay)
                    self.assertIsNotNone(datetime.fromisoformat(snapshot['captured_at']).tzinfo)
                    # An on-demand retry never replaces that day's first capture.
                    collect(mode, root)
                    self.assertEqual(fetch.call_count, 1)
                    self.assertEqual(path.read_text(), original)
                self.assertEqual((root / 'history/baseline.json').read_text(), baseline_before)

    def test_late_flag_and_delay_use_capture_finish_not_batch_start(self):
        started = datetime.fromisoformat('2026-11-25T02:59:58+00:00')
        finished = datetime.fromisoformat('2026-11-25T03:00:01+00:00')
        with patch('collect.datetime') as clock, patch('collect.fetch_player') as fetch:
            clock.now.side_effect = [started, finished]
            fetch.return_value = self.fetcher('alice', {}, 'alice-id')
            fetch.return_value['captured_at'] = finished.isoformat()
            collect('auto', self.root)
        snapshot = json.loads((self.root / 'history/daily/2026-11-25.json').read_text())
        self.assertEqual(snapshot['started_at'], started.isoformat())
        self.assertEqual(snapshot['captured_at'], finished.isoformat())
        self.assertTrue(snapshot['late_capture'])
        self.assertEqual(snapshot['capture_delay_seconds'], 21601)

    def test_batch_crossing_moscow_midnight_fails_without_writing_wrong_date(self):
        started = datetime.fromisoformat('2026-11-25T20:59:59+00:00')
        finished = datetime.fromisoformat('2026-11-25T21:00:03+00:00')
        with patch('collect.datetime') as clock, patch('collect.fetch_player') as fetch:
            clock.now.side_effect = [started, finished]
            fetch.return_value = self.fetcher('alice', {}, 'alice-id')
            fetch.return_value['captured_at'] = finished.isoformat()
            with self.assertRaisesRegex(ValueError, 'crossed Moscow midnight'):
                collect('auto', self.root)
        self.assertEqual(list((self.root / 'history/daily').glob('*.json')), [])
        self.assertEqual(json.loads((self.root / 'history/baseline.json').read_text()), self.baseline)


if __name__ == '__main__':
    unittest.main()
