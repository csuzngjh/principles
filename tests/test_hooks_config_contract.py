#!/usr/bin/env python3
import json
import os
import unittest


PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
HOOKS_CONFIG = os.path.join(PROJECT_ROOT, "hooks", "hooks.json")


class TestHooksConfigContract(unittest.TestCase):
    def test_pretooluse_includes_ask_user_gate(self):
        with open(HOOKS_CONFIG, "r", encoding="utf-8") as handle:
            data = json.load(handle)

        pre_tool_rules = data.get("PreToolUse") or []
        matchers = [str(rule.get("matcher") or "") for rule in pre_tool_rules]
        self.assertIn("AskUserQuestion", matchers)

        ask_rule = next(rule for rule in pre_tool_rules if str(rule.get("matcher")) == "AskUserQuestion")
        hooks = ask_rule.get("hooks") or []
        commands = [str(h.get("command") or "") for h in hooks]
        self.assertTrue(any("--hook pre_ask_user_gate" in cmd for cmd in commands))


if __name__ == "__main__":
    unittest.main()
