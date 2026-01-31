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

# 日志设置
logging.basicConfig(level=logging.INFO, format='[%(asctime)s] %(levelname)s: %(message)s')

def load_queue():
    if not os.path.isfile(QUEUE_FILE): return []
    with open(QUEUE_FILE, "r", encoding="utf-8") as f:
        return json.load(f)

def save_queue(queue):
    with open(QUEUE_FILE, "w", encoding="utf-8") as f:
        json.dump(queue, f, ensure_ascii=False, indent=2)

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
        result = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8")
        if result.returncode != 0:
            logging.error(f"Claude failed: {result.stderr}")
            return None
        return result.stdout
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

def process_task(task):
    task_id = task["id"]
    details = task["details"]
    logging.info(f"Processing Task {task_id}: {details.get('file_path')}")

    # Phase 1: Diagnosis
    diagnosis_prompt = f"你正在后台处理一个进化任务 (ID: {task_id})。\n错误现场：{json.dumps(details, indent=2)}\n请使用 /root-cause 技能分析原因并输出诊断报告。"
    diagnosis_skill = load_skill_prompt("root-cause")
    
    report = run_headless_claude(diagnosis_prompt, system_prompt=diagnosis_skill, allowed_tools="Read,Glob")
    if not report: return False
    
    update_prd(task_id, "PHASE 1: DIAGNOSIS", report)

    # Phase 2: Fix
    fix_prompt = f"根据以下诊断报告，修复代码并运行测试验证：\n{report}\n修复完成后，请运行 /reflection-log 将经验入库。"
    # 这里我们注入多个技能的上下文，或者简单的复合指令
    fix_skill = load_skill_prompt("reflection-log") # 引导它最后落盘
    
    fix_result = run_headless_claude(fix_prompt, system_prompt=fix_skill, allowed_tools="Read,Edit,Bash,Glob")
    if not fix_result: return False
    
    update_prd(task_id, "PHASE 2: FIX & REFLECT", fix_result)
    return True

def main_loop():
    logging.info("Evolution Daemon started. Watching docs/EVOLUTION_QUEUE.json...")
    while True:
        queue = load_queue()
        pending = [t for t in queue if t["status"] == "pending"]
        
        if not pending:
            time.sleep(30) # 无任务时休眠 30 秒
            continue
        
        for task in pending:
            task["status"] = "processing"
            save_queue(queue)
            
            success = process_task(task)
            
            if success:
                task["status"] = "completed"
            else:
                task["status"] = "failed"
                task["retry_count"] += 1
            
            save_queue(queue)
            logging.info(f"Task {task['id']} finished with status: {task['status']}")
            
        time.sleep(5)

if __name__ == "__main__":
    try:
        main_loop()
    except KeyboardInterrupt:
        logging.info("Daemon stopped by user.")
