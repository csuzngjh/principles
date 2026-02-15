#!/usr/bin/env python3
"""
Phase 3.5 测试：验证反脆弱机制
测试队列健康监控、断路器、降级策略、反火鸡阈值
"""
import unittest
import sys
import os
import json
import tempfile
import shutil
import datetime as _dt

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

class TestAntifragility(unittest.TestCase):
    """测试 Phase 3 反脆弱机制"""
    
    def setUp(self):
        self.test_dir = tempfile.mkdtemp()
        self.docs_dir = os.path.join(self.test_dir, "docs")
        os.makedirs(self.docs_dir)
    
    def tearDown(self):
        shutil.rmtree(self.test_dir)
    
    def test_queue_health_assessment(self):
        """测试队列健康度评估"""
        from hooks.queue_health import assess_queue_health
        
        # 创建空队列
        queue_file = os.path.join(self.docs_dir, "EVOLUTION_QUEUE.json")
        with open(queue_file, "w", encoding="utf-8") as f:
            json.dump([], f)
        
        health = assess_queue_health(self.test_dir)
        
        self.assertEqual(health["status"], "healthy")
        self.assertEqual(health["metrics"]["total_tasks"], 0)
    
    def test_circuit_breaker_lifecycle(self):
        """测试断路器生命周期"""
        from hooks.circuit_breaker import CircuitBreaker
        
        breaker = CircuitBreaker(self.test_dir, "test_op", failure_threshold=3, timeout_seconds=5)
        
        # 初始状态：CLOSED
        self.assertFalse(breaker.is_open())
        
        # 连续失败
        breaker.record_failure()
        breaker.record_failure()
        self.assertFalse(breaker.is_open())  # 未达阈值
        
        breaker.record_failure()
        self.assertTrue(breaker.is_open())  # 达到阈值，熔断
        
        # 成功恢复无效（仍在 OPEN）
        breaker.record_success()
        self.assertTrue(breaker.is_open())
    
    def test_degradation_decision(self):
        """测试降级决策逻辑"""
        from hooks import degradation
        
        # 模拟健康队列
        queue_file = os.path.join(self.docs_dir, "EVOLUTION_QUEUE.json")
        with open(queue_file, "w", encoding="utf-8") as f:
            json.dump([], f)
        
        should_deg, signals = degradation.should_degrade(self.test_dir)
        
        # 健康系统不应降级
        self.assertFalse(should_deg)
        self.assertEqual(len(signals), 0)
    
    def test_anti_turkey_threshold(self):
        """测试反火鸡阈值策略（收紧快、放松慢）"""
        from hooks.pain import _effective_soft_capture_threshold
        
        profile = {
            "pain": {
                "soft_capture_threshold": 30,
                "adaptive": {
                    "enabled": True
                }
            }
        }
        
        threshold, diag = _effective_soft_capture_threshold(profile, self.test_dir)
        
        self.assertIsNotNone(threshold)
        self.assertTrue(diag["adaptive_enabled"])
        self.assertGreaterEqual(threshold, 10)
        self.assertLessEqual(threshold, 60)  # 150% 上限

if __name__ == '__main__':
    unittest.main()
