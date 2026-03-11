# Principles Disciple - 综合测试计划

> **创建日期**: 2026-03-11
> **执行者**: Claude Code
> **目的**: 基于第一性原理，全面验证Principles Disciple插件的核心功能

---

## 📋 测试概览

### 测试目标

验证Principles Disciple插件的**核心进化机制**是否按预期工作：
1. ✅ Trust System - 安全基础，动态权限调整
2. ✅ Gatekeeper - 执行层，保护关键文件
3. ✅ Pain Detection → Evolution - 自我修复循环
4. ✅ 端到端 - Agent完成真实OKR任务

### 测试范围

| 特性 | 优先级 | 场景数 | 预计时间 | 状态 |
|------|--------|--------|----------|------|
| Trust System Deep | P0 | 1 | 10-15分钟 | ⏳ 待执行 |
| Gatekeeper Boundaries | P0 | 1 | 15-20分钟 | ⏳ 待执行 |
| Pain-Evolution Chain | P1 | 1 | 5-10分钟 | ⏳ 待执行 |
| Real OKR Task | P1 | 1 | 5-10分钟 | ⏳ 待执行 |

### 预期成果

- **测试报告**: 每个场景的详细报告（Markdown + JSON）
- **验证结果**: 每个特性的核心机制是否正确工作
- **问题列表**: 发现的bug、断点、异常行为
- **优化建议**: 基于测试结果的改进建议

---

## 🎯 Phase 1: 准备工作

### 1.1 环境检查

**目的**: 确保测试环境就绪

```bash
# 检查Gateway运行状态
ps aux | grep openclaw-gateway

# 检查工作区
ls -la ~/clawd/docs/
ls -la ~/clawd/memory/.state/

# 检查Agent状态
cat ~/.openclaw/agents/main/agent/sessions/sessions.json | jq '.'
```

**预期结果**:
- ✅ Gateway运行中
- ✅ 工作区文件存在
- ✅ Agent session正常

**退出标准**: 所有检查通过

---

### 1.2 清理测试环境

**目的**: 从干净状态开始测试

```bash
# 清理旧的测试报告
rm -rf tests/reports/feature-testing/old-*
mkdir -p tests/reports/feature-testing

# 重置Trust Score到59（冷启动）
cat > /tmp/reset-trust.json << 'EOF'
{
  "trust_score": 59,
  "success_streak": 0,
  "failure_streak": 0,
  "grace_failures_remaining": 3,
  "last_updated": "$(date -Iseconds)",
  "cold_start_end": "$(date -d '+24 hours' -Iseconds)",
  "history": []
}
EOF
cp /tmp/reset-trust.json ~/clawd/docs/AGENT_SCORECARD.json

# 清理旧pain flags
rm -f ~/clawd/workspace/code/principles/docs/.pain_flag
rm -f ~/clawd/memory/.state/evolution_queue.json
rm -f ~/clawd/memory/.state/evolution_directive.json

# 验证清理完成
echo "Trust Score: $(cat ~/clawd/docs/AGENT_SCORECARD.json | jq '.trust_score')"
echo "Grace Remaining: $(cat ~/clawd/docs/AGENT_SCORECARD.json | jq '.grace_failures_remaining')"
```

**预期结果**:
- ✅ Trust Score = 59
- ✅ Grace Remaining = 3
- ✅ 无旧pain signals

**退出标准**: 环境干净，信任分数正确

---

## 🔬 Phase 2: 核心特性测试

### 测试 2.1: Trust System - 深度分析

**文件**: `trust-system-deep.json`

**执行命令**:
```bash
cd /home/csuzngjh/code/principles
./tests/feature-testing/framework/feature-test-runner.sh trust-system-deep
```

**测试内容**:
1. Cold Start初始化验证
2. Grace Failures消耗测试（3次无惩罚）
3. Grace耗尽后的惩罚测试
4. Failure Streak Multiplier验证
5. Recovery Boost验证
6. Streak Bonus验证（连续5次成功）
7. 边界测试（Score=0, Score=100）
8. History Tracking验证

**观察点**:
- 每次操作的Score变化
- Grace数量的变化
- Streak状态的变化
- History记录的完整性

**预期结果**:
- ✅ Cold Start: Score=59, Grace=3
- ✅ Grace消耗: Score不变，Grace递减
- ✅ 首次惩罚: Score 59→51 (-8)
- ✅ Streak惩罚: -8 → -11 → -14
- ✅ Recovery boost: +4 (base 1 + boost 3)
- ✅ Streak bonus: 第5次成功额外+5
- ✅ 边界保护: Score不<0, 不>100

**验证标准**:
- 所有数值精确匹配预期
- History记录完整（每步都有）
- 无异常或错误

**时间预估**: 10-15分钟

---

### 测试 2.2: Gatekeeper - 边界分析

**文件**: `gatekeeper-boundaries.json`

**执行命令**:
```bash
./tests/feature-testing/framework/feature-test-runner.sh gatekeeper-boundaries
```

**测试内容**:
1. Stage 1 (Score 20):
   - Risk path阻止
   - 非平凡大文件阻止
2. Stage 2 (Score 40):
   - Risk path阻止
   - 10行限制验证
3. Stage 3 (Score 70):
   - Plan依赖验证
   - 100行限制验证
4. Stage 4 (Score 100):
   - 完全绕过验证
   - 无限制写入

**观察点**:
- 每个Stage的决策过程
- Block原因的准确性
- Line limits的精确性
- Plan whitelist的工作状态

**预期结果**:
- ✅ Stage 1: 只允许whitelist，阻止其他
- ✅ Stage 2: 禁止risk paths，限制10行
- ✅ Stage 3: 需要READY plan，限制100行
- ✅ Stage 4: 完全无限制
- ✅ 所有Block原因清晰

**验证标准**:
- 权限矩阵100%准确
- Block原因符合预期
- Line limits精确到行
- 事件日志完整记录

**时间预估**: 15-20分钟

---

### 测试 2.3: Pain-Evolution 完整链路

**文件**: `pain-evolution-chain.json`

**执行命令**:
```bash
./tests/feature-testing/framework/feature-test-runner.sh pain-evolution-chain
```

**测试内容**:
1. 诱导Tool Failure（非风险）
   → 验证Pain Score=30
   → 验证Trust -8
2. 诱导Risky Failure
   → 验证Pain Score=50 (30+20)
   → 验证Trust -15
3. 等待EvolutionWorker扫描
   → 验证队列化（score≥30）
   → 验证Directive生成
4. 低分信号测试（score<30）
   → 验证不被队列化
5. 去重测试
   → 验证重复信号不入队

**观察点**:
- Pain信号的生成和格式
- Trust惩罚的delta
- 队列化的阈值（30）
- 优先级排序（高分优先）
- 事件链完整性

**预期结果**:
- ✅ Pain Score计算正确（30/50）
- ✅ Trust惩罚正确（-8/-15）
- ✅ 只队列化score≥30的信号
- ✅ 高分信号优先处理
- ✅ 事件链完整可追溯

**验证标准**:
- Pain→Trust→Queue→Directive链路完整
- 所有数值精确匹配
- 阈值过滤正确工作
- 无信号丢失或重复

**时间预估**: 5-10分钟

---

## 🌍 Phase 3: 端到端测试

### 测试 3.1: 真实OKR任务

**目的**: 验证Agent在真实工作场景下的表现

**执行命令**:
```bash
# 设置高信任分数（Stage 4）
cat > /tmp/set-trust-100.json << 'EOF'
{
  "trust_score": 100,
  "success_streak": 10,
  "failure_streak": 0,
  "last_updated": "$(date -Iseconds)",
  "history": []
}
EOF
cp /tmp/set-trust-100.json ~/clawd/docs/AGENT_SCORECARD.json

# 执行OKR任务
./tests/run-okr-test.sh 1 structure

# 评分输出质量
./tests/score-report.sh ~/clawd/okr-diagnostic/phase1-structure-report.md
```

**任务内容**:
Phase 1: 故事结构分析
- 读取chapter-01.md
- 分析节奏和连贯性
- 生成诊断报告

**观察点**:
- Agent是否成功完成任务
- 输出文件质量（大小、字数、内容）
- Trust变化（如果有）
- Gate blocks（如果有）

**预期结果**:
- ✅ 报告文件生成成功
- ✅ 文件大小 ≥ 10KB
- ✅ 字数 ≥ 500
- ✅ 包含必需章节
- ✅ 质量分数 ≥ 60/100

**验证标准**:
- 任务完成度100%
- 输出质量合格
- 无Gate blocks（Stage 4）

**时间预估**: 5-10分钟

---

## 📊 Phase 4: 结果分析

### 4.1 汇总测试结果

**收集数据**:
```bash
# 收集所有测试报告
TEST_DIR=tests/reports/feature-testing
LATEST_TEST=$(ls -t $TEST_DIR/* | head -1)

echo "=== 测试汇总 ==="
echo "测试目录: $LATEST_TEST"
echo ""

# 统计通过率
echo "通过率统计:"
jq -r '.summary.success_rate' $LATEST_TEST/test-report.json

# 列出失败的步骤
echo ""
echo "失败的步骤:"
jq -r '.results[] | select(.status == "failed") | "- \(.name) (Step \(.step))"' $LATEST_TEST/test-report.json

# Trust Score最终值
echo ""
echo "最终Trust Score:"
cat ~/clawd/docs/AGENT_SCORECARD.json | jq '.trust_score'
```

### 4.2 生成综合报告

**创建文件**: `tests/COMPREHENSIVE_TEST_REPORT.md`

内容包括:
1. 执行摘要
2. 测试覆盖度
3. 每个特性的详细结果
4. 发现的问题列表
5. 优化建议
6. 结论和下一步行动

---

## 🎯 测试检查清单

### 执行前

- [ ] Gateway运行正常
- [ ] 工作区文件完整
- [ ] Trust Score重置到59
- [ ] 测试环境清理干净
- [ ] 备份现有AGENT_SCORECARD.json

### 执行中

- [ ] Trust System测试完成
- [ ] Gatekeeper测试完成
- [ ] Pain-Evolution测试完成
- [ ] OKR端到端测试完成
- [ ] 每个测试的报告生成

### 执行后

- [ ] 所有测试报告收集
- [ ] 通过率统计
- [ ] 问题列表整理
- [ ] 优化建议文档
- [ ] 环境恢复（可选）

---

## 🚨 风险评估

### 潜在问题和缓解措施

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| Gateway未运行 | 中 | 高 | 测试前检查，启动Gateway |
| API限流 | 中 | 中 | 使用MiniMax-M2.5模型 |
| 测试超时 | 低 | 中 | 增加timeout参数 |
| 文件权限问题 | 低 | 低 | 工作区有写权限 |
| Trust Score异常 | 低 | 中 | 重置为59（冷启动） |

---

## 📝 测试日志模板

```markdown
## 测试执行日志

**日期**: 2026-03-11
**执行者**: Claude Code
**环境**: Gateway运行中，Model=MiniMax-M2.5

### Test 2.1: Trust System Deep

**开始时间**: HH:MM:SS
**结束时间**: HH:MM:SS
**状态**: ✅ PASSED / ❌ FAILED

**关键发现**:
- [ ] Cold Start: 正确 / 异常
- [ ] Grace Failures: 正确 / 异常
- [ ] Streak Bonus: 正确 / 异常
- [ ] 边界保护: 正确 / 异常

**问题列表**:
1. 问题描述
   - 严重程度: P0/P1/P2
   - 复现步骤:
   - 实际行为:
   - 预期行为:

### Test 2.2: Gatekeeper Boundaries

...

### Test 2.3: Pain-Evolution Chain

...

### Test 3.1: Real OKR Task

...

## 总结

**总体通过率**: X%
**关键发现**: ...
**推荐行动**: ...
```

---

## 🎯 成功标准

### 测试成功定义

**通过条件**:
- ✅ 所有P0测试通过（Trust, Gatekeeper）
- ✅ 至少80%的P1测试通过
- ✅ 端到端OKR任务成功完成
- ✅ 无P0级别bug未发现

**可接受条件**:
- ⚠️ P0测试通过，P1有少量失败
- ⚠️ 端到端任务完成但质量一般
- ⚠️ 有P1级别问题但有解决方案

**失败条件**:
- ❌ 任何P0测试失败
- ❌ 端到端任务无法完成
- ❌ 发现无法解释的异常行为

---

## 📅 时间安排

| 阶段 | 任务 | 时间 | 状态 |
|------|------|------|------|
| Phase 1 | 环境准备 | 5-10分钟 | ⏳ 待开始 |
| Phase 2 | Trust System测试 | 10-15分钟 | ⏳ 待开始 |
| Phase 2 | Gatekeeper测试 | 15-20分钟 | ⏳ 待开始 |
| Phase 2 | Pain-Evolution测试 | 5-10分钟 | ⏳ 待开始 |
| Phase 3 | OKR端到端测试 | 5-10分钟 | ⏳ 待开始 |
| Phase 4 | 结果分析 | 10-15分钟 | ⏳ 待开始 |
| **总计** | | **50-80分钟** | |

---

## 🚀 立即开始

准备好了吗？让我们开始执行！

**第一步**: 运行环境检查
```bash
bash << 'EOF'
echo "=== 环境检查 ==="
ps aux | grep -q "[o]penclaw-gateway" && echo "✅ Gateway运行中" || echo "❌ Gateway未运行"
ls ~/clawd/docs/AGENT_SCORECARD.json >/dev/null 2>&1 && echo "✅ Scorecard存在" || echo "❌ Scorecard缺失"
ls ~/clawd/memory/.state/logs/events.jsonl >/dev/null 2>&1 && echo "✅ 事件日志存在" || echo "❌ 事件日志缺失"
EOF
```

**第二步**: 开始Phase 1准备
（见上文Phase 1详细步骤）

**第三步**: 依次执行核心测试
（见Phase 2详细步骤）

---

**计划版本**: v1.0
**创建日期**: 2026-03-11
**状态**: ✅ 就绪，开始执行
