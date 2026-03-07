#!/usr/bin/env python3
"""
Circuit Breaker Pattern
Phase 3.2: 断路器模式
当系统检测到连续失败时，自动降级到安全模式
"""
import os
import json
import datetime as _dt
import logging

__all__ = [
    "CircuitBreaker",
    "check_circuit_breaker",
    "record_operation",
]

class CircuitBreaker:
    """
    断路器状态机
    - CLOSED: 正常运行
    - OPEN: 熔断（拒绝请求）
    - HALF_OPEN: 半开（尝试恢复）
    """
    def __init__(self, project_dir, name, failure_threshold=5, timeout_seconds=300):
        self.project_dir = project_dir
        self.name = name
        self.failure_threshold = failure_threshold
        self.timeout_seconds = timeout_seconds
        self.state_file = os.path.join(project_dir, "docs", f".circuit_{name}.json")
    
    def _load_state(self):
        if not os.path.isfile(self.state_file):
            return {
                "state": "CLOSED",
                "failure_count": 0,
                "last_failure_time": None,
                "opened_at": None
            }
        
        try:
            with open(self.state_file, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return {"state": "CLOSED", "failure_count": 0, "last_failure_time": None, "opened_at": None}
    
    def _save_state(self, state):
        os.makedirs(os.path.dirname(self.state_file), exist_ok=True)
        with open(self.state_file, "w", encoding="utf-8") as f:
            json.dump(state, f, ensure_ascii=False, indent=2)
    
    def record_success(self):
        """记录成功操作"""
        state = self._load_state()
        
        if state["state"] == "HALF_OPEN":
            # 半开状态成功 -> 关闭断路器
            state["state"] = "CLOSED"
            state["failure_count"] = 0
            state["last_failure_time"] = None
            state["opened_at"] = None
            logging.info(f"[Circuit Breaker {self.name}] Recovered to CLOSED")
        else:
            # 重置失败计数
            state["failure_count"] = max(0, state["failure_count"] - 1)
        
        self._save_state(state)
    
    def record_failure(self):
        """记录失败操作"""
        state = self._load_state()
        now = _dt.datetime.now()
        
        state["failure_count"] += 1
        state["last_failure_time"] = now.isoformat()
        
        if state["state"] == "HALF_OPEN":
            # 半开状态失败 -> 重新打开
            state["state"] = "OPEN"
            state["opened_at"] = now.isoformat()
            logging.warning(f"[Circuit Breaker {self.name}] HALF_OPEN -> OPEN after failure")
        
        elif state["failure_count"] >= self.failure_threshold:
            # 达到阈值 -> 打开断路器
            state["state"] = "OPEN"
            state["opened_at"] = now.isoformat()
            logging.error(f"[Circuit Breaker {self.name}] CLOSED -> OPEN after {state['failure_count']} failures")
        
        self._save_state(state)
    
    def is_open(self):
        """检查断路器是否打开（熔断中）"""
        state = self._load_state()
        now = _dt.datetime.now()
        
        if state["state"] == "CLOSED":
            return False
        
        if state["state"] == "OPEN":
            # 检查是否超时，可以尝试半开
            opened_at_str = state.get("opened_at")
            if opened_at_str:
                try:
                    opened_at = _dt.datetime.fromisoformat(opened_at_str)
                    elapsed = (now - opened_at).total_seconds()
                    
                    if elapsed >= self.timeout_seconds:
                        # 超时 -> 半开
                        state["state"] = "HALF_OPEN"
                        self._save_state(state)
                        logging.info(f"[Circuit Breaker {self.name}] OPEN -> HALF_OPEN (timeout)")
                        return False  # 允许尝试
                except Exception:
                    pass
            
            return True  # 仍然熔断中
        
        # HALF_OPEN 状态允许尝试
        return False
    
    def get_state(self):
        """获取当前状态"""
        return self._load_state()

def check_circuit_breaker(project_dir, operation_name):
    """检查指定操作的断路器状态"""
    breaker = CircuitBreaker(project_dir, operation_name)
    return not breaker.is_open()

def record_operation(project_dir, operation_name, success):
    """记录操作结果"""
    breaker = CircuitBreaker(project_dir, operation_name)
    if success:
        breaker.record_success()
    else:
        breaker.record_failure()
