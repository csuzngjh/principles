# 测试框架完整索引

> **最后更新**: 2026-03-11
> **状态**: ✅ 生产就绪

---

## 📚 测试文档导航

### 🎯 快速开始
- **快速参考**: [`QUICKREF.md`](QUICKREF.md) - 一页纸速查表
- **特性测试总结**: [`FEATURE_TESTING_SUMMARY.md`](FEATURE_TESTING_SUMMARY.md) - 实施总结和示例

### 📖 完整指南
- **通用测试指南**: [`TESTING_GUIDE.md`](TESTING_GUIDE.md) - OKR测试最佳实践
- **特性测试指南**: [`feature-testing/FEATURE_TESTING_GUIDE.md`](feature-testing/FEATURE_TESTING_GUIDE.md) - 特性测试详细文档
- **特性测试README**: [`feature-testing/README.md`](feature-testing/README.md) - 框架概览
- **脚本优化说明**: [`SCRIPT_IMPROVEMENTS.md`](SCRIPT_IMPROVEMENTS.md) - 脚本改进历史

---

## 🛠️ 测试工具

### OKR任务测试工具

| 脚本 | 用途 | 快速使用 |
|------|------|----------|
| [`run-okr-test.sh`](run-okr-test.sh) | 统一OKR测试 | `./run-okr-test.sh 1 structure` |
| [`score-report.sh`](score-report.sh) | 质量评分 | `./score-report.sh report.md` |
| [`compare-reports.sh`](compare-reports.sh) | 报告对比 | `./compare-reports.sh r1.md r2.md` |
| [`health-check-loop.sh`](health-check-loop.sh) | 健康检查 | `./health-check-loop.sh` |

### 特性测试工具

| 脚本 | 用途 | 快速使用 |
|------|------|----------|
| [`feature-testing/framework/feature-test-runner.sh`](feature-testing/framework/feature-test-runner.sh) | 运行特性测试 | `./feature-testing/framework/feature-test-runner.sh trust-system` |
| [`feature-testing/tools/list-scenarios.sh`](feature-testing/tools/list-scenarios.sh) | 列出所有场景 | `./feature-testing/tools/list-scenarios.sh` |
| [`feature-testing/tools/create-scenario.sh`](feature-testing/tools/create-scenario.sh) | 创建场景 | `./feature-testing/tools/create-scenario.sh` |

### 配置文件

| 文件 | 用途 |
|------|------|
| [`config/test-env.sh`](config/test-env.sh) | 统一环境配置 |

### 测试结果归档

| 脚本 | 用途 | 快速使用 |
|------|------|----------|
| [`save-test-results.sh`](save-test-results.sh) | 保存和归档测试结果 | `./save-test-results.sh test-name completed --commit` |

**重要文档**:
- **归档指南**: [`TEST_RESULTS_GUIDE.md`](TEST_RESULTS_GUIDE.md) - 如何使用归档系统
- **归档目录**: `archive/` - 所有测试历史结果按日期组织

---

## 🎯 测试场景

### OKR测试场景

| 场景 | 脚本 | 阶段 | 任务类型 |
|------|------|------|----------|
| **Phase 1 结构分析** | `run-okr-test.sh 1 structure` | 1 | 故事节奏、连贯性 |
| **Phase 1 角色一致性** | `run-okr-test.sh 1 character` | 1 | 角色特征检查 |
| **Phase 1 概念映射** | `run-okr-test.sh 1 concept` | 1 | 编程概念验证 |
| **Phase 1 用户痛点** | `run-okr-test.sh 1 pain` | 1 | 痛点识别 |

### 特性测试场景

| 场景文件 | 特性 | 步骤数 | 耗时 | 标签 |
|----------|------|--------|------|------|
| [`trust-system.json`](feature-testing/framework/test-scenarios/trust-system.json) | Trust Engine V2 | 8 | 3-5分钟 | core,trust,critical |
| [`gatekeeper.json`](feature-testing/framework/test-scenarios/gatekeeper.json) | Progressive Gatekeeper | 11 | 4-6分钟 | core,gate,security |
| [`evolution-worker.json`](feature-testing/framework/test-scenarios/evolution-worker.json) | Evolution Worker | 7 | 2-3分钟 | service,evolution,background |
| [`thinking-os.json`](feature-testing/framework/test-scenarios/thinking-os.json) | Thinking OS | 9 | 5-7分钟 | core,cognition,prompt |

---

## 🚀 常用命令

### 查看所有可用场景

```bash
# 特性测试场景
./tests/feature-testing/tools/list-scenarios.sh
```

### 运行单个测试

```bash
# OKR测试
./tests/run-okr-test.sh 1 structure

# 特性测试
./tests/feature-testing/framework/feature-test-runner.sh trust-system
```

### 批量测试

```bash
# 所有核心特性测试
for feature in trust-system gatekeeper evolution-worker thinking-os; do
    ./tests/feature-testing/framework/feature-test-runner.sh $feature
done
```

### 查看测试报告

```bash
# 最新报告
latest=$(ls -t tests/reports/feature-testing/*/test-report.md | head -1)
cat "$latest"

# 所有报告
ls -lh tests/reports/feature-testing/*/
```

### 评分和对比

```bash
# 评分报告
./tests/score-report.sh ~/clawd/okr-diagnostic/phase1-structure-report.md

# 对比两份报告
./tests/compare-reports.sh report-v1.md report-v2.md
```

---

## 📊 测试类型对比

| 测试类型 | 目的 | 方法 | 频率 | 工具 |
|---------|------|------|------|------|
| **健康检查** | 系统状态监控 | 收集指标 | 30分钟 | `health-check-loop.sh` |
| **OKR任务测试** | 验证Agent工作能力 | 真实任务 | 每日/按需 | `run-okr-test.sh` |
| **特性测试** | 验证插件功能 | 场景驱动 | 代码变更后 | `feature-test-runner.sh` |
| **质量评分** | 评估输出质量 | 自动评分 | 任务完成后 | `score-report.sh` |
| **报告对比** | 评估改进效果 | 差异分析 | 版本对比时 | `compare-reports.sh` |

---

## 🎓 使用场景指南

### 场景1: 日常开发

```bash
# 1. 修改代码后验证特性
./tests/feature-testing/framework/feature-test-runner.sh trust-system

# 2. 如果失败，查看日志
cat tests/reports/feature-testing/*/test.log | tail -50

# 3. 修复后重新测试
./tests/feature-testing/framework/feature-test-runner.sh trust-system
```

### 场景2: 发布前验证

```bash
# 1. 运行所有特性测试
for f in trust-system gatekeeper evolution-worker thinking-os; do
    ./tests/feature-testing/framework/feature-test-runner.sh $f || exit 1
done

# 2. 运行OKR测试验证Agent能力
./tests/run-okr-test.sh 1 structure

# 3. 评分输出质量
./tests/score-report.sh ~/clawd/okr-diagnostic/phase1-structure-report.md
```

### 场景3: 持续监控

```bash
# 设置30分钟自动健康检查
CronCreate 'cron="*/30 * * * *' prompt='bash /home/csuzngjh/code/principles/tests/health-check-loop.sh' recurring=true

# 查看定时任务
CronList
```

### 场景4: 问题诊断

```bash
# 1. 运行特性测试定位问题
./tests/feature-testing/framework/feature-test-runner.sh gatekeeper

# 2. 查看详细执行日志
cat tests/reports/feature-testing/*/execution.jsonl | jq '.'

# 3. 手动验证系统状态
cat ~/clawd/docs/AGENT_SCORECARD.json | jq '.'
```

### 场景5: 创建新测试

```bash
# 方法1: 交互式创建（推荐）
./tests/feature-testing/tools/create-scenario.sh

# 方法2: 复制现有场景
cp tests/feature-testing/framework/test-scenarios/trust-system.json \
   tests/feature-testing/framework/test-scenarios/my-feature.json
vim tests/feature-testing/framework/test-scenarios/my-feature.json
```

---

## 📈 测试覆盖度

### 当前覆盖

| 功能模块 | 覆盖率 | 场景数 | 状态 |
|---------|--------|--------|------|
| **Trust System** | 100% | 1 | ✅ |
| **Gatekeeper** | 100% | 1 | ✅ |
| **Evolution Worker** | 80% | 1 | ✅ |
| **Thinking OS** | 70% | 1 | ✅ |
| **Hook System** | 0% | 0 | ⏳ 待实现 |
| **Command Handlers** | 0% | 0 | ⏳ 待实现 |
| **Session Management** | 0% | 0 | ⏳ 待实现 |
| **Tool System** | 0% | 0 | ⏳ 待实现 |

### 待添加场景

- [ ] Hook System测试（所有hook的触发时机）
- [ ] Command Handlers测试（所有slash命令）
- [ ] Session Management测试（会话创建、状态保持）
- [ ] Subagent Spawning测试（子agent创建和继承）
- [ ] Event Logging测试（事件记录完整性）
- [ ] Tool System测试（自定义工具如deep-reflect）

---

## 🔧 配置和调优

### 环境变量

```bash
# 工作目录
export WORKSPACE_DIR="/home/csuzngjh/clawd"

# 默认模型
export DEFAULT_MODEL="unicom-cloud/MiniMax-M2.5"

# 测试超时
export TEST_TIMEOUT=300  # 5分钟

# 检查间隔
export CHECK_INTERVAL=20  # 20秒

# 详细日志
export VERBOSE=true
```

### 质量阈值

```bash
# 最小文件大小
export MIN_FILE_SIZE=10240  # 10KB

# 最小字数
export MIN_WORD_COUNT=500

# 最小质量分数
export MIN_QUALITY_SCORE=60
```

---

## 📝 最佳实践

### DO's ✅

1. **代码变更后运行特性测试**
2. **每日运行OKR测试监控Agent健康度**
3. **定期查看测试报告趋势**
4. **及时更新测试场景**
5. **保持测试环境独立**

### DON'Ts ❌

1. **不要跳过测试直接部署**
2. **不要忽视测试失败**
3. **不要在低信任分数下测试**
4. **不要提交测试报告到git**
5. **不要使用不稳定的模型**

---

## 🎯 快速决策树

```
需要测试?
├─ 验证Agent完成OKR能力?
│  └─ 使用: run-okr-test.sh
│
├─ 验证插件功能正确性?
│  └─ 使用: feature-test-runner.sh
│
├─ 监控系统健康状态?
│  └─ 使用: health-check-loop.sh
│
├─ 评估输出质量?
│  └─ 使用: score-report.sh
│
└─ 对比改进效果?
   └─ 使用: compare-reports.sh
```

---

## 📞 获取帮助

### 文档优先级

1. **快速查询**: [`QUICKREF.md`](QUICKREF.md)
2. **详细指南**: [`TESTING_GUIDE.md`](TESTING_GUIDE.md) 或 [`feature-testing/FEATURE_TESTING_GUIDE.md`](feature-testing/FEATURE_TESTING_GUIDE.md)
3. **示例代码**: [`FEATURE_TESTING_SUMMARY.md`](FEATURE_TESTING_SUMMARY.md)
4. **完整API**: 运行 `./tests/feature-testing/tools/create-scenario.sh` 查看交互式帮助

### 常见问题

**Q: 测试超时怎么办？**
A: 增加`TEST_TIMEOUT`环境变量

**Q: 如何调试失败的测试？**
A: 查看`tests/reports/feature-testing/*/test.log`和`execution.jsonl`

**Q: 如何添加新的验证器？**
A: 编辑`feature-test-runner.sh`，添加新的`validate_*`函数

**Q: 测试报告在哪里？**
A: `tests/reports/feature-testing/<FEATURE>-<TIMESTAMP>/`

---

## 🔄 版本历史

- **v1.0** (2026-03-11): 初始版本
  - 通用测试框架
  - 4个特性测试场景
  - 完整文档体系
  - OKR测试工具
  - 质量评分和对比工具

---

**维护者**: Claude Code
**最后更新**: 2026-03-11
**文档状态**: ✅ 完整且最新
