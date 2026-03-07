#!/usr/bin/env python3
import json
import os
import subprocess
import time
import datetime as _dt
import sys
import logging

# 配置路径
PROJECT_ROOT = os.getcwd()
QUEUE_FILE = os.path.join(PROJECT_ROOT, "docs", "EVOLUTION_QUEUE.json")
PRD_FILE = os.path.join(PROJECT_ROOT, "docs", "EVOLUTION_PRD.md")
SKILLS_DIR = os.path.join(PROJECT_ROOT, "skills")
OPEN_STATES = {"pending", "processing", "retrying"}
DEFAULT_PRIORITY = 50
DEFAULT_RETRY_POLICY = {
    "base_seconds": 15,
    "max_seconds": 900,
    "max_attempts": 5,
}

# 日志设置
logging.basicConfig(level=logging.INFO, format='[%(asctime)s] %(levelname)s: %(message)s')

def load_queue():
    if not os.path.isfile(QUEUE_FILE): return []
    with open(QUEUE_FILE, "r", encoding="utf-8") as f:
        return json.load(f)

def save_queue(queue):
    ordered = sorted(queue, key=_queue_sort_key)
    with open(QUEUE_FILE, "w", encoding="utf-8") as f:
        json.dump(ordered, f, ensure_ascii=False, indent=2)

def _safe_int(value, default=0):
    try:
        return int(value)
    except Exception:
        return default

def _parse_iso_dt(value):
    if not isinstance(value, str) or not value:
        return None
    try:
        return _dt.datetime.fromisoformat(value)
    except Exception:
        return None

def _infer_priority(task):
    task_type = task.get("type")
    details = task.get("details") or {}
    if details.get("is_spiral"):
        return 100
    if task_type == "test_failure":
        if _safe_int(details.get("exit_code"), 0) != 0:
            return 90
        return 80
    if details.get("missing_test_command"):
        return 70
    return DEFAULT_PRIORITY

def _normalize_retry_policy(task):
    raw = task.get("retry_policy")
    policy = dict(DEFAULT_RETRY_POLICY)
    if isinstance(raw, dict):
        policy["base_seconds"] = max(1, _safe_int(raw.get("base_seconds"), policy["base_seconds"]))
        policy["max_seconds"] = max(policy["base_seconds"], _safe_int(raw.get("max_seconds"), policy["max_seconds"]))
        policy["max_attempts"] = max(1, _safe_int(raw.get("max_attempts"), policy["max_attempts"]))
    task["retry_policy"] = policy
    return policy

def _retry_wait_seconds(task):
    retry_count = max(1, _safe_int(task.get("retry_count"), 1))
    policy = _normalize_retry_policy(task)
    return min(policy["max_seconds"], policy["base_seconds"] * (2 ** (retry_count - 1)))

def _next_retry_at(task, now):
    return (now + _dt.timedelta(seconds=_retry_wait_seconds(task))).isoformat()

def normalize_task(task, now=None):
    if not isinstance(task, dict):
        return None

    now = now or _dt.datetime.now()
    task.setdefault("id", f"legacy-{int(now.timestamp())}")
    task["status"] = str(task.get("status") or "pending").lower()
    if task["status"] not in {"pending", "processing", "retrying", "completed", "failed"}:
        task["status"] = "pending"

    task["retry_count"] = max(0, _safe_int(task.get("retry_count"), 0))
    if "priority" not in task:
        task["priority"] = _infer_priority(task)
    task["priority"] = _safe_int(task.get("priority"), DEFAULT_PRIORITY)
    _normalize_retry_policy(task)

    timestamp = task.get("timestamp")
    if not isinstance(timestamp, str) or not timestamp:
        task["timestamp"] = now.isoformat()

    if task["status"] == "retrying":
        next_retry_at = _parse_iso_dt(task.get("next_retry_at"))
        if next_retry_at is None:
            task["next_retry_at"] = _next_retry_at(task, now)
    return task

def normalize_queue(queue, now=None):
    now = now or _dt.datetime.now()
    normalized = []
    for task in queue or []:
        item = normalize_task(task, now=now)
        if item is not None:
            normalized.append(item)
    return normalized

def _task_sort_time(task):
    for key in ("next_retry_at", "first_seen", "timestamp"):
        parsed = _parse_iso_dt(task.get(key))
        if parsed:
            return parsed
    return _dt.datetime.min

def _queue_sort_key(task):
    status = str(task.get("status") or "").lower()
    open_rank = 0 if status in OPEN_STATES else 1
    return (open_rank, -_safe_int(task.get("priority"), DEFAULT_PRIORITY), _task_sort_time(task))

def _is_retry_due(task, now):
    due_at = _parse_iso_dt(task.get("next_retry_at"))
    if due_at is None:
        return True
    return due_at <= now

def select_runnable_tasks(queue, now=None):
    now = now or _dt.datetime.now()
    runnable = []
    for task in normalize_queue(queue, now=now):
        status = task.get("status")
        if status == "pending":
            runnable.append(task)
        elif status == "retrying" and _is_retry_due(task, now):
            runnable.append(task)
    runnable.sort(key=_queue_sort_key)
    return runnable

def mark_task_failed(task, now=None):
    now = now or _dt.datetime.now()
    task["retry_count"] = max(0, _safe_int(task.get("retry_count"), 0)) + 1
    policy = _normalize_retry_policy(task)
    if task["retry_count"] >= policy["max_attempts"]:
        task["status"] = "failed"
        task.pop("next_retry_at", None)
        return

    task["status"] = "retrying"
    task["next_retry_at"] = _next_retry_at(task, now)

def process_queue_once(queue, process_fn=None, now=None, on_state_change=None):
    now = now or _dt.datetime.now()
    process_fn = process_fn or process_task
    runnable = select_runnable_tasks(queue, now=now)
    if not runnable:
        return False

    for task in runnable:
        task["status"] = "processing"
        task["started_at"] = now.isoformat()
        if on_state_change:
            on_state_change(queue)

        success = bool(process_fn(task))
        if success:
            task["status"] = "completed"
            task["completed_at"] = now.isoformat()
            task.pop("next_retry_at", None)
        else:
            mark_task_failed(task, now=now)

        if on_state_change:
            on_state_change(queue)
        logging.info("Task %s finished with status: %s", task.get("id"), task.get("status"))

    return True

def compute_next_wake_seconds(queue, now=None, idle_default=30):
    now = now or _dt.datetime.now()
    next_deltas = []
    for task in normalize_queue(queue, now=now):
        if str(task.get("status") or "").lower() != "retrying":
            continue
        due = _parse_iso_dt(task.get("next_retry_at"))
        if due is None:
            return 1
        delta = int((due - now).total_seconds())
        next_deltas.append(max(1, delta))

    if not next_deltas:
        return idle_default
    return min(idle_default, min(next_deltas))

def load_skill_prompt(skill_name):
    """从本地 skills 目录加载提示词"""
    skill_path = os.path.join(SKILLS_DIR, skill_name, "SKILL.md")
    if not os.path.isfile(skill_path):
        logging.warning(f"Skill {skill_name} not found at {skill_path}")
        return ""
    
    with open(skill_path, "r", encoding="utf-8") as f:
        content = f.read()
        # 简单去掉 YAML Frontmatter
        if content.startswith("---"):
            parts = content.split("---", 2)
            if len(parts) >= 3:
                return parts[2].strip()
        return content.strip()

def run_headless_claude(prompt, system_prompt="", allowed_tools="Read,Edit,Bash,Glob"):
    """调用 Headless Claude 模式"""
    cmd = ["claude", "-p", prompt]
    if system_prompt:
        # 使用 --append-system-prompt 保证项目特定规则生效
        cmd.extend(["--append-system-prompt", system_prompt])
    
    if allowed_tools:
        cmd.extend(["--allowedTools", allowed_tools])
    
    logging.info(f"Executing: {' '.join(cmd[:5])}...")
    try:
        result = subprocess.run(
            cmd, 
            capture_output=True, 
            text=True, 
            encoding="utf-8",
            timeout=300  # 5 分钟硬超时
        )
        if result.returncode != 0:
            logging.error(f"Claude failed: {result.stderr}")
            return None
        return result.stdout
    except subprocess.TimeoutExpired:
        logging.error("Claude execution timed out after 300s")
        return None
    except Exception as e:
        logging.error(f"Failed to run Claude: {e}")
        return None

def update_prd(task_id, phase, result):
    """更新状态看板"""
    ts = _dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    entry = f"\n### [{ts}] Task {task_id} - {phase}\n{result}\n---\n"
    
    mode = "a" if os.path.isfile(PRD_FILE) else "w"
    with open(PRD_FILE, mode, encoding="utf-8") as f:
        if mode == "w": f.write("# Evolution Progress Board\n")
        f.write(entry)

def _rollback_stash(stash_name):
    """回滚到指定的 git stash 快照"""
    try:
        # 查找 stash
        result = subprocess.run(
            ["git", "stash", "list"],
            cwd=PROJECT_ROOT,
            capture_output=True,
            text=True,
            check=True
        )
        
        stash_index = None
        for i, line in enumerate(result.stdout.splitlines()):
            if stash_name in line:
                stash_index = f"stash@{{{i}}}"
                break
        
        if stash_index:
            # 重置到 stash 状态
            subprocess.run(
                ["git", "reset", "--hard"],
                cwd=PROJECT_ROOT,
                capture_output=True,
                check=True
            )
            subprocess.run(
                ["git", "stash", "apply", stash_index],
                cwd=PROJECT_ROOT,
                capture_output=True,
                check=True
            )
            logging.info(f"Rollback successful: applied {stash_index}")
        else:
            logging.warning(f"Stash {stash_name} not found, skipping rollback")
            
    except Exception as exc:
        logging.error(f"Rollback failed: {exc}")


def process_task(task):
    task_id = task["id"]
    details = task["details"]
    logging.info(f"Processing Task {task_id}: {details.get('file_path')}")

    # 进化前快照（git stash）
    stash_name = f"evolution-{task_id}-{int(time.time())}"
    try:
        subprocess.run(
            ["git", "stash", "push", "-m", stash_name],
            cwd=PROJECT_ROOT,
            capture_output=True,
            check=False  # 允许 "No local changes" 的情况
        )
        logging.info(f"Created evolution snapshot: {stash_name}")
    except Exception as exc:
        logging.warning(f"Failed to create git stash snapshot: {exc}")

    # Phase 1: Diagnosis
    diagnosis_prompt = f"你正在后台处理一个进化任务 (ID: {task_id})。\n错误现场：{json.dumps(details, indent=2)}\n请使用 /root-cause 技能分析原因并输出诊断报告。"
    diagnosis_skill = load_skill_prompt("root-cause")
    
    report = run_headless_claude(diagnosis_prompt, system_prompt=diagnosis_skill, allowed_tools="Read,Glob")
    if not report:
        logging.error("Phase 1 (Diagnosis) failed, attempting rollback")
        _rollback_stash(stash_name)
        return False
    
    update_prd(task_id, "PHASE 1: DIAGNOSIS", report)

    # Phase 2: Fix
    fix_prompt = f"根据以下诊断报告，修复代码并运行测试验证：\n{report}\n修复完成后，请运行 /reflection-log 将经验入库。"
    # 这里我们注入多个技能的上下文，或者简单的复合指令
    fix_skill = load_skill_prompt("reflection-log") # 引导它最后落盘
    
    fix_result = run_headless_claude(fix_prompt, system_prompt=fix_skill, allowed_tools="Read,Edit,Bash,Glob")
    if not fix_result:
        logging.error("Phase 2 (Fix) failed, attempting rollback")
        _rollback_stash(stash_name)
        return False
    
    update_prd(task_id, "PHASE 2: FIX & REFLECT", fix_result)
    return True

def main_loop():
    logging.info("Evolution Daemon started. Watching docs/EVOLUTION_QUEUE.json...")
    while True:
        queue = normalize_queue(load_queue())

        def flush(_):
            save_queue(queue)

        changed = process_queue_once(queue, on_state_change=flush)
        if changed:
            save_queue(queue)
            time.sleep(5)
            continue

        save_queue(queue)
        sleep_seconds = compute_next_wake_seconds(queue, idle_default=30)
        time.sleep(sleep_seconds)

if __name__ == "__main__":
    try:
        main_loop()
    except KeyboardInterrupt:
        logging.info("Daemon stopped by user.")
