#!/usr/bin/env python3
import argparse
import datetime as _dt
import json
import logging
import os
import posixpath
import re
import shutil
import subprocess
import sys
import traceback
from pathlib import PurePosixPath, PureWindowsPath

# --- Telemetry & Logging Setup ---
# 设置日志文件路径
PROJECT_ROOT = os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
LOG_FILE = os.path.join(PROJECT_ROOT, "docs", "SYSTEM.log")

# 简单的日志配置
logging.basicConfig(
    filename=LOG_FILE,
    level=logging.INFO,
    format="[%(asctime)s] [%(levelname)s] [%(funcName)s] %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S"
)

def log_telemetry(hook_name, status, duration=0, error=None):
    """统一遥测记录"""
    msg = f"Status: {status} | Duration: {duration:.2f}ms"
    if error:
        msg += f" | Error: {str(error)}"
    
    level = logging.ERROR if status == "ERROR" else logging.INFO
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

def load_profile(project_dir):
    profile_path = os.path.join(project_dir, "docs", "PROFILE.json")
    if not os.path.isfile(profile_path):
        return None, profile_path
    try:
        with open(profile_path, "r", encoding="utf-8") as handle:
            return json.load(handle), profile_path
    except json.JSONDecodeError as exc:
        print(f"Invalid PROFILE.json: {exc}", file=sys.stderr)
        sys.exit(2)

def _run_command(cmd):
    if os.name == "nt":
        result = subprocess.run(cmd, shell=True)
    else:
        result = subprocess.run(["bash", "-lc", cmd])
    return result.returncode

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

    tests = profile.get("tests") or {}
    level = tests.get("on_change") or "smoke"
    if risky:
        level = tests.get("on_risk_change") or "unit"

    commands = tests.get("commands") or {}
    cmd = commands.get(level) or ""
    if not cmd:
        return 0

    rc = _run_command(cmd)
    if rc == 0:
        return 0

    pain_flag = os.path.join(project_dir, "docs", ".pain_flag")
    with open(pain_flag, "w", encoding="utf-8") as handle:
        handle.write(f"time: {_dt.datetime.now().isoformat()}\n")
        handle.write(f"tool: {tool}\n")
        handle.write(f"file_path: {file_path}\n")
        handle.write(f"risk: {str(risky).lower()}\n")
        handle.write(f"test_level: {level}\n")
        handle.write(f"command: {cmd}\n")
        handle.write(f"exit_code: {rc}\n")

    print(f"Post-write checks failed (rc={rc}). Pain flag written to docs/.pain_flag", file=sys.stderr)
    return rc

def session_init(payload, project_dir):
    profile, _ = load_profile(project_dir)
    pain_flag = os.path.join(project_dir, "docs", ".pain_flag")
    issue_log = os.path.join(project_dir, "docs", "ISSUE_LOG.md")
    plan_path = os.path.join(project_dir, "docs", "PLAN.md")
    pending_reflection = os.path.join(project_dir, "docs", ".pending_reflection")

    print("[INFO] Evolutionary Programming Agent Initialized")

    # 1. 优先检查反思要求 (Ported from Bash)
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
        print(f"  - Audit Level: {audit_level}")
        print(f"  - Risk Paths: {json.dumps(risk_paths, ensure_ascii=False)}")

    if os.path.isfile(pain_flag):
        print("")
        print("[WARNING] Unresolved pain flag detected from last session.")
        print("Summary:")
        with open(pain_flag, "r", encoding="utf-8") as handle:
            for line in handle.read().splitlines()[:6]:
                print(f"    {line}")
        print("")
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

def stop_evolution_update(payload, project_dir):
    docs_dir = os.path.join(project_dir, "docs")
    pain_flag = os.path.join(docs_dir, ".pain_flag")
    issue_log = os.path.join(docs_dir, "ISSUE_LOG.md")
    decisions = os.path.join(docs_dir, "DECISIONS.md")
    user_profile = os.path.join(docs_dir, "USER_PROFILE.json")
    user_verdict = os.path.join(docs_dir, ".user_verdict.json")

    os.makedirs(docs_dir, exist_ok=True)

    # 1. 处理 Pain Flag
    if os.path.isfile(pain_flag):
        with open(pain_flag, "r", encoding="utf-8") as handle:
            pain_content = handle.read()

        ts = _dt.datetime.now().isoformat()
        title_snippet = " ".join(pain_content.splitlines()[:6])[:80]
        title = f"Pain detected - {title_snippet}".strip()

        with open(issue_log, "a", encoding="utf-8") as handle:
            handle.write(f"\n## [{ts}] {title}\n\n### Pain Signal (auto-captured)\n```\n{pain_content}\n```\n\n### Diagnosis (Pending)\n- Run /evolve-task to diagnose.\n")

        with open(decisions, "a", encoding="utf-8") as handle:
            handle.write(f"\n## [{ts}] Decision checkpoint\n- Pain flag detected; IssueLog entry appended.\n")

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
    """同步 USER_PROFILE.json 到 USER_CONTEXT.md"""
    user_profile = os.path.join(project_dir, "docs", "USER_PROFILE.json")
    user_context = os.path.join(project_dir, "docs", "USER_CONTEXT.md")
    
    if not os.path.isfile(user_profile):
        return 0
        
    try:
        with open(user_profile, "r", encoding="utf-8") as f:
            data = json.load(f)
            
        domains = data.get("domains", {})
        prefs = data.get("preferences", {})
        
        def get_level(score):
            if score >= 10: return "Expert"
            if score >= 5: return "Proficient"
            if score >= 0: return "Intermediate"
            return "Novice/Low"
            
        with open(user_context, "w", encoding="utf-8") as f:
            f.write(f"# User Cognitive Profile (System Generated)\n")
            f.write(f"> 🛑 DO NOT EDIT MANUALLY. Updated: {_dt.datetime.now().isoformat()}\n\n")
            f.write("## Current Domain Expertise\n")
            for domain, score in domains.items():
                level = get_level(score)
                f.write(f"- **{domain}**: [{level}] (Score: {score})\n")
            
            if prefs:
                f.write("\n## Communication Preferences\n")
                for k, v in prefs.items():
                    f.write(f"- **{k}**: {v}\n")
            
            f.write("\n## Interaction Strategy\n")
            # 简单的策略生成逻辑
            for domain, score in domains.items():
                if score < 0:
                    f.write(f"- **{domain} Control**: High vigilance. Verify strictly.\n")
                    
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
                score = stats.get("score", 0)
                level = "Neutral (Standard)"
                if score >= 5: level = "High (Trustworthy)"
                elif score < 0: level = "Low (Risky)"
                
                f.write(f"- **{name}**: [{level}] (Score: {score}, Wins: {stats.get('wins',0)}, Losses: {stats.get('losses',0)})\n")
                
            f.write("\n## Operational Guidance\n")
            f.write("- If an agent has a **Low/Risky** status, you MUST double-check its output.\n")
            
    except Exception as e:
        logging.error(f"Failed to sync agent context: {e}")
        
    return 0

def subagent_complete(payload, project_dir):
    agent_name = payload.get("agent_type") or ""
    scorecard = os.path.join(project_dir, "docs", "AGENT_SCORECARD.json")
    verdict_file = os.path.join(project_dir, "docs", ".verdict.json")
    pain_flag = os.path.join(project_dir, "docs", ".pain_flag")

    if not agent_name or not os.path.isfile(scorecard):
        return 0

    # 1. 获取裁决数据 (The Verdict) - Ported from Bash
    win = True
    score_delta = 1
    
    if os.path.isfile(verdict_file):
        try:
            with open(verdict_file, "r", encoding="utf-8") as f:
                verdict = json.load(f)
            # 校验 target_agent
            if verdict.get("target_agent") == agent_name:
                win = verdict.get("win", True)
                score_delta = verdict.get("score_delta", 0)
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
    if tool not in ("Write", "Edit"):
        return 0

    profile, profile_path = load_profile(project_dir)
    if profile is None:
        print("Blocked: missing docs/PROFILE.json (required for gating).", file=sys.stderr)
        return 2

    file_path = (payload.get("tool_input") or {}).get("file_path") or ""
    rel = normalize_path(file_path, project_dir) if file_path else ""
    risk_paths = profile.get("risk_paths") or []
    risky = is_risky(rel, risk_paths) if file_path else True

    gate = profile.get("gate") or {}
    require_plan = bool(gate.get("require_plan_for_risk_paths", False))
    require_audit = bool(gate.get("require_audit_before_write", False))

    plan_path = os.path.join(project_dir, "docs", "PLAN.md")
    audit_path = os.path.join(project_dir, "docs", "AUDIT.md")

    if risky:
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

        return handler()
        
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
