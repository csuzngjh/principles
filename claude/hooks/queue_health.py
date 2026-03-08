#!/usr/bin/env python3
"""
Queue Health Monitor
Phase 3.1: 队列健康度监控
监控进化队列状态，检测异常模式（队列堵塞、重试风暴等）
"""
import datetime as _dt
import logging

try:
    from hooks.evolution_queue import _load_queue, QUEUE_OPEN_STATES, QUEUE_MAX_SIZE
    from hooks.io_utils import _coerce_int, _parse_iso_datetime
except ImportError:
    try:
        from evolution_queue import _load_queue, QUEUE_OPEN_STATES, QUEUE_MAX_SIZE
        from io_utils import _coerce_int, _parse_iso_datetime
    except ImportError:
        pass

__all__ = [
    "assess_queue_health",
    "detect_queue_anomalies",
]

def assess_queue_health(project_dir):
    """
    评估队列健康状态
    返回: {"status": "healthy|warning|critical", "metrics": {...}, "issues": [...]}
    """
    queue = _load_queue(project_dir)
    now = _dt.datetime.now()
    
    metrics = {
        "total_tasks": len(queue),
        "pending_tasks": 0,
        "retrying_tasks": 0,
        "failed_tasks": 0,
        "stale_tasks": 0,
        "high_priority_blocked": 0,
    }
    
    issues = []
    
    for task in queue:
        status = str(task.get("status", "")).lower()
        
        if status == "pending":
            metrics["pending_tasks"] += 1
        elif status == "retrying":
            metrics["retrying_tasks"] += 1
        elif status == "failed":
            metrics["failed_tasks"] += 1
        
        # 检测陈旧任务（超过 24 小时未处理）
        first_seen = task.get("first_seen")
        if first_seen:
            first_dt = _parse_iso_datetime(first_seen)
            if first_dt:
                hours_old = (now - first_dt).total_seconds() / 3600
                if hours_old > 24:
                    metrics["stale_tasks"] += 1
        
        # 检测高优先级阻塞
        if status in QUEUE_OPEN_STATES:
            priority = _coerce_int(task.get("priority"), 50)
            if priority >= 80:
                metrics["high_priority_blocked"] += 1
    
    # 判断健康状态
    status = "healthy"
    
    # 队列接近满载
    if metrics["total_tasks"] >= QUEUE_MAX_SIZE * 0.9:
        issues.append(f"Queue near capacity: {metrics['total_tasks']}/{QUEUE_MAX_SIZE}")
        status = "critical"
    elif metrics["total_tasks"] >= QUEUE_MAX_SIZE * 0.7:
        issues.append(f"Queue usage high: {metrics['total_tasks']}/{QUEUE_MAX_SIZE}")
        status = "warning"
    
    # 重复失败
    if metrics["failed_tasks"] >= 10:
        issues.append(f"Too many failed tasks: {metrics['failed_tasks']}")
        status = "critical" if metrics["failed_tasks"] >= 20 else "warning"
    
    # 陈旧任务堆积
    if metrics["stale_tasks"] >= 5:
        issues.append(f"Stale tasks detected: {metrics['stale_tasks']}")
        status = "warning"
    
    # 高优先级阻塞
    if metrics["high_priority_blocked"] >= 3:
        issues.append(f"High-priority tasks blocked: {metrics['high_priority_blocked']}")
        status = "critical" if metrics["high_priority_blocked"] >= 5 else "warning"
    
    return {
        "status": status,
        "metrics": metrics,
        "issues": issues,
        "timestamp": now.isoformat()
    }

def detect_queue_anomalies(project_dir):
    """
    检测队列异常模式
    - 重试风暴：短时间内大量重试
    - 任务重复：相同 fingerprint 任务过多
    - 优先级倒挂：低优先级任务阻塞高优先级
    """
    queue = _load_queue(project_dir)
    now = _dt.datetime.now()
    
    anomalies = []
    
    # 检测重试风暴
    recent_retries = []
    for task in queue:
        if str(task.get("status", "")).lower() == "retrying":
            next_retry = task.get("next_retry_at")
            if next_retry:
                retry_dt = _parse_iso_datetime(next_retry)
                if retry_dt and (retry_dt - now).total_seconds() < 300:  # 5分钟内
                    recent_retries.append(task)
    
    if len(recent_retries) >= 5:
        anomalies.append({
            "type": "retry_storm",
            "severity": "high",
            "count": len(recent_retries),
            "description": f"{len(recent_retries)} tasks will retry within 5 minutes"
        })
    
    # 检测任务重复
    fingerprint_counts = {}
    for task in queue:
        if str(task.get("status", "")).lower() in QUEUE_OPEN_STATES:
            fp = task.get("fingerprint", "")
            if fp:
                fingerprint_counts[fp] = fingerprint_counts.get(fp, 0) + 1
    
    for fp, count in fingerprint_counts.items():
        if count >= 3:
            anomalies.append({
                "type": "duplicate_tasks",
                "severity": "medium",
                "fingerprint": fp,
                "count": count,
                "description": f"Task fingerprint appears {count} times (possible dedup issue)"
            })
    
    # 检测优先级倒挂（低优先级在高优先级前面）
    open_tasks = [t for t in queue if str(t.get("status", "")).lower() in QUEUE_OPEN_STATES]
    for i in range(len(open_tasks) - 1):
        curr_priority = _coerce_int(open_tasks[i].get("priority"), 50)
        next_priority = _coerce_int(open_tasks[i + 1].get("priority"), 50)
        
        if next_priority > curr_priority + 20:  # 显著优先级差异
            anomalies.append({
                "type": "priority_inversion",
                "severity": "low",
                "description": f"Task {i+1} has priority {next_priority} but follows task with priority {curr_priority}"
            })
            break  # 只报告第一个倒挂
    
    return anomalies
