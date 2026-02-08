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

# --- Encoding Fix for Windows ---
if sys.platform == "win32":
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')

# --- Telemetry & Logging Setup ---
# 设置日志文件路径
PROJECT_ROOT = os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
LOG_FILE = os.path.join(PROJECT_ROOT, "docs", "SYSTEM.log")
QUEUE_FILE = os.path.join(PROJECT_ROOT, "docs", "EVOLUTION_QUEUE.json")
QUIET_SUCCESS_HOOKS = {"statusline"}
QUEUE_OPEN_STATES = {"pending", "processing", "retrying"}
QUEUE_MAX_SIZE = 300

PROFILE_DEFAULTS = {
    "audit_level": "medium",
    "risk_paths": [],
    "evolution_mode": "realtime",
    "gate": {
        "require_plan_for_risk_paths": True,
        "require_audit_before_write": True,
        "require_reviewer_after_write": True,
    },
    "tests": {
        "on_change": "smoke",
        "on_risk_change": "unit",
        "commands": {},
    },
    "pain": {
        "soft_capture_threshold": 30,
        "adaptive": {
            "enabled": True,
            "min_threshold": 15,
            "max_threshold": 70,
            "backlog_trigger": 6,
            "hard_failure_trigger": 2,
            "stable_quality_threshold": 5,
        },
    },
    "lifecycle": {
        "enabled": True,
        "require_owner_approval_for_risk_writes": True,
        "require_challenge_before_approval": True,
        "heartbeat_timeout_minutes": 180,
    },
    "permissions": {},
    "custom_guards": [],
}
PROFILE_AUDIT_LEVELS = {"low", "medium", "high"}
PROFILE_EVOLUTION_MODES = {"realtime", "async"}
PROFILE_TEST_LEVELS = {"smoke", "unit", "full"}
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

def _queue_file(project_dir=None):
    if project_dir:
        return os.path.join(project_dir, "docs", "EVOLUTION_QUEUE.json")
    return QUEUE_FILE

def _compute_task_priority(task_type, details):
    try:
        pain_score = int(details.get("pain_score") or 0)
    except Exception:
        pain_score = 0

    if details.get("is_spiral"):
        return 100
    if task_type == "test_failure":
        if int(details.get("exit_code") or 0) != 0:
            return 90
        return 80
    if pain_score >= 80:
        return 85
    if details.get("missing_test_command"):
        return 70
    if pain_score >= 50:
        return 65
    return 50

def _task_fingerprint(task_type, details):
    key = {
        "type": task_type,
        "reason": details.get("reason") or "",
        "file_path": details.get("file_path") or "",
        "tool": details.get("tool") or "",
        "command": details.get("command") or "",
    }
    return json.dumps(key, ensure_ascii=False, sort_keys=True, separators=(",", ":"))

def _retry_backoff_seconds(retry_count):
    try:
        count = max(0, int(retry_count))
    except Exception:
        count = 0
    # 15s, 30s, 60s, ... capped at 15min
    return min(900, 15 * (2 ** count))

def _next_retry_at(retry_count, now=None):
    current = now or _dt.datetime.now()
    wait_seconds = _retry_backoff_seconds(retry_count)
    return (current + _dt.timedelta(seconds=wait_seconds)).isoformat()

def _queue_sort_key(task):
    status = str(task.get("status") or "").lower()
    open_rank = 0 if status in QUEUE_OPEN_STATES else 1
    try:
        priority = int(task.get("priority") or 0)
    except Exception:
        priority = 0
    first_seen = task.get("first_seen") or task.get("timestamp") or ""
    return (open_rank, -priority, first_seen)

def _write_queue(queue, project_dir):
    queue_file = _queue_file(project_dir)
    ordered = sorted(queue, key=_queue_sort_key)[:QUEUE_MAX_SIZE]
    with open(queue_file, "w", encoding="utf-8") as f:
        json.dump(ordered, f, ensure_ascii=False, indent=2)

def enqueue_evolution_task(task_type, details, project_dir):
    """将进化工单推入队列"""
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

        for task in queue:
            status = str(task.get("status") or "").lower()
            if status not in QUEUE_OPEN_STATES:
                continue
            if str(task.get("fingerprint") or "") != fingerprint:
                continue
            task["details"] = details
            task["priority"] = max(int(task.get("priority") or 0), priority)
            task["occurrences"] = int(task.get("occurrences") or 1) + 1
            task["last_seen"] = now.isoformat()
            if status == "retrying":
                retry_count = int(task.get("retry_count") or 0)
                task["next_retry_at"] = _next_retry_at(retry_count, now)
            _write_queue(queue, project_dir)
            return task.get("id")

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
    for task in _load_queue(project_dir):
        if str(task.get("status", "")).lower() in QUEUE_OPEN_STATES:
            return True
    return False

# 简单的日志配置
logging.basicConfig(
    filename=LOG_FILE,
    level=logging.INFO,
    format="[%(asctime)s] [%(levelname)s] [%(funcName)s] %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S"
)

def log_telemetry(hook_name, status, duration=0, error=None):
    """统一遥测记录"""
    if status == "SUCCESS" and hook_name in QUIET_SUCCESS_HOOKS:
        return

    msg = f"Status: {status} | Duration: {duration:.2f}ms"
    if error:
        msg += f" | Error: {str(error)}"
    
    if status == "ERROR":
        level = logging.ERROR
    elif status == "BLOCKED":
        level = logging.WARNING
    else:
        level = logging.INFO
    logging.log(level, f"[{hook_name}] {msg}")
    
    if status == "ERROR":
        # 记录详细堆栈到 debug 日志（如果有）或直接到 SYSTEM.log
        logging.error(f"Stacktrace: {traceback.format_exc()}")

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
    env_dir = os.environ.get("CLAUDE_PROJECT_DIR", "").strip()
    if env_dir:
        return env_dir
    workspace = payload.get("workspace") or {}
    project_dir = (workspace.get("project_dir") or "").strip()
    if project_dir:
        return project_dir
    return os.getcwd()

def _is_windows_path(path):
    return bool(re.match(r"^[a-zA-Z]:[\\/]", path))

def _wsl_from_windows(path):
    drive = path[0].lower()
    rest = path[2:].replace("\\", "/").lstrip("/")
    return f"/mnt/{drive}/{rest}"

def normalize_path(file_path, project_dir):
    if not file_path:
        return ""

    fp = file_path.strip().rstrip("\r")
    proj = project_dir.strip().rstrip("\r")

    if _is_windows_path(proj):
        fp_win = PureWindowsPath(fp) if _is_windows_path(fp) else PureWindowsPath(fp.replace("/", "\\"))
        proj_win = PureWindowsPath(proj)
        try:
            rel = fp_win.relative_to(proj_win)
            return rel.as_posix().lstrip("/")
        except ValueError:
            return fp_win.as_posix().lstrip("/")

    if _is_windows_path(fp):
        fp = _wsl_from_windows(fp)

    fp = fp.replace("\\", "/")
    proj = proj.replace("\\", "/")

    fp_norm = posixpath.normpath(fp)
    proj_norm = posixpath.normpath(proj)

    if fp_norm == proj_norm:
        return ""
    if fp_norm.startswith(proj_norm + "/"):
        return fp_norm[len(proj_norm) + 1 :]
    return fp_norm.lstrip("/")

def normalize_risk_path(path):
    p = (path or "").strip().rstrip("\r").replace("\\", "/")
    if p.startswith("./"):
        p = p[2:]
    return p

def is_risky(rel_path, risk_paths):
    rel = (rel_path or "").replace("\\", "/")
    for p in risk_paths or []:
        rp = normalize_risk_path(p)
        if not rp:
            continue
        if rel == rp or rel.startswith(rp):
            return True
    return False

def _pick_bool(value, default):
    return value if isinstance(value, bool) else default

def _normalize_profile(raw_profile, profile_path):
    defaults = copy.deepcopy(PROFILE_DEFAULTS)
    warnings = []
    normalized = copy.deepcopy(defaults)
    invalid = False

    if not isinstance(raw_profile, dict):
        warnings.append("PROFILE root must be an object; defaults applied.")
        invalid = True
    else:
        for key, value in raw_profile.items():
            if key not in normalized:
                normalized[key] = value

        audit_level = raw_profile.get("audit_level")
        if isinstance(audit_level, str) and audit_level in PROFILE_AUDIT_LEVELS:
            normalized["audit_level"] = audit_level
        elif audit_level is not None:
            warnings.append(f"Invalid audit_level '{audit_level}', fallback to '{defaults['audit_level']}'.")

        evolution_mode = raw_profile.get("evolution_mode")
        if isinstance(evolution_mode, str) and evolution_mode in PROFILE_EVOLUTION_MODES:
            normalized["evolution_mode"] = evolution_mode
        elif evolution_mode is not None:
            warnings.append(f"Invalid evolution_mode '{evolution_mode}', fallback to '{defaults['evolution_mode']}'.")

        raw_risk_paths = raw_profile.get("risk_paths", defaults["risk_paths"])
        if isinstance(raw_risk_paths, str):
            raw_risk_paths = [raw_risk_paths]
        if isinstance(raw_risk_paths, list):
            normalized["risk_paths"] = [str(p) for p in raw_risk_paths if isinstance(p, str) and p.strip()]
        else:
            warnings.append("risk_paths must be an array of strings; fallback to defaults.")

        raw_gate = raw_profile.get("gate", {})
        if isinstance(raw_gate, dict):
            # Legacy compatibility: old profiles did not have full gate keys and defaulted to non-blocking behavior.
            gate = {
                "require_plan_for_risk_paths": False,
                "require_audit_before_write": False,
                "require_reviewer_after_write": False,
            }
            gate["require_plan_for_risk_paths"] = _pick_bool(
                raw_gate.get("require_plan_for_risk_paths"), gate["require_plan_for_risk_paths"]
            )
            gate["require_audit_before_write"] = _pick_bool(
                raw_gate.get("require_audit_before_write"), gate["require_audit_before_write"]
            )
            gate["require_reviewer_after_write"] = _pick_bool(
                raw_gate.get("require_reviewer_after_write"), gate["require_reviewer_after_write"]
            )
            normalized["gate"] = gate
        else:
            warnings.append("gate must be an object; fallback to defaults.")

        raw_tests = raw_profile.get("tests", {})
        if isinstance(raw_tests, dict):
            tests = copy.deepcopy(defaults["tests"])
            on_change = raw_tests.get("on_change")
            if isinstance(on_change, str) and on_change in PROFILE_TEST_LEVELS:
                tests["on_change"] = on_change
            elif on_change is not None:
                warnings.append(f"Invalid tests.on_change '{on_change}', fallback to '{tests['on_change']}'.")

            on_risk_change = raw_tests.get("on_risk_change")
            if isinstance(on_risk_change, str) and on_risk_change in PROFILE_TEST_LEVELS:
                tests["on_risk_change"] = on_risk_change
            elif on_risk_change is not None:
                warnings.append(
                    f"Invalid tests.on_risk_change '{on_risk_change}', fallback to '{tests['on_risk_change']}'."
                )

            commands = {}
            raw_commands = raw_tests.get("commands")
            if isinstance(raw_commands, dict):
                for key, value in raw_commands.items():
                    if isinstance(key, str) and isinstance(value, str):
                        commands[key] = value
                    else:
                        warnings.append("tests.commands only accepts string-to-string pairs.")
            elif raw_commands is not None:
                warnings.append("tests.commands must be an object; fallback to empty commands.")
            tests["commands"] = commands
            normalized["tests"] = tests
        else:
            warnings.append("tests must be an object; fallback to defaults.")

        raw_pain = raw_profile.get("pain", {})
        if isinstance(raw_pain, dict):
            pain = copy.deepcopy(defaults["pain"])
            soft_capture_threshold = raw_pain.get("soft_capture_threshold")
            if isinstance(soft_capture_threshold, int):
                pain["soft_capture_threshold"] = max(0, min(100, soft_capture_threshold))
            elif soft_capture_threshold is not None:
                warnings.append(
                    f"Invalid pain.soft_capture_threshold '{soft_capture_threshold}', fallback to "
                    f"'{pain['soft_capture_threshold']}'."
                )

            raw_adaptive = raw_pain.get("adaptive")
            adaptive = pain.get("adaptive") or {}
            if raw_adaptive is None:
                pass
            elif isinstance(raw_adaptive, dict):
                adaptive["enabled"] = _pick_bool(raw_adaptive.get("enabled"), adaptive.get("enabled", True))
                adaptive["min_threshold"] = max(
                    0, min(100, _coerce_int(raw_adaptive.get("min_threshold"), adaptive.get("min_threshold", 15)))
                )
                adaptive["max_threshold"] = max(
                    0, min(100, _coerce_int(raw_adaptive.get("max_threshold"), adaptive.get("max_threshold", 70)))
                )
                if adaptive["min_threshold"] > adaptive["max_threshold"]:
                    adaptive["min_threshold"], adaptive["max_threshold"] = (
                        adaptive["max_threshold"],
                        adaptive["min_threshold"],
                    )
                adaptive["backlog_trigger"] = max(
                    1, _coerce_int(raw_adaptive.get("backlog_trigger"), adaptive.get("backlog_trigger", 6))
                )
                adaptive["hard_failure_trigger"] = max(
                    1,
                    _coerce_int(raw_adaptive.get("hard_failure_trigger"), adaptive.get("hard_failure_trigger", 2)),
                )
                adaptive["stable_quality_threshold"] = max(
                    1,
                    _coerce_int(
                        raw_adaptive.get("stable_quality_threshold"),
                        adaptive.get("stable_quality_threshold", 5),
                    ),
                )
            else:
                warnings.append("pain.adaptive must be an object; fallback to defaults.")
            pain["adaptive"] = adaptive
            normalized["pain"] = pain
        else:
            warnings.append("pain must be an object; fallback to defaults.")

        raw_lifecycle = raw_profile.get("lifecycle")
        if raw_lifecycle is None:
            # Legacy compatibility: old profiles had no lifecycle section and should not
            # suddenly start blocking risky writes after upgrade.
            lifecycle = copy.deepcopy(defaults["lifecycle"])
            lifecycle["enabled"] = False
            normalized["lifecycle"] = lifecycle
        elif isinstance(raw_lifecycle, dict):
            lifecycle = copy.deepcopy(defaults["lifecycle"])
            lifecycle["enabled"] = _pick_bool(raw_lifecycle.get("enabled"), lifecycle["enabled"])
            lifecycle["require_owner_approval_for_risk_writes"] = _pick_bool(
                raw_lifecycle.get("require_owner_approval_for_risk_writes"),
                lifecycle["require_owner_approval_for_risk_writes"],
            )
            lifecycle["require_challenge_before_approval"] = _pick_bool(
                raw_lifecycle.get("require_challenge_before_approval"),
                lifecycle["require_challenge_before_approval"],
            )
            lifecycle["heartbeat_timeout_minutes"] = max(
                1, _coerce_int(raw_lifecycle.get("heartbeat_timeout_minutes"), lifecycle["heartbeat_timeout_minutes"])
            )
            normalized["lifecycle"] = lifecycle
        elif raw_lifecycle is not None:
            warnings.append("lifecycle must be an object; fallback to defaults.")

        raw_permissions = raw_profile.get("permissions", {})
        if isinstance(raw_permissions, dict):
            normalized["permissions"] = raw_permissions
        elif raw_permissions is not None:
            warnings.append("permissions must be an object; fallback to defaults.")

        raw_guards = raw_profile.get("custom_guards", defaults["custom_guards"])
        valid_guards = []
        if isinstance(raw_guards, list):
            for idx, guard in enumerate(raw_guards):
                if not isinstance(guard, dict):
                    warnings.append(f"custom_guards[{idx}] must be an object; skipped.")
                    continue
                pattern = guard.get("pattern")
                message = guard.get("message")
                if not isinstance(pattern, str) or not pattern.strip():
                    warnings.append(f"custom_guards[{idx}] missing valid pattern; skipped.")
                    continue
                if not isinstance(message, str) or not message.strip():
                    warnings.append(f"custom_guards[{idx}] missing valid message; skipped.")
                    continue
                severity = guard.get("severity", "error")
                if severity not in ("error", "warning"):
                    severity = "error"
                    warnings.append(f"custom_guards[{idx}] has invalid severity; fallback to 'error'.")
                valid_guards.append({"pattern": pattern, "message": message, "severity": severity})
            normalized["custom_guards"] = valid_guards
        else:
            warnings.append("custom_guards must be an array; fallback to empty list.")

    normalized["_profile_invalid"] = invalid
    normalized["_profile_warnings"] = warnings
    if warnings:
        logging.warning("[%s] PROFILE normalization warnings: %s", profile_path, " | ".join(warnings))
    return normalized

def load_profile(project_dir):
    profile_path = os.path.join(project_dir, "docs", "PROFILE.json")
    if not os.path.isfile(profile_path):
        return None, profile_path
    try:
        with open(profile_path, "r", encoding="utf-8") as handle:
            raw_profile = json.load(handle)
    except json.JSONDecodeError as exc:
        print(f"Invalid PROFILE.json: {exc}", file=sys.stderr)
        logging.error("[%s] PROFILE parse failed: %s", profile_path, exc)
        return _normalize_profile(None, profile_path), profile_path
    return _normalize_profile(raw_profile, profile_path), profile_path

def _run_command(cmd):
    if os.name == "nt":
        result = subprocess.run(cmd, shell=True)
    else:
        result = subprocess.run(["bash", "-lc", cmd])
    return result.returncode

def _read_text_file(path):
    with open(path, "rb") as handle:
        raw = handle.read()
    for encoding in ("utf-8", "utf-8-sig", "utf-16", "utf-16-le", "utf-16-be"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")

def _parse_iso_datetime(value):
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        return _dt.datetime.fromisoformat(text)
    except ValueError:
        return None

def _format_queue_status(project_dir, now=None):
    queue = _load_queue(project_dir)
    if not queue:
        return ""

    current = now or _dt.datetime.now()
    pending = 0
    retrying = 0
    retry_deltas = []

    for task in queue:
        status = str(task.get("status") or "").lower()
        if status == "pending":
            pending += 1
            continue
        if status != "retrying":
            continue

        retrying += 1
        due = _parse_iso_datetime(task.get("next_retry_at"))
        if due is None:
            retry_deltas.append(0)
            continue

        if due.tzinfo is not None:
            if current.tzinfo is None:
                current_cmp = _dt.datetime.now(tz=due.tzinfo)
            else:
                current_cmp = current.astimezone(due.tzinfo)
        else:
            current_cmp = current.replace(tzinfo=None)

        retry_deltas.append(int((due - current_cmp).total_seconds()))

    if pending + retrying == 0:
        return ""

    if retrying == 0:
        next_label = "now"
    else:
        min_delta = min(retry_deltas) if retry_deltas else 0
        if min_delta <= 0:
            next_label = "due"
        elif min_delta < 60:
            next_label = f"{min_delta}s"
        else:
            next_label = f"{(min_delta + 59) // 60}m"

    return f"🚦P{pending}|R{retrying}|N{next_label}"

def _format_week_status(project_dir):
    state, _, exists = _load_week_state(project_dir)
    stage = str(state.get("stage") or "UNPLANNED").upper()
    if not exists and stage == "UNPLANNED":
        return ""

    tags = {
        "UNPLANNED": "U",
        "DRAFT": "D",
        "CHALLENGE": "C",
        "PENDING_OWNER_APPROVAL": "A",
        "LOCKED": "L",
        "EXECUTING": "E",
        "REVIEW": "R",
        "CLOSED": "X",
        "INTERRUPTED": "I",
    }
    execution = state.get("execution") or {}
    completed = int(execution.get("completed_events") or 0)
    blocked = int(execution.get("blocked_events") or 0)
    return f"📅{tags.get(stage, '?')} C{completed}/B{blocked}"

def _parse_kv_lines(text):
    data = {}
    for line in (text or "").splitlines():
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        data[key.strip()] = value.strip()
    return data

def _serialize_kv_lines(data):
    ordered_keys = [
        "time",
        "tool",
        "file_path",
        "risk",
        "test_level",
        "command",
        "exit_code",
        "pain_score",
        "severity",
        "diagnosis",
        "reason",
        "soft_signals",
        "soft_capture_threshold_base",
        "soft_capture_threshold_effective",
        "soft_threshold_reasons",
        "mode",
        "queue_task_id",
        "issue_logged",
    ]
    lines = []
    for key in ordered_keys:
        value = data.get(key)
        if value is None or value == "":
            continue
        lines.append(f"{key}: {value}")
    for key in sorted(data.keys()):
        if key in ordered_keys:
            continue
        value = data.get(key)
        if value is None or value == "":
            continue
        lines.append(f"{key}: {value}")
    return "\n".join(lines) + ("\n" if lines else "")

def _pain_flag_path(project_dir):
    return os.path.join(project_dir, "docs", ".pain_flag")

def _write_pain_flag(project_dir, pain_data):
    path = _pain_flag_path(project_dir)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(_serialize_kv_lines(pain_data))
    return path

def _read_pain_flag_data(project_dir):
    path = _pain_flag_path(project_dir)
    if not os.path.isfile(path):
        return {}, path, ""
    raw = _read_text_file(path)
    return _parse_kv_lines(raw), path, raw

def _plan_status(project_dir):
    plan_path = os.path.join(project_dir, "docs", "PLAN.md")
    if not os.path.isfile(plan_path):
        return ""
    with open(plan_path, "r", encoding="utf-8") as handle:
        for line in handle:
            if line.startswith("STATUS:"):
                return line.split(":", 1)[1].strip().split()[0]
    return ""

def _coerce_int(value, default=0):
    try:
        return int(value)
    except Exception:
        return default

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

def _append_issue_from_pain(issue_log_path, decisions_path, pain_content):
    ts = _dt.datetime.now().isoformat()
    title_snippet = " ".join(pain_content.splitlines()[:6])[:80]
    title = f"Pain detected - {title_snippet}".strip()

    with open(issue_log_path, "a", encoding="utf-8") as handle:
        handle.write(
            f"\n## [{ts}] {title}\n\n### Pain Signal (auto-captured)\n```\n{pain_content}\n```\n\n"
            "### Diagnosis (Pending)\n- Run /evolve-task to diagnose.\n"
        )

    with open(decisions_path, "a", encoding="utf-8") as handle:
        handle.write(f"\n## [{ts}] Decision checkpoint\n- Pain flag detected; IssueLog entry appended.\n")

def _update_workboard(project_dir, event):
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

def _week_state_path(project_dir):
    return os.path.join(project_dir, "docs", "okr", "WEEK_STATE.json")

def _week_events_path(project_dir):
    return os.path.join(project_dir, "docs", "okr", "WEEK_EVENTS.jsonl")

def _current_week_id(now=None):
    dt = now or _dt.datetime.now()
    iso = dt.isocalendar()
    return f"{iso.year}-W{iso.week:02d}"

def _default_week_state(now=None):
    ts = (now or _dt.datetime.now()).isoformat()
    return {
        "version": 1,
        "week_id": _current_week_id(now),
        "stage": "UNPLANNED",
        "owner_approved": False,
        "owner_decision": "",
        "owner_note": "",
        "proposer_agent": "",
        "challenger_agent": "",
        "lock": {"locked": False, "locked_at": ""},
        "execution": {
            "started_at": "",
            "last_heartbeat_at": "",
            "heartbeat_count": 0,
            "completed_events": 0,
            "blocked_events": 0,
        },
        "interruption": {
            "active": False,
            "detected_at": "",
            "reason": "",
        },
        "updated_at": ts,
    }

def _normalize_week_state(raw_state, now=None):
    state = _default_week_state(now)
    if not isinstance(raw_state, dict):
        return state

    for key, value in raw_state.items():
        if key not in state:
            state[key] = value

    stage = str(raw_state.get("stage") or state["stage"]).upper()
    if stage not in WEEK_STAGES:
        stage = state["stage"]
    state["stage"] = stage
    state["owner_approved"] = bool(raw_state.get("owner_approved", state["owner_approved"]))
    state["owner_decision"] = str(raw_state.get("owner_decision") or state["owner_decision"])
    state["owner_note"] = str(raw_state.get("owner_note") or state["owner_note"])
    state["proposer_agent"] = str(raw_state.get("proposer_agent") or state["proposer_agent"]).strip()
    state["challenger_agent"] = str(raw_state.get("challenger_agent") or state["challenger_agent"]).strip()

    lock = raw_state.get("lock")
    if isinstance(lock, dict):
        state["lock"]["locked"] = bool(lock.get("locked", state["lock"]["locked"]))
        state["lock"]["locked_at"] = str(lock.get("locked_at") or state["lock"]["locked_at"])

    execution = raw_state.get("execution")
    if isinstance(execution, dict):
        state["execution"]["started_at"] = str(execution.get("started_at") or state["execution"]["started_at"])
        state["execution"]["last_heartbeat_at"] = str(
            execution.get("last_heartbeat_at") or state["execution"]["last_heartbeat_at"]
        )
        state["execution"]["heartbeat_count"] = max(
            0, _coerce_int(execution.get("heartbeat_count"), state["execution"]["heartbeat_count"])
        )
        state["execution"]["completed_events"] = max(
            0, _coerce_int(execution.get("completed_events"), state["execution"]["completed_events"])
        )
        state["execution"]["blocked_events"] = max(
            0, _coerce_int(execution.get("blocked_events"), state["execution"]["blocked_events"])
        )

    interruption = raw_state.get("interruption")
    if isinstance(interruption, dict):
        state["interruption"]["active"] = bool(interruption.get("active", state["interruption"]["active"]))
        state["interruption"]["detected_at"] = str(
            interruption.get("detected_at") or state["interruption"]["detected_at"]
        )
        state["interruption"]["reason"] = str(interruption.get("reason") or state["interruption"]["reason"])

    state["updated_at"] = str(raw_state.get("updated_at") or state["updated_at"])
    return state

def _load_week_state(project_dir):
    path = _week_state_path(project_dir)
    if not os.path.isfile(path):
        return _default_week_state(), path, False
    try:
        with open(path, "r", encoding="utf-8") as handle:
            raw = json.load(handle)
        return _normalize_week_state(raw), path, True
    except Exception:
        return _default_week_state(), path, False

def _save_week_state(project_dir, state):
    path = _week_state_path(project_dir)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    state["updated_at"] = _dt.datetime.now().isoformat()
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(state, handle, ensure_ascii=False, indent=2)
    return path

def _append_week_event(project_dir, event_type, payload=None):
    state, _, _ = _load_week_state(project_dir)
    path = _week_events_path(project_dir)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    event = {
        "timestamp": _dt.datetime.now().isoformat(),
        "week_id": state.get("week_id") or _current_week_id(),
        "type": event_type,
    }
    if isinstance(payload, dict):
        event.update(payload)
    with open(path, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(event, ensure_ascii=False) + "\n")

def _read_week_events(project_dir, limit=50):
    path = _week_events_path(project_dir)
    if not os.path.isfile(path):
        return []
    rows = []
    try:
        with open(path, "r", encoding="utf-8") as handle:
            for line in handle:
                text = line.strip()
                if not text:
                    continue
                try:
                    rows.append(json.loads(text))
                except Exception:
                    continue
    except Exception:
        return []
    return rows[-limit:]

def _week_lock_is_valid(state, lifecycle_cfg):
    if not _pick_bool(lifecycle_cfg.get("enabled"), True):
        return True
    if not _pick_bool(lifecycle_cfg.get("require_owner_approval_for_risk_writes"), True):
        return True
    if not bool(state.get("owner_approved")):
        return False
    if _pick_bool(lifecycle_cfg.get("require_challenge_before_approval"), True):
        if not str(state.get("challenger_agent") or "").strip():
            return False
    if state.get("stage") == "INTERRUPTED":
        return False
    stage = str(state.get("stage") or "").upper()
    lock = state.get("lock") or {}
    locked = bool(lock.get("locked"))
    return stage in {"LOCKED", "EXECUTING", "REVIEW", "CLOSED"} or locked

def _record_execution_heartbeat(project_dir, profile, payload, file_path):
    lifecycle = (profile or {}).get("lifecycle") or {}
    if not _pick_bool(lifecycle.get("enabled"), True):
        return

    state, _, _ = _load_week_state(project_dir)
    if not bool(state.get("owner_approved")):
        return

    stage = str(state.get("stage") or "").upper()
    if stage not in {"LOCKED", "EXECUTING", "REVIEW"}:
        return

    now = _dt.datetime.now().isoformat()
    if stage == "LOCKED":
        state["stage"] = "EXECUTING"
        if not state.get("execution", {}).get("started_at"):
            state["execution"]["started_at"] = now
    state["execution"]["last_heartbeat_at"] = now
    state["execution"]["heartbeat_count"] = int(state["execution"].get("heartbeat_count") or 0) + 1
    state["interruption"]["active"] = False
    state["interruption"]["detected_at"] = ""
    state["interruption"]["reason"] = ""

    _save_week_state(project_dir, state)
    _append_week_event(
        project_dir,
        "heartbeat",
        {
            "tool": payload.get("tool_name"),
            "file_path": file_path,
            "summary": f"heartbeat after {payload.get('tool_name')} {file_path or ''}".strip(),
        },
    )

def _mark_week_interrupted_if_stale(project_dir, profile):
    lifecycle = (profile or {}).get("lifecycle") or {}
    if not _pick_bool(lifecycle.get("enabled"), True):
        return None

    state, _, exists = _load_week_state(project_dir)
    if not exists:
        return None
    if str(state.get("stage") or "").upper() != "EXECUTING":
        return None

    timeout_minutes = max(1, _coerce_int(lifecycle.get("heartbeat_timeout_minutes"), 180))
    last_heartbeat = _parse_iso_datetime((state.get("execution") or {}).get("last_heartbeat_at"))
    if last_heartbeat is None:
        return None

    now = _dt.datetime.now()
    if last_heartbeat.tzinfo is not None and now.tzinfo is None:
        now_cmp = _dt.datetime.now(tz=last_heartbeat.tzinfo)
    elif last_heartbeat.tzinfo is None and now.tzinfo is not None:
        now_cmp = now.replace(tzinfo=None)
    else:
        now_cmp = now

    age_minutes = (now_cmp - last_heartbeat).total_seconds() / 60.0
    if age_minutes < timeout_minutes:
        return None

    state["stage"] = "INTERRUPTED"
    state["interruption"]["active"] = True
    state["interruption"]["detected_at"] = _dt.datetime.now().isoformat()
    state["interruption"]["reason"] = (
        f"No heartbeat for {int(age_minutes)}m (timeout={timeout_minutes}m)."
    )
    _save_week_state(project_dir, state)
    _append_week_event(
        project_dir,
        "interruption_detected",
        {"summary": state["interruption"]["reason"]},
    )
    return state

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
        # Check last 5 commits for "fix" patterns
        if os.path.exists(os.path.join(project_dir, ".git")):
            git_log = subprocess.check_output(
                ["git", "-C", project_dir, "log", "--oneline", "-n", "5"], 
                text=True, stderr=subprocess.DEVNULL
            ).lower()
            
            fix_count = 0
            for keyword in ["fix", "fail", "error", "repair", "patch", "revert"]:
                fix_count += git_log.count(keyword)
            
            if fix_count >= 3:
                is_spiral = True
                spiral_warning = f"\n💀 DEATH SPIRAL DETECTED: {fix_count} recent fixes found. STOP CODING. THINK."
    except Exception:
        pass

    soft_signals, soft_score = _detect_soft_pain_signals(project_dir, file_path, risky, level)
    soft_threshold, threshold_diag = _effective_soft_capture_threshold(profile, project_dir)
    base_threshold = _coerce_int(threshold_diag.get("base"), soft_threshold)

    hard_signal = (rc != 0) or is_spiral or missing_test_command
    pain_score = _compute_pain_score(rc, is_spiral, missing_test_command, soft_score)
    if not hard_signal and pain_score < soft_threshold:
        return 0

    evolution_mode = profile.get("evolution_mode") or "realtime"
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
    task_type = "test_failure" if rc != 0 else "quality_signal"
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
        except:
            pass

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
        except Exception:
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
        except Exception:
            pass

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
            
        except Exception as e:
            logging.error(f"Failed to update user profile: {e}")

    return 0

def sync_user_context(payload, project_dir):
    """同步 USER_PROFILE.json 到 USER_CONTEXT.md (支持保留手动笔记)"""
    user_profile = os.path.join(project_dir, "docs", "USER_PROFILE.json")
    user_context = os.path.join(project_dir, "docs", "USER_CONTEXT.md")
    
    if not os.path.isfile(user_profile):
        return 0
        
    try:
        # 1. 读取旧文件中的手动部分
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
                f.write("\n## Communication Preferences\n")
                for k, v in prefs.items():
                    f.write(f"- **{k}**: {v}\n")
            
            f.write("\n## Interaction Strategy\n")
            for domain, score in domains.items():
                if score < 0:
                    f.write(f"- **{domain} Control**: High vigilance. Verify strictly.\n")
            
            # 3. 追加手动部分
            f.write(f"\n\n{manual_marker}\n")
            if manual_content:
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

    gate = profile.get("gate") or {}
    require_plan = bool(gate.get("require_plan_for_risk_paths", False))
    require_audit = bool(gate.get("require_audit_before_write", False))
    lifecycle = profile.get("lifecycle") or {}

    plan_path = os.path.join(project_dir, "docs", "PLAN.md")
    audit_path = os.path.join(project_dir, "docs", "AUDIT.md")

    if risky:
        state, _, _ = _load_week_state(project_dir)
        if str(state.get("stage") or "").upper() == "INTERRUPTED":
            print(
                "Blocked: weekly execution interrupted. Recover lifecycle state before risky writes.",
                file=sys.stderr,
            )
            return 2
        if not _week_lock_is_valid(state, lifecycle):
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
