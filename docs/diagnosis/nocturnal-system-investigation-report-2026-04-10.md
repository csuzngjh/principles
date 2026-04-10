# Nocturnal 原则内化系统调查报告

**日期**: 2026-04-10  
**报告对象**: 原 Nocturnal 功能开发人员  
**调查范围**: 原则内化系统（Principle Internalization System）的生产运行状态、已知问题、修复记录和待办事项

---

## 一、执行摘要

### 核心结论

**原则内化系统的"骨架"（代码）已完整部署，但"血肉"（数据层）从未填充。**

| 组件 | 代码状态 | 数据状态 | 运行状态 |
|------|----------|----------|----------|
| Principle Tree Ledger | ✅ 已部署 | ⚠️ 部分填充 | ⚠️ 需验证 |
| Rule Host | ✅ 已部署 | ❌ 空 | ❌ 无法运行 |
| Replay Engine | ✅ 已部署 | ❌ 无样本 | ❌ 无法运行 |
| Nocturnal Artificer | ✅ 已部署 | ⚠️ 高失败率 | ⚠️ 部分可用 |
| Evolution Worker | ✅ 已部署 | ✅ 正常运行 | ✅ 活跃 |

---

## 二、生产环境数据快照

### 2.1 原则树账本状态

```
文件位置: ~/.openclaw/workspace-main/.state/principle_training_state.json

数据格式: 混合格式（旧 trainingStore + 新 _tree）
```

| 指标 | 值 | 说明 |
|------|-----|------|
| trainingStore 原则数 | 74 | 旧格式，兼容保留 |
| `_tree.principles` | 74 | ✅ 已迁移（2026-04-10T00:12:35Z） |
| `_tree.rules` | **0** | ❌ 空！关键缺失 |
| `_tree.implementations` | **0** | ❌ 空！关键缺失 |

**迁移日志证据**:
```
[2026-04-10T00:12:35.876Z] [PRINCIPLE_TREE_MIGRATION_COMPLETE] Migrated 74 principles to tree.principles (0 skipped, 0 errors)
```

### 2.2 进化队列状态

```
文件位置: ~/.openclaw/workspace-main/.state/evolution_queue.json
```

| 状态 | 数量 | 占比 |
|------|------|------|
| completed | 9 | 41% |
| failed | 13 | 59% |
| pending | 0 | 0% |
| in_progress | 0 | 0% |

**失败原因分布**:

| 失败原因 | 数量 | 根因分类 |
|----------|------|----------|
| `sleep_reflection timed out after 30 minutes` | 4 | 超时 |
| `Plugin runtime subagent methods are only available during a gateway request` | 3 | 子智能体不可用 |
| `Workflow terminal_error: Stale active > 10s` | 2 | 状态过期 |
| `no_target_selected (skipReason: insufficient_snapshot_data)` | 2 | 数据不足（#200） |
| `no_target_selected (skipReason: no_violating_sessions)` | 2 | 正常（无违规会话） |

### 2.3 进化积分状态

```
文件位置: ~/.openclaw/workspace-main/.state/evolution-scorecard.json
```

| 指标 | 值 |
|------|-----|
| 总积分 | 10,888 |
| 可用积分 | 10,888 |
| 当前 Tier | 5 |
| 成功操作 | 1,542 |
| 失败操作 | 3 |
| 连续成功 | 663 |

---

## 三、关键问题分析

### 3.1 P0: Rule/Implementation 层为空

**现象**: `_tree.rules = {}`, `_tree.implementations = {}`

**根因**: Phase 11（原则树实体化）只完成了 `createPrinciple()`，缺少：
1. Rule 生成逻辑
2. Implementation 生成逻辑

**影响**:
- Rule Host 无法加载任何实现
- 整个原则内化流程在 Rule 层断开
- `pd-promote-impl` 等命令无数据可操作

**代码位置**:
```
packages/openclaw-plugin/src/core/principle-tree-ledger.ts
  - createPrinciple() ✅ 存在
  - createRule() ✅ 存在
  - createImplementation() ✅ 存在

packages/openclaw-plugin/src/core/evolution-reducer.ts
  - createPrincipleFromDiagnosis() 只调用 updateTrainingStore()
  - 不调用 createRule() 或 createImplementation()
```

### 3.2 P1: Nocturnal 任务高失败率

**失败率**: 13/22 = 59%

**根本原因分析**:

#### 原因 A: 子智能体 API 不可用（3 例）

```
sleep_reflection failed: Error: Plugin runtime subagent methods are only available during a gateway request.
```

**根因**: Gateway 在独立进程运行时，子智能体 API 仅在请求上下文中可用。Evolution Worker 是后台服务，不在请求上下文中。

**代码位置**:
```
packages/openclaw-plugin/src/service/subagent-workflow/nocturnal-workflow-manager.ts:181
  throw new Error(`NocturnalWorkflowManager: subagent runtime unavailable`);
```

**现有缓解措施**:
```typescript
// subagent-error-utils.ts
export function isExpectedSubagentError(err: unknown): boolean {
  // 已识别 daemon/cron 模式的预期错误
}
```

**问题**: 缓解措施只是标记为 `stub_fallback`，不会真正执行 Nocturnal 反思。

#### 原因 B: 超时（4 例）

```
sleep_reflection timed out after 30 minutes
```

**根因**: Trinity 链（Dreamer → Philosopher → Scribe）执行时间超过 30 分钟限制。

**可能原因**:
- 子智能体调用延迟
- 大量历史数据分析
- 模型响应慢

#### 原因 C: 数据不足（2 例，#200 相关）

```
no_target_selected (skipReason: insufficient_snapshot_data)
```

**根因**: trajectory extractor 返回空数据时，fallback 路径的 stats 硬编码为 0。

**Issue**: #200（已关闭，但可能未完全修复）

### 3.3 P2: 已关闭 Issue 状态

| Issue | 标题 | 状态 | 说明 |
|-------|------|------|------|
| #200 | snapshot stats hardcoded to 0 | CLOSED | fallback 路径数据问题 |
| #202 | sleep_reflection 在 cron session 中全部 failed | CLOSED | try-finally 无 catch |
| #204 | EvolutionReducer 和 principle_training_state.json 断联 | CLOSED | ✅ 本次修复 |
| #205 | NocturnalWorkflowManager 绕过核心逻辑 | CLOSED | principleId 硬编码问题 |

---

## 四、代码变更历史摘要

### 4.1 PR #195: 原则内化系统（v1.9.0）

**提交**: `4cbf211f`

**新增功能**:
- Principle Tree Ledger（三层账本）
- Rule Host（在线态规则执行）
- Replay Engine（回放评估）
- Nocturnal Artificer（候选生成）
- Lifecycle Commands（`pd-promote-impl` 等）

**遗漏项**:
- ❌ `createPrinciple()` 函数（本次修复添加）
- ❌ Evolution Worker 调用 `createPrinciple()`（本次修复添加）
- ❌ 数据迁移脚本 `trainingStore → tree.principles`（本次修复添加）

### 4.2 PR #217: v1.9.1 补丁（Issues #207-#215）

**提交**: `8ae261c7`

**修复内容**:
- #208/#209: 扩展 `isExpectedSubagentError` 处理 daemon 模式错误
- #213: 添加 `.catch()` 到 fire-and-forget Promise
- #214: sleep_reflection 超时时过期 nocturnal workflow
- #212: evaluability 默认值改为 `weak_heuristic`
- #207/#210: WorkspaceContext 路径修复
- #215: 移除废弃的 `src/agents/*.md` 文件（prompts 已内嵌）

**测试覆盖**: 新增 `regression-v1-9-1.test.ts`（13 个测试）

---

## 五、系统架构现状

### 5.1 数据流断点

```
                    ┌─────────────────────────────────────┐
                    │      Pain Signal Detection          │
                    │   (hooks/pain.ts → pain_flag)       │
                    └─────────────────┬───────────────────┘
                                      │
                                      ▼
                    ┌─────────────────────────────────────┐
                    │      Evolution Worker Service       │
                    │   (15min 轮询 → evolution_queue)    │
                    └─────────────────┬───────────────────┘
                                      │
                    ┌─────────────────┴───────────────────┐
                    │                                     │
                    ▼                                     ▼
        ┌───────────────────┐              ┌───────────────────┐
        │  pain_diagnosis   │              │  sleep_reflection │
        │  (Diagnostician)  │              │  (Nocturnal)      │
        └─────────┬─────────┘              └─────────┬─────────┘
                  │                                  │
                  ▼                                  ▼
        ┌───────────────────┐              ┌───────────────────┐
        │ createPrinciple() │              │  Trinity Chain    │
        │ ✅ 已修复         │              │  Dreamer → Phil   │
        └─────────┬─────────┘              │  → Scribe         │
                  │                        └─────────┬─────────┘
                  ▼                                  │
        ┌───────────────────┐                        │
        │ _tree.principles  │                        ▼
        │ ✅ 74 条          │              ┌───────────────────┐
        └───────────────────┘              │ createRule()      │
                                           │ ❌ 从未调用        │
                                           └─────────┬─────────┘
                                                     │
                                                     ▼
                                           ┌───────────────────┐
                                           │ _tree.rules       │
                                           │ ❌ 空              │
                                           └─────────┬─────────┘
                                                     │
                                                     ▼
                                           ┌───────────────────┐
                                           │ createImpl()      │
                                           │ ❌ 从未调用        │
                                           └─────────┬─────────┘
                                                     │
                                                     ▼
                                           ┌───────────────────┐
                                           │ _tree.impls       │
                                           │ ❌ 空              │
                                           └───────────────────┘
```

### 5.2 Rule Host 空转

**代码路径**:
```
packages/openclaw-plugin/src/core/rule-host.ts

async loadActiveImplementations(stateDir: string): Promise<LedgerImplementation[]>
  // 从 ledger.tree.implementations 加载
  // 过滤 lifecycleState='active' 且 type='code'
```

**当前状态**: `ledger.tree.implementations = {}` → 返回空数组 → 无规则可执行

---

## 六、待办事项清单

### 6.1 P0 - 阻塞性问题

| # | 任务 | 说明 | 文件 |
|---|------|------|------|
| 1 | 实现 Rule 生成逻辑 | Nocturnal Artificer 需要生成 Rule 候选 | `nocturnal-artificer.ts` |
| 2 | 实现 Implementation 生成逻辑 | Artificer 需要生成代码实现候选 | `nocturnal-artificer.ts` |
| 3 | 连接 Artificer 输出到 Ledger | 将生成的 Rule/Implementation 写入 `_tree` | `evolution-worker.ts` |
| 4 | 创建 implementations 目录结构 | `.state/implementations/<id>/` | 运行时自动创建 |

### 6.2 P1 - 功能完善

| # | 任务 | 说明 | 文件 |
|---|------|------|------|
| 5 | 解决子智能体 API 不可用问题 | daemon 模式下的替代方案 | `nocturnal-workflow-manager.ts` |
| 6 | 优化 Trinity 链性能 | 减少超时风险 | `nocturnal-trinity.ts` |
| 7 | 完善 trajectory 数据提取 | 确保 snapshot 数据完整 | `nocturnal-trajectory-extractor.ts` |
| 8 | 添加样本数据集 | pain-negative, success-positive, principle-anchor | `.state/nocturnal-dataset/` |

### 6.3 P2 - 监控与可观测性

| # | 任务 | 说明 |
|---|------|------|
| 9 | 添加 Nocturnal 执行成功率指标 | 当前只有失败记录 |
| 10 | 完善 workflow_store.json | 当前不存在或为空 |
| 11 | 添加 Rule Host 执行日志 | 记录每次 evaluate() 调用 |

---

## 七、验证命令参考

### 7.1 数据层验证

```bash
# 检查原则树状态
cat ~/.openclaw/workspace-main/.state/principle_training_state.json | \
  jq '{principles: (._tree.principles | keys | length), rules: (._tree.rules | keys | length), impls: (._tree.implementations | keys | length)}'

# 预期输出: {"principles": 74, "rules": N, "impls": M}
# 当前输出: {"principles": 74, "rules": 0, "impls": 0}

# 检查实现目录
ls ~/.openclaw/workspace-main/.state/implementations/

# 检查进化队列
cat ~/.openclaw/workspace-main/.state/evolution_queue.json | \
  jq '[group_by(.status)[] | {status: .[0].status, count: length}]'
```

### 7.2 运行时验证

```bash
# 查看实时日志
tail -f /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log | \
  grep -E "EvolutionWorker|Nocturnal|Trinity"

# 查看 SYSTEM.log
tail -f ~/.openclaw/workspace-main/memory/logs/SYSTEM.log | \
  grep -E "PRINCIPLE_TREE|Nocturnal|RULE_HOST"

# 触发手动诊断（如果有 pending 任务）
# 在 OpenClaw 对话中执行: /evolve-task
```

### 7.3 命令行验证

```bash
# 在 OpenClaw 中执行:

/pd-evolution-status    # 查看进化状态
/pd-promote-impl list   # 列出候选实现（应为空）
/pd-nocturnal-review list  # 列出 nocturnal 样本
```

---

## 八、代码关键位置索引

### 8.1 核心文件

| 文件 | 功能 | 行数参考 |
|------|------|----------|
| `principle-tree-ledger.ts` | 三层账本 CRUD | L1-450 |
| `evolution-reducer.ts` | Pain → Principle 转换 | L380-430 |
| `evolution-worker.ts` | 后台任务调度 | L1785-2008 |
| `nocturnal-workflow-manager.ts` | Nocturnal 工作流管理 | L1-727 |
| `nocturnal-service.ts` | Nocturnal 核心逻辑 | L1-1456 |
| `nocturnal-trinity.ts` | Trinity 链实现 | L1-1628 |
| `rule-host.ts` | 在线态规则执行 | L1-200 |

### 8.2 关键函数

| 函数 | 位置 | 状态 |
|------|------|------|
| `createPrinciple()` | `principle-tree-ledger.ts:L395-415` | ✅ 已添加 |
| `createRule()` | `principle-tree-ledger.ts:L417-435` | ✅ 存在但未调用 |
| `createImplementation()` | `principle-tree-ledger.ts:L437-460` | ✅ 存在但未调用 |
| `updateTrainingStore()` | `principle-tree-ledger.ts:L280-320` | ✅ 正常工作 |
| `runMigrationIfNeeded()` | `principle-tree-migration.ts:L130-145` | ✅ 已添加 |

---

## 九、总结与建议

### 9.1 当前状态评估

原则内化系统目前处于 **"半成品"状态**：

1. **代码完整度**: 90%（核心逻辑已实现）
2. **数据完整度**: 30%（只有 Principle 层，缺少 Rule/Implementation）
3. **可用性**: 40%（后台服务运行正常，但核心功能无法闭环）

### 9.2 优先级建议

**第一阶段（1-2 周）**:
- 实现 Artificer → Rule/Implementation 生成
- 连接输出到 Ledger

**第二阶段（2-3 周）**:
- 解决子智能体 API 可用性问题
- 优化 Trinity 链性能

**第三阶段（持续）**:
- 完善监控和可观测性
- 添加更多测试覆盖

### 9.3 联系信息

如有疑问，请在 GitHub 上 reopen 相关 Issue 或创建新 Issue。

---

**报告生成时间**: 2026-04-10T02:30:00Z  
**插件版本**: 1.10.14  
**Gateway 版本**: OpenClaw latest
