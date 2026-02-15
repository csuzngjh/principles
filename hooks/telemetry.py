#!/usr/bin/env python3
"""
Telemetry Module  
提取自 hook_runner.py 的遥测和日志相关函数
包括：遥测记录、队列状态格式化、周状态格式化
"""
import os
import json
import logging
import datetime as _dt

# 导入基础工具
try:
    from hooks.io_utils import _coerce_int, _parse_iso_datetime
    from hooks.evolution_queue import _load_queue, QUEUE_OPEN_STATES
    from hooks.week_lifecycle import _load_week_state
except ImportError:
    try:
        from io_utils import _coerce_int, _parse_iso_datetime
        from evolution_queue import _load_queue, QUEUE_OPEN_STATES
        from week_lifecycle import _load_week_state
    except ImportError:
        pass

__all__ = [
    "log_telemetry",
    "_format_queue_status",
    "_format_week_status",
    "_update_workboard",
]

# --- Logging Configuration ---

PROJECT_ROOT = os.getcwd()
LOG_FILE = os.path.join(PROJECT_ROOT, "docs", "SYSTEM.log")

logging.basicConfig(
    filename=LOG_FILE,
    level=logging.INFO,
    format="[%(asctime)s] [%(levelname)s] [%(funcName)s] %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S"
)

# --- Telemetry Functions ---

def log_telemetry(hook_name, status, duration=0, error=None):
    """统一遥测记录"""
    record = {
        "time": _dt.datetime.now().isoformat(),
        "hook": hook_name,
        "status": status,
        "duration_ms": int(duration * 1000) if duration else 0
    }
    
    if error:
        record["error"] = str(error)
    
    if status == "success":
        logging.info(f"[{hook_name}] Completed in {duration:.3f}s")
    elif status == "error":
        logging.error(f"[{hook_name}] Failed: {error}")
    else:
        logging.warning(f"[{hook_name}] Status: {status}")

def _format_queue_status(project_dir, now=None):
    """格式化队列状态为紧凑字符串"""
    now = now or _dt.datetime.now()
    queue = _load_queue(project_dir)
    
    pending = [t for t in queue if str(t.get("status", "")).lower() == "pending"]
    retrying = [t for t in queue if str(t.get("status", "")).lower() == "retrying"]
    
    if not pending and not retrying:
        return "Queue:Empty"
    
    parts = []
    if pending:
        parts.append(f"Pending:{len(pending)}")
    
    if retrying:
        # 找到下次重试时间
        next_retry_times = []
        for task in retrying:
            next_retry_str = task.get("next_retry_at")
            if next_retry_str:
                next_dt = _parse_iso_datetime(next_retry_str)
                if next_dt:
                    next_retry_times.append(next_dt)
        
        if next_retry_times:
            earliest = min(next_retry_times)
            delta_seconds = int((earliest - now).total_seconds())
            if delta_seconds > 0:
                parts.append(f"Retry:{len(retrying)}(in {delta_seconds}s)")
            else:
                parts.append(f"Retry:{len(retrying)}(due)")
        else:
            parts.append(f"Retry:{len(retrying)}")
    
    return " ".join(parts)

def _format_week_status(project_dir):
    """格式化周状态为紧凑字符串"""
    state, _, week_exists = _load_week_state(project_dir)
    
    if not week_exists:
        return "Week:Unplanned"
    
    stage = str(state.get("stage") or "UNPLANNED").upper()
    execution = state.get("execution") or {}
    completed = _coerce_int(execution.get("completed_events"), 0)
    blocked = _coerce_int(execution.get("blocked_events"), 0)
    
    parts = [f"Week:{stage}"]
    
    if stage == "EXECUTING":
        parts.append(f"Done:{completed}")
        if blocked > 0:
            parts.append(f"Block:{blocked}")
    
    return " ".join(parts)

def _update_workboard(project_dir, event):
    """更新工作看板状态"""
    docs_dir = os.path.join(project_dir, "docs")
    os.makedirs(docs_dir, exist_ok=True)
    workboard_path = os.path.join(docs_dir, "WORKBOARD.json")
    board = {"events": []}

    if os.path.isfile(workboard_path):
        try:
            with open(workboard_path, "r", encoding="utf-8") as handle:
                data = json.load(handle)
            if isinstance(data, dict):
                board = data
        except Exception:
            pass

    events = board.setdefault("events", [])
    if not isinstance(events, list):
        events = []
    events.append(event)
    board["events"] = events[-200:]
    board["updated_at"] = _dt.datetime.now().isoformat()

    with open(workboard_path, "w", encoding="utf-8") as handle:
        json.dump(board, handle, ensure_ascii=False, indent=2)
