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

    def create_decision_policy(self, content):
        with open(os.path.join(self.docs_dir, "DECISION_POLICY.json"), "w", encoding="utf-8") as f:
            json.dump(content, f, ensure_ascii=False, indent=2)

    def create_user_profile(self, content):
        with open(os.path.join(self.docs_dir, "USER_PROFILE.json"), "w", encoding="utf-8") as f:
            json.dump(content, f, ensure_ascii=False, indent=2)

    def write_week_state(self, content):
        okr_dir = os.path.join(self.docs_dir, "okr")
        os.makedirs(okr_dir, exist_ok=True)
        with open(os.path.join(okr_dir, "WEEK_STATE.json"), "w", encoding="utf-8") as f:
            json.dump(content, f, ensure_ascii=False, indent=2)

    def append_week_event(self, event):
        okr_dir = os.path.join(self.docs_dir, "okr")
        os.makedirs(okr_dir, exist_ok=True)
        path = os.path.join(okr_dir, "WEEK_EVENTS.jsonl")
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(event, ensure_ascii=False) + "\n")

    def test_backward_compatibility_old_profile(self):
        """测试旧版 PROFILE.json (无 custom_guards) 是否会导致崩溃"""
        profile = {
            "audit_level": "medium",
            "risk_paths": ["src/"],
            "gate": {"require_plan_for_risk_paths": False},
            "lifecycle": {"enabled": False}  # Explicitly disable for old profile compat test
        }
        self.create_profile(profile)
        
        payload = {
            "tool_name": "Edit",
            "tool_input": {"file_path": "src/test.ts"}
        }
        
        # Should allow (since plan check is off) and not crash
        rc = hook_runner.pre_write_gate(payload, self.test_dir)
        self.assertEqual(rc, 0)

    def test_load_profile_normalizes_invalid_fields(self):
        """测试 PROFILE 运行时归一化与默认值回填"""
        profile = {
            "audit_level": "critical",
            "risk_paths": "src/",
            "evolution_mode": "background",
            "gate": {"require_plan_for_risk_paths": "yes"},
            "tests": {
                "on_change": "quick",
                "commands": {"unit": 123, "full": "npm test"}
            },
            "pain": {
                "soft_capture_threshold": "high",
                "adaptive": {
                    "enabled": "yes",
                    "min_threshold": "low",
                    "max_threshold": 120,
                    "backlog_trigger": 0
                }
            },
            "custom_guards": [
                {"pattern": "Edit.*SECRET", "message": "No touch", "severity": "fatal"},
                {"pattern": "", "message": "invalid"},
                "broken"
            ]
        }
        self.create_profile(profile)

        normalized, _ = hook_runner.load_profile(self.test_dir)
        self.assertEqual(normalized["audit_level"], "medium")
        self.assertEqual(normalized["risk_paths"], ["src/"])
        self.assertEqual(normalized["evolution_mode"], "realtime")
        if isinstance(normalized.get("gate"), dict) and isinstance(normalized["gate"].get("require_plan_for_risk_paths"), bool):
            # 默认是 True (安全优先)
            self.assertTrue(normalized["gate"]["require_plan_for_risk_paths"])
        else:
            self.fail("Gate normalization failed structure check")
        self.assertEqual(normalized["tests"]["on_change"], "smoke")
        self.assertEqual(normalized["tests"]["commands"], {"full": "npm test"})
        self.assertEqual(normalized["pain"]["soft_capture_threshold"], 30)
        self.assertTrue(normalized["pain"]["adaptive"]["enabled"])
        self.assertEqual(normalized["pain"]["adaptive"]["min_threshold"], 15)
        self.assertEqual(normalized["pain"]["adaptive"]["max_threshold"], 100)
        self.assertEqual(normalized["pain"]["adaptive"]["backlog_trigger"], 1)
        self.assertEqual(len(normalized["custom_guards"]), 1)
        self.assertEqual(normalized["custom_guards"][0]["severity"], "fatal")
        self.assertFalse(normalized["_profile_invalid"])

    def test_pre_write_gate_blocks_invalid_profile_json(self):
        """测试 PROFILE JSON 非法时门禁应阻断"""
        with open(os.path.join(self.docs_dir, "PROFILE.json"), "w", encoding="utf-8") as f:
            f.write("{ invalid json")

        payload = {
            "tool_name": "Edit",
            "tool_input": {"file_path": "src/risky.ts"}
        }
        rc = hook_runner.pre_write_gate(payload, self.test_dir)
        self.assertEqual(rc, 2)
        err = self.sys_stderr.getvalue()
        self.assertIn("Invalid PROFILE.json", err)
        self.assertIn("Blocked: docs/PROFILE.json is invalid", err)

    def test_pre_ask_user_gate_blocks_micro_decision_for_expert(self):
        """测试 AskUserQuestion 门禁：专家用户下微观决策应自动化执行，不应频繁打扰"""
        self.create_decision_policy({
            "enabled": True,
            "autonomy": {
                "block_micro_ask_user_question": True,
                "high_impact_score_threshold": 70,
                "medium_impact_score_threshold": 40
            },
            "user_profile": {
                "domain_low_threshold": 0,
                "ask_on_medium_for_low_expertise": True
            }
        })
        self.create_user_profile({
            "domains": {"frontend": 9},
            "preferences": {}
        })

        payload = {
            "tool_name": "AskUserQuestion",
            "tool_input": {
                "question": "Should I rename this local variable to foo or bar?",
                "decision_context": {
                    "domain": "frontend",
                    "impact_level": "low",
                    "impact_score": 10,
                    "reversible": True
                }
            }
        }
        rc = hook_runner.pre_ask_user_gate(payload, self.test_dir)
        self.assertEqual(rc, 2)
        self.assertIn("decide autonomously", self.sys_stderr.getvalue().lower())

    def test_pre_ask_user_gate_allows_high_impact_question(self):
        """测试 AskUserQuestion 门禁：高影响决策可向用户请示"""
        self.create_decision_policy({
            "enabled": True,
            "autonomy": {
                "block_micro_ask_user_question": True,
                "high_impact_score_threshold": 70,
                "medium_impact_score_threshold": 40
            }
        })
        payload = {
            "tool_name": "AskUserQuestion",
            "tool_input": {
                "question": "Should we proceed with irreversible DB migration in production?",
                "decision_context": {
                    "impact_level": "high",
                    "impact_score": 95,
                    "reversible": False,
                    "requires_owner_decision": True
                }
            }
        }
        rc = hook_runner.pre_ask_user_gate(payload, self.test_dir)
        self.assertEqual(rc, 0)

    def test_pre_ask_user_gate_allows_medium_when_user_expertise_low(self):
        """测试 AskUserQuestion 门禁：中等影响在低熟练度领域可升级为请示"""
        self.create_decision_policy({
            "enabled": True,
            "autonomy": {
                "block_micro_ask_user_question": True,
                "high_impact_score_threshold": 70,
                "medium_impact_score_threshold": 40
            },
            "user_profile": {
                "domain_low_threshold": 0,
                "ask_on_medium_for_low_expertise": True
            }
        })
        self.create_user_profile({
            "domains": {"architecture": -2},
            "preferences": {}
        })
        payload = {
            "tool_name": "AskUserQuestion",
            "tool_input": {
                "question": "Should we split this service into two modules now?",
                "decision_context": {
                    "domain": "architecture",
                    "impact_level": "medium",
                    "impact_score": 50,
                    "reversible": True
                }
            }
        }
        rc = hook_runner.pre_ask_user_gate(payload, self.test_dir)
        self.assertEqual(rc, 0)

    def test_pre_write_gate_blocks_risky_write_without_week_lock(self):
        """测试生命周期门禁：未获 Owner 批准时禁止风险写入"""
        profile = {
            "risk_paths": ["src/"],
            "gate": {"require_plan_for_risk_paths": False},
            "lifecycle": {
                "enabled": True,
                "require_owner_approval_for_risk_writes": True,
                "require_challenge_before_approval": True
            }
        }
        self.create_profile(profile)
        self.write_week_state({
            "stage": "PENDING_OWNER_APPROVAL",
            "owner_approved": False,
            "proposer_agent": "planner",
            "challenger_agent": ""
        })
        payload = {
            "tool_name": "Edit",
            "tool_input": {"file_path": "src/risky.ts"}
        }
        rc = hook_runner.pre_write_gate(payload, self.test_dir)
        self.assertEqual(rc, 2)
        self.assertIn("weekly plan lock", self.sys_stderr.getvalue().lower())

    def test_pre_write_gate_allows_risky_write_when_week_locked(self):
        """测试生命周期门禁：已锁定周计划后允许风险写入"""
        profile = {
            "risk_paths": ["src/"],
            "gate": {"require_plan_for_risk_paths": False},
            "lifecycle": {
                "enabled": True,
                "require_owner_approval_for_risk_writes": True,
                "require_challenge_before_approval": True
            }
        }
        self.create_profile(profile)
        self.write_week_state({
            "stage": "LOCKED",
            "owner_approved": True,
            "proposer_agent": "planner",
            "challenger_agent": "reviewer",
            "lock": {"locked": True}
        })
        payload = {
            "tool_name": "Edit",
            "tool_input": {"file_path": "src/risky.ts"}
        }
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

    def test_post_write_checks_async_writes_pain_flag_and_queue(self):
        """测试 async 模式下：失败会写 pain_flag 且入队"""
        profile = {
            "audit_level": "medium",
            "risk_paths": ["src/"],
            "evolution_mode": "async",
            "gate": {"require_plan_for_risk_paths": False},
            "tests": {
                "on_change": "smoke",
                "on_risk_change": "unit",
                "commands": {"unit": "echo run-unit-tests"}
            }
        }
        self.create_profile(profile)

        queue_file = os.path.join(self.docs_dir, "EVOLUTION_QUEUE.json")
        old_queue_file = os.path.join(self.docs_dir, "EVOLUTION_QUEUE.json")
        old_run_command = hook_runner._run_command
        hook_runner.QUEUE_FILE = queue_file
        hook_runner._run_command = lambda cmd: 1

        try:
            payload = {
                "tool_name": "Edit",
                "tool_input": {"file_path": "src/risky.ts"}
            }
            rc = hook_runner.post_write_checks(payload, self.test_dir)
            self.assertEqual(rc, 0)

            pain_flag = os.path.join(self.docs_dir, ".pain_flag")
            self.assertTrue(os.path.isfile(pain_flag))
            with open(pain_flag, "r", encoding="utf-8") as f:
                content = f.read()
            self.assertIn("exit_code: 1", content)
            self.assertIn("issue_logged: false", content)

            self.assertTrue(os.path.isfile(queue_file))
            with open(queue_file, "r", encoding="utf-8") as f:
                queue = json.load(f)
            self.assertEqual(len(queue), 1)
            self.assertEqual(queue[0]["status"], "pending")
            self.assertEqual(queue[0]["type"], "test_failure")
        finally:
            hook_runner.QUEUE_FILE = old_queue_file
            hook_runner._run_command = old_run_command

    def test_post_write_checks_async_captures_soft_signal_when_score_above_threshold(self):
        """测试 async 模式下：软信号分数达阈值会记录 pain 并入队"""
        profile = {
            "audit_level": "medium",
            "risk_paths": ["src/"],
            "evolution_mode": "async",
            "gate": {"require_plan_for_risk_paths": False},
            "pain": {"soft_capture_threshold": 30},
            "tests": {
                "on_change": "smoke",
                "on_risk_change": "smoke",
                "commands": {"smoke": "echo smoke"}
            }
        }
        self.create_profile(profile)
        with open(os.path.join(self.docs_dir, "PLAN.md"), "w", encoding="utf-8") as f:
            f.write("STATUS: DRAFT\n")

        old_run_command = hook_runner._run_command
        hook_runner._run_command = lambda cmd: 0
        try:
            payload = {
                "tool_name": "Edit",
                "tool_input": {"file_path": "src/risky.ts"}
            }
            rc = hook_runner.post_write_checks(payload, self.test_dir)
            self.assertEqual(rc, 0)

            pain_flag = os.path.join(self.docs_dir, ".pain_flag")
            self.assertTrue(os.path.isfile(pain_flag))
            with open(pain_flag, "r", encoding="utf-8") as f:
                content = f.read()
            self.assertIn("reason: soft_signal:", content)
            self.assertIn("pain_score:", content)
            self.assertIn("soft_signals:", content)
            self.assertIn("soft_capture_threshold_effective:", content)

            queue_file = os.path.join(self.docs_dir, "EVOLUTION_QUEUE.json")
            self.assertTrue(os.path.isfile(queue_file))
            with open(queue_file, "r", encoding="utf-8") as f:
                queue = json.load(f)
            self.assertEqual(queue[0]["type"], "quality_signal")
            self.assertGreaterEqual(int(queue[0]["details"]["pain_score"]), 30)
        finally:
            hook_runner._run_command = old_run_command

    def test_post_write_checks_updates_week_heartbeat(self):
        """测试执行期写入会刷新周执行心跳与事件日志"""
        profile = {
            "risk_paths": ["src/"],
            "evolution_mode": "async",
            "gate": {"require_plan_for_risk_paths": False},
            "tests": {"on_change": "smoke", "commands": {"smoke": ""}},
            "lifecycle": {
                "enabled": True,
                "require_owner_approval_for_risk_writes": False
            }
        }
        self.create_profile(profile)
        self.write_week_state({
            "stage": "LOCKED",
            "owner_approved": True,
            "proposer_agent": "planner",
            "challenger_agent": "reviewer",
            "execution": {"heartbeat_count": 0}
        })
        rc = hook_runner.post_write_checks(
            {"tool_name": "Edit", "tool_input": {"file_path": "src/safe.ts"}},
            self.test_dir
        )
        self.assertEqual(rc, 0)
        state_path = os.path.join(self.docs_dir, "okr", "WEEK_STATE.json")
        with open(state_path, "r", encoding="utf-8") as f:
            state = json.load(f)
        self.assertEqual(state.get("stage"), "EXECUTING")
        self.assertGreaterEqual(int((state.get("execution") or {}).get("heartbeat_count", 0)), 1)
        events_path = os.path.join(self.docs_dir, "okr", "WEEK_EVENTS.jsonl")
        self.assertTrue(os.path.isfile(events_path))

    def test_effective_soft_threshold_adapts_to_queue_pressure(self):
        """测试队列压力下自适应阈值下调"""
        profile = {
            "pain": {
                "soft_capture_threshold": 50,
                "adaptive": {
                    "enabled": True,
                    "backlog_trigger": 2,
                    "hard_failure_trigger": 1,
                    "min_threshold": 10,
                    "max_threshold": 70
                }
            }
        }
        self.create_profile(profile)
        queue = [
            {"id": "q1", "type": "test_failure", "status": "pending", "details": {"file_path": "src/a.ts"}},
            {"id": "q2", "type": "quality_signal", "status": "retrying", "details": {"file_path": "src/b.ts"}},
        ]
        with open(os.path.join(self.docs_dir, "EVOLUTION_QUEUE.json"), "w", encoding="utf-8") as f:
            json.dump(queue, f, ensure_ascii=False, indent=2)

        normalized, _ = hook_runner.load_profile(self.test_dir)
        effective, diag = hook_runner._effective_soft_capture_threshold(normalized, self.test_dir)
        self.assertEqual(effective, 30)
        self.assertIn("backlog_pressure", diag["reasons"])
        self.assertIn("hard_failure_pressure", diag["reasons"])

    def test_effective_soft_threshold_relaxes_when_stable(self):
        """测试稳定期自适应阈值上调"""
        profile = {
            "pain": {
                "soft_capture_threshold": 30,
                "adaptive": {
                    "enabled": True,
                    "stable_quality_threshold": 5,
                    "min_threshold": 10,
                    "max_threshold": 70
                }
            }
        }
        self.create_profile(profile)
        queue = []
        for i in range(6):
            queue.append({"id": f"q{i}", "type": "quality_signal", "status": "completed"})
        with open(os.path.join(self.docs_dir, "EVOLUTION_QUEUE.json"), "w", encoding="utf-8") as f:
            json.dump(queue, f, ensure_ascii=False, indent=2)

        normalized, _ = hook_runner.load_profile(self.test_dir)
        effective, diag = hook_runner._effective_soft_capture_threshold(normalized, self.test_dir)
        self.assertEqual(effective, 38)
        self.assertIn("stable_completion_streak", diag["reasons"])

    def test_post_write_checks_uses_adaptive_threshold(self):
        """测试 post_write_checks 使用自适应阈值而非固定阈值"""
        profile = {
            "audit_level": "medium",
            "risk_paths": ["src/"],
            "evolution_mode": "async",
            "gate": {"require_plan_for_risk_paths": False},
            "pain": {
                "soft_capture_threshold": 50,
                "adaptive": {
                    "enabled": True,
                    "backlog_trigger": 2,
                    "hard_failure_trigger": 1,
                    "min_threshold": 10,
                    "max_threshold": 70
                }
            },
            "tests": {
                "on_change": "smoke",
                "on_risk_change": "smoke",
                "commands": {"smoke": "echo smoke"}
            }
        }
        self.create_profile(profile)
        with open(os.path.join(self.docs_dir, "PLAN.md"), "w", encoding="utf-8") as f:
            f.write("STATUS: DRAFT\n")
        queue = [
            {"id": "q1", "type": "test_failure", "status": "pending", "details": {"file_path": "src/risky.ts"}},
            {"id": "q2", "type": "quality_signal", "status": "retrying", "details": {"file_path": "src/other.ts"}},
        ]
        with open(os.path.join(self.docs_dir, "EVOLUTION_QUEUE.json"), "w", encoding="utf-8") as f:
            json.dump(queue, f, ensure_ascii=False, indent=2)

        old_run_command = hook_runner._run_command
        hook_runner._run_command = lambda cmd: 0
        try:
            rc = hook_runner.post_write_checks(
                {"tool_name": "Edit", "tool_input": {"file_path": "src/risky.ts"}},
                self.test_dir
            )
            self.assertEqual(rc, 0)
            pain_flag = os.path.join(self.docs_dir, ".pain_flag")
            self.assertTrue(os.path.isfile(pain_flag))
            with open(pain_flag, "r", encoding="utf-8") as f:
                content = f.read()
            self.assertIn("soft_capture_threshold_base: 50", content)
            self.assertIn("soft_capture_threshold_effective: 30", content)
        finally:
            hook_runner._run_command = old_run_command

    def test_post_write_checks_skips_soft_signal_below_threshold(self):
        """测试软信号分数未达阈值时不应写 pain_flag"""
        profile = {
            "audit_level": "medium",
            "risk_paths": ["src/"],
            "evolution_mode": "async",
            "gate": {"require_plan_for_risk_paths": False},
            "pain": {"soft_capture_threshold": 80},
            "tests": {
                "on_change": "smoke",
                "on_risk_change": "smoke",
                "commands": {"smoke": "echo smoke"}
            }
        }
        self.create_profile(profile)
        with open(os.path.join(self.docs_dir, "PLAN.md"), "w", encoding="utf-8") as f:
            f.write("STATUS: DRAFT\n")

        old_run_command = hook_runner._run_command
        hook_runner._run_command = lambda cmd: 0
        try:
            payload = {
                "tool_name": "Edit",
                "tool_input": {"file_path": "src/risky.ts"}
            }
            rc = hook_runner.post_write_checks(payload, self.test_dir)
            self.assertEqual(rc, 0)

            pain_flag = os.path.join(self.docs_dir, ".pain_flag")
            self.assertFalse(os.path.isfile(pain_flag))
            queue_file = os.path.join(self.docs_dir, "EVOLUTION_QUEUE.json")
            self.assertFalse(os.path.isfile(queue_file))
        finally:
            hook_runner._run_command = old_run_command

    def test_enqueue_evolution_task_deduplicates_open_task(self):
        """测试相同信号入队时去重并累计 occurrences"""
        details = {
            "tool": "Edit",
            "file_path": "src/risky.ts",
            "reason": "post_write_checks_failed",
            "command": "npm test",
            "exit_code": 1
        }
        task_id_1 = hook_runner.enqueue_evolution_task("test_failure", details, self.test_dir)
        task_id_2 = hook_runner.enqueue_evolution_task("test_failure", details, self.test_dir)

        self.assertEqual(task_id_1, task_id_2)
        queue_file = os.path.join(self.docs_dir, "EVOLUTION_QUEUE.json")
        with open(queue_file, "r", encoding="utf-8") as f:
            queue = json.load(f)
        self.assertEqual(len(queue), 1)
        self.assertEqual(queue[0]["occurrences"], 2)
        self.assertEqual(queue[0]["priority"], 90)
        self.assertIn("fingerprint", queue[0])
        self.assertIn("next_retry_at", queue[0])

    def test_enqueue_evolution_task_priority_escalates_on_duplicate(self):
        """测试重复信号可提升优先级"""
        base = {
            "tool": "Edit",
            "file_path": "src/risky.ts",
            "reason": "quality_signal",
            "command": "",
        }
        task_id_1 = hook_runner.enqueue_evolution_task("quality_signal", base, self.test_dir)
        escalated = dict(base)
        escalated["is_spiral"] = True
        task_id_2 = hook_runner.enqueue_evolution_task("quality_signal", escalated, self.test_dir)

        self.assertEqual(task_id_1, task_id_2)
        queue_file = os.path.join(self.docs_dir, "EVOLUTION_QUEUE.json")
        with open(queue_file, "r", encoding="utf-8") as f:
            queue = json.load(f)
        self.assertEqual(queue[0]["priority"], 100)
        self.assertEqual(queue[0]["occurrences"], 2)

    def test_stop_evolution_update_tolerates_non_utf8_pain_flag(self):
        """测试 Stop 钩子可容忍非 UTF-8 的 pain_flag"""
        pain_flag = os.path.join(self.docs_dir, ".pain_flag")
        with open(pain_flag, "wb") as f:
            f.write("time: 2026-02-08T12:00:00\nreason: test\n".encode("utf-16"))

        rc = hook_runner.stop_evolution_update({}, self.test_dir)
        self.assertEqual(rc, 0)
        self.assertFalse(os.path.isfile(pain_flag))

    def test_user_prompt_context_injects_additional_context(self):
        """测试 UserPromptSubmit 上下文注入"""
        os.makedirs(os.path.join(self.docs_dir, "okr"), exist_ok=True)
        with open(os.path.join(self.docs_dir, ".pain_flag"), "w", encoding="utf-8") as f:
            f.write("time: 2026-02-08T10:00:00\n")
            f.write("tool: Edit\n")
            f.write("file_path: src/risky.ts\n")
        with open(os.path.join(self.docs_dir, "PLAN.md"), "w", encoding="utf-8") as f:
            f.write("STATUS: DRAFT\n")
        with open(os.path.join(self.docs_dir, "okr", "CURRENT_FOCUS.md"), "w", encoding="utf-8") as f:
            f.write("## Active Objective (O)\n- [None] - Run `/init-strategy`\n")

        rc = hook_runner.user_prompt_context({}, self.test_dir)
        self.assertEqual(rc, 0)

        raw = self.sys_stdout.getvalue().strip()
        self.assertTrue(raw)
        payload = json.loads(raw)
        self.assertEqual(payload["hookSpecificOutput"]["hookEventName"], "UserPromptSubmit")
        context = payload["hookSpecificOutput"]["additionalContext"]
        self.assertIn("Unresolved pain signal", context)
        self.assertIn("STATUS: DRAFT", context)

    def test_user_prompt_context_keeps_anchors_when_stable(self):
        """测试无异常时也注入核心锚点，避免长期对话丢失原则"""
        rc = hook_runner.user_prompt_context({}, self.test_dir)
        self.assertEqual(rc, 0)

        raw = self.sys_stdout.getvalue().strip()
        self.assertTrue(raw)
        payload = json.loads(raw)
        context = payload["hookSpecificOutput"]["additionalContext"]
        self.assertIn("[System Anchors]", context)
        self.assertIn("Workflow order is mandatory", context)
        self.assertIn("State: stable", context)

    def test_user_prompt_context_includes_weekly_execution_recap(self):
        """测试上下文注入包含周执行状态与近况回顾"""
        self.write_week_state({
            "stage": "EXECUTING",
            "owner_approved": True,
            "proposer_agent": "planner",
            "challenger_agent": "reviewer",
            "execution": {
                "heartbeat_count": 4,
                "completed_events": 2,
                "blocked_events": 1,
                "last_heartbeat_at": "2026-02-08T12:00:00"
            }
        })
        self.append_week_event({
            "type": "task_completed",
            "summary": "finish parser migration",
            "timestamp": "2026-02-08T11:58:00"
        })
        rc = hook_runner.user_prompt_context({}, self.test_dir)
        self.assertEqual(rc, 0)
        raw = self.sys_stdout.getvalue().strip()
        payload = json.loads(raw)
        context = payload["hookSpecificOutput"]["additionalContext"]
        self.assertIn("Weekly lifecycle stage", context)
        self.assertIn("Completed this week: 2", context)
        self.assertIn("finish parser migration", context)

    def test_session_init_marks_week_interrupted_when_heartbeat_stale(self):
        """测试 SessionStart 能检测并标记执行中断"""
        profile = {
            "lifecycle": {
                "enabled": True,
                "heartbeat_timeout_minutes": 1
            }
        }
        self.create_profile(profile)
        self.write_week_state({
            "stage": "EXECUTING",
            "owner_approved": True,
            "execution": {
                "last_heartbeat": "2020-01-01T00:00:00",
                "heartbeat_count": 10
            }
        })
        rc = hook_runner.session_init({}, self.test_dir)
        self.assertEqual(rc, 0)
        state_path = os.path.join(self.docs_dir, "okr", "WEEK_STATE.json")
        with open(state_path, "r", encoding="utf-8") as f:
            state = json.load(f)
        self.assertEqual(state.get("stage"), "INTERRUPTED")
        self.assertTrue((state.get("interruption") or {}).get("active"))
        self.assertIn("WEEKLY EXECUTION INTERRUPTED", self.sys_stdout.getvalue())

    def test_subagent_complete_ignores_blank_agent_name(self):
        """测试空白 agent_name 不应污染 scorecard"""
        scorecard_path = os.path.join(self.docs_dir, "AGENT_SCORECARD.json")
        with open(scorecard_path, "w", encoding="utf-8") as f:
            json.dump({"agents": {"explorer": {"wins": 1, "losses": 0, "score": 1}}}, f)

        rc = hook_runner.subagent_complete({"agent_type": "   "}, self.test_dir)
        self.assertEqual(rc, 0)

        with open(scorecard_path, "r", encoding="utf-8") as f:
            scorecard = json.load(f)
        self.assertNotIn("   ", scorecard["agents"])

    def test_sync_agent_context_has_valid_markdown_name_format(self):
        """测试 agent 名称 markdown 格式正确"""
        scorecard_path = os.path.join(self.docs_dir, "AGENT_SCORECARD.json")
        with open(scorecard_path, "w", encoding="utf-8") as f:
            json.dump({"agents": {"explorer": {"wins": 2, "losses": 1, "score": 3}}}, f)

        rc = hook_runner.sync_agent_context({}, self.test_dir)
        self.assertEqual(rc, 0)

        context_path = os.path.join(self.docs_dir, "AGENT_CONTEXT.md")
        with open(context_path, "r", encoding="utf-8") as f:
            content = f.read()
        self.assertIn("**explorer**:", content)
        self.assertIn("Losses: 1)", content)

if __name__ == '__main__':
    unittest.main()
