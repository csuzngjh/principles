#!/usr/bin/env python3
"""
集成测试：验证 Python 版 Hooks 在 Windows/Linux 下的统一行为
"""
import json
import os
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

# 定位项目根目录
PROJECT_ROOT = Path(__file__).parent.parent.resolve()
HOOK_RUNNER = PROJECT_ROOT / "hooks" / "hook_runner.py"
if not HOOK_RUNNER.exists():
    HOOK_RUNNER = PROJECT_ROOT / ".claude" / "hooks" / "hook_runner.py"
DOCS_DIR = PROJECT_ROOT / "docs"

class TestPythonHooks(unittest.TestCase):
    def setUp(self):
        # 确保 docs 目录存在
        DOCS_DIR.mkdir(exist_ok=True)
        # 备份关键文件
        self.backup_files = ["PLAN.md", "AUDIT.md", "PROFILE.json", "USER_PROFILE.json", "AGENT_SCORECARD.json"]
        for fname in self.backup_files:
            fpath = DOCS_DIR / fname
            if fpath.exists():
                shutil.copy(fpath, DOCS_DIR / (fname + ".bak"))
        # 备份运行态临时文件，避免测试污染工作区
        self.temp_files = [".pain_flag", ".verdict.json", ".user_verdict.json", ".pending_reflection"]
        for temp in self.temp_files:
            tpath = DOCS_DIR / temp
            if tpath.exists():
                shutil.copy(tpath, DOCS_DIR / (temp + ".bak"))

    def tearDown(self):
        # 恢复备份
        for fname in self.backup_files:
            bak_path = DOCS_DIR / (fname + ".bak")
            orig_path = DOCS_DIR / fname
            if bak_path.exists():
                shutil.move(bak_path, orig_path)
            elif orig_path.exists():
                # 如果原本没有文件但测试创建了，则删除
                # 注意：这里假设原本没有文件的情况较少，且不影响大局
                pass
        
        # 清理临时文件
        for temp in self.temp_files:
            bak_path = DOCS_DIR / (temp + ".bak")
            orig_path = DOCS_DIR / temp
            if bak_path.exists():
                shutil.move(bak_path, orig_path)
            else:
                orig_path.unlink(missing_ok=True)

    def run_hook(self, hook_name, payload):
        """运行 Hook 并返回 (returncode, stderr)"""
        # 设置环境变量，模拟真实运行环境
        env = os.environ.copy()
        env["CLAUDE_PROJECT_DIR"] = str(PROJECT_ROOT)
        
        # 使用 python3 运行 (或 python)
        python_cmd = sys.executable
        
        process = subprocess.Popen(
            [python_cmd, str(HOOK_RUNNER), "--hook", hook_name],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, # 捕获 stdout 避免干扰测试输出
            stderr=subprocess.PIPE,
            env=env,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        
        stdout, stderr = process.communicate(input=json.dumps(payload))
        return process.returncode, stderr

    def test_pre_write_gate_block(self):
        """测试门禁：未授权文件应被拦截"""
        # Setup: PLAN 存在但没包含目标文件
        with open(DOCS_DIR / "PLAN.md", "w", encoding="utf-8") as f:
            f.write("STATUS: READY\n## Target Files\n- src/safe.ts")
        
        with open(DOCS_DIR / "PROFILE.json", "w", encoding="utf-8") as f:
            json.dump({"gate": {"require_plan_for_risk_paths": True}, "risk_paths": ["src/"]}, f)

        payload = {
            "tool_name": "Write",
            "tool_input": {"file_path": str(PROJECT_ROOT / "src/risky.ts")}
        }
        
        rc, stderr = self.run_hook("pre_write_gate", payload)
        if rc != 2:
            print(f"\n[DEBUG] test_pre_write_gate_block stderr:\n{stderr}")
        self.assertEqual(rc, 2, "Should block unauthorized risk path")
        self.assertIn("NOT declared", stderr)

    def test_pre_write_gate_allow(self):
        """测试门禁：授权文件应放行"""
        with open(DOCS_DIR / "PLAN.md", "w", encoding="utf-8") as f:
            f.write("STATUS: READY\n## Target Files\n- src/risky.ts")
        
        # Profile 同上
        with open(DOCS_DIR / "PROFILE.json", "w", encoding="utf-8") as f:
            json.dump({"gate": {"require_plan_for_risk_paths": True}, "risk_paths": ["src/"]}, f)

        payload = {
            "tool_name": "Write",
            "tool_input": {"file_path": str(PROJECT_ROOT / "src/risky.ts")}
        }
        
        rc, stderr = self.run_hook("pre_write_gate", payload)
        if rc != 0:
            print(f"\n[DEBUG] test_pre_write_gate_allow stderr:\n{stderr}")
        self.assertEqual(rc, 0, "Should allow authorized risk path")

    def test_user_profile_update(self):
        """测试用户画像更新：增量合并"""
        # Setup: 初始 Profile
        with open(DOCS_DIR / "USER_PROFILE.json", "w", encoding="utf-8") as f:
            json.dump({"domains": {"frontend": 5}, "preferences": {}}, f)
        
        # Setup: 模拟 Verdict
        with open(DOCS_DIR / ".user_verdict.json", "w", encoding="utf-8") as f:
            json.dump({
                "updates": [{"domain": "frontend", "delta": 2}],
                "preferences": {"lang": "en"}
            }, f)

        # Run Stop hook
        rc, stderr = self.run_hook("stop_evolution_update", {})
        if rc != 0:
            print(f"\n[DEBUG] test_user_profile_update stderr:\n{stderr}")
        self.assertEqual(rc, 0)

        # Verify
        with open(DOCS_DIR / "USER_PROFILE.json", "r", encoding="utf-8") as f:
            data = json.load(f)
        self.assertEqual(data["domains"]["frontend"], 7, "Score should accumulate (5+2=7)")
        self.assertEqual(data["preferences"]["lang"], "en", "Preference should merge")

    def test_reflection_trigger(self):
        """测试反思触发：DRAFT 状态应报警"""
        with open(DOCS_DIR / "PLAN.md", "w", encoding="utf-8") as f:
            f.write("STATUS: DRAFT\nSteps...")
        
        # Run PreCompact
        rc, stderr = self.run_hook("precompact_checkpoint", {})
        if rc != 0:
            print(f"\n[DEBUG] test_reflection_trigger stderr:\n{stderr}")
        self.assertEqual(rc, 0)
        
        # Verify file creation
        self.assertTrue((DOCS_DIR / ".pending_reflection").exists(), "Should create pending reflection marker")

if __name__ == "__main__":
    print(f"Running tests in: {PROJECT_ROOT}")
    unittest.main(verbosity=2)
