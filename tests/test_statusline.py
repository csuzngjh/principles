#!/usr/bin/env python3
import unittest
import sys
import os
import json
import tempfile
import shutil
from io import StringIO

# Add parent directory to path to import hook_runner
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
from hooks import hook_runner

class TestStatusLine(unittest.TestCase):
    def setUp(self):
        # Create a temp directory for the project
        self.test_dir = tempfile.mkdtemp()
        self.docs_dir = os.path.join(self.test_dir, "docs")
        os.makedirs(self.docs_dir)
        os.makedirs(os.path.join(self.docs_dir, "okr"))
        
        # Redirect stdout to capture print output
        self.held_stdout = sys.stdout
        self.sys_stdout = StringIO()
        sys.stdout = self.sys_stdout

    def tearDown(self):
        shutil.rmtree(self.test_dir)
        sys.stdout = self.held_stdout

    def test_statusline_happy_path(self):
        # Setup files
        with open(os.path.join(self.docs_dir, "PLAN.md"), "w", encoding="utf-8") as f:
            f.write("STATUS: READY\nSteps...")
        with open(os.path.join(self.docs_dir, "AUDIT.md"), "w", encoding="utf-8") as f:
            f.write("RESULT: PASS\n...")
        with open(os.path.join(self.docs_dir, "okr", "CURRENT_FOCUS.md"), "w", encoding="utf-8") as f:
            f.write("- [ ] Fix All Bugs")
            
        payload = {
            "model": {"display_name": "Sonnet"},
            "context_window": {"used_percentage": 0.45}
        }
        
        hook_runner.statusline(payload, self.test_dir)
        output = self.sys_stdout.getvalue().strip()
        
        self.assertIn("[Sonnet 🟢45%]", output)
        self.assertIn("💾READY", output)
        self.assertIn("🛡️✅", output)
        self.assertIn("🎯Fix All Bugs", output)

    def test_statusline_missing_files(self):
        # Empty docs dir
        payload = {"model": {"display_name": "Haiku"}}
        
        hook_runner.statusline(payload, self.test_dir)
        output = self.sys_stdout.getvalue().strip()
        
        self.assertIn("[Haiku 🟢0%]", output)
        self.assertIn("💾NoPlan", output)
        self.assertNotIn("🛡️", output) # No audit file
        self.assertNotIn("🎯", output) # No OKR file

    def test_statusline_pain_flag(self):
        # Create pain flag
        with open(os.path.join(self.docs_dir, ".pain_flag"), "w") as f:
            f.write("ouch")
            
        hook_runner.statusline({}, self.test_dir)
        output = self.sys_stdout.getvalue().strip()
        
        self.assertIn("💊", output)

    def test_statusline_queue_metrics(self):
        queue = [
            {
                "id": "task-1",
                "status": "pending",
                "priority": 90,
                "timestamp": "2026-02-08T10:00:00",
            },
            {
                "id": "task-2",
                "status": "retrying",
                "priority": 80,
                "next_retry_at": "2020-01-01T00:00:00",
                "timestamp": "2026-02-08T10:05:00",
            },
        ]
        with open(os.path.join(self.docs_dir, "EVOLUTION_QUEUE.json"), "w", encoding="utf-8") as f:
            json.dump(queue, f, ensure_ascii=False, indent=2)

        hook_runner.statusline({}, self.test_dir)
        output = self.sys_stdout.getvalue().strip()

        self.assertIn("Pending:1", output)
        self.assertIn("Retry:1(due)", output)

    def test_statusline_queue_metrics_absent_when_no_open_tasks(self):
        queue = [
            {
                "id": "task-1",
                "status": "completed",
                "priority": 90,
                "timestamp": "2026-02-08T10:00:00",
            }
        ]
        with open(os.path.join(self.docs_dir, "EVOLUTION_QUEUE.json"), "w", encoding="utf-8") as f:
            json.dump(queue, f, ensure_ascii=False, indent=2)

        hook_runner.statusline({}, self.test_dir)
        output = self.sys_stdout.getvalue().strip()

        self.assertNotIn("🚦", output)

if __name__ == '__main__':
    unittest.main()
