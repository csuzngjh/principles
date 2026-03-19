# 特性测试框架使用指南

## 📋 概述

通用特性测试框架用于对Principles Disciple插件的各项功能进行端到端测试，验证完整流程中的断点和错误。

### 核心特性

- ✅ **场景驱动**: 通过JSON定义测试场景，无需编写代码
- ✅ **自动化验证**: 自动检查预期结果和系统状态
- ✅ **断点检测**: 智能识别流程中的阻塞点
- ✅ **详细报告**: 生成Markdown和JSON格式的测试报告
- ✅ **灵活扩展**: 支持自定义验证器和检查类型

---

## 🚀 快速开始

### 1. 运行现有测试场景

```bash
# 测试Trust System
./tests/feature-testing/framework/feature-test-runner.sh trust-system

# 测试Gatekeeper
./tests/feature-testing/framework/feature-test-runner.sh gatekeeper

# 测试Evolution Worker
./tests/feature-testing/framework/feature-test-runner.sh evolution-worker

# 测试Thinking OS
./tests/feature-testing/framework/feature-test-runner.sh thinking-os
```

### 2. 使用自定义场景文件

```bash
./tests/feature-testing/framework/feature-test-runner.sh my-feature /path/to/my-scenario.json
```

### 3. 查看测试报告

```bash
# 查看最新测试报告
ls -lt tests/reports/feature-testing/ | head -5

# 查看详细日志
cat tests/reports/feature-testing/<FEATURE>-<TIMESTAMP>/test.log
```

---

## 📐 场景定义格式

### 完整场景结构

```json
{
  "metadata": {
    "name": "Feature Name",
    "description": "What this test covers",
    "version": "1.0",
    "author": "Your Name",
    "tags": ["tag1", "tag2"]
  },
  "setup": {
    "preconditions": ["condition1", "condition2"],
    "initial_state": {
      "key": "value"
    }
  },
  "steps": [
    {
      "name": "Step Name",
      "type": "task|validation|cleanup|wait",
      "description": "What this step does",
      "...": "step-specific fields"
    }
  ],
  "teardown": {
    "final_state": {...},
    "notes": ["observation1", "observation2"]
  }
}
```

### 步骤类型详解

#### 1. Task 步骤（发送任务给Agent）

```json
{
  "name": "Execute Agent Task",
  "type": "task",
  "description": "Send a task to the agent",
  "task": "The actual task prompt for the agent",
  "timeout": 120,
  "wait_for_completion": true,
  "expected_outcomes": [
    {
      "type": "file_exists",
      "path": "/path/to/file"
    },
    {
      "type": "file_contains",
      "path": "/path/to/file",
      "content": "expected text"
    },
    {
      "type": "trust_score",
      "operator": ">=",
      "value": 60
    },
    {
      "type": "event_logged",
      "event_type": "gate_block"
    }
  ]
}
```

#### 2. Validation 步骤（验证系统状态）

```json
{
  "name": "Validate System State",
  "type": "validation",
  "description": "Check system state matches expectations",
  "validator": "trust_validator|gate_validator|file_validator",
  "params": {
    "min_score": 60,
    "max_score": 100,
    "expected_stage": "Stage 3"
  }
}
```

#### 3. Cleanup 步骤（清理测试环境）

```json
{
  "name": "Cleanup",
  "type": "cleanup",
  "description": "Remove test artifacts",
  "actions": [
    {
      "type": "delete_file",
      "path": "/tmp/test-file.txt"
    },
    {
      "type": "reset_trust",
      "score": 59
    }
  ]
}
```

#### 4. Wait 步骤（等待条件）

```json
{
  "name": "Wait for Processing",
  "type": "wait",
  "description": "Allow time for background processing",
  "duration": 90,
  "reason": "Evolution worker scans every 90 seconds"
}
```

### 预期结果类型

| 类型 | 参数 | 说明 |
|------|------|------|
| `file_exists` | `path` | 检查文件是否存在 |
| `file_contains` | `path`, `content` | 检查文件是否包含内容 |
| `trust_score` | `operator`, `value` | 检查信任分数 |
| `event_logged` | `event_type` | 检查事件是否记录 |

---

## 🔧 验证器详解

### trust_validator

验证信任分数和阶段

```json
{
  "validator": "trust_validator",
  "params": {
    "min_score": 60,
    "max_score": 100,
    "expected_stage": "Stage 3"
  }
}
```

### gate_validator

验证Gate行为

```json
{
  "validator": "gate_validator",
  "params": {
    "should_block": true,
    "operation": "write"
  }
}
```

### file_validator

验证文件状态

```json
{
  "validator": "file_validator",
  "params": {
    "path": "/path/to/file",
    "min_size": 1024,
    "required_sections": ["Chapter 1", "Analysis"]
  }
}
```

---

## 📊 测试报告

### Markdown报告

```markdown
# Feature Test Report: trust-system

**Date**: 2026-03-11 12:00:00
**Feature**: trust-system
**Status**: ✅ PASSED
**Duration**: 245s

## Summary

| Metric | Value |
|--------|-------|
| Total Steps | 8 |
| Passed | 8 |
| Failed | 0 |
| Success Rate | 100% |

## Step Results

### Verify Initial Trust Score
- **Status**: passed
- **Duration**: 2s
- **Type**: validation

...
```

### JSON报告

```json
{
  "feature_name": "trust-system",
  "timestamp": "2026-03-11T12:00:00Z",
  "status": "passed",
  "summary": {
    "total_steps": 8,
    "passed_steps": 8,
    "failed_steps": 0,
    "success_rate": 100
  },
  "results": [...]
}
```

---

## 💡 创建新测试场景

### 方法1: 手动创建

```bash
# 1. 复制模板
cp tests/feature-testing/framework/test-scenarios/trust-system.json \
   tests/feature-testing/framework/test-scenarios/my-feature.json

# 2. 编辑场景
vim tests/feature-testing/framework/test-scenarios/my-feature.json

# 3. 运行测试
./tests/feature-testing/framework/feature-test-runner.sh my-feature
```

### 方法2: 使用场景生成器（推荐）

```bash
# 交互式创建场景
./tests/feature-testing/tools/create-scenario.sh

# 按提示输入：
# - Feature name: my-new-feature
# - Description: Test XYZ functionality
# - Step 1 type: task
# - Step 1 task: Create a test file...
# ... (继续添加步骤)
```

---

## 🎯 测试最佳实践

### 1. 场景设计原则

- **独立性**: 每个场景应该独立运行，不依赖其他场景
- **幂等性**: 多次运行同一场景应该产生相同结果
- **清理**: 始终在teardown中清理测试环境
- **明确性**: 步骤名称和描述应该清晰易懂

### 2. 步骤设计原则

- **原子性**: 每个步骤只做一件事
- **可验证**: 每个步骤都应该有明确的验证标准
- **合理的超时**: 根据任务复杂度设置合适的timeout
- **错误处理**: 考虑失败情况和边界条件

### 3. 验证策略

```json
// ✅ 好的验证 - 具体明确
{
  "expected_outcomes": [
    {
      "type": "file_exists",
      "path": "/tmp/specific-file.txt"
    },
    {
      "type": "file_contains",
      "path": "/tmp/specific-file.txt",
      "content": "exact expected text"
    }
  ]
}

// ❌ 差的验证 - 过于宽松
{
  "expected_outcomes": []
}
```

### 4. 超时设置建议

| 任务类型 | 建议超时 |
|---------|----------|
| 简单任务（创建文件） | 30-60秒 |
| 中等任务（分析文件） | 60-120秒 |
| 复杂任务（多步骤） | 120-300秒 |
| 后台服务（Evolution Worker） | 90-180秒 |

---

## 🐛 调试技巧

### 1. 启用详细日志

```bash
VERBOSE=true ./tests/feature-testing/framework/feature-test-runner.sh my-feature
```

### 2. 检查执行日志

```bash
# 查看实时执行事件
cat tests/reports/feature-testing/<FEATURE>-<TIMESTAMP>/execution.jsonl | jq '.'

# 查看特定步骤
grep '"step":3' tests/reports/feature-testing/<FEATURE>-<TIMESTAMP>/execution.jsonl | jq '.'
```

### 3. 手动验证

```bash
# 检查Agent会话
SESSION=$(cat ~/.openclaw/agents/main/sessions/sessions.json | jq -r '.[0].sessionFile')
tail -50 "$SESSION" | jq '.'

# 检查系统状态
cat ~/clawd/docs/AGENT_SCORECARD.json | jq '.'
cat ~/clawd/memory/.state/logs/events.jsonl | tail -10
```

### 4. 常见问题

| 问题 | 可能原因 | 解决方法 |
|------|----------|----------|
| 场景文件未找到 | 路径错误或文件不存在 | 检查路径，使用绝对路径 |
| Agent无响应 | Gateway未运行 | 启动Gateway |
| 超时 | 任务太复杂或Agent慢 | 增加timeout参数 |
| 验证失败 | 预期结果不正确 | 检查expected_outcomes |

---

## 📈 测试覆盖率

### 核心特性测试场景

| 特性 | 场景文件 | 覆盖内容 |
|------|----------|----------|
| **Trust System** | `trust-system.json` | 信任分数计算、阶段转换、奖惩机制 |
| **Gatekeeper** | `gatekeeper.json` | 阶段限制、行数限制、权限控制 |
| **Evolution Worker** | `evolution-worker.json` | 痛苦信号检测、队列、调度 |
| **Thinking OS** | `thinking-os.json` | 元认知层注入、使用跟踪、模型遵循 |

### 待添加的场景

- [ ] **Hook System**: 测试各个hook的触发时机和执行
- [ ] **Subagent Spawning**: 测试子agent创建和继承
- [ ] **Session Management**: 测试会话状态管理
- [ ] **Event Logging**: 测试事件记录完整性
- [ ] **Command Handlers**: 测试slash命令功能

---

## 🔄 集成到CI/CD

### GitHub Actions示例

```yaml
name: Feature Tests

on: [push, pull_request]

jobs:
  test-features:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      - name: Setup OpenClaw
        run: ./install-openclaw.sh --force
      - name: Start Gateway
        run: openclaw-gateway &
      - name: Run Feature Tests
        run: |
          ./tests/feature-testing/framework/feature-test-runner.sh trust-system
          ./tests/feature-testing/framework/feature-test-runner.sh gatekeeper
      - name: Upload Reports
        uses: actions/upload-artifact@v2
        with:
          name: test-reports
          path: tests/reports/feature-testing/
```

---

## 📝 场景模板

### 最小化模板

```json
{
  "metadata": {
    "name": "My Feature",
    "description": "Test my feature",
    "version": "1.0",
    "author": "Your Name",
    "tags": ["feature"]
  },
  "setup": {
    "preconditions": [],
    "initial_state": {}
  },
  "steps": [
    {
      "name": "First Step",
      "type": "task",
      "task": "Do something",
      "timeout": 60,
      "wait_for_completion": true,
      "expected_outcomes": []
    }
  ],
  "teardown": {
    "final_state": {},
    "notes": []
  }
}
```

---

## 🎓 进阶主题

### 自定义验证器

在 `feature-test-runner.sh` 中添加：

```bash
validate_custom() {
    local params="$1"

    # 自定义验证逻辑
    local value=$(echo "$params" | jq -r '.value')

    if [ "$value" == "expected" ]; then
        return 0
    else
        return 1
    fi
}
```

### 自定义预期结果类型

```bash
check_outcome() {
    # ... 现有代码 ...

    case "$type" in
        custom_type)
            # 自定义检查逻辑
            ;;
    esac
}
```

---

**文档版本**: v1.0
**最后更新**: 2026-03-11
**维护者**: iFlow CLI
