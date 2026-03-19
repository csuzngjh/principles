# 特性测试框架 - 完整指南

## 🎯 概述

这是一个通用的端到端测试框架，专门用于验证Principles Disciple插件的各项功能特性。通过JSON场景驱动，可以快速创建、执行和报告测试结果。

### 核心特性

- ✅ **场景驱动测试**: 无需编码，通过JSON定义测试流程
- ✅ **端到端验证**: 完整测试从输入到输出的全流程
- ✅ **断点检测**: 自动识别流程中的阻塞点和错误
- ✅ **详细报告**: 生成Markdown和JSON格式的测试报告
- ✅ **灵活扩展**: 支持自定义验证器和检查类型
- ✅ **易于维护**: 场景与代码分离，便于更新

---

## 📁 目录结构

```
tests/feature-testing/
├── framework/
│   ├── feature-test-runner.sh          # 核心测试引擎
│   └── test-scenarios/                 # 测试场景定义
│       ├── trust-system.json           # Trust System测试
│       ├── gatekeeper.json             # Gatekeeper测试
│       ├── evolution-worker.json       # Evolution Worker测试
│       └── thinking-os.json            # Thinking OS测试
├── tools/
│   ├── create-scenario.sh              # 场景生成器（交互式）
│   └── list-scenarios.sh               # 场景列表工具
├── FEATURE_TESTING_GUIDE.md            # 详细使用指南
└── README.md                           # 本文件
```

---

## 🚀 快速开始

### 1. 查看所有可用场景

```bash
./tests/feature-testing/tools/list-scenarios.sh
```

输出示例：
```
📋 trust-system
   Name:        Trust System
   Description: Test Trust Engine V2 - score calculation, stage transitions
   Version:     1.0
   Tags:        core, trust, critical
   Steps:       8

📋 gatekeeper
   Name:        Progressive Gatekeeper
   Description: Test gate enforcement across different stages
   Version:     1.0
   Tags:        core, gate, security
   Steps:       11
```

### 2. 运行测试

```bash
# 运行特定场景的测试
./tests/feature-testing/framework/feature-test-runner.sh trust-system

# 运行所有核心测试
for scenario in trust-system gatekeeper evolution-worker thinking-os; do
    ./tests/feature-testing/framework/feature-test-runner.sh $scenario
done
```

### 3. 查看测试报告

```bash
# 查看最新测试报告
ls -lt tests/reports/feature-testing/ | head -5

# 阅读Markdown报告
cat tests/reports/feature-testing/trust-system-20260311-120000/test-report.md

# 查看JSON报告
cat tests/reports/feature-testing/trust-system-20260311-120000/test-report.json | jq '.'
```

---

## 📊 已实现的测试场景

### 1. Trust System (trust-system.json)

**测试内容**:
- ✅ 初始信任分数验证
- ✅ 成功任务后信任分数增加
- ✅ 失败任务后信任分数减少
- ✅ Gate正确阻止高风险操作
- ✅ 阶段转换机制

**运行命令**:
```bash
./tests/feature-testing/framework/feature-test-runner.sh trust-system
```

**预期结果**: 8个步骤全部通过，约需3-5分钟

### 2. Progressive Gatekeeper (gatekeeper.json)

**测试内容**:
- ✅ Stage 1 限制（10行）
- ✅ 小文件写入成功
- ✅ 大文件写入被阻止
- ✅ Stage 4 无限制
- ✅ 阶段权限正确控制

**运行命令**:
```bash
./tests/feature-testing/framework/feature-test-runner.sh gatekeeper
```

**预期结果**: 11个步骤全部通过，约需4-6分钟

### 3. Evolution Worker (evolution-worker.json)

**测试内容**:
- ✅ 服务状态检查
- ✅ 痛苦信号创建
- ✅ 队列处理（等待90秒扫描周期）
- ✅ 事件日志记录
- ✅ 清理测试信号

**运行命令**:
```bash
./tests/feature-testing/framework/feature-test-runner.sh evolution-worker
```

**预期结果**: 6个步骤全部通过，约需2-3分钟

### 4. Thinking OS (thinking-os.json)

**测试内容**:
- ✅ THINKING_OS.md 配置验证
- ✅ T-03 (Evidence Over Intuition) 触发
- ✅ 证据收集验证
- ✅ 使用追踪记录
- ✅ T-07 (Minimum Viable Change) 触发

**运行命令**:
```bash
./tests/feature-testing/framework/feature-test-runner.sh thinking-os
```

**预期结果**: 9个步骤全部通过，约需5-7分钟

---

## 💡 创建自定义测试场景

### 方法1: 交互式创建（推荐）

```bash
./tests/feature-testing/tools/create-scenario.sh
```

按提示输入：
```
Feature name: my-new-feature
Description: Test my new functionality
Version: 1.0
Author: My Name
Tags: feature,new

Step 1:
  Name: Create test file
  Type: task
  Description: Create a test file via agent
  Enter task prompt: Create /tmp/test.txt with content 'Hello'
  Timeout: 60
  Wait for completion? Y

  Expected outcomes:
    Outcome 1:
      Type: file_exists
      File path: /tmp/test.txt
    Outcome 2:
      Type: file_contains
      File path: /tmp/test.txt
      Content: Hello
    Outcome 3:
      Type: done

Add another step? Y

Step 2:
  Name: done

Add another step? N
```

### 方法2: 手动编辑

```bash
# 1. 复制现有场景作为模板
cp tests/feature-testing/framework/test-scenarios/trust-system.json \
   tests/feature-testing/framework/test-scenarios/my-feature.json

# 2. 编辑场景
vim tests/feature-testing/framework/test-scenarios/my-feature.json

# 3. 验证JSON格式
cat tests/feature-testing/framework/test-scenarios/my-feature.json | jq '.'

# 4. 运行测试
./tests/feature-testing/framework/feature-test-runner.sh my-feature
```

### 方法3: 从零创建

创建 `my-feature.json`:

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
    "preconditions": ["Gateway is running"],
    "initial_state": {}
  },
  "steps": [
    {
      "name": "Test Step",
      "type": "task",
      "description": "Execute a test task",
      "task": "Create a test file at /tmp/test.txt",
      "timeout": 60,
      "wait_for_completion": true,
      "expected_outcomes": [
        {
          "type": "file_exists",
          "path": "/tmp/test.txt"
        }
      ]
    }
  ],
  "teardown": {
    "final_state": {},
    "notes": ["Test completed successfully"]
  }
}
```

---

## 🔧 高级用法

### 1. 详细日志模式

```bash
VERBOSE=true ./tests/feature-testing/framework/feature-test-runner.sh trust-system
```

### 2. 使用自定义场景文件

```bash
# 场景文件不在默认目录
./tests/feature-testing/framework/feature-test-runner.sh \
  my-feature \
  /path/to/custom-scenario.json
```

### 3. 批量测试

```bash
# 测试所有场景
for scenario in $(ls tests/feature-testing/framework/test-scenarios/*.json | xargs -n1 basename | sed 's/.json$//'); do
    echo "Testing $scenario..."
    ./tests/feature-testing/framework/feature-test-runner.sh "$scenario"
done
```

### 4. 并行测试（加速）

```bash
# 同时运行多个独立测试
./tests/feature-testing/framework/feature-test-runner.sh trust-system &
PID1=$!

./tests/feature-testing/framework/feature-test-runner.sh gatekeeper &
PID2=$!

wait $PID1
wait $PID2
```

---

## 📈 测试报告解析

### Markdown报告结构

```
# Feature Test Report: trust-system

**Status**: ✅ PASSED
**Duration**: 245s

## Summary
- Total Steps: 8
- Passed: 8
- Failed: 0
- Success Rate: 100%

## Step Results
### Verify Initial Trust Score
- Status: passed
- Duration: 2s
- Type: validation

...

## Execution Timeline
[2026-03-11T12:00:00+00:00] step_start: 1 Verify Initial Trust Score
[2026-03-11T12:00:02+00:00] step_complete: 1 Verify Initial Trust Score
...
```

### JSON报告结构

```json
{
  "feature_name": "trust-system",
  "status": "passed",
  "summary": {
    "total_steps": 8,
    "passed_steps": 8,
    "success_rate": 100
  },
  "results": [
    {
      "step": 1,
      "name": "Verify Initial Trust Score",
      "status": "passed",
      "duration": 2
    }
  ],
  "artifacts": {
    "log": "test.log",
    "execution_log": "execution.jsonl"
  }
}
```

---

## 🐛 调试技巧

### 1. 查看详细执行日志

```bash
# 查看所有事件
cat tests/reports/feature-testing/<TIMESTAMP>/execution.jsonl | jq '.'

# 过滤特定步骤
cat tests/reports/feature-testing/<TIMESTAMP>/execution.jsonl | \
  jq 'select(.data.step == 3)'

# 查看错误事件
cat tests/reports/feature-testing/<TIMESTAMP>/execution.jsonl | \
  jq 'select(.type == "step_failed")'
```

### 2. 手动验证系统状态

```bash
# 检查信任分数
cat ~/clawd/docs/AGENT_SCORECARD.json | jq '.'

# 检查Agent会话
SESSION=$(cat ~/.openclaw/agents/main/sessions/sessions.json | jq -r '.[0].sessionFile')
tail -50 "$SESSION" | jq '.'

# 检查事件日志
tail -20 ~/clawd/memory/.state/logs/events.jsonl | jq '.'

# 检查Gate blocks
tail -50 "$SESSION" | jq 'select(.message.details.error != null)'
```

### 3. 常见问题排查

| 症状 | 可能原因 | 诊断命令 | 解决方法 |
|------|----------|----------|----------|
| 场景文件未找到 | 路径错误 | `ls tests/feature-testing/framework/test-scenarios/` | 检查文件名和路径 |
| Agent无响应 | Gateway未运行 | `ps aux \| grep openclaw-gateway` | 启动Gateway |
| 验证失败 | 预期不匹配 | 查看test.log | 检查expected_outcomes |
| 超时 | 任务复杂/慢 | 检查execution.jsonl | 增加timeout |

---

## 🎯 最佳实践

### 1. 场景设计

- ✅ **独立性**: 每个场景独立运行
- ✅ **幂等性**: 多次运行结果一致
- ✅ **清理**: 始终清理测试环境
- ✅ **明确性**: 步骤名称清晰

### 2. 步骤设计

- ✅ **原子性**: 每步只做一件事
- ✅ **可验证**: 明确的验证标准
- ✅ **合理超时**: 根据复杂度设置
- ✅ **错误处理**: 考虑失败情况

### 3. 验证策略

```json
// ✅ 好 - 具体明确
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

// ❌ 差 - 过于宽松
{
  "expected_outcomes": []
}
```

### 4. 超时建议

| 任务类型 | 建议超时 |
|---------|----------|
| 简单任务 | 30-60秒 |
| 中等任务 | 60-120秒 |
| 复杂任务 | 120-300秒 |
| 后台服务 | 90-180秒 |

---

## 📚 相关文档

- **详细使用指南**: `FEATURE_TESTING_GUIDE.md`
- **通用测试指南**: `../TESTING_GUIDE.md`
- **快速参考**: `../QUICKREF.md`
- **脚本优化说明**: `../SCRIPT_IMPROVEMENTS.md`

---

## 🔄 待实现的测试场景

### 高优先级

- [ ] **Hook System**: 测试所有hook的触发时机
- [ ] **Command Handlers**: 测试slash命令（/trust, /thinking-os等）
- [ ] **Session Management**: 测试会话状态管理

### 中优先级

- [ ] **Subagent Spawning**: 测试子agent创建和继承
- [ ] **Event Logging**: 测试事件记录完整性
- [ ] **Tool System**: 测试自定义工具（deep-reflect等）

### 低优先级

- [ ] **Multi-Agent**: 测试多agent协作
- [ ] **Long-running**: 测试长时间运行的稳定性
- [ ] **Performance**: 测试性能和资源使用

---

## 🤝 贡献指南

添加新测试场景时：

1. **选择合适的场景文件名**: 使用kebab-case（如：`my-feature.json`）
2. **遵循JSON格式**: 使用jq验证：`cat my-feature.json | jq '.'`
3. **添加元数据**: 包含名称、描述、版本、作者、标签
4. **编写清晰的步骤**: 步骤名称和描述应该易懂
5. **设置合理的超时**: 根据任务复杂度
6. **添加预期结果**: 尽可能具体
7. **包含清理步骤**: 移除所有测试文件
8. **更新此文档**: 添加到"已实现的测试场景"部分

---

## 📞 支持

遇到问题时：

1. 查看日志: `cat tests/reports/feature-testing/<TIMESTAMP>/test.log`
2. 启用详细模式: `VERBOSE=true ./feature-test-runner.sh ...`
3. 参考示例场景: `framework/test-scenarios/*.json`
4. 阅读详细指南: `FEATURE_TESTING_GUIDE.md`

---

**版本**: v1.0
**最后更新**: 2026-03-11
**维护者**: iFlow CLI
**许可**: MIT
