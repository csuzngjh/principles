#!/usr/bin/env python3
"""
Phase 1.1 测试：验证 task_type 未定义 Bug 的修复

TDD Step 1: 编写测试用例，确认 Bug 存在
"""
import unittest
import sys
import os
import json
import tempfile
import shutil

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
from hooks import hook_runner

class TestTaskTypeDefinitionBug(unittest.TestCase):
    """测试 post_write_checks 中 task_type 变量定义问题"""
    
    def setUp(self):
        self.test_dir = tempfile.mkdtemp()
        self.docs_dir = os.path.join(self.test_dir, "docs")
        os.makedirs(self.docs_dir)
        
        # 创建最小化 PROFILE
        profile = {
            "risk_paths": ["src/"],
            "evolution_mode": "async",
            "tests": {
                "on_change": "smoke",
                "on_risk_change": "unit",
                "commands": {"unit": "echo test"}
            },
            "pain": {"soft_capture_threshold": 15}  # 降低阈值以捕获 PLAN DRAFT (20分)
        }
        with open(os.path.join(self.docs_dir, "PROFILE.json"), "w", encoding="utf-8") as f:
            json.dump(profile, f)
    
    def tearDown(self):
        shutil.rmtree(self.test_dir)
    
    def test_task_type_should_be_defined_before_use(self):
        """
        测试场景：soft signal 被捕获时，task_type 应该在
        _compute_task_priority 调用之前就已经定义
        """
        # 模拟测试失败场景
        old_run_command = hook_runner._run_command
        hook_runner._run_command = lambda cmd: 1  # 测试失败
        
        try:
            payload = {
                "tool_name": "Edit",
                "tool_input": {"file_path": "src/risky.ts"}
            }
            
            # 这个调用不应该抛出 NameError
            rc = hook_runner.post_write_checks(payload, self.test_dir)
            
            # 应该成功返回（即使有痛苦信号）
            self.assertEqual(rc, 0)
            
            # 验证 pain_flag 被正确写入且包含 task_type 相关信息
            pain_flag = os.path.join(self.docs_dir, ".pain_flag")
            self.assertTrue(os.path.isfile(pain_flag))
            
            # 验证进化队列包含正确的 task_type
            queue_file = os.path.join(self.docs_dir, "EVOLUTION_QUEUE.json")
            self.assertTrue(os.path.isfile(queue_file))
            
            with open(queue_file, "r", encoding="utf-8") as f:
                queue = json.load(f)
            
            self.assertEqual(len(queue), 1)
            # rc=1 应该是 test_failure
            self.assertEqual(queue[0]["type"], "test_failure")
            
        finally:
            hook_runner._run_command = old_run_command
    
    def test_task_type_quality_signal_for_soft_pain(self):
        """
        测试场景：仅有 soft signal（无测试失败）时，
        task_type 应该是 quality_signal
        """
        # 模拟测试通过但有软信号
        old_run_command = hook_runner._run_command
        hook_runner._run_command = lambda cmd: 0  # 测试成功
        
        # 创建 PLAN.md 处于 DRAFT 状态（触发软信号）
        with open(os.path.join(self.docs_dir, "PLAN.md"), "w", encoding="utf-8") as f:
            f.write("STATUS: DRAFT\n")
        
        try:
            payload = {
                "tool_name": "Edit",
                "tool_input": {"file_path": "src/risky.ts"}
            }
            
            rc = hook_runner.post_write_checks(payload, self.test_dir)
            self.assertEqual(rc, 0)
            
            queue_file = os.path.join(self.docs_dir, "EVOLUTION_QUEUE.json")
            self.assertTrue(os.path.isfile(queue_file))
            
            with open(queue_file, "r", encoding="utf-8") as f:
                queue = json.load(f)
            
            # rc=0 应该是 quality_signal
            self.assertEqual(queue[0]["type"], "quality_signal")
            
        finally:
            hook_runner._run_command = old_run_command

if __name__ == '__main__':
    unittest.main()
