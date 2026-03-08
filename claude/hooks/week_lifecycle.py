#!/usr/bin/env python3
"""
Week Lifecycle Module
提取自 hook_runner.py 的周生命周期管理相关函数
包括：周状态机、心跳检测、事件日志、中断恢复
"""
import os
import json
import datetime as _dt
import logging

# 导入基础工具
try:
    from hooks.io_utils import _read_text_file, _coerce_int, _parse_iso_datetime
    from hooks.debug_utils import debug_log, debug_stderr, debug_enabled
except ImportError:
    try:
        from io_utils import _read_text_file, _coerce_int, _parse_iso_datetime
        from debug_utils import debug_log, debug_stderr, debug_enabled
    except ImportError:
        pass

__all__ = [
    "WEEK_STAGES",
    "_week_state_path",
    "_week_events_path",
    "_current_week_id",
    "_default_week_state",
    "_normalize_week_state",
    "_load_week_state",
    "_save_week_state",
    "_append_week_event",
    "_read_week_events",
    "_week_lock_is_valid",
    "_record_execution_heartbeat",
    "_mark_week_interrupted_if_stale",
]

# --- Constants ---

WEEK_STAGES = {
    "UNPLANNED",
    "DRAFT",
    "CHALLENGE",
    "PENDING_OWNER_APPROVAL",
    "LOCKED",
    "EXECUTING",
    "REVIEW",
    "CLOSED",
    "INTERRUPTED",
}

# --- Helper Functions ---

def _week_state_path(project_dir):
    return os.path.join(project_dir, "docs", "okr", "WEEK_STATE.json")

def _week_events_path(project_dir):
    return os.path.join(project_dir, "docs", "okr", "WEEK_EVENTS.jsonl")

def _current_week_id(now=None):
    """获取当前周 ID（格式：2024-W01）"""
    now = now or _dt.datetime.now()
    iso_year, iso_week, _ = now.isocalendar()
    return f"{iso_year}-W{iso_week:02d}"

def _default_week_state(now=None):
    """生成默认周状态"""
    return {
        "week_id": _current_week_id(now),
        "stage": "UNPLANNED",
        "owner_approved": False,
        "locked_at": None,
        "execution": {
            "completed_events": 0,
            "blocked_events": 0,
            "heartbeat_count": 0,
            "last_heartbeat": None,
        },
        "interruption": None,
    }

def _normalize_week_state(raw_state, now=None):
    """归一化周状态"""
    now = now or _dt.datetime.now()
    current_week = _current_week_id(now)
    
    if not isinstance(raw_state, dict):
        return _default_week_state(now)
    
    state = _default_week_state(now)
    
    # week_id
    week_id = raw_state.get("week_id")
    if isinstance(week_id, str) and week_id:
        state["week_id"] = week_id
    
    # stage
    stage = str(raw_state.get("stage") or "UNPLANNED").upper()
    if stage in WEEK_STAGES:
        state["stage"] = stage
    
    # owner_approved
    state["owner_approved"] = bool(raw_state.get("owner_approved"))
    
    # locked_at
    locked_at = raw_state.get("locked_at")
    if isinstance(locked_at, str):
        state["locked_at"] = locked_at
    
    # execution
    raw_exec = raw_state.get("execution", {})
    if isinstance(raw_exec, dict):
        exec_data = state["execution"]
        exec_data["completed_events"] = _coerce_int(raw_exec.get("completed_events"), 0)
        exec_data["blocked_events"] = _coerce_int(raw_exec.get("blocked_events"), 0)
        exec_data["heartbeat_count"] = _coerce_int(raw_exec.get("heartbeat_count"), 0)
        
        last_heartbeat = raw_exec.get("last_heartbeat")
        if isinstance(last_heartbeat, str):
            exec_data["last_heartbeat"] = last_heartbeat
    
    # interruption
    interruption = raw_state.get("interruption")
    if isinstance(interruption, dict):
        state["interruption"] = interruption
    
    return state

def _load_week_state(project_dir):
    """加载周状态（返回 state, path, exists）"""
    path = _week_state_path(project_dir)
    if not os.path.isfile(path):
        return _default_week_state(), path, False
    
    try:
        with open(path, "r", encoding="utf-8") as f:
            raw_state = json.load(f)
        return _normalize_week_state(raw_state), path, True
    except Exception:
        return _default_week_state(), path, False

def _save_week_state(project_dir, state):
    """保存周状态"""
    path = _week_state_path(project_dir)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)

def _append_week_event(project_dir, event_type, payload=None):
    """追加周事件日志"""
    path = _week_events_path(project_dir)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    
    event = {
        "time": _dt.datetime.now().isoformat(),
        "type": event_type,
        "payload": payload or {}
    }
    
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(event, ensure_ascii=False) + "\n")

def _read_week_events(project_dir, limit=50):
    """读取最近的周事件"""
    path = _week_events_path(project_dir)
    if not os.path.isfile(path):
        return []
    
    events = []
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    event = json.loads(line)
                    events.append(event)
    except Exception:
        pass
    
    return events[-limit:] if limit > 0 else events

def _week_lock_is_valid(state, lifecycle_cfg):
    """检查周锁是否有效"""
    import sys
    
    if not lifecycle_cfg.get("enabled", True):
        return True
    
    stage = str(state.get("stage") or "").upper()
    lock = state.get("lock") or {}
    locked = bool(lock.get("locked"))
    # 必须处于受控状态或已锁定
    result = stage in {"LOCKED", "EXECUTING", "REVIEW", "CLOSED"} or locked

    return result

def _record_execution_heartbeat(project_dir, profile, payload, file_path):
    """记录执行心跳"""
    debug_log(f"Heartbeat called for {file_path}", "lifecycle_debug.txt", project_dir)

    lifecycle = (profile or {}).get("lifecycle", {})
    if not lifecycle.get("enabled", True):
        return
    
    state, _, _ = _load_week_state(project_dir)
    stage = str(state.get("stage") or "").upper()
    
    # Auto-start execution if Locked
    if stage == "LOCKED":
        state["stage"] = "EXECUTING"
        stage = "EXECUTING"
        
    if stage not in {"EXECUTING", "REVIEW"}:
         return

    execution = state.get("execution") or {}
    
    execution["heartbeat_count"] = int(execution.get("heartbeat_count") or 0) + 1
    execution["last_heartbeat"] = _dt.datetime.now().isoformat()
    state["execution"] = execution
    
    _save_week_state(project_dir, state)
    
    _append_week_event(project_dir, "heartbeat", {
        "file_path": file_path,
        "tool": payload.get("tool_name", "")
    })

def _mark_week_interrupted_if_stale(project_dir, profile):
    """检查是否心跳过期，标记为中断"""
    lifecycle = (profile or {}).get("lifecycle", {})
    if not lifecycle.get("enabled", True):
        return None
    
    state, _, week_exists = _load_week_state(project_dir)
    stage = str(state.get("stage") or "").upper()

    if stage not in {"LOCKED", "EXECUTING", "REVIEW"}:
        return None
    
    execution = state.get("execution") or {}
    last_heartbeat = execution.get("last_heartbeat")
    if not last_heartbeat:
        return None
    
    last_dt = _parse_iso_datetime(last_heartbeat)
    if not last_dt:
        return None
    
    stale_hours = _coerce_int(lifecycle.get("heartbeat_stale_hours"), 72)
    now = _dt.datetime.now()
    hours_since = (now - last_dt).total_seconds() / 3600
    
    if hours_since > stale_hours:
        state["stage"] = "INTERRUPTED"
        state["interruption"] = {
            "reason": f"No heartbeat for {int(hours_since)} hours",
            "interrupted_at": now.isoformat(),
            "last_heartbeat": last_heartbeat,
            "active": True
        }
        _save_week_state(project_dir, state)
        _append_week_event(project_dir, "interrupted", state["interruption"])
        return state
    
    return None
