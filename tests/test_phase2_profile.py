#!/usr/bin/env python3
"""
Phase 2.2 测试：验证 profile.py 模块提取的正确性

TDD Step 1: 编写测试确保 PROFILE 解析功能正确
"""
import unittest
import sys
import os
import json
import tempfile
import shutil

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

class TestProfileModule(unittest.TestCase):
    """测试 profile.py 模块的 PROFILE 解析功能"""
    
    def setUp(self):
        self.test_dir = tempfile.mkdtemp()
        self.docs_dir = os.path.join(self.test_dir, "docs")
        os.makedirs(self.docs_dir)
    
    def tearDown(self):
        shutil.rmtree(self.test_dir)
    
    def test_load_profile_with_defaults(self):
        """测试 load_profile 能正确归一化缺失字段"""
        # 创建最小 PROFILE
        profile_path = os.path.join(self.docs_dir, "PROFILE.json")
        with open(profile_path, "w", encoding="utf-8") as f:
            json.dump({"audit_level": "high"}, f)
        
        # 导入并测试
        from hooks import hook_runner
        profile, path = hook_runner.load_profile(self.test_dir)
        
        self.assertIsNotNone(profile)
        self.assertEqual(profile["audit_level"], "high")
        # 应该有默认值
        self.assertIn("risk_paths", profile)
        self.assertIn("evolution_mode", profile)
        self.assertEqual(profile["evolution_mode"], "realtime")
    
    def test_load_profile_normalizes_invalid_audit_level(self):
        """测试 load_profile 能纠正非法 audit_level"""
        profile_path = os.path.join(self.docs_dir, "PROFILE.json")
        with open(profile_path, "w", encoding="utf-8") as f:
            json.dump({"audit_level": "invalid_level"}, f)
        
        from hooks import hook_runner
        profile, _ = hook_runner.load_profile(self.test_dir)
        
        # 应该被纠正为 medium
        self.assertEqual(profile["audit_level"], "medium")
    
    def test_load_decision_policy_with_defaults(self):
        """测试 load_decision_policy 默认值"""
        from hooks import hook_runner
        
        policy, path = hook_runner.load_decision_policy(self.test_dir)
        
        # 应该返回默认策略
        self.assertIsNotNone(policy)
        self.assertTrue(policy["enabled"])
        self.assertIn("autonomy", policy)
    
    def test_normalize_decision_policy(self):
        """测试 _normalize_decision_policy 能合并用户配置"""
        from hooks import hook_runner
        
        # 部分配置
        partial = {"enabled": False}
        
        normalized, warnings = hook_runner._normalize_decision_policy(partial)
        
        self.assertFalse(normalized["enabled"])
        # 其他字段应该有默认值
        self.assertIn("autonomy", normalized)

if __name__ == '__main__':
    unittest.main()
