# 系统可观测性升级方案 (System Observability Upgrade)

## 1. 现状痛点
当前系统缺乏对“自身健康状况”的监控。当 Hook 脚本崩溃、执行超时或逻辑错误时，缺乏统一的调试视图，导致“修系统”比“修代码”还难。

## 2. 架构设计：系统遥测层 (System Telemetry Layer)

### 2.1 核心组件
- **`scripts/lib/telemetry.sh`**: 通用遥测库。提供日志格式化、计时器、错误捕获 (`trap`) 等基础能力。
- **`docs/SYSTEM.log`**: 系统运行日志。记录所有 Hook 的生命周期事件 (Start/Success/Fail) 和耗时。
- **`/system-status`**: 可视化技能。读取日志并生成健康报告。

### 2.2 数据流向
```text
[Hook Script] --(source)--> [telemetry.sh]
      |
      +--(log_info/error)--> [docs/SYSTEM.log]
                                    ^
                                    | (Read)
                                    |
                             [Skill: /system-status]
```

## 3. 实施细节

### Step 1: 创建通用库 `scripts/lib/telemetry.sh`
```bash
#!/bin/bash
LOG_FILE="$CLAUDE_PROJECT_DIR/docs/SYSTEM.log"

init_telemetry() {
  local hook_name=$1
  START_TIME=$(date +%s%N)
  log "INFO" "$hook_name" "Started"
  # 捕获非正常退出
  trap 'log "CRITICAL" "$hook_name" "Script Crashed (Line $LINENO)"; exit 1' ERR
}

log() {
  local level=$1
  local scope=$2
  local msg=$3
  echo "[$(date -Iseconds)] [$level] [$scope] $msg" >> "$LOG_FILE"
}

finish_telemetry() {
  local exit_code=$1
  local end_time=$(date +%s%N)
  local duration=$(( (end_time - START_TIME) / 1000000 ))
  log "INFO" "$scope" "Finished (Exit: $exit_code, Time: ${duration}ms)"
}
```

### Step 2: 改造所有 Hook 脚本
在脚本头部引入库：
```bash
source "$CLAUDE_PROJECT_DIR/scripts/lib/telemetry.sh"
init_telemetry "pre_write_gate"

# ... 业务逻辑 ...

finish_telemetry 0
exit 0
```

### Step 3: 创建 `/system-status` Skill
- 统计 `SYSTEM.log` 中的 `CRITICAL` 数量。
- 计算平均耗时，找出性能瓶颈。
- 输出最近 10 条系统报错。

## 4. 预期收益
- **透明化**: 知道每个 Hook 是否正常运行。
- **性能优化**: 知道哪个环节最慢（比如 `jq` 处理大文件）。
- **快速排障**: 脚本崩溃时能定位到具体行号。
