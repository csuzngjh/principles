# Nocturnal Pipeline 优化 — Phase 2-5 设计与执行计划

> 基于 Phase 1 复盘：先定义接口 → 再写实现 → 边写边测 → 不把 build artifact 混入提交

---

## Phase 1 复盘：为什么代码质量差

| 错误 | 根因 | 改进 |
|------|------|------|
| 调用了不存在的方法 `findLatestPainSignal` | 写调用前没 grep 确认 EventLog 类是否有此方法 | **Rule 1: 每改一处调用前先 `grep` 目标定义** |
| 类型不匹配（score 传 number 不是 string） | 没读 `buildPainFlag` 的接口签名 | **Rule 2: 写代码前先读接口定义** |
| 路径错误（stateDir 传给 writePainFlag） | 没确认函数参数是 workspaceDir | **Rule 3: 不假设参数名，读源码确认** |
| tsconfig.tsbuildinfo 被提交 | 没检查 git diff 范围就 commit | **Rule 4: commit 前 `git diff --stat` 审查** |
| lint 引号问题没被发现 | 没本地跑 lint 就 push | **Rule 5: 写完立即 `npx tsc && npm run lint` 本地验证** |

---

## 当前状态（Phase 1 已完成）

| 模块 | 状态 | 说明 |
|------|------|------|
| 管道基础链路 | ✅ 打通 | `/pd-reflect` → Trinity → Arbiter → Artifact |
| Quota bypass | ✅ 完成 | manual/test 触发跳过 idle + cooldown + quota |
| Rich session 门槛 | ✅ 降低 | `>= 2` → `>= 1`，候选 10 → 87 |
| Stub reflector | ✅ 改进 | 使用实际事件内容而非模板 |
| Gate block pain | ✅ 已写 | `gate-block-helper.ts` 写入 pain signal（待合并 PR #264） |
| 诊断脚本 | ✅ 已合并 | 12 检查点 `diagnose-nocturnal.mjs`（PR #263） |
| Type errors 修复 | ✅ 已写 | 4 个类型错误 + 路径 bug（PR #264） |
| tsbuildinfo 清理 | ✅ 已写 | 从 git 移除并加入 .gitignore（PR #264） |

---

## Phase 2: 数据源扩展

### 2a. Gate Block Pain Signal ✅（已在 PR #264 中）

**状态**: 代码已写好，待 PR #264 合并。

### 2b. Correction Samples → Pain Signal（新）

**价值**: `correction_samples` 是系统中最高保真度的训练信号——人类明确指出 Agent 写错了什么。当前 `userCorrections: []` 始终为空，完全没被消费。

**设计**:

```
correction_samples (review_status='rejected')
  → 读取: sample_id, session_id, principle_ids_json, quality_score, diff_excerpt
  → 转换为 pain event (source='correction_rejected', score=基于 quality_score 映射)
  → 写入: trajectory.pain_events + .pain_flag（如分数够高）
  → 触发: evolution_queue 入队
```

**修改点**:
| 文件 | 改动 |
|------|------|
| `src/core/trajectory.ts` | 新增 `recordCorrectionRejected()` 方法 |
| `src/hooks/pain.ts` 或新文件 | 在 correction handler 的 rejected 分支调用 |
| `nocturnal-target-selector.ts` | 确认 `userCorrections` 能被 `detectViolation()` 使用 |

**验收标准**:
1. 一条 rejected correction sample 产生一个 pain event（source=correction_rejected）
2. 该 pain event 出现在 NocturnalSessionSnapshot 的 painEvents 列表中
3. `detectViolation()` 对 P_* 原则正确识别 correction 作为 violation 信号

### 2c. Principle Events → Pain Signal（新）

**价值**: `principle_events` 表有 `violated` 事件类型，表示原则被违反了。当前管道从原始事件重新计算合规性，忽略了这些已聚合的事件。

**设计**: 只读不写——在 `NocturnalTrajectoryExtractor` 中增加 `listPrincipleViolationsForSession(sessionId)` 查询，将结果传入 `detectViolation()` 的 `planApprovals`/`userCorrections` 参数。

---

## Phase 3: 数据质量提升

### 3a. Stub Reflector 多事件分析 ✅（已在 PR #264 中）

**状态**: 代码已写好（使用实际事件内容），待 PR #264 合并。

### 3b. 种子数据注入（新）

**问题**: 当前只有 62 个 tool_failure 和 25 个 user_empathy，信号类型极度单一。

**方案**: 创建 10-20 个已知高质量的合成 pain 场景作为种子，覆盖：

| 场景 | 信号类型 | 预期原则 |
|------|----------|----------|
| 安全漏洞（写入敏感信息） | tool_failure + gate_block | P_005 (Security) |
| 架构违反（循环依赖） | user_correction + pain | T-02 (Type Safety) |
| 过度工程（10 行写 100 行） | user_empathy (severe) | T-06 (Simplicity) |
| 边界条件遗漏 | tool_failure (null deref) | T-03 (Evidence-Based) |
| 错误处理缺失 | tool_failure + pain cascade | P_001 (Error Prevention) |
| 未读文件就编辑 | gate_block + pain | T-01 (Map Before Territory) |
| 批量操作无计划 | gate_block + user_empathy | T-07 (Blast Radius) |
| 失败后继续操作 | pain cascade | T-08 (Pain as Signal) |
| 复杂任务未分解 | tool_failure + multiple pains | T-09 (Task Division) |

**实现**: 创建一个 `scripts/seed-nocturnal-scenarios.mjs` 脚本，直接向 trajectory.db 写入合成数据。

### 3c. 多样本去重机制（新）

**问题**: 同一个错误模式跨 session 重复出现，但当前没有跨 session 聚合。

**方案**: 在 `evolution-worker.ts` 的 `processEvolutionQueue` 中增加 pain task 去重逻辑（关键词重叠 > 70% 视为重复）。

---

## Phase 4: 测试覆盖

### 4a. Correction Samples 集成测试

```typescript
it('e2e: correction_rejected → pain event → nocturnal selection', async () => {
  // 1. Seed a rejected correction sample
  // 2. Run pipeline
  // 3. Verify pain event was created
  // 4. Verify TargetSelector picked up the session
  // 5. Verify artifact references the correction
});
```

### 4b. Gate Block 多信号场景测试

```typescript
it('selects session with both gate_block and pain signals', async () => {
  // Session has 2 gate blocks + 1 pain event
  // Verify violation density > session with just 1 pain event
});
```

### 4c. 边界值测试矩阵

| 测试 | 场景 | 预期 |
|------|------|------|
| 空 pipeline | 无 session、无 pain、无 gate block | skip: insufficient_snapshot_data |
| 仅 1 个 pain | 1 个 pain signal，无 failure | 选中该 session |
| 仅 1 个 gate block | 1 个 gate block，无 pain | 选中（MIN_VIOLATION_DEPTH=1） |
| 仅 1 个 failure | 1 个 failure，无 pain/gate | 选中 |
| 全 cooldown | 所有原则都在 cooldown 中 | skip: all_targets_in_cooldown |
| Quota 耗尽 | 3/3 runs used | manual 触发绕过，auto 触发跳过 |

---

## Phase 5: 可观测性增强

### 5a. Pipeline Metrics Dashboard

在 `diagnose-nocturnal.mjs` 中新增检查点：

| # | 检查点 | 验证内容 |
|---|--------|----------|
| 13 | Correction samples | 是否有 rejected 样本可作为 pain 来源 |
| 14 | Principle violations | 是否有未消费的 violated 事件 |
| 15 | Signal diversity | pain signal 来源种类数（目标 ≥ 4） |
| 16 | Artifact uniqueness | 最近 artifact 的 badDecision 是否有重复 |

### 5b. Pipeline 执行日志增强

在关键路径添加结构化日志：
- `TargetSelector.select()` → 输出候选原则列表及分数
- `detectViolation()` → 输出哪些信号触发了 violation
- `invokeStubReflector()` → 输出使用了哪个事件作为内容源

---

## 执行顺序

```
Phase 2b (correction_rejected pain)  →  1 天
Phase 3b (seed scenarios)            →  0.5 天
Phase 4a-4c (tests)                  →  1.5 天  ← 与 Phase 2b 并行
Phase 3c (dedup)                     →  0.5 天
Phase 2c (principle events)          →  0.5 天
Phase 5a-5b (observability)          →  0.5 天
```

---

## 每个 Phase 的交付检查清单

### Phase 2b: Correction Samples Pain
- [ ] `grep` 确认 `correction_samples` 表结构和现有写入点
- [ ] 定义 `recordCorrectionRejected()` 接口并写进 `trajectory.ts`
- [ ] 在 correction handler 的 rejected 分支调用
- [ ] `npx tsc --noEmit` 本地验证（**不等 CI**）
- [ ] `npm run lint` 本地验证
- [ ] `git diff --stat` 审查变更范围
- [ ] 提交（不含 build artifact）
- [ ] 写 E2E 测试

### Phase 3b: Seed Scenarios
- [ ] 设计 10 个场景的数据结构
- [ ] 编写 `seed-nocturnal-scenarios.mjs`
- [ ] 手动执行验证数据写入
- [ ] 运行诊断脚本确认新场景被识别

### Phase 4: Tests
- [ ] 每个新数据源至少 2 个 E2E 测试
- [ ] 边界值矩阵全部覆盖
- [ ] `npm test` 全量通过

---

## 代码质量标准（强制执行）

1. **写调用前 grep 定义** — 永远不假设方法存在
2. **写完立即 tsc + lint** — 不等 CI 报错了再修
3. **提交前 git diff 审查** — 不混入 build artifact
4. **每个改动配一个测试** — 不单独提交无测试的功能代码
5. **PR 描述写清楚接口变更** — 不只是功能描述
