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

class TestHookRunnerAdvanced(unittest.TestCase):
    def setUp(self):
        self.test_dir = tempfile.mkdtemp()
        self.docs_dir = os.path.join(self.test_dir, "docs")
        os.makedirs(self.docs_dir)
        
        # Redirect stderr/stdout
        self.held_stderr = sys.stderr
        self.held_stdout = sys.stdout
        self.sys_stderr = StringIO()
        self.sys_stdout = StringIO()
        sys.stderr = self.sys_stderr
        sys.stdout = self.sys_stdout

    def tearDown(self):
        shutil.rmtree(self.test_dir)
        sys.stderr = self.held_stderr
        sys.stdout = self.held_stdout

    def create_profile(self, content):
        with open(os.path.join(self.docs_dir, "PROFILE.json"), "w", encoding="utf-8") as f:
            json.dump(content, f)

    def test_backward_compatibility_old_profile(self):
        """测试旧版 PROFILE.json (无 custom_guards) 是否会导致崩溃"""
        profile = {
            "audit_level": "medium",
            "risk_paths": ["src/"],
            "gate": {"require_plan_for_risk_paths": False}
        }
        self.create_profile(profile)
        
        payload = {
            "tool_name": "Edit",
            "tool_input": {"file_path": "src/test.ts"}
        }
        
        # Should allow (since plan check is off) and not crash
        rc = hook_runner.pre_write_gate(payload, self.test_dir)
        self.assertEqual(rc, 0)

    def test_custom_guards_block(self):
        """测试自定义正则拦截"""
        profile = {
            "risk_paths": [],
            "gate": {},
            "custom_guards": [
                {
                    "pattern": "Edit.*SECRET",
                    "message": "Do not touch secrets!"
                }
            ]
        }
        self.create_profile(profile)
        
        # 1. Should Block
        payload = {
            "tool_name": "Edit",
            "tool_input": {"file_path": "config/SECRET_KEY"}
        }
        rc = hook_runner.pre_write_gate(payload, self.test_dir)
        self.assertEqual(rc, 2)
        self.assertIn("Do not touch secrets!", self.sys_stderr.getvalue())

    def test_custom_guards_warning(self):
        """测试自定义正则警告 (不拦截)"""
        profile = {
            "risk_paths": [],
            "gate": {},
            "custom_guards": [
                {
                    "pattern": "Edit.*deprecated",
                    "message": "This file is deprecated",
                    "severity": "warning"
                }
            ]
        }
        self.create_profile(profile)
        
        # Should Warn but Pass
        payload = {
            "tool_name": "Edit",
            "tool_input": {"file_path": "src/deprecated.ts"}
        }
        rc = hook_runner.pre_write_gate(payload, self.test_dir)
        self.assertEqual(rc, 0) # Exit code 0 means allow
        self.assertIn("⚠️ Warning by Evolutionary Guardrail", self.sys_stderr.getvalue())
        self.assertIn("This file is deprecated", self.sys_stderr.getvalue())

    def test_custom_guards_pass(self):
        """测试自定义正则放行"""
        profile = {
            "risk_paths": [],
            "gate": {},
            "custom_guards": [
                {"pattern": "Edit.*SECRET", "message": "No!"}
            ]
        }
        self.create_profile(profile)
        
        # 2. Should Pass
        payload = {
            "tool_name": "Edit",
            "tool_input": {"file_path": "config/public.txt"}
        }
        rc = hook_runner.pre_write_gate(payload, self.test_dir)
        self.assertEqual(rc, 0)

    def test_statusline_rendering(self):
        """测试状态栏的各种组合"""
        # Create OKR dir
        os.makedirs(os.path.join(self.docs_dir, "okr"))
        
        # Case 1: All files present
        with open(os.path.join(self.docs_dir, "PLAN.md"), "w") as f:
            f.write("STATUS: WIP")
        with open(os.path.join(self.docs_dir, "okr", "CURRENT_FOCUS.md"), "w") as f:
            f.write("- [ ] Fix Latency")
        with open(os.path.join(self.docs_dir, ".pain_flag"), "w") as f:
            f.write("error")
            
        hook_runner.statusline({"model": {"display_name": "TestModel"}}, self.test_dir)
        output = self.sys_stdout.getvalue()
        
        self.assertIn("[TestModel 🟢0%]", output)
        self.assertIn("💾WIP", output)
        self.assertIn("💊", output)
        self.assertIn("🎯Fix Latency", output)

    def test_missing_files_robustness(self):
        """测试文件缺失时的健壮性"""
        # No docs at all (except PROFILE which load_profile needs, but statusline tolerates its absence)
        # Actually statusline doesn't call load_profile, it reads files directly.
        # So we can test with empty dir.
        
        hook_runner.statusline({}, self.test_dir)
        output = self.sys_stdout.getvalue()
        
        self.assertIn("💾NoPlan", output)
        # Should not crash

if __name__ == '__main__':
    unittest.main()
