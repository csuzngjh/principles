#!/usr/bin/env python3
import os
import unittest


PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
KERNEL_PATH = os.path.join(PROJECT_ROOT, "templates", "rules", "00-kernel.md")
CLAUDE_MD_PATH = os.path.join(PROJECT_ROOT, "CLAUDE.md")


class TestKernelPromptContract(unittest.TestCase):
    def _read(self, path):
        with open(path, "r", encoding="utf-8") as handle:
            return handle.read()

    def test_kernel_includes_weekly_lifecycle_governance(self):
        content = self._read(KERNEL_PATH)
        required_tokens = [
            "WEEK_STATE.json",
            "WEEK_EVENTS.jsonl",
            "WEEK_PLAN_LOCK.json",
            "DECISION_POLICY.json",
            "scripts/weekly_governance.py",
            "AskUserQuestion",
            "PENDING_OWNER_APPROVAL",
            "INTERRUPTED",
        ]
        for token in required_tokens:
            self.assertIn(token, content)

    def test_claude_md_mentions_weekly_governance_entrypoints(self):
        content = self._read(CLAUDE_MD_PATH)
        required_tokens = [
            "WEEK_STATE.json",
            "DECISION_POLICY.json",
            "scripts/weekly_governance.py",
        ]
        for token in required_tokens:
            self.assertIn(token, content)


if __name__ == "__main__":
    unittest.main()
