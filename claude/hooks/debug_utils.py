#!/usr/bin/env python3
"""
Debug Utilities Module
统一的调试日志工具，支持环境变量控制

使用方法：
1. 设置环境变量 PRINCIPLES_DEBUG=1 启用调试
2. 设置环境变量 PRINCIPLES_ROOT 指定项目根目录（可选）
3. 调用 debug_log() 或 debug_stderr() 输出调试信息
"""
import os
import sys
import datetime as _dt

__all__ = [
    "DEBUG_ENABLED",
    "PROJECT_ROOT",
    "debug_log",
    "debug_stderr",
    "debug_enabled",
]

# 检查是否启用调试模式
DEBUG_ENABLED = os.environ.get("PRINCIPLES_DEBUG", "").lower() in ("1", "true", "yes")

# 获取项目根目录
PROJECT_ROOT = os.environ.get("PRINCIPLES_ROOT", "")
if not PROJECT_ROOT:
    # 尝试自动检测：从当前目录向上查找 docs/ 目录
    cwd = os.getcwd()
    while cwd and cwd != os.path.dirname(cwd):
        if os.path.isdir(os.path.join(cwd, "docs")):
            PROJECT_ROOT = cwd
            break
        cwd = os.path.dirname(cwd)
    if not PROJECT_ROOT:
        PROJECT_ROOT = os.getcwd()


def debug_enabled():
    """检查调试是否启用"""
    return DEBUG_ENABLED


def debug_log(message, filename="debug.log", project_dir=None):
    """
    写入调试日志到文件
    
    Args:
        message: 调试消息
        filename: 日志文件名（默认 debug.log）
        project_dir: 项目目录（可选，默认使用 PROJECT_ROOT）
    """
    if not DEBUG_ENABLED:
        return
    
    root = project_dir or PROJECT_ROOT
    log_dir = os.path.join(root, "docs")
    os.makedirs(log_dir, exist_ok=True)
    log_path = os.path.join(log_dir, filename)
    
    timestamp = _dt.datetime.now().isoformat()
    try:
        with open(log_path, "a", encoding="utf-8") as f:
            f.write(f"[{timestamp}] {message}\n")
    except Exception:
        pass  # 调试日志失败不应影响主流程


def debug_stderr(message):
    """
    输出调试信息到 stderr
    
    Args:
        message: 调试消息
    """
    if not DEBUG_ENABLED:
        return
    
    timestamp = _dt.datetime.now().strftime("%H:%M:%S")
    try:
        sys.stderr.write(f"[DEBUG {timestamp}] {message}\n")
    except Exception:
        pass
