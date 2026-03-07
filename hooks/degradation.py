#!/usr/bin/env python3
"""
Graceful Degradation
Phase 3.3: 自动降级策略
当系统检测到异常时，自动降低检查级别，保证核心功能可用
"""
import logging

try:
    from hooks.queue_health import assess_queue_health
    from hooks.circuit_breaker import check_circuit_breaker
    from hooks.profile import load_profile
except ImportError:
    try:
        from queue_health import assess_queue_health
        from circuit_breaker import check_circuit_breaker
        from profile import load_profile
    except ImportError:
        pass

__all__ = [
    "should_degrade",
    "get_degraded_config",
]

def should_degrade(project_dir):
    """
    判断是否应该启用降级模式
    检查：队列健康度、断路器状态、系统负载
    """
    degradation_signals = []
    
    # 检查队列健康
    try:
        health = assess_queue_health(project_dir)
        if health["status"] == "critical":
            degradation_signals.append("queue_critical")
        elif health["status"] == "warning" and health["metrics"]["total_tasks"] > 50:
            degradation_signals.append("queue_high_load")
    except Exception as exc:
        logging.debug("Failed to assess queue health: %s", exc)
    
    # 检查断路器
    critical_operations = ["evolution_task", "test_execution"]
    for op in critical_operations:
        try:
            if not check_circuit_breaker(project_dir, op):
                degradation_signals.append(f"circuit_open_{op}")
        except Exception:
            pass
    
    # 判断是否降级
    should_degrade = len(degradation_signals) >= 2
    
    if should_degrade:
        logging.warning(f"[Degradation] Entering degraded mode due to: {', '.join(degradation_signals)}")
    
    return should_degrade, degradation_signals

def get_degraded_config(profile):
    """
    获取降级配置
    降级策略：
    1. 关闭非关键检查（如 custom_guards）
    2. 降低测试级别（full -> smoke）
    3. 延长重试间隔
    """
    degraded = profile.copy()
    
    # 降低门禁严格度
    if "gate" in degraded:
        degraded["gate"]["require_audit_before_write"] = False
        degraded["gate"]["require_reviewer_after_write"] = False
    
    # 降低测试级别
    if "tests" in degraded:
        if degraded["tests"]["on_change"] == "full":
            degraded["tests"]["on_change"] = "smoke"
        if degraded["tests"]["on_risk_change"] == "full":
            degraded["tests"]["on_risk_change"] = "unit"
    
    # 放宽痛苦阈值（减少进化触发）
    if "pain" in degraded:
        degraded["pain"]["soft_capture_threshold"] = min(
            80,  # 最高80
            degraded["pain"].get("soft_capture_threshold", 30) + 20
        )
    
    return degraded
