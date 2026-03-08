#!/usr/bin/env python3
"""
IO Utilities Module
提取自 hook_runner.py 的基础 I/O 工具函数
包括：路径规范化、文件读写、KV 序列化、日期解析等
"""
import os
import sys
import posixpath
from pathlib import PurePosixPath, PureWindowsPath

__all__ = [
    "normalize_path",
    "normalize_risk_path",
    "is_risky",
    "_read_text_file",
    "_parse_kv_lines",
    "_serialize_kv_lines",
    "_plan_status",
    "_pick_bool",
    "_coerce_int",
    "_parse_iso_datetime",
    "_is_windows_path",
    "_wsl_from_windows",
]

# --- Path Utilities ---

def _is_windows_path(path):
    return "\\" in path or (len(path) >= 2 and path[1] == ":")

def _wsl_from_windows(path):
    """D:\\path -> /mnt/d/path"""
    p = PureWindowsPath(path)
    return "/mnt/" + str(p).replace(":", "").replace("\\", "/").lower()

def normalize_path(file_path, project_dir):
    """
    将任意路径规范化为相对于 project_dir 的路径
    支持 Windows 路径、WSL 路径、相对路径
    """
    if not file_path:
        return ""
    
    # 处理 WSL/Windows 混合场景
    project_is_win = _is_windows_path(project_dir)
    file_is_win = _is_windows_path(file_path)
    
    if project_is_win != file_is_win:
        if file_is_win:
            file_path = _wsl_from_windows(file_path)
        else:
            pass
    
    if project_is_win:
        project_abs = os.path.abspath(project_dir)
        file_abs = os.path.join(project_abs, file_path) if not os.path.isabs(file_path) else file_path
        try:
            rel = os.path.relpath(file_abs, project_abs)
        except ValueError:
            return file_path
    else:
        project_posix = PurePosixPath(project_dir).as_posix()
        file_posix = file_path if posixpath.isabs(file_path) else posixpath.join(project_posix, file_path)
        try:
            rel = posixpath.relpath(file_posix, project_posix)
        except ValueError:
            return file_path
    
    rel = rel.replace("\\", "/")
    if rel.startswith("../"):
        return file_path
    return rel

def normalize_risk_path(path):
    """将 risk_path 规范化为统一格式（使用 / 分隔符）"""
    normalized = path.replace("\\", "/")
    normalized = normalized.rstrip("/")
    return normalized

def is_risky(rel_path, risk_paths):
    """判断相对路径是否匹配任一风险路径模式"""
    if not rel_path or not risk_paths:
        return False
    
    normalized_rel = normalize_risk_path(rel_path)
    for pattern in risk_paths:
        normalized_pattern = normalize_risk_path(pattern)
        if normalized_rel.startswith(normalized_pattern):
            return True
    return False

# --- File I/O ---

def _read_text_file(path):
    """安全读取文本文件，失败返回空字符串"""
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return handle.read()
    except Exception:
        return ""

# --- Data Parsing ---

def _parse_kv_lines(text):
    """解析 key: value 格式的文本为字典"""
    result = {}
    for line in text.splitlines():
        if ":" in line:
            key, _, value = line.partition(":")
            result[key.strip()] = value.strip()
    return result

def _serialize_kv_lines(data):
    """将字典序列化为 key: value 格式"""
    lines = []
    if isinstance(data, dict):
        for k in sorted(data.keys()):
            v = data[k]
            if isinstance(v, list):
                lines.append(f"{k}: {','.join(map(str, v))}")
            elif isinstance(v, dict):
                import json
                lines.append(f"{k}: {json.dumps(v, ensure_ascii=False)}")
            else:
                lines.append(f"{k}: {v}")
    return "\n".join(lines)

def _parse_iso_datetime(value):
    """解析 ISO datetime 字符串"""
    if not isinstance(value, str) or not value:
        return None
    try:
        import datetime as _dt
        return _dt.datetime.fromisoformat(value)
    except Exception:
        return None

# --- Helper Functions ---

def _pick_bool(value, default):
    """将任意值转为布尔值"""
    return bool(value) if value is not None else default

def _coerce_int(value, default=0):
    """安全转换为整数"""
    try:
        return int(value)
    except Exception:
        return default

def _plan_status(project_dir):
    """读取 PLAN.md 的状态"""
    plan_path = os.path.join(project_dir, "docs", "PLAN.md")
    if not os.path.isfile(plan_path):
        return ""
    
    with open(plan_path, "r", encoding="utf-8") as handle:
        for line in handle:
            if line.startswith("STATUS:"):
                return line.split(":", 1)[1].strip().split()[0] if len(line.split(":", 1)) > 1 else ""
    return ""
