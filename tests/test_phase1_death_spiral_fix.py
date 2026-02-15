#!/usr/bin/env python3
"""
Phase 1.2 测试：验证 Death Spiral 检测的关键词边界匹配修复

TDD Step 1: 编写测试用例，确认 Bug 存在（误判）
"""
import unittest
import sys
import os
import json
import tempfile
import shutil
import subprocess

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
from hooks import hook_runner

class TestDeathSpiralRegexFix(unittest.TestCase):
    """测试 Death Spiral 检测的词边界匹配"""
    
    def setUp(self):
        self.test_dir = tempfile.mkdtemp()
        self.docs_dir = os.path.join(self.test_dir, "docs")
        os.makedirs(self.docs_dir)
        
        # 初始化 git repo
        subprocess.run(["git", "init"], cwd=self.test_dir, capture_output=True)
        subprocess.run(["git", "config", "user.email", "test@test.com"], cwd=self.test_dir, capture_output=True)
        subprocess.run(["git", "config", "user.name", "Test"], cwd=self.test_dir, capture_output=True)
        
        # 创建 dummy 文件并提交
        dummy = os.path.join(self.test_dir, "dummy.txt")
        with open(dummy, "w") as f:
            f.write("init")
        subprocess.run(["git", "add", "."], cwd=self.test_dir, capture_output=True)
        subprocess.run(["git", "commit", "-m", "initial commit"], cwd=self.test_dir, capture_output=True)
        
        # 创建 PROFILE
        profile = {
            "risk_paths": [],
            "evolution_mode": "realtime",
            "tests": {"on_change": "smoke", "commands": {}},
            "pain": {"soft_capture_threshold": 10}  # 低阈值以捕获 spiral (40分)
        }
        with open(os.path.join(self.docs_dir, "PROFILE.json"), "w", encoding="utf-8") as f:
            json.dump(profile, f)
    
    def tearDown(self):
        try:
            shutil.rmtree(self.test_dir)
        except:
            pass
    
    def create_commits(self, messages):
        """创建一系列 git commits"""
        for msg in messages:
            dummy = os.path.join(self.test_dir, "dummy.txt")
            with open(dummy, "a") as f:
                f.write(f"\n{msg}")
            subprocess.run(["git", "add", "."], cwd=self.test_dir, capture_output=True, check=True)
            subprocess.run(["git", "commit", "-m", msg], cwd=self.test_dir, capture_output=True, check=True)
    
    def test_false_positives_should_not_trigger_spiral(self):
        """
        测试场景：包含 fix 子串但不是真正 fix 的词汇（如 prefix/suffix）
        使用简单 count() 会误判，但使用词边界正则不会
        """
        self.create_commits([
            "Add prefix validation logic",         # 包含 "fix" 子串
            "Implement suffix for API response",    # 包含 "fix" 子串  
            "Affix timestamp to logs",              # 包含 "fix" 子串
        ])
        
        old_run_command = hook_runner._run_command
        hook_runner._run_command = lambda cmd: 0
        
        try:
            payload = {
                "tool_name": "Edit",
                "tool_input": {"file_path": "src/safe.ts"}
            }
            
            rc = hook_runner.post_write_checks(payload, self.test_dir)
            self.assertEqual(rc, 0)
            
            # 当前的 count() 会把 "prefix" 中的 "fix" 计数，导致 3个"fix" -> 触发 spiral
            # 修复后使用 \bfix\b，这些不应该触发
            pain_flag = os.path.join(self.docs_dir, ".pain_flag")
            
            if os.path.isfile(pain_flag):
                with open(pain_flag, "r", encoding="utf-8") as f:
                    content = f.read()
                # 如果有 pain_flag，不应该是 death_spiral 原因
                self.assertNotIn("death_spiral", content.lower(),
                                "False positive: 'prefix'/'suffix'/'affix' should not trigger spiral")
            
        finally:
            hook_runner._run_command = old_run_command
    
    def test_real_fix_pattern_should_trigger_spiral(self):
        """
        测试场景：真正的重复 fix 应该触发 Death Spiral
        """
        self.create_commits([
            "fix: broken auth logic",
            "fix: typo in auth",
            "repair auth validation",
        ])
        
        old_run_command = hook_runner._run_command
        hook_runner._run_command = lambda cmd: 0
        
        try:
            payload = {
                "tool_name": "Edit",
                "tool_input": {"file_path": "src/safe.ts"}
            }
            
            rc = hook_runner.post_write_checks(payload, self.test_dir)
            self.assertEqual(rc, 0)
            
            # 应该有 pain_flag（Death Spiral 被检测）
            pain_flag = os.path.join(self.docs_dir, ".pain_flag")
            self.assertTrue(os.path.isfile(pain_flag))
            
            with open(pain_flag, "r", encoding="utf-8") as f:
                content = f.read()
            
            self.assertIn("death_spiral", content.lower())
            
        finally:
            hook_runner._run_command = old_run_command

if __name__ == '__main__':
    unittest.main()
