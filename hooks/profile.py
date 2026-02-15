#!/usr/bin/env python3
"""
Profile Module
提取自 hook_runner.py 的配置解析相关函数
包括：PROFILE.json 和 DECISION_POLICY.json 的加载、归一化和验证
"""
import os
import sys
import json
import copy
import logging

# 导入基础工具
try:
    from hooks.io_utils import _pick_bool, _coerce_int
except ImportError:
    try:
        from io_utils import _pick_bool, _coerce_int
    except ImportError:
        def _pick_bool(value, default):
            return bool(value) if value is not None else default
        
        def _coerce_int(value, default=0):
            try:
                return int(value)
            except Exception:
                return default

__all__ = [
    "PROFILE_DEFAULTS",
    "PROFILE_AUDIT_LEVELS",
    "PROFILE_EVOLUTION_MODES",
    "PROFILE_TEST_LEVELS",
    "DECISION_POLICY_DEFAULTS",
    "_normalize_profile",
    "load_profile",
    "_normalize_decision_policy",
    "load_decision_policy",
    "_decision_policy_path",
    "_load_user_profile",
]

# --- Constants ---

PROFILE_AUDIT_LEVELS = {"low", "medium", "high"}
PROFILE_EVOLUTION_MODES = {"realtime", "async"}
PROFILE_TEST_LEVELS = {"smoke", "unit", "full"}

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
            "spiral_boost": 20,
            "min_threshold": 15,
            "max_threshold": 70,
            "backlog_trigger": 6,
            "hard_failure_trigger": 1,
            "low_recent_success_boost": 15,
            "high_recent_pain_boost": 10,
        },
    },
    "lifecycle": {
        "enabled": True,
        "heartbeat_stale_hours": 72,
    },
}

DECISION_POLICY_DEFAULTS = {
    "enabled": True,
    "autonomy": {
        "block_micro_ask_user_question": True,
        "high_impact_score_threshold": 70,
        "medium_impact_score_threshold": 40,
        "allow_force_ask_override": True,
        "high_impact_keywords": [
            "delete",
            "remove",
            "drop",
            "destructive",
            "irreversible",
            "production",
            "deploy",
        ],
        "micro_keywords": [
            "which",
            "prefer",
            "should i",
            "minor",
            "typo",
            "wording",
            "small refactor",
            "which name",
        ],
    },
    "user_profile": {
        "domain_low_threshold": 0,
        "ask_on_medium_for_low_expertise": True,
    },
}

# --- Profile Functions ---

def _normalize_profile(raw_profile, profile_path):
    """归一化 PROFILE.json，填充默认值并验证"""
    defaults = copy.deepcopy(PROFILE_DEFAULTS)
    warnings = []
    normalized = copy.deepcopy(defaults)
    invalid = False

    if not isinstance(raw_profile, dict):
        warnings.append("PROFILE root must be an object; defaults applied.")
        invalid = True
    else:
        # 保留用户自定义字段
        for key, value in raw_profile.items():
            if key not in normalized:
                normalized[key] = value

        # audit_level
        audit_level = raw_profile.get("audit_level")
        if isinstance(audit_level, str) and audit_level in PROFILE_AUDIT_LEVELS:
            normalized["audit_level"] = audit_level
        elif audit_level is not None:
            warnings.append(f"Invalid audit_level '{audit_level}', fallback to '{defaults['audit_level']}'.")

        # evolution_mode
        evolution_mode = raw_profile.get("evolution_mode")
        if isinstance(evolution_mode, str) and evolution_mode in PROFILE_EVOLUTION_MODES:
            normalized["evolution_mode"] = evolution_mode
        elif evolution_mode is not None:
            warnings.append(f"Invalid evolution_mode '{evolution_mode}', fallback to '{defaults['evolution_mode']}'.")

        # risk_paths
        raw_risk_paths = raw_profile.get("risk_paths", defaults["risk_paths"])
        if isinstance(raw_risk_paths, str):
            raw_risk_paths = [raw_risk_paths]
        if isinstance(raw_risk_paths, list):
            normalized["risk_paths"] = [str(p) for p in raw_risk_paths if isinstance(p, str) and p.strip()]
        else:
            warnings.append("risk_paths must be an array of strings; fallback to defaults.")

        # gate
        raw_gate = raw_profile.get("gate", {})
        if isinstance(raw_gate, dict):
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

        # tests
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

        # pain
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
            if isinstance(raw_adaptive, dict):
                adaptive["enabled"] = _pick_bool(raw_adaptive.get("enabled"), adaptive.get("enabled", True))
                adaptive["spiral_boost"] = _coerce_int(raw_adaptive.get("spiral_boost"), adaptive.get("spiral_boost", 20))
                adaptive["low_recent_success_boost"] = _coerce_int(
                    raw_adaptive.get("low_recent_success_boost"), adaptive.get("low_recent_success_boost", 15)
                )
                adaptive["high_recent_pain_boost"] = _coerce_int(
                    raw_adaptive.get("high_recent_pain_boost"), adaptive.get("high_recent_pain_boost", 10)
                )
                adaptive["min_threshold"] = _coerce_int(
                    raw_adaptive.get("min_threshold"), adaptive.get("min_threshold", 15)
                )
                adaptive["max_threshold"] = min(100, _coerce_int(
                    raw_adaptive.get("max_threshold"), adaptive.get("max_threshold", 70)
                ))
                adaptive["backlog_trigger"] = max(1, _coerce_int(
                    raw_adaptive.get("backlog_trigger"), adaptive.get("backlog_trigger", 6)
                ))
                adaptive["hard_failure_trigger"] = _coerce_int(
                    raw_adaptive.get("hard_failure_trigger"), adaptive.get("hard_failure_trigger", 1)
                )
                pain["adaptive"] = adaptive
            elif raw_adaptive is not None:
                warnings.append("pain.adaptive must be an object; fallback to defaults.")
            normalized["pain"] = pain
        else:
            warnings.append("pain must be an object; fallback to defaults.")

        # lifecycle
        raw_lifecycle = raw_profile.get("lifecycle", {})
        if isinstance(raw_lifecycle, dict):
            lifecycle = copy.deepcopy(defaults["lifecycle"])
            lifecycle["enabled"] = _pick_bool(raw_lifecycle.get("enabled"), lifecycle["enabled"])
            lifecycle["heartbeat_stale_hours"] = max(
                1, _coerce_int(raw_lifecycle.get("heartbeat_stale_hours"), lifecycle["heartbeat_stale_hours"])
            )
            normalized["lifecycle"] = lifecycle
        else:
            warnings.append("lifecycle must be an object; fallback to defaults.")

        # custom_guards
        raw_guards = raw_profile.get("custom_guards", [])
        if isinstance(raw_guards, list):
            guards = []
            for item in raw_guards:
                if isinstance(item, dict):
                    pattern = str(item.get("pattern") or "")
                    if pattern:
                        guard = {
                            "pattern": pattern,
                            "message": str(item.get("message") or "Custom guard triggered"),
                            "severity": str(item.get("severity") or "error").lower()
                        }
                        # Validate severity
                        if guard["severity"] not in {"info", "warning", "error", "fatal"}:
                            guard["severity"] = "error"
                        guards.append(guard)
            normalized["custom_guards"] = guards
        elif "custom_guards" in raw_profile:
             warnings.append("custom_guards must be an array; ignored.")

    normalized["_profile_invalid"] = invalid
    normalized["_profile_warnings"] = warnings

    if warnings:
        logging.warning(f"[{profile_path}] Profile warnings: {' | '.join(warnings)}")
    
    return normalized

def load_profile(project_dir):
    """加载并归一化 PROFILE.json"""
    profile_path = os.path.join(project_dir, "docs", "PROFILE.json")
    if not os.path.isfile(profile_path):
        logging.info("DEBUG: Using NEW profile module")
        return None, profile_path
    try:
        with open(profile_path, "r", encoding="utf-8") as handle:
            raw_profile = json.load(handle)
    except json.JSONDecodeError as exc:
        print(f"Invalid PROFILE.json: {exc}", file=sys.stderr)
        logging.error("[%s] PROFILE parse failed: %s", profile_path, exc)
        return _normalize_profile(None, profile_path), profile_path
    return _normalize_profile(raw_profile, profile_path), profile_path

# --- Decision Policy Functions ---

def _decision_policy_path(project_dir):
    return os.path.join(project_dir, "docs", "DECISION_POLICY.json")

def _normalize_decision_policy(raw_policy):
    """归一化 DECISION_POLICY.json"""
    defaults = copy.deepcopy(DECISION_POLICY_DEFAULTS)
    policy = copy.deepcopy(defaults)
    warnings = []

    if not isinstance(raw_policy, dict):
        warnings.append("Decision policy root must be an object; defaults applied.")
        return policy, warnings

    policy["enabled"] = _pick_bool(raw_policy.get("enabled"), defaults["enabled"])

    # autonomy
    raw_autonomy = raw_policy.get("autonomy")
    if raw_autonomy is None:
        pass
    elif isinstance(raw_autonomy, dict):
        autonomy = policy["autonomy"]
        autonomy["block_micro_ask_user_question"] = _pick_bool(
            raw_autonomy.get("block_micro_ask_user_question"),
            autonomy["block_micro_ask_user_question"],
        )
        autonomy["high_impact_score_threshold"] = max(
            0, min(100, _coerce_int(raw_autonomy.get("high_impact_score_threshold"), autonomy["high_impact_score_threshold"]))
        )
        autonomy["medium_impact_score_threshold"] = max(
            0, min(100, _coerce_int(raw_autonomy.get("medium_impact_score_threshold"), autonomy["medium_impact_score_threshold"]))
        )
        if autonomy["medium_impact_score_threshold"] > autonomy["high_impact_score_threshold"]:
            autonomy["medium_impact_score_threshold"] = autonomy["high_impact_score_threshold"]
        autonomy["allow_force_ask_override"] = _pick_bool(
            raw_autonomy.get("allow_force_ask_override"),
            autonomy["allow_force_ask_override"],
        )
        for list_key in ("high_impact_keywords", "micro_keywords"):
            raw_list = raw_autonomy.get(list_key)
            if raw_list is None:
                continue
            if isinstance(raw_list, list):
                autonomy[list_key] = [str(item).lower() for item in raw_list if isinstance(item, str) and item.strip()]
            else:
                warnings.append(f"autonomy.{list_key} must be an array of strings; defaults applied.")
    else:
        warnings.append("autonomy must be an object; defaults applied.")

    # user_profile
    raw_profile = raw_policy.get("user_profile")
    if raw_profile is None:
        pass
    elif isinstance(raw_profile, dict):
        user_profile = policy["user_profile"]
        user_profile["domain_low_threshold"] = _coerce_int(
            raw_profile.get("domain_low_threshold"),
            user_profile["domain_low_threshold"],
        )
        user_profile["ask_on_medium_for_low_expertise"] = _pick_bool(
            raw_profile.get("ask_on_medium_for_low_expertise"),
            user_profile["ask_on_medium_for_low_expertise"],
        )
    else:
        warnings.append("user_profile must be an object; defaults applied.")

    return policy, warnings

def load_decision_policy(project_dir):
    """加载并归一化 DECISION_POLICY.json"""
    path = _decision_policy_path(project_dir)
    if not os.path.isfile(path):
        return copy.deepcopy(DECISION_POLICY_DEFAULTS), path
    try:
        with open(path, "r", encoding="utf-8") as handle:
            raw_policy = json.load(handle)
    except Exception as exc:
        logging.error(f"[{path}] Decision policy parse failed: {exc}")
        return copy.deepcopy(DECISION_POLICY_DEFAULTS), path

    normalized, warnings = _normalize_decision_policy(raw_policy)
    if warnings:
        logging.warning(f"[{path}] Decision policy warnings: {' | '.join(warnings)}")
    return normalized, path

def _load_user_profile(project_dir):
    """加载 USER_PROFILE.json（用于 AskUser 决策）"""
    user_profile_path = os.path.join(project_dir, "docs", "USER_PROFILE.json")
    if not os.path.isfile(user_profile_path):
        return {}
    try:
        with open(user_profile_path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except Exception:
        return {}
