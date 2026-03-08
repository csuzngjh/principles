#!/usr/bin/env python3
"""
Evolution Queue Module
提取自 hook_runner.py 的进化队列管理相关函数
包括：队列 CRUD、任务入队、优先级计算、指纹去重
"""
import os
import json
import uuid
import datetime as _dt
import logging

# 导入基础工具
try:
    from hooks.io_utils import _coerce_int
except ImportError:
    try:
        from io_utils import _coerce_int
    except ImportError:
        def _coerce_int(value, default=0):
            try:
                return int(value)
            except Exception:
                return default

__all__ = [
    "QUEUE_OPEN_STATES",
    "QUEUE_MAX_SIZE",
    "_queue_file",
    "_compute_task_priority",
    "_task_fingerprint",
    "_retry_backoff_seconds",
    "_next_retry_at",
    "_queue_sort_key",
    "_write_queue",
    "enqueue_evolution_task",
    "_load_queue",
    "_has_open_evolution_tasks",
]

# --- Constants ---

QUEUE_OPEN_STATES = {"pending", "processing", "retrying"}
QUEUE_MAX_SIZE = 300

# --- Helper Functions ---

def _queue_file(project_dir=None):
    """获取队列文件路径"""
    if project_dir:
        return os.path.join(project_dir, "docs", "EVOLUTION_QUEUE.json")
    # Fallback（仅在独立模式下）
    return os.path.join(os.getcwd(), "docs", "EVOLUTION_QUEUE.json")

def _compute_task_priority(task_type, details):
    """计算任务优先级（0-100，越高越优先）"""
    details = details or {}
    
    # Death Spiral: 最高优先级
    if details.get("is_spiral"):
        return 100
    
    # 测试失败
    if task_type == "test_failure":
        exit_code = _coerce_int(details.get("exit_code"), 0)
        if exit_code != 0:
            return 90
        return 80
    
    # 缺少测试命令
    if details.get("missing_test_command"):
        return 70
    
    # 质量信号
    if task_type == "quality_signal":
        pain_score = _coerce_int(details.get("pain_score"), 0)
        if pain_score >= 70:
            return 65
        elif pain_score >= 40:
            return 55
        else:
            return 45
    
    # 默认优先级
    return 50

def _task_fingerprint(task_type, details):
    """生成任务指纹，用于去重"""
    details = details or {}
    file_path = details.get("file_path", "")
    tool_name = details.get("tool_name", "")
    exit_code = details.get("exit_code", "")
    
    # 使用稳定的字段组合生成指纹
    parts = [task_type, file_path, tool_name, str(exit_code)]
    return "|".join(parts)

def _retry_backoff_seconds(retry_count):
    """计算重试退避时间（指数退避）"""
    base = 15
    max_seconds = 900  # 15 分钟
    backoff = base * (2 ** retry_count)
    return min(backoff, max_seconds)

def _next_retry_at(retry_count, now=None):
    """计算下次重试时间"""
    now = now or _dt.datetime.now()
    backoff = _retry_backoff_seconds(retry_count)
    next_time = now + _dt.timedelta(seconds=backoff)
    return next_time.isoformat()

def _queue_sort_key(task):
    """队列排序键：开放任务优先，然后按优先级和时间"""
    status = str(task.get("status") or "").lower()
    open_rank = 0 if status in QUEUE_OPEN_STATES else 1
    priority = -_coerce_int(task.get("priority"), 50)  # 负数使高优先级排前
    
    # 时间排序：优先使用 next_retry_at，其次 first_seen，最后 timestamp
    time_str = task.get("next_retry_at") or task.get("first_seen") or task.get("timestamp") or ""
    
    return (open_rank, priority, time_str)

def _write_queue(queue, project_dir):
    """写入队列文件（排序并限制大小）"""
    queue_file = _queue_file(project_dir)
    os.makedirs(os.path.dirname(queue_file), exist_ok=True)
    ordered = sorted(queue, key=_queue_sort_key)[:QUEUE_MAX_SIZE]
    with open(queue_file, "w", encoding="utf-8") as f:
        json.dump(ordered, f, ensure_ascii=False, indent=2)

def enqueue_evolution_task(task_type, details, project_dir):
    """将进化工单推入队列（带去重和合并逻辑）"""
    try:
        queue = []
        queue_file = _queue_file(project_dir)
        if os.path.isfile(queue_file):
            with open(queue_file, "r", encoding="utf-8") as f:
                data = json.load(f)
                if isinstance(data, list):
                    queue = data

        now = _dt.datetime.now()
        details = details or {}
        priority = _compute_task_priority(task_type, details)
        fingerprint = _task_fingerprint(task_type, details)

        # 检查是否已有相同任务（去重 + 合并）
        for task in queue:
            status = str(task.get("status") or "").lower()
            if status not in QUEUE_OPEN_STATES:
                continue
            if str(task.get("fingerprint") or "") != fingerprint:
                continue
            
            # 找到相同任务，更新详情和优先级
            task["details"] = details
            task["priority"] = max(int(task.get("priority") or 0), priority)
            task["occurrences"] = int(task.get("occurrences") or 1) + 1
            task["last_seen"] = now.isoformat()
            
            if status == "retrying":
                retry_count = int(task.get("retry_count") or 0)
                task["next_retry_at"] = _next_retry_at(retry_count, now)
            
            _write_queue(queue, project_dir)
            return task.get("id")

        # 创建新任务
        task_id = f"evt-{now.strftime('%Y%m%d-%H%M%S-%f')}-{uuid.uuid4().hex[:6]}"
        new_task = {
            "id": task_id,
            "timestamp": now.isoformat(),
            "type": task_type,
            "details": details,
            "status": "pending",
            "retry_count": 0,
            "priority": priority,
            "fingerprint": fingerprint,
            "occurrences": 1,
            "first_seen": now.isoformat(),
            "last_seen": now.isoformat(),
            "next_retry_at": _next_retry_at(0, now),
            "retry_policy": {
                "base_seconds": 15,
                "max_seconds": 900,
            },
        }
        queue.append(new_task)
        _write_queue(queue, project_dir)
        return task_id
    except Exception as e:
        logging.error(f"Failed to enqueue task: {e}")
        return None

def _load_queue(project_dir=None):
    """加载进化队列"""
    queue_file = _queue_file(project_dir)
    if not os.path.isfile(queue_file):
        return []
    try:
        with open(queue_file, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, list):
            return data
    except Exception:
        pass
    return []

def _has_open_evolution_tasks(project_dir=None):
    """检查是否有待处理的进化任务"""
    for task in _load_queue(project_dir):
        if str(task.get("status", "")).lower() in QUEUE_OPEN_STATES:
            return True
    return False
