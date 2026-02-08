#!/usr/bin/env python3
import json
import os
import sys
import tempfile
import shutil
import unittest

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from scripts import weekly_governance


class TestWeeklyGovernance(unittest.TestCase):
    def setUp(self):
        self.test_dir = tempfile.mkdtemp()
        os.makedirs(os.path.join(self.test_dir, "docs", "okr"), exist_ok=True)

    def tearDown(self):
        shutil.rmtree(self.test_dir)

    def test_lifecycle_happy_path(self):
        weekly_governance.start_week(self.test_dir, week_id="2026-W06", goal="Ship parser quality")
        weekly_governance.record_proposal(self.test_dir, "planner", "Plan A with milestones")
        weekly_governance.record_challenge(self.test_dir, "reviewer", "Need rollback strategy")
        state = weekly_governance.owner_decision(self.test_dir, "approve", note="approved by owner")

        self.assertEqual(state["stage"], "LOCKED")
        self.assertTrue(state["owner_approved"])
        self.assertEqual(state["proposer_agent"], "planner")
        self.assertEqual(state["challenger_agent"], "reviewer")
        self.assertTrue(os.path.isfile(os.path.join(self.test_dir, "docs", "okr", "WEEK_PLAN_LOCK.json")))

    def test_challenger_must_differ_from_proposer(self):
        weekly_governance.start_week(self.test_dir)
        weekly_governance.record_proposal(self.test_dir, "planner", "Plan A")
        with self.assertRaises(ValueError):
            weekly_governance.record_challenge(self.test_dir, "planner", "self challenge")

    def test_log_execution_event_updates_counters(self):
        weekly_governance.start_week(self.test_dir)
        weekly_governance.record_proposal(self.test_dir, "planner", "Plan A")
        weekly_governance.record_challenge(self.test_dir, "reviewer", "counter")
        weekly_governance.owner_decision(self.test_dir, "approve")

        state = weekly_governance.log_execution_event(
            self.test_dir, "task_started", summary="start migration", agent="implementer", task="MIG-1"
        )
        self.assertEqual(state["stage"], "EXECUTING")
        self.assertEqual(state["execution"]["heartbeat_count"], 1)

        state = weekly_governance.log_execution_event(
            self.test_dir, "task_completed", summary="done", agent="implementer", task="MIG-1"
        )
        self.assertEqual(state["execution"]["completed_events"], 1)

    def test_interrupt_and_recover(self):
        weekly_governance.start_week(self.test_dir)
        weekly_governance.record_proposal(self.test_dir, "planner", "Plan A")
        weekly_governance.record_challenge(self.test_dir, "reviewer", "counter")
        weekly_governance.owner_decision(self.test_dir, "approve")
        weekly_governance.log_execution_event(self.test_dir, "task_started", summary="start")

        state = weekly_governance.mark_interrupted(self.test_dir, "daemon stopped")
        self.assertEqual(state["stage"], "INTERRUPTED")
        self.assertTrue(state["interruption"]["active"])

        state = weekly_governance.recover_execution(self.test_dir, note="resume after restart")
        self.assertEqual(state["stage"], "EXECUTING")
        self.assertFalse(state["interruption"]["active"])

    def test_events_file_written(self):
        weekly_governance.start_week(self.test_dir)
        weekly_governance.record_proposal(self.test_dir, "planner", "Plan A")
        path = os.path.join(self.test_dir, "docs", "okr", "WEEK_EVENTS.jsonl")
        self.assertTrue(os.path.isfile(path))
        with open(path, "r", encoding="utf-8") as f:
            lines = [line.strip() for line in f if line.strip()]
        self.assertGreaterEqual(len(lines), 2)
        row = json.loads(lines[-1])
        self.assertIn("type", row)


if __name__ == "__main__":
    unittest.main()
