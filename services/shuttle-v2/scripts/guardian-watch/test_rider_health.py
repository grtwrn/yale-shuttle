import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import poll


class RiderFeedHealthTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.watch = str(Path(self.temp.name) / 'rider')
        Path(self.watch).mkdir()
        self.at = 1792531800
        self.state = {}
        self.clock = patch.object(poll, 'now', side_effect=lambda: self.at)
        self.clock.start()
        self.addCleanup(self.clock.stop)
        self.alert = patch.object(poll, 'raise_incident')
        self.incident = self.alert.start()
        self.addCleanup(self.alert.stop)

    def check(self, age=0, **changes):
        row = {'updatedAt': poll.iso(self.at), 'running': True,
               'feedReceivedAt': poll.iso(self.at - age), 'feedStale': False, 'cachedBuses': 0, **changes}
        (Path(self.watch) / 'status.json').write_text(json.dumps(row))
        poll.check_rider(self.state, self.watch)
        return row

    def test_fresh_heartbeat_cannot_hide_a_day_old_feed_even_with_false_stale_flag(self):
        row = self.check(86400)
        self.assertEqual(self.incident.call_count, 1)
        call = self.incident.call_args
        self.assertEqual(call.args[1], 'rider-feed-stalled')
        self.assertEqual(call.args[5]['status'], row)
        self.assertEqual(call.args[6]['watcherDir'], self.watch)
        self.assertEqual(self.state['riderFeedHealth'][self.watch]['state'], 'stalled')

    def test_continuing_outage_does_not_append_unbounded_occurrences_after_monitor_restart(self):
        self.check(600)
        self.state = json.loads(json.dumps(self.state))
        for _ in range(60):
            self.at += 60
            self.check(600)
        self.assertEqual(self.incident.call_count, 1)

    def test_fresh_empty_service_rearms_a_later_outage_without_journey_or_accuracy_claim(self):
        self.check(600)
        self.at += 60
        self.check(0)
        self.assertEqual(self.state['riderFeedHealth'][self.watch]['state'], 'fresh')
        self.at += 60
        self.check(600)
        self.assertEqual(self.incident.call_count, 2)

    def test_five_minute_boundary_and_short_source_pauses_do_not_alert(self):
        for age in [0, 31, 120, 300]:
            self.check(age)
        self.assertEqual(self.incident.call_count, 0)
        self.check(300.001)
        self.assertEqual(self.incident.call_count, 1)

    def test_receipts_older_than_thirty_seconds_are_stale_and_do_not_rearm_an_outage(self):
        self.check(600)
        for age in [30.001, 120, 300]:
            self.check(age)
            self.assertEqual(self.state['riderFeedHealth'][self.watch]['state'], 'stale')
        self.check(600)
        self.assertEqual(self.incident.call_count, 1)
        self.check(30)
        self.assertEqual(self.state['riderFeedHealth'][self.watch]['state'], 'fresh')

    def test_unknown_or_future_receipts_do_not_claim_recovery_or_rearm_an_existing_outage(self):
        self.check(600)
        for value in [None, 'invalid', poll.iso(self.at + 60)]:
            self.check(feedReceivedAt=value)
            self.assertEqual(self.state['riderFeedHealth'][self.watch]['state'], 'unknown')
        self.check(600)
        self.assertEqual(self.incident.call_count, 1)

    def test_dead_heartbeat_keeps_the_existing_stall_alert_without_duplicate_feed_alert(self):
        self.check(86400, updatedAt=poll.iso(self.at - 901))
        self.assertEqual(self.incident.call_count, 1)
        self.assertEqual(self.incident.call_args.args[1], 'rider-stalled')

    def test_configured_red_watcher_retains_line_attribution(self):
        row = {'updatedAt': poll.iso(self.at), 'running': True, 'feedReceivedAt': poll.iso(self.at - 600)}
        (Path(self.watch) / 'status.json').write_text(json.dumps(row))
        poll.check_rider(self.state, self.watch, 'Red')
        self.assertEqual(self.incident.call_count, 1)
        self.assertEqual(self.incident.call_args.args[2], 'Red')
        self.assertTrue(self.incident.call_args.args[6]['log'].endswith('watcher-red.log'))


if __name__ == '__main__':
    unittest.main()
