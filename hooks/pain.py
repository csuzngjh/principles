#!/usr/bin/env python3
"""
Pain Detection Module
提取自 hook_runner.py 的痛苦检测和评分相关函数
包括：软痛苦信号检测、自适应阈值、痛苦分数计算、痛苦标志读写
"""
import os
import json
import logging
import datetime as _dt

# 导入基础工具
try:
    from hooks.io_utils import _read_text_file, _parse_kv_lines, _serialize_kv_lines, _plan_status, _coerce_int, _parse_iso_datetime
    from hooks.profile import PROFILE_TEST_LEVELS
    from hooks.evolution_queue import _load_queue, QUEUE_OPEN_STATES
    from hooks.debug_utils import debug_log, debug_stderr, debug_enabled
except ImportError:
    # Fallback处理
    pass

__all__ = [
    "_effective_soft_capture_threshold",
    "_detect_soft_pain_signals",
    "_compute_pain_score",
    "_pain_severity_label",
    "_pain_flag_path",
    "_write_pain_flag",
    "_read_pain_flag_data",
    "_append_issue_from_pain",
]

def _pain_flag_path(project_dir):
    return os.path.join(project_dir, "docs", ".pain_flag")

def _write_pain_flag(project_dir, pain_data):
    pain_flag = _pain_flag_path(project_dir)
    os.makedirs(os.path.dirname(pain_flag), exist_ok=True)
    with open(pain_flag, "w", encoding="utf-8") as f:
        f.write(_serialize_kv_lines(pain_data))

def _read_pain_flag_data(project_dir):
    pain_flag = _pain_flag_path(project_dir)
    if not os.path.isfile(pain_flag):
        return {}
    return _parse_kv_lines(_read_text_file(pain_flag))

def _effective_soft_capture_threshold(profile, project_dir):
    """计算有效的软捕获阈值（根据最近的成功/失败动态调整）"""
    pain_cfg = (profile or {}).get("pain", {})
    base_threshold = _coerce_int(pain_cfg.get("soft_capture_threshold"), 30)
    adaptive_cfg = pain_cfg.get("adaptive", {})
    
    import sys
    debug_stderr(f"Start effective threshold. Keys: {list(pain_cfg.keys())}, Adaptive: {adaptive_cfg}")

    if not adaptive_cfg.get("enabled", True):
        return base_threshold, {
            "base": base_threshold,
            "adaptive_enabled": False,
            "reasons": []
        }
    
    # 不对称参数：收紧力度是放松的 10 倍
    spiral_boost = _coerce_int(adaptive_cfg.get("spiral_boost"), 20) * 2
    low_success_boost = _coerce_int(adaptive_cfg.get("low_recent_success_boost"), 15) // 5
    high_pain_boost = _coerce_int(adaptive_cfg.get("high_recent_pain_boost"), 10) * 2
    
    reasons = []  # Formerly adjustments, renamed for test compat
    effective = base_threshold
    
    # 0. Queue Backlog Check (Restored Logic)
    queue = _load_queue(project_dir)
    # Using hardcoded open states if import failed, though it shouldn't
    open_states = {"pending", "retrying", "in_progress"}
    try:
        from hooks.evolution_queue import QUEUE_OPEN_STATES
        if QUEUE_OPEN_STATES:
            open_states = QUEUE_OPEN_STATES
    except ImportError:
        pass
        
    pending_count = len([t for t in queue if str(t.get("status", "")).lower() in open_states])
    backlog_trigger = _coerce_int(adaptive_cfg.get("backlog_trigger"), 6)
    
    # Debug log (only when PRINCIPLES_DEBUG=1)
    debug_log(f"Queue pending={pending_count}, trigger={backlog_trigger}, items={len(queue)}", "pain_debug.txt", project_dir)

    if pending_count >= backlog_trigger:
        effective = max(10, min(effective, _coerce_int(adaptive_cfg.get("min_threshold"), 15)))
        reasons.append("backlog_pressure")

    # 1. Death Spiral Check (Strong Signal)
    import subprocess
    try:
        git_log = subprocess.check_output(
            ["git", "-C", project_dir, "log", "--oneline", "-n", "10"],
            text=True,
            stderr=subprocess.DEVNULL
        ).lower()
        
        import re
        SPIRAL_PATTERN = re.compile(r'\b(?:fix|fail|error|repair|patch|revert)\b', re.IGNORECASE)
        fix_count = len(SPIRAL_PATTERN.findall(git_log))
        
        if fix_count >= 3:
            effective -= spiral_boost
            reasons.append(f"death_spiral_detected_-{spiral_boost}")
    except Exception:
        pass
    
    # 2. Quiet Period Check
    issue_log_path = os.path.join(project_dir, "docs", "ISSUE_LOG.md")
    stable_weeks = 0
    if os.path.isfile(issue_log_path):
        try:
            content = _read_text_file(issue_log_path)
            recent_issues = [line for line in content.splitlines()[:30] if line.startswith("## [")]
            if len(recent_issues) == 0: stable_weeks = 3
            elif len(recent_issues) <= 2: stable_weeks = 2
            elif len(recent_issues) <= 5: stable_weeks = 1
            
            if stable_weeks >= 2:
                effective += low_success_boost
                reasons.append(f"stable_{stable_weeks}w_+{low_success_boost}")
        except Exception:
            pass
    
    # 3. High Pain Check
    pain_flag_data = _read_pain_flag_data(project_dir)
    if pain_flag_data:
        last_time = pain_flag_data.get("time", "")
        last_dt = _parse_iso_datetime(last_time)
        if last_dt:
            import datetime as _dt
            hours_since = (_dt.datetime.now() - last_dt).total_seconds() / 3600
            if hours_since < 24:
                effective -= high_pain_boost
                reasons.append(f"recent_pain_-{high_pain_boost}")
    
    # Limit Range
    max_threshold = _coerce_int(adaptive_cfg.get("max_threshold"), 70)
    min_threshold = _coerce_int(adaptive_cfg.get("min_threshold"), 15)
    effective = max(min_threshold, min(max_threshold, effective))
    
    return effective, {
        "base": base_threshold,
        "effective": effective,
        "adaptive_enabled": True,
        "reasons": reasons,
        "stable_weeks": stable_weeks
    }

def _detect_soft_pain_signals(project_dir, file_path, risky, test_level):
    """检测软痛苦信号（警示但不致命的问题）"""
    signals = []
    score = 0
    
    plan_status = _plan_status(project_dir)
    audit_path = os.path.join(project_dir, "docs", "AUDIT.md")
    audit_status = ""
    
    if os.path.isfile(audit_path):
        audit_content = _read_text_file(audit_path)
        for line in audit_content.splitlines():
            if line.startswith("STATUS:"):
                audit_status = line.split(":", 1)[1].strip().split()[0] if len(line.split(":", 1)) > 1 else ""
                break
    
    # 信号1：风险路径但 PLAN 未就绪
    if risky and plan_status in ("", "DRAFT", "IN_PROGRESS"):
        signals.append("plan_not_ready_on_risky_write")
        score += 20
    
    # 信号2：AUDIT 不通过
    if audit_status == "BLOCK":
        signals.append("audit_blocked")
        score += 25
    
    # 信号3：测试级别降级
    if test_level not in PROFILE_TEST_LEVELS:
        signals.append("invalid_test_level")
        score += 10
    
    # 信号4：缺少测试命令
    if not test_level or test_level == "skip":
        signals.append("missing_test_coverage")
        score += 15
    
    return signals, score

def _compute_pain_score(rc, is_spiral, missing_test_command, soft_score):
    """计算总痛苦分数（0-100）"""
    score = max(0, _coerce_int(soft_score, 0))
    
    if rc != 0:
        score += 70
    
    if is_spiral:
        score += 40
    
    if missing_test_command:
        score += 30
    
    return min(100, score)

def _pain_severity_label(pain_score, is_spiral=False):
    """将痛苦分数映射为严重性标签"""
    if is_spiral:
        return "critical"
    elif pain_score >= 70:
        return "high"
    elif pain_score >= 40:
        return "medium"
    elif pain_score >= 20:
        return "low"
    else:
        return "info"

def _append_issue_from_pain(issue_log_path, decisions_path, pain_content):
    """将痛苦信号追加到 Issue Log"""
    ts = _dt.datetime.now().isoformat()
    title_snippet = " ".join(pain_content.splitlines()[:6])[:80]
    title = f"Pain detected - {title_snippet}".strip()

    with open(issue_log_path, "a", encoding="utf-8") as handle:
        handle.write(
            f"\n## [{ts}] {title}\n\n### Pain Signal (auto-captured)\n```\n{pain_content}\n```\n\n"
            "### Diagnosis (Pending)\n- Run /evolve-task to diagnose.\n"
        )
    
    # Optional: also log to decisions
    if decisions_path:
        with open(decisions_path, "a", encoding="utf-8") as handle:
            handle.write(f"\n## [{ts}] Decision checkpoint\n- Pain flag detected; IssueLog entry appended.\n")
