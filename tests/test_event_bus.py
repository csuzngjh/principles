#!/usr/bin/env python3
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

# 定位 hook_runner.py
PROJECT_ROOT = Path(__file__).parent.parent.resolve()
HOOK_RUNNER = PROJECT_ROOT / "hooks" / "hook_runner.py"

class TestEventBus(unittest.TestCase):
    def setUp(self):
        self.test_dir = tempfile.mkdtemp()
        self.docs_dir = os.path.join(self.test_dir, "docs")
        os.makedirs(self.docs_dir)
        self.workboard_path = os.path.join(self.docs_dir, "WORKBOARD.json")
        
        # 环境变量
        self.env = os.environ.copy()
        self.env["CLAUDE_PROJECT_DIR"] = self.test_dir

    def tearDown(self):
        shutil.rmtree(self.test_dir)

    def run_hook(self, hook_name, payload):
        cmd = [sys.executable, str(HOOK_RUNNER), "--hook", hook_name]
        env = self.env.copy()
        env["CLAUDE_HOOK_TYPE"] = "PostToolUse"
        proc = subprocess.run(
            cmd,
            input=json.dumps(payload),
            capture_output=True,
            text=True,
            env=env,
            encoding='utf-8'
        )
        return proc

    def test_emit_signal_writes_to_workboard(self):
        """测试 emit_signal 能否写入 WORKBOARD.json (包含第三方 Agent)"""
        # 模拟一个来自外部下载的 Agent：SuperHacker
        payload = {
            "agent_type": "SuperHacker",
            "tool_name": "Edit",
            "tool_input": {"file_path": "virus.py"}
        }
        
        # 运行 Hook
        proc = self.run_hook("emit_signal", payload)
        if proc.returncode != 0:
            print(f"Hook failed (rc={proc.returncode}). Stderr:\n{proc.stderr}", file=sys.stderr)
        
        # 验证文件是否生成
        self.assertTrue(os.path.isfile(self.workboard_path), "WORKBOARD.json should be created")
        
        with open(self.workboard_path, "r", encoding="utf-8") as f:
            data = json.load(f)
            
        events = data.get("events", [])
        last_event = events[-1]
        
        # 即使没定义过 SuperHacker，总线也应该记录它
        self.assertEqual(last_event.get("source"), "SuperHacker")
        self.assertEqual(last_event.get("type"), "modification")

    def test_workboard_truncation(self):
        """测试 WORKBOARD 是否会自动截断旧消息"""
        # 预先填充 205 条消息
        initial_data = {"events": [{"id": i} for i in range(205)]}
        with open(self.workboard_path, "w", encoding="utf-8") as f:
            json.dump(initial_data, f)
            
        # 发射一条新消息
        payload = {"tool_name": "Read"}
        self.run_hook("emit_signal", payload)
        
        with open(self.workboard_path, "r", encoding="utf-8") as f:
            data = json.load(f)
            
        # 验证是否截断
        self.assertLessEqual(len(data["events"]), 201)
        # 确保新消息在最后
        self.assertEqual(data["events"][-1]["event"], "signal")

if __name__ == "__main__":
    unittest.main()
