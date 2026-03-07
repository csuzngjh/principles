#!/usr/bin/env python3
import datetime as _dt
import os
import sys
import unittest

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from scripts import evolution_daemon as daemon


class TestEvolutionDaemonScheduling(unittest.TestCase):
    def test_select_runnable_tasks_respects_priority_and_next_retry_at(self):
        now = _dt.datetime(2026, 2, 8, 12, 0, 0)
        queue = [
            {"id": "low", "status": "pending", "priority": 10, "timestamp": "2026-02-08T11:00:00"},
            {"id": "high", "status": "pending", "priority": 90, "timestamp": "2026-02-08T11:05:00"},
            {
                "id": "due-retry",
                "status": "retrying",
                "priority": 80,
                "next_retry_at": "2026-02-08T11:59:00",
                "timestamp": "2026-02-08T10:00:00",
            },
            {
                "id": "not-due",
                "status": "retrying",
                "priority": 100,
                "next_retry_at": "2026-02-08T12:10:00",
                "timestamp": "2026-02-08T09:00:00",
            },
        ]

        runnable = daemon.select_runnable_tasks(queue, now=now)
        self.assertEqual([t["id"] for t in runnable], ["high", "due-retry", "low"])

    def test_mark_task_failed_sets_retrying_and_backoff(self):
        now = _dt.datetime(2026, 2, 8, 12, 0, 0)
        task = {
            "id": "t1",
            "status": "processing",
            "retry_count": 0,
            "retry_policy": {"base_seconds": 15, "max_seconds": 60, "max_attempts": 3},
        }

        daemon.mark_task_failed(task, now=now)

        self.assertEqual(task["status"], "retrying")
        self.assertEqual(task["retry_count"], 1)
        self.assertEqual(task["next_retry_at"], "2026-02-08T12:00:15")

    def test_mark_task_failed_marks_failed_when_max_attempts_reached(self):
        now = _dt.datetime(2026, 2, 8, 12, 0, 0)
        task = {
            "id": "t2",
            "status": "processing",
            "retry_count": 2,
            "retry_policy": {"base_seconds": 15, "max_seconds": 60, "max_attempts": 3},
        }

        daemon.mark_task_failed(task, now=now)

        self.assertEqual(task["status"], "failed")
        self.assertEqual(task["retry_count"], 3)
        self.assertNotIn("next_retry_at", task)

    def test_process_queue_once_executes_runnable_tasks_in_priority_order(self):
        now = _dt.datetime(2026, 2, 8, 12, 0, 0)
        queue = [
            {"id": "a", "status": "pending", "priority": 10, "timestamp": "2026-02-08T11:00:00", "retry_count": 0},
            {"id": "b", "status": "pending", "priority": 90, "timestamp": "2026-02-08T11:05:00", "retry_count": 0},
        ]
        processed = []

        def fake_process(task):
            processed.append(task["id"])
            return True

        changed = daemon.process_queue_once(queue, process_fn=fake_process, now=now)
        self.assertTrue(changed)
        self.assertEqual(processed, ["b", "a"])
        self.assertEqual(queue[0]["status"], "completed")
        self.assertEqual(queue[1]["status"], "completed")

    def test_compute_next_wake_seconds_uses_nearest_retry_due(self):
        now = _dt.datetime(2026, 2, 8, 12, 0, 0)
        queue = [
            {"id": "r1", "status": "retrying", "next_retry_at": "2026-02-08T12:00:12"},
            {"id": "r2", "status": "retrying", "next_retry_at": "2026-02-08T12:00:20"},
        ]
        wait = daemon.compute_next_wake_seconds(queue, now=now, idle_default=30)
        self.assertEqual(wait, 12)


if __name__ == "__main__":
    unittest.main()
