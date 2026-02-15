#!/usr/bin/env python3
import argparse
import copy
import datetime as _dt
import json
import logging
import os
import posixpath
import re
import shutil
import subprocess
import traceback
import sys
import uuid
from pathlib import PurePosixPath, PureWindowsPath

# Phase 2 Architecture: Import extracted modules
try:
    from hooks.io_utils import *
    from hooks.profile import *
    from hooks.pain import *
    from hooks.evolution_queue import *
    from hooks.week_lifecycle import *
    from hooks.telemetry import *
    from hooks.debug_utils import debug_log
except ImportError:
    # Fallback: functions are still defined in this file
    pass


# --- Encoding Fix for Windows ---
if sys.platform == "win32":
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')

# --- Telemetry & Logging Setup ---
# 设置日志文件路径
PROJECT_ROOT = os.getcwd()
LOG_FILE = os.path.join(PROJECT_ROOT, "docs", "SYSTEM.log")
QUIET_SUCCESS_HOOKS = {"statusline"}


# 简单的日志配置
logging.basicConfig(
    filename=LOG_FILE,
    level=logging.INFO,
    format="[%(asctime)s] [%(levelname)s] [%(funcName)s] %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S"
)


# --- Core Utilities ---

def read_input_json():
    raw = sys.stdin.read()
    if not raw.strip():
        return {}
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        print(f"Invalid JSON input: {exc}", file=sys.stderr)
        sys.exit(2)

def parse_args(argv):
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--hook", dest="hook", required=True)
    return parser.parse_args(argv)

def resolve_project_dir(payload):
    # 1. Priority: Environment Variable
    env_dir = os.environ.get("CLAUDE_PROJECT_DIR", "").strip()
    if env_dir and os.path.isdir(env_dir):
        return env_dir.replace("\\", "/")
    
    # 2. Priority: Payload data
    workspace = payload.get("workspace") or {}
    project_dir = (workspace.get("project_dir") or "").strip()
    if project_dir and os.path.isdir(project_dir):
        return project_dir.replace("\\", "/")

    # 3. Priority: Self-healing Backtracking
    # If this script is at .claude/hooks/hook_runner.py, its grandparent is the root
    script_dir = os.path.dirname(os.path.abspath(__file__))
    potential_root = os.path.abspath(os.path.join(script_dir, "..", ".."))
    if os.path.isdir(os.path.join(potential_root, ".claude")):
        return potential_root.replace("\\", "/")
    
    # 4. Fallback: CWD
    return os.getcwd().replace("\\", "/")



def _run_command(cmd):
    if os.name == "nt":
        result = subprocess.run(cmd, shell=True)
    else:
        result = subprocess.run(["bash", "-lc", cmd])
    return result.returncode



def _extract_question_text(tool_input):
    if not isinstance(tool_input, dict):
        return ""
    for key in ("question", "prompt", "message", "title"):
        value = tool_input.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""

def _extract_decision_context(tool_input):
    if not isinstance(tool_input, dict):
        return {}
    context = tool_input.get("decision_context")
    return context if isinstance(context, dict) else {}

def _domain_expertise_score(user_profile, domain):
    domains = user_profile.get("domains") if isinstance(user_profile, dict) else {}
    if not isinstance(domains, dict) or not domains:
        return 0

    clean_domain = str(domain or "").strip().lower()
    if clean_domain:
        for key, value in domains.items():
            if str(key).strip().lower() == clean_domain:
                return _coerce_int(value, 0)
    return max((_coerce_int(v, 0) for v in domains.values()), default=0)

def _classify_ask_user_decision(tool_input, policy, user_profile):
    autonomy = (policy or {}).get("autonomy") or {}
    profile_cfg = (policy or {}).get("user_profile") or {}

    question = _extract_question_text(tool_input)
    question_text = question.lower()
    context = _extract_decision_context(tool_input)
    force_ask = bool(
        context.get("force_ask_user")
        or context.get("force_owner_question")
        or tool_input.get("force_ask_user")
    )
    if force_ask and _pick_bool(autonomy.get("allow_force_ask_override"), True):
        return "ask", "force_ask_override", {"impact_level": "high", "impact_score": 100}

    impact_level = str(
        context.get("impact_level")
        or tool_input.get("impact_level")
        or ""
    ).strip().lower()
    impact_score = _coerce_int(
        context.get("impact_score", tool_input.get("impact_score", -1)),
        -1,
    )
    reversible = _pick_bool(
        context.get("reversible", tool_input.get("reversible", True)),
        True,
    )
    requires_owner_decision = bool(
        context.get("requires_owner_decision")
        or tool_input.get("requires_owner_decision")
    )
    domain = str(context.get("domain") or tool_input.get("domain") or "").strip().lower()

    high_keywords = [str(k).lower() for k in (autonomy.get("high_impact_keywords") or []) if str(k).strip()]
    micro_keywords = [str(k).lower() for k in (autonomy.get("micro_keywords") or []) if str(k).strip()]
    has_high_keyword = any(keyword in question_text for keyword in high_keywords) if question_text else False
    has_micro_keyword = any(keyword in question_text for keyword in micro_keywords) if question_text else False

    if not impact_level:
        if has_high_keyword:
            impact_level = "high"
        elif has_micro_keyword:
            impact_level = "low"
        elif impact_score >= 0:
            if impact_score >= _coerce_int(autonomy.get("high_impact_score_threshold"), 70):
                impact_level = "high"
            elif impact_score >= _coerce_int(autonomy.get("medium_impact_score_threshold"), 40):
                impact_level = "medium"
            else:
                impact_level = "low"
        else:
            impact_level = "medium"

    if impact_score < 0:
        if impact_level == "high":
            impact_score = 85
        elif impact_level == "medium":
            impact_score = 50
        else:
            impact_score = 20

    high_threshold = _coerce_int(autonomy.get("high_impact_score_threshold"), 70)
    medium_threshold = _coerce_int(autonomy.get("medium_impact_score_threshold"), 40)

    if requires_owner_decision:
        route = "ask"
        reason = "owner_decision_required"
    elif (impact_level == "high") or (impact_score >= high_threshold) or (not reversible) or has_high_keyword:
        route = "ask"
        reason = "high_impact_decision"
    elif (impact_level == "medium") or (impact_score >= medium_threshold):
        route = "notify"
        reason = "medium_impact_decision"
    else:
        route = "auto"
        reason = "micro_or_low_impact_decision"

    if route == "notify" and _pick_bool(profile_cfg.get("ask_on_medium_for_low_expertise"), True):
        score = _domain_expertise_score(user_profile, domain)
        low_threshold = _coerce_int(profile_cfg.get("domain_low_threshold"), 0)
        if score <= low_threshold:
            route = "ask"
            reason = "medium_impact_with_low_user_expertise"

    if route != "ask" and not _pick_bool(autonomy.get("block_micro_ask_user_question"), True):
        route = "ask"
        reason = "decision_gate_disabled_for_ask_user"

    return route, reason, {
        "impact_level": impact_level,
        "impact_score": impact_score,
        "reversible": reversible,
        "requires_owner_decision": requires_owner_decision,
        "domain": domain,
        "question_preview": question[:120],
    }

def _effective_soft_capture_threshold(profile, project_dir):
    pain_cfg = profile.get("pain") or {}
    base = max(0, min(100, _coerce_int(pain_cfg.get("soft_capture_threshold"), 30)))
    adaptive = pain_cfg.get("adaptive") or {}
    if not _pick_bool(adaptive.get("enabled"), True):
        return base, {"base": base, "effective": base, "delta": 0, "reasons": []}

    min_threshold = max(0, min(100, _coerce_int(adaptive.get("min_threshold"), 15)))
    max_threshold = max(0, min(100, _coerce_int(adaptive.get("max_threshold"), 70)))
    if min_threshold > max_threshold:
        min_threshold, max_threshold = max_threshold, min_threshold

    backlog_trigger = max(1, _coerce_int(adaptive.get("backlog_trigger"), 6))
    hard_failure_trigger = max(1, _coerce_int(adaptive.get("hard_failure_trigger"), 2))
    stable_quality_threshold = max(1, _coerce_int(adaptive.get("stable_quality_threshold"), 5))

    queue = _load_queue(project_dir)
    open_tasks = [t for t in queue if str(t.get("status") or "").lower() in QUEUE_OPEN_STATES]
    backlog = len(open_tasks)
    open_hard_failures = sum(1 for t in open_tasks if str(t.get("type") or "") == "test_failure")
    recent = queue[-50:] if isinstance(queue, list) else []
    recent_hard_failures = sum(
        1 for t in recent if str(t.get("type") or "") == "test_failure" and str(t.get("status") or "") == "failed"
    )
    recent_quality_completed = sum(
        1 for t in recent if str(t.get("type") or "") == "quality_signal" and str(t.get("status") or "") == "completed"
    )
    recent_quality_failed = sum(
        1 for t in recent if str(t.get("type") or "") == "quality_signal" and str(t.get("status") or "") == "failed"
    )

    delta = 0
    reasons = []
    if backlog >= backlog_trigger:
        delta -= 10
        reasons.append("backlog_pressure")
    if (open_hard_failures + recent_hard_failures) >= hard_failure_trigger:
        delta -= 10
        reasons.append("hard_failure_pressure")
    if recent_quality_failed >= 3 and backlog > 0:
        delta -= 5
        reasons.append("quality_signal_retries")
    if (
        backlog == 0
        and open_hard_failures == 0
        and recent_hard_failures == 0
        and recent_quality_completed >= stable_quality_threshold
    ):
        delta += 8
        reasons.append("stable_completion_streak")
    if recent_quality_completed >= 10 and recent_quality_failed == 0 and backlog <= 1:
        delta += 5
        reasons.append("high_quality_throughput")

    effective = max(min_threshold, min(max_threshold, base + delta))
    return effective, {
        "base": base,
        "effective": effective,
        "delta": delta,
        "reasons": reasons,
        "backlog": backlog,
        "open_hard_failures": open_hard_failures,
        "recent_hard_failures": recent_hard_failures,
        "recent_quality_completed": recent_quality_completed,
        "recent_quality_failed": recent_quality_failed,
    }

def _detect_soft_pain_signals(project_dir, file_path, risky, test_level):
    signals = []
    score = 0

    plan_status = (_plan_status(project_dir) or "").upper()
    if risky and plan_status in ("", "DRAFT", "IN_PROGRESS"):
        signals.append("plan_not_ready_on_risky_write")
        score += 20

    if risky and test_level == "smoke":
        signals.append("risky_edit_with_smoke_tests")
        score += 10

    open_tasks = [t for t in _load_queue(project_dir) if str(t.get("status") or "").lower() in QUEUE_OPEN_STATES]
    if len(open_tasks) >= 5:
        signals.append("queue_backlog_pressure")
        score += 15

    if file_path:
        same_file_open = 0
        for task in open_tasks:
            details = task.get("details") or {}
            if str(details.get("file_path") or "") == str(file_path):
                same_file_open += 1
        if same_file_open >= 2:
            signals.append("same_file_repeated_incidents")
            score += 25

    return signals, score

def _compute_pain_score(rc, is_spiral, missing_test_command, soft_score):
    score = max(0, _coerce_int(soft_score, 0))
    if rc != 0:
        score += 70
    if is_spiral:
        score += 40
    if missing_test_command:
        score += 30
    return min(100, score)

def _pain_severity_label(pain_score, is_spiral=False):
    score = _coerce_int(pain_score, 0)
    if is_spiral or score >= 85:
        return "CRITICAL"
    if score >= 65:
        return "HIGH"
    if score >= 35:
        return "MEDIUM"
    return "LOW"

# --- Hook Handlers ---

def audit_log(payload, project_dir):
    # 保留原有的审计日志逻辑，因为它和 System Telemetry 是互补的
    # Telemetry 关注 Hook 自身运行，Audit Log 关注业务操作
    hook_type = os.environ.get("CLAUDE_HOOK_TYPE", "Unknown")
    tool = payload.get("tool_name") or "-"
    file_path = (payload.get("tool_input") or {}).get("file_path") or "-"
    agent_type = payload.get("agent_type") or "-"
    stop_reason = payload.get("stop_reason") or "-"

    docs_dir = os.path.join(project_dir, "docs")
    os.makedirs(docs_dir, exist_ok=True)
    audit_log_path = os.path.join(docs_dir, "AUDIT_TRAIL.log")

    profile, _ = load_profile(project_dir)
    risk_flag = "N"
    if profile and file_path != "-":
        rel = normalize_path(file_path, project_dir)
        risk_paths = profile.get("risk_paths") or []
        if is_risky(rel, risk_paths):
            risk_flag = "Y"

    ts = _dt.datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
    
    # 简单的格式化逻辑
    if hook_type == "PreToolUse":
        line = f"[{ts}] PRE   | {tool} | file={file_path} | risk={risk_flag}"
    elif hook_type == "PostToolUse":
        line = f"[{ts}] POST  | {tool} | file={file_path} | risk={risk_flag}"
    else:
        line = f"[{ts}] {hook_type} | {tool} | {file_path}"

    try:
        with open(audit_log_path, "a", encoding="utf-8") as handle:
            handle.write(line + "\n")
    except Exception as e:
        logging.error(f"Failed to write audit log: {e}")
        
    return 0

def post_write_checks(payload, project_dir):
    tool = payload.get("tool_name") or ""
    if tool not in ("Write", "Edit"):
        return 0

    profile, _ = load_profile(project_dir)
    if profile is None:
        return 0

    file_path = (payload.get("tool_input") or {}).get("file_path") or ""
    rel = normalize_path(file_path, project_dir) if file_path else ""
    risk_paths = profile.get("risk_paths") or []
    risky = is_risky(rel, risk_paths) if file_path else False
    _record_execution_heartbeat(project_dir, profile, payload, file_path)

    tests = profile.get("tests") or {}
    level = tests.get("on_change") or "smoke"
    if risky:
        level = tests.get("on_risk_change") or "unit"

    commands = tests.get("commands") or {}
    cmd = commands.get(level) or ""
    missing_test_command = risky and not cmd
    rc = _run_command(cmd) if cmd else 0
    
    # --- Pain Escalation: Death Spiral Detection ---
    spiral_warning = ""
    is_spiral = False
    try:
        # Check last 5 commits for "fix" patterns (使用词边界避免误判)
        if os.path.exists(os.path.join(project_dir, ".git")):
            git_log = subprocess.check_output(
                ["git", "-C", project_dir, "log", "--oneline", "-n", "5"], 
                text=True, stderr=subprocess.DEVNULL
            ).lower()
            
            # 使用正则词边界匹配，避免 prefix/suffix/affix 等误判
            import re as _re_for_spiral
            SPIRAL_KEYWORDS = r'\b(?:fix|fail|error|repair|patch|revert)\b'
            matches = _re_for_spiral.findall(SPIRAL_KEYWORDS, git_log, _re_for_spiral.IGNORECASE)
            fix_count = len(matches)
            
            if fix_count >= 3:
                is_spiral = True
                spiral_warning = f"\n💀 DEATH SPIRAL DETECTED: {fix_count} recent fixes found. STOP CODING. THINK."
    except Exception:
        pass

    soft_signals, soft_score = _detect_soft_pain_signals(project_dir, file_path, risky, level)
    soft_threshold, threshold_diag = _effective_soft_capture_threshold(profile, project_dir)
    base_threshold = _coerce_int(threshold_diag.get("base"), soft_threshold)

    hard_signal = (rc != 0) or missing_test_command
    pain_score = _compute_pain_score(rc, is_spiral, missing_test_command, soft_score)
    if not (hard_signal or (is_spiral and rc != 0)) and pain_score < soft_threshold:
        return 0

    evolution_mode = profile.get("evolution_mode") or "realtime"
    
    # 判定优先级和严重程度（先定义 task_type）
    task_type = "test_failure" if rc != 0 else "quality_signal"
    severity = _pain_severity_label(pain_score, is_spiral=(is_spiral and rc != 0))
    task_priority = _compute_task_priority(task_type, {"exit_code": rc, "is_spiral": (is_spiral and rc != 0), "pain_score": pain_score})
    
    if is_spiral and rc == 0:
        # rc=0 时的螺旋通常是微调，降低优先级并抑制痛觉
        task_priority = 30
        severity = "LOW"
        pain_score = min(pain_score, 25) # 强制低于阈值 30
    if rc != 0:
        reason = "post_write_checks_failed"
        diagnosis = "POST_WRITE_TEST_FAILED"
    elif missing_test_command:
        reason = "missing_test_command_on_risky_edit"
        diagnosis = "NO_TEST_COMMAND_FOR_RISKY_EDIT"
    elif is_spiral:
        reason = "death_spiral_detected"
        diagnosis = "POTENTIAL_DEATH_SPIRAL"
    elif soft_signals:
        reason = f"soft_signal:{soft_signals[0]}"
        diagnosis = "SOFT_SIGNAL_CAPTURED"
    else:
        reason = "quality_signal_detected"
        diagnosis = "QUALITY_SIGNAL_CAPTURED"

    pain_data = {
        "time": _dt.datetime.now().isoformat(),
        "tool": tool,
        "file_path": file_path,
        "risk": str(risky).lower(),
        "test_level": level,
        "command": cmd or "<missing>",
        "exit_code": rc,
        "pain_score": pain_score,
        "severity": _pain_severity_label(pain_score, is_spiral=is_spiral),
        "diagnosis": diagnosis,
        "mode": evolution_mode,
        "reason": reason,
        "issue_logged": "false",
        "soft_capture_threshold_base": base_threshold,
        "soft_capture_threshold_effective": soft_threshold,
    }
    if soft_signals:
        pain_data["soft_signals"] = ",".join(soft_signals)
    if threshold_diag.get("reasons"):
        pain_data["soft_threshold_reasons"] = ",".join(threshold_diag.get("reasons") or [])

    _write_pain_flag(project_dir, pain_data)

    details = {
        "tool": tool,
        "file_path": file_path,
        "exit_code": rc,
        "command": cmd,
        "is_spiral": is_spiral,
        "missing_test_command": missing_test_command,
        "reason": reason,
        "pain_score": pain_score,
        "soft_signals": soft_signals,
        "soft_score": soft_score,
        "soft_capture_threshold_base": base_threshold,
        "soft_capture_threshold": soft_threshold,
        "soft_threshold_reasons": threshold_diag.get("reasons") or [],
    }
    # task_type 已在前面定义（line ~1492）
    if evolution_mode == "async":
        task_id = enqueue_evolution_task(task_type, details, project_dir)
        if task_id:
            pain_data["queue_task_id"] = task_id
            _write_pain_flag(project_dir, pain_data)
        if rc != 0:
            print(f"⚠️  Post-write checks failed (rc={rc}). Issue queued (ID: {task_id}).", file=sys.stderr)
        if missing_test_command:
            print("⚠️  Risky edit has no configured test command. Pain signal queued.", file=sys.stderr)
        if is_spiral:
            print(f"💀 DEATH SPIRAL DETECTED. Queued for background analysis.{spiral_warning}", file=sys.stderr)
        if (not hard_signal) and soft_signals:
            print(
                f"⚠️  Soft pain signals captured (score={pain_score}, "
                f"threshold={soft_threshold}, base={base_threshold}). "
                f"Queued (ID: {task_id}).",
                file=sys.stderr,
            )
        return 0

    if missing_test_command:
        print("⚠️  Risky edit has no configured test command. Pain flag written.", file=sys.stderr)
        return 0

    if rc != 0:
        print(f"❌ Post-write checks failed (rc={rc}). Pain flag written.{spiral_warning}", file=sys.stderr)
        return rc

    if is_spiral:
        print(f"💀 DEATH SPIRAL DETECTED. Pain flag written.{spiral_warning}", file=sys.stderr)
        return 0

    if soft_signals:
        print(
            f"⚠️  Soft pain signals captured (score={pain_score}, "
            f"threshold={soft_threshold}, base={base_threshold}). Pain flag written.",
            file=sys.stderr,
        )

    return 0

def session_init(payload, project_dir):
    profile, _ = load_profile(project_dir)
    pain_flag = os.path.join(project_dir, "docs", ".pain_flag")
    issue_log = os.path.join(project_dir, "docs", "ISSUE_LOG.md")
    plan_path = os.path.join(project_dir, "docs", "PLAN.md")
    pending_reflection = os.path.join(project_dir, "docs", ".pending_reflection")

    print("[INFO] Evolutionary Programming Agent Initialized")

    evolution_mode = (profile or {}).get("evolution_mode") or "realtime"
    interrupted_state = _mark_week_interrupted_if_stale(project_dir, profile or {})
    if interrupted_state:
        print("")
        print("[WARNING] WEEKLY EXECUTION INTERRUPTED")
        print(f"Reason: {(interrupted_state.get('interruption') or {}).get('reason')}")
        print("Action: Recover lifecycle state before new risky execution.")

    # 1. 检查异步队列状态
    queue_file = _queue_file(project_dir)
    if os.path.isfile(queue_file):
        try:
            with open(queue_file, "r", encoding="utf-8") as f:
                queue = json.load(f)
            pending = [t for t in queue if str(t.get("status", "")).lower() == "pending"]
            if pending:
                print(f"[INFO] 🚀 {len(pending)} tasks in evolution queue. Run /watch-evolution to start worker.")
        except (json.JSONDecodeError, OSError, KeyError) as exc:
            logging.debug("Non-critical: failed to parse evolution queue: %s", exc)

    # 2. 优先检查反思要求
    if os.path.isfile(pending_reflection):
        try:
            with open(pending_reflection, "r", encoding="utf-8") as f:
                reason = f.read().strip()
            print("")
            print("[STOP] **URGENT: PENDING REFLECTION**")
            print("System context was compressed while unstable.")
            print(f"Reason: {reason}")
            print("")
            print("[ACTION] **ACTION REQUIRED**: Run `/reflection` immediately to analyze root causes.")
            print("   (This file will be removed after reflection is logged)")
        except Exception:
            pass

    if profile:
        audit_level = profile.get("audit_level") or "medium"
        risk_paths = profile.get("risk_paths") or []
        print(f"  - Mode: {evolution_mode} | Audit: {audit_level}")
        print(f"  - Risk Paths: {json.dumps(risk_paths, ensure_ascii=False)}")
        week_state, _, week_exists = _load_week_state(project_dir)
        if week_exists or str(week_state.get("stage") or "").upper() != "UNPLANNED":
            print(
                "  - Weekly Lifecycle: "
                f"{week_state.get('stage')} | owner_approved={week_state.get('owner_approved')}"
            )

    if os.path.isfile(pain_flag):
        print("")
        print("[WARNING] Unresolved pain flag detected from last session.")
        print("Summary:")
        for line in _read_text_file(pain_flag).splitlines()[:6]:
            print(f"    {line}")
        print("")
        if evolution_mode == "async":
            if _has_open_evolution_tasks(project_dir):
                print("Suggestion: Run /watch-evolution to process queued pain signals.")
            else:
                print("Suggestion: Queue is clear. Run /reflection-log and clear the pain flag.")
        else:
            print("Suggestion: Run /evolve-task --recover to diagnose.")

    if os.path.isfile(plan_path):
        status = ""
        with open(plan_path, "r", encoding="utf-8") as handle:
            for line in handle:
                if line.startswith("STATUS:"):
                    status = line.split(":", 1)[1].strip().split()[0]
                    break
        if status in ("IN_PROGRESS", "DRAFT"):
            print("")
            print(f"[STATUS] Active plan detected (STATUS: {status})")
            if status == "DRAFT":
                print("Suggestion: Complete the plan and set STATUS to READY")
            else:
                print("Suggestion: Continue following steps in docs/PLAN.md")

    if os.path.isfile(issue_log):
        last_issue = ""
        with open(issue_log, "r", encoding="utf-8") as handle:
            for line in handle:
                if line.startswith("## ["):
                    last_issue = line.strip()[:80]
        if last_issue:
            print(f"  - Latest Issue: {last_issue}")

    return 0

def user_prompt_context(payload, project_dir):
    docs_dir = os.path.join(project_dir, "docs")
    pain_flag = os.path.join(docs_dir, ".pain_flag")
    pending_reflection = os.path.join(docs_dir, ".pending_reflection")
    plan_status = _plan_status(project_dir)
    profile, _ = load_profile(project_dir)

    context_lines = [
        "[System Anchors]",
        "- Workflow order is mandatory: Goal -> Map -> Plan -> Delegate -> Review -> Verify -> Log.",
        "- Risky writes require PLAN READY and AUDIT PASS.",
    ]
    decision_policy, _ = load_decision_policy(project_dir)
    if _pick_bool((decision_policy or {}).get("enabled"), True):
        autonomy = (decision_policy.get("autonomy") or {})
        high_score = _coerce_int(autonomy.get("high_impact_score_threshold"), 70)
        medium_score = _coerce_int(autonomy.get("medium_impact_score_threshold"), 40)
        context_lines.append(
            f"- Decision policy: auto/notify for low-medium impact (<{high_score}); "
            f"AskUserQuestion only for high-impact or owner decisions (medium >= {medium_score})."
        )
    signal_lines = []

    if os.path.isfile(pain_flag):
        try:
            with open(pain_flag, "r", encoding="utf-8") as handle:
                preview = [line.strip() for line in handle.read().splitlines()[:3] if line.strip()]
            if preview:
                signal_lines.append("- Unresolved pain signal:")
                for line in preview:
                    signal_lines.append(f"  {line}")
            else:
                signal_lines.append("- Unresolved pain signal exists.")
        except (OSError, UnicodeDecodeError) as exc:
            logging.debug("Failed to read pain_flag preview: %s", exc)
            signal_lines.append("- Unresolved pain signal exists.")

    if os.path.isfile(pending_reflection):
        signal_lines.append("- Pending reflection marker exists. `/reflection` should run before new implementation.")

    if plan_status in ("DRAFT", "IN_PROGRESS"):
        signal_lines.append(f"- Active plan status: STATUS: {plan_status}")

    lifecycle = (profile or {}).get("lifecycle") or {}
    if _pick_bool(lifecycle.get("enabled"), True):
        week_state, _, week_exists = _load_week_state(project_dir)
        if week_exists or str(week_state.get("stage") or "").upper() != "UNPLANNED":
            stage = str(week_state.get("stage") or "UNPLANNED").upper()
            signal_lines.append(f"- Weekly lifecycle stage: {stage}")
            execution = week_state.get("execution") or {}
            signal_lines.append(
                f"- Completed this week: {int(execution.get('completed_events') or 0)} | "
                f"Blocked: {int(execution.get('blocked_events') or 0)} | "
                f"Heartbeats: {int(execution.get('heartbeat_count') or 0)}"
            )

            if stage == "PENDING_OWNER_APPROVAL" and not week_state.get("owner_approved"):
                signal_lines.append("- Owner approval missing: use AskUserQuestion before execution.")
            if stage == "INTERRUPTED":
                reason = (week_state.get("interruption") or {}).get("reason") or "unknown interruption"
                signal_lines.append(f"- Lifecycle interrupted: {reason}")
                signal_lines.append("- Recover plan state before continuing risky execution.")

            recent_events = _read_week_events(project_dir, limit=30)
            completed = [e for e in recent_events if str(e.get("type") or "") == "task_completed"]
            if completed:
                latest = completed[-1]
                summary = (
                    str(latest.get("summary") or latest.get("task") or latest.get("file_path") or "").strip()
                    or "latest completion recorded"
                )
                signal_lines.append(f"- Latest completed task: {summary[:140]}")

    current_focus = os.path.join(docs_dir, "okr", "CURRENT_FOCUS.md")
    if os.path.isfile(current_focus):
        try:
            with open(current_focus, "r", encoding="utf-8") as handle:
                for line in handle:
                    text = line.strip()
                    if text.startswith("- [None]"):
                        signal_lines.append("- Strategic focus is not initialized. Run `/init-strategy` then `/manage-okr`.")
                        break
                    if text.startswith("- [") or text.startswith("- "):
                        signal_lines.append(f"- Current focus: {text[:120]}")
                        break
        except (OSError, UnicodeDecodeError) as exc:
            logging.debug("Failed to read CURRENT_FOCUS: %s", exc)

    if not signal_lines:
        signal_lines.append("- State: stable. Keep the workflow order and guardrails active.")

    additional_context = "\n".join(context_lines + signal_lines)
    print(
        json.dumps(
            {
                "hookSpecificOutput": {
                    "hookEventName": "UserPromptSubmit",
                    "additionalContext": additional_context,
                }
            },
            ensure_ascii=False,
        )
    )
    return 0

def emit_signal(payload, project_dir):
    """Event Bus: Emit a signal to WORKBOARD.json"""
    hook_event = os.environ.get("CLAUDE_HOOK_TYPE", "Unknown")
    agent_type = payload.get("agent_type") or "main"
    tool_input = payload.get("tool_input") or {}
    
    # 自动推断信号类型
    sig_type = "generic"
    if hook_event == "PostToolUse":
        sig_type = "discovery" if payload.get("tool_name") in ("Grep", "Glob") else "modification"
    elif "Stop" in hook_event:
        sig_type = "milestone"

    signal = {
        "timestamp": _dt.datetime.now().isoformat(),
        "event": "signal",
        "type": sig_type,
        "source": agent_type,
        "hook": hook_event,
        "message": f"{agent_type} executed {payload.get('tool_name') or 'task'}",
        "details": tool_input
    }
    _update_workboard(project_dir, signal)
    return 0

def subagent_onboarding(payload, project_dir):
    """通用智能体入职协议：向总线广播新成员加入"""
    agent_type = payload.get("agent_type") or "unknown"
    session_id = payload.get("session_id")
    
    signal = {
        "timestamp": _dt.datetime.now().isoformat(),
        "event": "team_entry",
        "type": "onboarding",
        "source": agent_type,
        "session_id": session_id,
        "message": f"Teammate [{agent_type}] has joined the session."
    }
    _update_workboard(project_dir, signal)
    return 0

def subagent_init_map(payload, project_dir):
    """为子智能体注入地图上下文 (v2.1.0+ 特性)"""
    maps = []
    # 查找可能的地图目录
    map_dirs = ["codemaps", "docs/codemaps", "docs"]
    for d in map_dirs:
        full_path = os.path.join(project_dir, d)
        if os.path.isdir(full_path):
            for f in os.listdir(full_path):
                if f.endswith(".md") and ("architecture" in f or "backend" in f or "map" in f):
                    maps.append(os.path.join(d, f))
    
    if not maps:
        return 0

    # 构造注入信息
    context = "[Subagent Context Injection: Map Awareness]\n"
    context += "You are provided with the following architectural maps. READ THEM before searching code:\n"
    for m in maps:
        context += f"- @{m}\n"
    
    # 利用 v2.1.0+ 的 additionalContext 响应格式
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "additionalContext": context
        }
    }))
    return 0

def statusline(payload, project_dir):
    """
    Generate a custom status line for Claude Code.
    Display: [Model Context%] [Plan Status] [Audit] [Pain] [Current OKR]
    """
    # 1. Parse Payload
    model = (payload.get("model") or {}).get("display_name") or "?"
    usage = (payload.get("context_window") or {}).get("used_percentage") or 0
    try:
        usage_pct = int(usage * 100) if usage <= 1 else int(usage) # Handle 0.45 vs 45
    except:
        usage_pct = 0
        
    # Context Color
    ctx_icon = "🟢"
    if usage_pct > 80: ctx_icon = "🔴"
    elif usage_pct > 60: ctx_icon = "🟡"
    
    # 2. Plan Status
    plan_path = os.path.join(project_dir, "docs", "PLAN.md")
    plan_status = "NoPlan"
    if os.path.isfile(plan_path):
        with open(plan_path, "r", encoding="utf-8") as f:
            for line in f:
                if line.startswith("STATUS:"):
                    plan_status = line.split(":", 1)[1].strip()
                    break
    
    # 3. Audit Status
    audit_path = os.path.join(project_dir, "docs", "AUDIT.md")
    audit_icon = ""
    if os.path.isfile(audit_path):
        with open(audit_path, "r", encoding="utf-8") as f:
            content = f.read()
            if "RESULT: PASS" in content: audit_icon = "🛡️✅"
            elif "RESULT: FAIL" in content: audit_icon = "🛡️❌"
            
    # 4. Pain/Issue
    pain_flag = os.path.join(project_dir, "docs", ".pain_flag")
    pain_icon = ""
    if os.path.isfile(pain_flag):
        pain_icon = "💊"
        
    # 5. Queue Metrics
    queue_text = _format_queue_status(project_dir)
    week_text = _format_week_status(project_dir)

    # 6. OKR Focus
    okr_path = os.path.join(project_dir, "docs", "okr", "CURRENT_FOCUS.md")
    okr_text = ""
    if os.path.isfile(okr_path):
        with open(okr_path, "r", encoding="utf-8") as f:
            lines = f.readlines()
            # Try to find the first KR
            for line in lines:
                if line.strip().startswith("- [ ]"):
                    # Extract text like "Zero TypeScript errors"
                    okr_text = f"🎯{line.strip()[5:].strip()[:20]}..."
                    break
                    
    # Output Format
    # [Model 🟢45%] Plan:READY 🛡️✅ 💊 🎯KR...
    
    parts = [
        f"[{model} {ctx_icon}{usage_pct}%]",
        f"💾{plan_status}",
    ]
    if audit_icon: parts.append(audit_icon)
    if pain_icon: parts.append(pain_icon)
    if queue_text: parts.append(queue_text)
    if week_text: parts.append(week_text)
    if okr_text: parts.append(okr_text)
    
    print(" ".join(parts))
    return 0

def stop_evolution_update(payload, project_dir):
    docs_dir = os.path.join(project_dir, "docs")
    pain_flag = os.path.join(docs_dir, ".pain_flag")
    issue_log = os.path.join(docs_dir, "ISSUE_LOG.md")
    decisions = os.path.join(docs_dir, "DECISIONS.md")
    user_profile = os.path.join(docs_dir, "USER_PROFILE.json")
    user_verdict = os.path.join(docs_dir, ".user_verdict.json")

    os.makedirs(docs_dir, exist_ok=True)
    profile, _ = load_profile(project_dir)
    evolution_mode = (profile or {}).get("evolution_mode") or "realtime"

    # 1. 处理 Pain Flag
    if os.path.isfile(pain_flag):
        pain_content = _read_text_file(pain_flag)
        pain_data = _parse_kv_lines(pain_content)
        issue_logged = str(pain_data.get("issue_logged", "false")).lower() == "true"

        if not issue_logged:
            _append_issue_from_pain(issue_log, decisions, pain_content)
            pain_data["issue_logged"] = "true"
            pain_content = _serialize_kv_lines(pain_data)

        if evolution_mode == "async" and _has_open_evolution_tasks(project_dir):
            with open(pain_flag, "w", encoding="utf-8") as handle:
                handle.write(pain_content)
        else:
            os.remove(pain_flag)

    # 2. 处理用户画像更新 (Ported from Bash)
    if os.path.isfile(user_verdict):
        try:
            # 读取 Verdict
            with open(user_verdict, "r", encoding="utf-8") as f:
                verdict = json.load(f)
            
            # 读取 Profile (如果不存在则初始化)
            if not os.path.isfile(user_profile):
                profile = {"domains": {}, "preferences": {}, "history": []}
            else:
                with open(user_profile, "r", encoding="utf-8") as f:
                    profile = json.load(f)
            
            # 更新 Domains
            updates = verdict.get("updates", [])
            for u in updates:
                domain = u.get("domain")
                delta = u.get("delta", 0)
                if domain:
                    current_score = profile["domains"].get(domain, 0)
                    profile["domains"][domain] = current_score + delta
            
            # 更新 Preferences
            new_prefs = verdict.get("preferences", {})
            profile["preferences"].update(new_prefs)
            
            # 更新 Achievements (新增)
            new_achievement = verdict.get("achievement")
            if new_achievement:
                if "achievements" not in profile:
                    profile["achievements"] = []
                profile["achievements"] = ([{
                    "date": _dt.datetime.now().strftime("%Y-%m-%d"),
                    "pattern": new_achievement
                }] + profile["achievements"])[:5] # 只保留最近 5 条高光时刻
            
            # 更新 History (追加并切片)
            profile["history"] = (updates + profile.get("history", []))[:20]
            
            # 写回 Profile
            with open(user_profile, "w", encoding="utf-8") as f:
                json.dump(profile, f, ensure_ascii=False, indent=2)
            
            os.remove(user_verdict)
            
            # 触发 sync_user_context (直接调用函数，不再 spawn shell)
            sync_user_context(payload, project_dir)
            
        except (json.JSONDecodeError, OSError, KeyError, TypeError) as exc:
            logging.error("Failed to update user profile: %s", exc)

    return 0

def sync_user_context(payload, project_dir):
    """同步 USER_PROFILE.json 到 USER_CONTEXT.md (支持保留手动笔记)"""
    user_profile = os.path.join(project_dir, "docs", "USER_PROFILE.json")
    user_context = os.path.join(project_dir, "docs", "USER_CONTEXT.md")
    
    if not os.path.isfile(user_profile):
        return 0
        
    try:
        # 1. 读取旧文件中的手动部分 (保护机制)
        manual_content = ""
        manual_marker = "<!-- MANUAL_START -->"
        if os.path.isfile(user_context):
            with open(user_context, "r", encoding="utf-8") as f:
                content = f.read()
                if manual_marker in content:
                    manual_content = content.split(manual_marker)[1]
        
        # 2. 生成系统部分
        with open(user_profile, "r", encoding="utf-8") as f:
            data = json.load(f)
            
        domains = data.get("domains", {})
        prefs = data.get("preferences", {})
        achievements = data.get("achievements", [])
        
        def get_level(score):
            if score >= 10: return "Expert"
            if score >= 5: return "Proficient"
            if score >= 0: return "Intermediate"
            return "Novice/Low"

        with open(user_context, "w", encoding="utf-8") as f:
            f.write(f"# User Cognitive Profile (System Generated)\n")
            f.write(f"> 🛑 DO NOT EDIT ABOVE THIS LINE. Updated: {_dt.datetime.now().isoformat()}\n\n")
            
            if achievements:
                f.write("## 🎖️ Achievement Wall (Success Patterns)\n")
                for ach in achievements:
                    f.write(f"- **[{ach.get('date','?')}]**: {ach.get('pattern')}\n")
                f.write("\n")

            f.write("## Current Domain Expertise\n")
            for domain, score in domains.items():
                level = get_level(score)
                f.write(f"- **{domain}**: [{level}] (Score: {score})\n")
            
            if prefs:
                # 兼容不同格式的 Preferences
                f.write("\n## Communication Preferences\n")
                if isinstance(prefs, dict):
                    for k, v in prefs.items():
                        f.write(f"- **{k}**: {v}\n")
                else:
                    f.write(f"- {prefs}\n")
            
            f.write("\n## Interaction Strategy\n")
            for domain, score in domains.items():
                if _coerce_int(score, 0) < 0:
                    f.write(f"- **{domain} Control**: High vigilance. Verify strictly.\n")
            
            # 3. 追加并写回手动部分
            f.write(f"\n\n{manual_marker}\n")
            if manual_content.strip():
                f.write(manual_content)
            else:
                f.write("## Manual Notes (User Preserved)\n> You can write your permanent notes below. They will be preserved during updates.\n")
                    
    except Exception as e:
        logging.error(f"Failed to sync user context: {e}")
        
    return 0

def sync_agent_context(payload, project_dir):
    """同步 AGENT_SCORECARD.json 到 AGENT_CONTEXT.md"""
    scorecard = os.path.join(project_dir, "docs", "AGENT_SCORECARD.json")
    context = os.path.join(project_dir, "docs", "AGENT_CONTEXT.md")
    
    if not os.path.isfile(scorecard):
        return 0
        
    try:
        with open(scorecard, "r", encoding="utf-8") as f:
            data = json.load(f)
            
        agents = data.get("agents", {})
        
        with open(context, "w", encoding="utf-8") as f:
            f.write(f"# Agent Performance Context (System Generated)\n")
            f.write(f"> 🛑 DO NOT EDIT MANUALLY. Updated: {_dt.datetime.now().isoformat()}\n\n")
            f.write("## Current Agent Reliability\n")
            
            for name, stats in agents.items():
                clean_name = str(name).strip()
                if not clean_name:
                    continue
                score = stats.get("score", 0)
                level = "Neutral (Standard)"
                if score >= 5: level = "High (Trustworthy)"
                elif score < 0: level = "Low (Risky)"
                
                wins = int(stats.get("wins", 0) or 0)
                losses = int(stats.get("losses", 0) or 0)
                f.write(f"- **{clean_name}**: [{level}] (Score: {score}, Wins: {wins}, Losses: {losses})\n")
                
            f.write("\n## Operational Guidance\n")
            f.write("- If an agent has a **Low/Risky** status, you MUST double-check its output.\n")
            
    except Exception as e:
        logging.error(f"Failed to sync agent context: {e}")
        
    return 0

def subagent_complete(payload, project_dir):
    agent_name = str(payload.get("agent_type") or "").strip()
    scorecard = os.path.join(project_dir, "docs", "AGENT_SCORECARD.json")
    verdict_file = os.path.join(project_dir, "docs", ".verdict.json")
    pain_flag = os.path.join(project_dir, "docs", ".pain_flag")

    if not agent_name or not os.path.isfile(scorecard):
        return 0

    # 1. 获取裁决数据 (The Verdict) - Ported from Bash
    win = True
    score_delta = 1
    
    verdict_reason = ""
    if os.path.isfile(verdict_file):
        try:
            with open(verdict_file, "r", encoding="utf-8") as f:
                verdict = json.load(f)
            # 校验 target_agent
            target_agent = str(verdict.get("target_agent") or "").strip()
            if target_agent == agent_name:
                win = verdict.get("win", True)
                score_delta = verdict.get("score_delta", 0)
                verdict_reason = verdict.get("reason", "")
                os.remove(verdict_file)
        except Exception:
            pass # Fallback to heuristic
            
    elif os.path.isfile(pain_flag):
        win = False
        score_delta = -1

    # 2. 更新 Scorecard
    try:
        with open(scorecard, "r", encoding="utf-8") as handle:
            data = json.load(handle)

        agents = data.setdefault("agents", {})
        stats = agents.setdefault(agent_name, {"wins": 0, "losses": 0, "score": 0})

        if win:
            stats["wins"] = int(stats.get("wins", 0)) + 1
        else:
            stats["losses"] = int(stats.get("losses", 0)) + 1
        
        stats["score"] = int(stats.get("score", 0)) + score_delta

        with open(scorecard, "w", encoding="utf-8") as handle:
            json.dump(data, handle, ensure_ascii=False, indent=2)
            
        # 3. 触发上下文同步
        sync_agent_context(payload, project_dir)
        _update_workboard(
            project_dir,
            {
                "timestamp": _dt.datetime.now().isoformat(),
                "session_id": payload.get("session_id"),
                "agent": agent_name,
                "result": "win" if win else "loss",
                "score_delta": score_delta,
                "reason": verdict_reason or ("pain_flag_fallback" if not win else "default_increment"),
            },
        )
        week_state, _, _ = _load_week_state(project_dir)
        stage = str(week_state.get("stage") or "").upper()
        if stage in {"LOCKED", "EXECUTING", "REVIEW", "INTERRUPTED"}:
            if win:
                week_state["execution"]["completed_events"] = int(
                    week_state.get("execution", {}).get("completed_events") or 0
                ) + 1
            else:
                week_state["execution"]["blocked_events"] = int(
                    week_state.get("execution", {}).get("blocked_events") or 0
                ) + 1
            _save_week_state(project_dir, week_state)
            _append_week_event(
                project_dir,
                "task_completed" if win else "blocker",
                {
                    "agent": agent_name,
                    "summary": verdict_reason or ("subagent finished with win" if win else "subagent hit blocker"),
                },
            )
         
    except Exception as e:
        logging.error(f"Failed to update scorecard: {e}")

    return 0

def precompact_checkpoint(payload, project_dir):
    docs_dir = os.path.join(project_dir, "docs")
    os.makedirs(docs_dir, exist_ok=True)
    
    # Checkpoint logic
    profile, _ = load_profile(project_dir)
    checkpoint = os.path.join(docs_dir, "CHECKPOINT.md")
    ts = _dt.datetime.now().isoformat()
    
    with open(checkpoint, "a", encoding="utf-8") as handle:
        handle.write(f"\n## PreCompact checkpoint [{ts}]\n")
        if profile:
            handle.write(f"- PROFILE.audit_level: {profile.get('audit_level')}\n")

    # Pain Detection Logic (Ported from Bash)
    pain_detected = False
    pain_reasons = []
    
    plan_path = os.path.join(docs_dir, "PLAN.md")
    if os.path.isfile(plan_path):
        with open(plan_path, "r", encoding="utf-8") as f:
            if "STATUS: DRAFT" in f.read():
                pain_detected = True
                pain_reasons.append("PLAN is still in DRAFT status after long context.")
    
    if os.path.isfile(os.path.join(docs_dir, ".pain_flag")):
        pain_detected = True
        pain_reasons.append("Unresolved pain flag detected.")
        
    print("[WARNING] **Context Compaction Triggered** [WARNING]\n")
    print("System is about to compress memory. Before details are lost:")
    
    if pain_detected:
        print("[ALERT] **Potential Pain Detected:**")
        for reason in pain_reasons:
            print(f" - {reason}")
        print("[ACTION] **RECOMMENDATION**: Run `/reflection` NOW.")
        
        pending_file = os.path.join(docs_dir, ".pending_reflection")
        with open(pending_file, "w", encoding="utf-8") as f:
            f.write("Compaction triggered while task was unstable.")
    else:
        print("✅ Status looks stable. Saving checkpoint.")

    return 0

def shellcheck_guard(payload, project_dir):
    # 保留原有的 shellcheck 逻辑
    tool_input = payload.get("tool_input") or {}
    file_path = tool_input.get("file_path") or "-"
    if file_path == "-" or not file_path.endswith(".sh"):
        return 0

    shellcheck = shutil.which("shellcheck")
    if not shellcheck:
        return 0

    result = subprocess.run(
        [shellcheck, "--severity=warning", "--shell=bash", "--format=json", file_path],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )

    output = result.stdout.strip()
    try:
        issues = json.loads(output) if output else []
    except json.JSONDecodeError:
        issues = []

    if issues:
        count = len(issues)
        print(f"鉂 ShellCheck 鍙戠幇 {count} 涓棶棰橈細", file=sys.stderr)
        for issue in issues:
            msg = (
                f"{issue.get('file')}:{issue.get('line')}:{issue.get('column')} "
                f"{issue.get('level')} - {issue.get('code')}\n"
                f"  {issue.get('message')}"
            )
            print(msg, file=sys.stderr)
        return 2

    return 0

def pre_ask_user_gate(payload, project_dir):
    tool = payload.get("tool_name") or ""
    if tool != "AskUserQuestion":
        return 0

    policy, _ = load_decision_policy(project_dir)
    if not _pick_bool(policy.get("enabled"), True):
        return 0

    tool_input = payload.get("tool_input") or {}
    user_profile = _load_user_profile(project_dir)
    route, reason, details = _classify_ask_user_decision(tool_input, policy, user_profile)

    _update_workboard(
        project_dir,
        {
            "timestamp": _dt.datetime.now().isoformat(),
            "session_id": payload.get("session_id"),
            "event": "ask_user_decision_gate",
            "route": route,
            "reason": reason,
            "impact_level": details.get("impact_level"),
            "impact_score": details.get("impact_score"),
            "domain": details.get("domain"),
        },
    )

    if route == "ask":
        return 0

    print("Blocked: AskUserQuestion is not required for this decision.", file=sys.stderr)
    print(
        "Action: decide autonomously from current goal and environment, then continue execution.",
        file=sys.stderr,
    )
    print(
        f"Route={route}; reason={reason}; impact={details.get('impact_level')}:{details.get('impact_score')}.",
        file=sys.stderr,
    )
    print(
        "Escalate to AskUserQuestion only for high-impact or owner-required decisions.",
        file=sys.stderr,
    )
    return 2

def pre_write_gate(payload, project_dir):
    tool = payload.get("tool_name") or ""
    # 我们只对具有修改能力的工具进行门禁检查
    if tool not in ("Write", "Edit"):
        return 0

    profile, profile_path = load_profile(project_dir)
    if profile is None:
        print("Blocked: missing docs/PROFILE.json (required for gating).", file=sys.stderr)
        return 2
    if profile.get("_profile_invalid"):
        print("Blocked: docs/PROFILE.json is invalid and was auto-sanitized. Fix the file before risky writes.", file=sys.stderr)
        return 2

    file_path = (payload.get("tool_input") or {}).get("file_path") or ""
    rel = normalize_path(file_path, project_dir) if file_path else ""

    # Debug
    debug_log(f"Profile gate: {profile.get('gate')}", "debug_log.txt", project_dir)
    debug_log(f"Profile risk_paths: {profile.get('risk_paths')}", "debug_log.txt", project_dir)
    debug_log(f"tool={tool}, file_path={file_path}, rel={rel}", "debug_log.txt", project_dir)
    
    # --- 1. 动态自定义钩子检查 (Dynamic Custom Guards) ---
    # 允许系统通过修改 PROFILE.json 实现自我进化
    custom_guards = profile.get("custom_guards", [])
    if custom_guards:
        test_str = f"{tool} {rel}"
        for guard in custom_guards:
            pattern = guard.get("pattern")
            message = guard.get("message")
            severity = guard.get("severity", "error") # Default to blocking
            
            if pattern and message:
                try:
                    if re.search(pattern, test_str, re.IGNORECASE):
                        prefix = "⛔ Blocked" if severity == "error" else "⚠️ Warning"
                        print(f"{prefix} by Evolutionary Guardrail:", file=sys.stderr)
                        print(f"Reason: {message}", file=sys.stderr)
                        
                        if severity == "error":
                            print(f"Pattern Matched: {pattern}", file=sys.stderr)
                            return 2
                        # If warning, just continue loop (or return 0? No, checking other guards)
                except re.error as e:
                    logging.error(f"Invalid regex in custom_guards: {pattern} - {e}")

    # --- 2. 传统风险路径检查 ---
    risk_paths = profile.get("risk_paths") or []
    risky = is_risky(rel, risk_paths) if file_path else True

    debug_log(f"Risky check: rel={rel}, risk_paths={risk_paths}, risky={risky}", "debug_log.txt", project_dir)

    gate = profile.get("gate") or {}
    require_plan = bool(gate.get("require_plan_for_risk_paths", False))
    require_audit = bool(gate.get("require_audit_before_write", False))
    lifecycle = profile.get("lifecycle") or {}

    debug_log(f"require_plan={require_plan}, require_audit={require_audit}", "debug_log.txt", project_dir)

    plan_path = os.path.join(project_dir, "docs", "PLAN.md")
    audit_path = os.path.join(project_dir, "docs", "AUDIT.md")
    
    if risky:
        debug_log("Entered risky block", "debug_log.txt", project_dir)

        state, _, _ = _load_week_state(project_dir)
        if str(state.get("stage") or "").upper() == "INTERRUPTED":
            debug_log("Blocked by INTERRUPTED stage", "debug_log.txt", project_dir)
            print(
                "Blocked: weekly execution interrupted. Recover lifecycle state before risky writes.",
                file=sys.stderr,
            )
            return 2

        debug_log(f"Checking week lock: state={state}, lifecycle={lifecycle}", "debug_log.txt", project_dir)
            
        if not _week_lock_is_valid(state, lifecycle):
            debug_log("Blocked by week lock invalid", "debug_log.txt", project_dir)
            print(
                "Blocked: weekly plan lock missing. Use proposal+challenge flow and AskUserQuestion owner approval first.",
                file=sys.stderr,
            )
            return 2

        if require_plan:
            if not os.path.isfile(plan_path):
                print(f"Blocked: Writing to risky path '{rel}' requires 'docs/PLAN.md'.", file=sys.stderr)
                return 2
            
            with open(plan_path, "r", encoding="utf-8") as f:
                plan_content = f.read()
                
            if not re.search(r"^STATUS:\s*READY", plan_content, re.MULTILINE):
                print("Blocked: 'docs/PLAN.md' status is not READY.", file=sys.stderr)
                return 2
                
            # 6.2 [Ported] Target-Credential Alignment Check
            # 这里的 Python 实现比 Bash 更稳健
            target_match = False
            in_target_section = False
            
            for line in plan_content.splitlines():
                if line.startswith("## Target Files"):
                    in_target_section = True
                    continue
                if line.startswith("## ") and in_target_section:
                    in_target_section = False
                    break
                
                if in_target_section and line.strip().startswith("-"):
                    # 提取路径并规范化
                    target_path = line.strip()[1:].strip()
                    # 简单规范化，去掉可能的 ./ 或引号
                    target_path = target_path.strip("'").strip('"')
                    if target_path.startswith("./"): target_path = target_path[2:]
                    
                    # 匹配逻辑：前缀匹配 (目录) 或 精确匹配 (文件)
                    if rel == target_path or rel.startswith(target_path):
                        target_match = True
                        break
            
            if not target_match:
                print("⛔ Blocked: Semantic Guardrail Triggered", file=sys.stderr)
                print(f"Reason: Target file '{rel}' is NOT declared in 'docs/PLAN.md'.", file=sys.stderr)
                return 2

        if require_audit:
            if not os.path.isfile(audit_path):
                print("Blocked: risk edit requires docs/AUDIT.md.", file=sys.stderr)
                return 2
            with open(audit_path, "r", encoding="utf-8") as handle:
                if not re.search(r"^RESULT:\s*PASS\b", handle.read(), re.MULTILINE):
                    print("Blocked: docs/AUDIT.md must contain 'RESULT: PASS'.", file=sys.stderr)
                    return 2

    return 0

# --- Main Entry Point ---

def main(argv):
    try:
        args = parse_args(argv)
    except SystemExit:
        print("Usage: hook_runner.py --hook <name>", file=sys.stderr)
        return 2

    payload = read_input_json()
    hook = args.hook
    
    # Start Telemetry
    start_time = _dt.datetime.now()
    status = "SUCCESS"
    err = None
    
    try:
        project_dir = resolve_project_dir(payload)

        handlers = {
            "pre_ask_user_gate": lambda: pre_ask_user_gate(payload, project_dir),
            "pre_write_gate": lambda: pre_write_gate(payload, project_dir),
            "audit_log": lambda: audit_log(payload, project_dir),
            "post_write_checks": lambda: post_write_checks(payload, project_dir),
            "session_init": lambda: session_init(payload, project_dir),
            "user_prompt_context": lambda: user_prompt_context(payload, project_dir),
            "statusline": lambda: statusline(payload, project_dir),
            "stop_evolution_update": lambda: stop_evolution_update(payload, project_dir),
            "subagent_complete": lambda: subagent_complete(payload, project_dir),
            "precompact_checkpoint": lambda: precompact_checkpoint(payload, project_dir),
            "shellcheck_guard": lambda: shellcheck_guard(payload, project_dir),
            "sync_user_context": lambda: sync_user_context(payload, project_dir), # New
            "sync_agent_context": lambda: sync_agent_context(payload, project_dir), # New
            "subagent_init_map": lambda: subagent_init_map(payload, project_dir), # New
            "subagent_onboarding": lambda: subagent_onboarding(payload, project_dir), # New
            "emit_signal": lambda: emit_signal(payload, project_dir), # New
        }

        handler = handlers.get(hook)
        if handler is None:
            print(f"Unknown hook: {hook}", file=sys.stderr)
            return 2

        rc = handler()
        if rc == 0:
            status = "SUCCESS"
        elif rc == 2:
            status = "BLOCKED"
        else:
            status = "ERROR"
        return rc
        
    except Exception as e:
        status = "ERROR"
        err = e
        print(f"Hook '{hook}' crashed: {e}", file=sys.stderr)
        traceback.print_exc()
        return 1
        
    finally:
        # End Telemetry
        duration = (_dt.datetime.now() - start_time).total_seconds() * 1000
        log_telemetry(hook, status, duration, err)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
