# ADR-0005: Nocturnal 与 Internalization Engine 合并

> **状态**: Accepted
> **日期**: 2026-05-15
> **关联 ADR**: ADR-0003（Peer Agent 状态机编排）, ADR-0001（Runtime V2 服务边界）
> **取代**: 部分取代 `docs/design/2026-04-07-principle-internalization-system.md` 中关于"nocturnal 复用"的设计

> **2026-05-23 修订提示**: [ADR-0012](./0012-runtime-v2-standalone-scheduling-and-legacy-retirement.md) 取代本文中“保留 `IdleTrigger` / OpenClaw 夜间空闲调度”的决策。Runtime V2 仍是唯一规范实现，但新的收敛目标是删除 Nocturnal 执行逻辑和 OpenClaw-coupled idle/night orchestration，只保留经证明确有需要的历史只读导入/导出薄适配。本文下方涉及 `IdleTrigger` 保留的段落仅记录原始迁移思路，不再作为实施指令。

## 1. 背景

PD 项目中前后出现了两套**几乎相同**的反思流水线设计与实现：

### 1.1 第一代：Plugin 中的 Nocturnal Trinity（现存代码）

位置：`packages/openclaw-plugin/src/core/nocturnal-trinity.ts` + `service/nocturnal-service.ts`

链路：
```
NocturnalTargetSelector → TrajectoryExtractor → Dreamer → Philosopher → Scribe
  → Arbiter → Executability → Artificer → Persist
```

特征：
- 设计目标：夜间反思，生成训练样本（ORPO）
- 触发方式：`sleep-cycle.ts` 决定空闲时唤起
- 工件：`NocturnalArtifact` + `TrinityDraftArtifact`
- 运行时抽象：`TrinityRuntimeAdapter`（plugin 内部接口）

### 1.2 第二代：Core 中的 Internalization Engine（现存代码）

位置：`packages/principles-core/src/runtime-v2/internalization/`

链路：
```
InternalizationOrchestrator → Dreamer → Philosopher → Scribe → Artificer
  → Evaluator → RolloutReviewer → Trainer
```

特征：
- 设计目标：原则到实现的多阶段内化
- 触发方式：宿主层调用 `wakeOnce()`
- 工件：`PIArtifact`
- 运行时抽象：`PDRuntimeAdapter`（core 标准接口）
- 状态机基于 ADR-0003 的 SQLite 任务队列

### 1.3 重叠分析（代码审计结果）

两套实现在以下维度高度重叠：

| 维度 | Nocturnal Trinity | Internalization Engine | 重叠度 |
|------|------------------|----------------------|-------|
| Dreamer 角色与 Prompt | 候选生成 | 候选生成 | 95% |
| Philosopher 角色 | 原则评判 | 原则精炼 | 90% |
| Scribe 角色 | 工件起草 | 原则文档化 | 85% |
| Artificer 角色 | 规则代码生成 | 实现计划生成 | 80% |
| 输入数据 | session snapshot + pain | session snapshot + pain | 95% |
| 状态管理 | 文件 + cooldown | SQLite TaskStore | 0%（机制不同） |
| Runtime 调用 | TrinityRuntimeAdapter | PDRuntimeAdapter | 0%（接口不同） |
| 验证机制 | Arbiter + Executability | Evaluator + Validator | 90% |

**结论**：两套实现是**功能重复**的产物，而非互补设计。维持两套带来的代价：

1. **代码重复**：Dreamer/Philosopher/Scribe/Artificer 各有两份实现，修一个 bug 要改两处
2. **状态分裂**：文件状态（nocturnal）与 SQLite 状态（runtime-v2）不可对账
3. **运行时绑定**：Trinity 绑定 OpenClaw（`OpenClawTrinityRuntimeAdapter`），无法跨宿主复用
4. **触发逻辑分散**：sleep-cycle 与 wakeOnce 同时存在，调度策略冲突
5. **工件不互通**：NocturnalArtifact 与 PIArtifact 无映射，下游消费方需要双适配

---

## 2. 决策

**全面合并：以 Internalization Engine（Core）为唯一规范实现，将 Nocturnal 的功能拆解为两部分：**

1. **保留**：Nocturnal 的"空闲检测 + 任务唤起"作为 `IdleTrigger`，留在 plugin 中
2. **移除**：Nocturnal 的 Runner / Artifact / 验证 / 持久化逻辑（已被 Internalization Engine 完整覆盖）

### 2.1 合并后的架构

```
┌─────────────────────────── openclaw-plugin（Host） ──────────────────────────┐
│                                                                              │
│  IdleTrigger（合并后保留）                                                   │
│   ├─ 监听工作区空闲（heartbeat / cron / 文件变化）                          │
│   ├─ 决定何时调用 InternalizationOrchestrator.wakeOnce()                   │
│   └─ NEVER 拥有业务逻辑                                                      │
│                                                                              │
└──────────────────────────────────┬───────────────────────────────────────────┘
                                   │ 仅一个调用点
                                   ▼
┌─────────────────────────── @principles/core ──────────────────────────────────┐
│                                                                                │
│  InternalizationOrchestrator                                                   │
│   ├─ wakeOnce()                                                                │
│   ├─ proposeNextTask()                                                         │
│   └─ commitNextTaskProposal()                                                  │
│                                                                                │
│         ↓ 入队/调度                                                            │
│                                                                                │
│  TaskStore + RunStore + PIArtifactStore（统一状态）                           │
│                                                                                │
│         ↓                                                                      │
│                                                                                │
│  7 个 Peer Runner（统一实现）                                                 │
│  Dreamer → Philosopher → Scribe → Artificer → Evaluator → RR → Trainer       │
│                                                                                │
└────────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 新建组件：`IdleTrigger`

位置：`packages/openclaw-plugin/src/service/idle-trigger.ts`（新建）

职责：
- 监听 OpenClaw 的空闲信号（heartbeat 间隔、最近活跃时间）
- 在合适时机调用 `InternalizationOrchestrator.wakeOnce()`
- 暴露简单状态查询（最后唤起时间、跳过原因）

**禁止**：
- 直接执行 LLM 调用
- 直接读写 PIArtifact / Ledger
- 实现任何 Runner 逻辑

接口（伪代码）：
```typescript
class IdleTrigger {
  start(orchestrator: InternalizationOrchestrator): void;
  stop(): void;
  status(): IdleTriggerStatus;
}

interface IdleTriggerStatus {
  lastWakeAt: string | null;
  lastResult: 'leased' | 'no_ready_tasks' | 'error';
  nextScheduledAt: string | null;
}
```

### 2.3 数据迁移

**NocturnalArtifact → PIArtifact 映射规则**：

| NocturnalArtifact 字段 | PIArtifact 字段 | 备注 |
|----------------------|----------------|------|
| `artifactId` | `artifactId` | 同名 |
| `principleId` | `sourcePrincipleId` | 重命名 |
| `betterDecision` / `badDecision` | `contentJson.candidates[]` | 整合到 DreamerOutput 结构 |
| `boundedAction` | `contentJson.expectedDecision` | 整合到 ArtificerOutput |
| `arbiterResult` | `validationStatus` | `passed → validated`, `failed → rejected` |

迁移脚本将提供，但**新写入只走 PIArtifact**。旧的 NocturnalArtifact 文件（`.state/nocturnal/samples/*.json`）保留只读。

### 2.4 文件级重构清单

| 文件 | 处理 |
|-----|------|
| `plugin/core/nocturnal-trinity.ts` | 内容删除，保留 file 直到所有引用迁移完毕 |
| `plugin/core/nocturnal-arbiter.ts` | 删除（Validator 在 core） |
| `plugin/core/nocturnal-executability.ts` | 评估部分迁入 core；rule 实例化部分保留为 plugin adapter |
| `plugin/core/nocturnal-artificer.ts` | 删除（已有 ArtificerRunner in core） |
| `plugin/core/nocturnal-dataset.ts` | 保留（仅工具类，与训练样本相关） |
| `plugin/core/nocturnal-export.ts` | 保留（外部训练 export，与 model_training 通道集成） |
| `plugin/service/nocturnal-service.ts` | 拆解：Idle 部分保留为 `idle-trigger.ts`，业务部分删除 |
| `plugin/service/sleep-cycle.ts` | 简化：仅保留唤起判断逻辑 |

### 2.5 命名统一

合并后弃用以下名词，统一到标准词典：

| 旧名 | 新名 |
|-----|------|
| `Nocturnal Trinity` | `Internalization Pipeline` |
| `NocturnalArtifact` | `PIArtifact` |
| `TrinityRuntimeAdapter` | `PDRuntimeAdapter` |
| `OpenClawTrinityRuntimeAdapter` | `OpenClawCliRuntimeAdapter`（已存在） |
| `Sleep Cycle` | `IdleTrigger` |
| `Reflection Pipeline` | `Internalization Pipeline` |

---

## 3. 后果（Consequences）

### 3.1 收益

- **代码减少**：~3500 行 plugin 代码可下线，统一维护点
- **状态收敛**：所有反思相关数据归一到 SQLite，可观测性提升
- **跨宿主**：Internalization 不再绑定 OpenClaw，可在 Codex CLI / Gemini CLI / pd-cli 直接驱动
- **测试性**：core 部分可在无 OpenClaw 环境中完整测试
- **触发可配置**：宿主层任意决定何时唤起，不再被 sleep-cycle 写死

### 3.2 代价

- **迁移成本**：~3500 行 plugin 代码删除 + 引用更新（约 15-25 个 PR）
- **临时双轨**：迁移期间 nocturnal 与 internalization 同时存在，需 feature flag 隔离
- **历史 NocturnalArtifact 数据**：必须保留只读访问，不能强制迁移到 PIArtifact

### 3.3 不变项（保留）

以下代码**不在合并范围**：

- `nocturnal-export.ts`（外部训练数据 export 工具，与 L3 model_training 通道集成）
- `nocturnal-paths.ts`（路径工具）
- `nocturnal-dataset.ts`（训练样本聚合工具）
- `nocturnal-reasoning-deriver.ts`（推理链推导，可能并入 Philosopher prompt）

这些文件可能改名（去掉 `nocturnal-` 前缀），但功能保留。

---

## 4. 实施计划

### 阶段 0：决策与公示（本 ADR 通过后立即）
- [ ] ADR 评审通过
- [ ] 在 `GLOSSARY.md` 标注 NocturnalArtifact / TrinityRuntimeAdapter 为 deprecated
- [ ] 在 `CONTRIBUTING.md` 增加"新代码不得引入 nocturnal-* 模块"规则

### 阶段 1：建立 IdleTrigger（约 1 个 Sprint）
- [ ] 抽取空闲检测逻辑到 `plugin/service/idle-trigger.ts`
- [ ] IdleTrigger 调用 `InternalizationOrchestrator.wakeOnce()`
- [ ] 通过 feature flag 切换：`PD_USE_INTERNALIZATION_ENGINE=true` 启用新路径

### 阶段 2：迁移现有 nocturnal 调用点（约 2 个 Sprint）
- [ ] `evolution-worker.ts` 中所有 `runTrinity` 调用改为入队 PI 任务
- [ ] `merge-gate-audit.ts` 中的 `OpenClawTrinityRuntimeAdapter` 引用替换
- [ ] CLI 命令 `pd nocturnal-*` 改为 `pd runtime internalization-*`（保留旧命令做兼容 alias）

### 阶段 3：迁移历史数据（约 1 个 Sprint）
- [ ] 提供 `pd legacy-import nocturnal-artifacts` 命令
- [ ] 数据迁移到 PIArtifact 表（仅作为只读历史数据）

### 阶段 4：删除冗余代码（约 1 个 Sprint）
- [ ] 删除 `nocturnal-trinity.ts` / `nocturnal-arbiter.ts` / `nocturnal-artificer.ts` / `nocturnal-service.ts`
- [ ] 删除 feature flag
- [ ] 更新所有受影响的架构文档
- [ ] 添加 architecture-regression test：禁止新代码引用 `nocturnal-*` 模块名

---

## 5. 风险与缓解

| 风险 | 缓解 |
|------|------|
| 历史 NocturnalArtifact 数据丢失 | 保留只读访问 + 提供导出工具 |
| 迁移期间 plugin 行为不稳定 | feature flag + dual-track + 充分测试 |
| Runner 实现存在隐性差异（如 Trinity 的 tournament 选择） | 在迁移前完整 diff 两套实现，把缺失能力补到 core |
| 性能回退（SQLite 写入比文件慢） | 基准测试 + 适当批量写入 |
| 触发频率不当导致空跑或漏跑 | IdleTrigger 暴露指标，可观测调优 |

---

## 6. 决策依据

合并比维持两套架构更优，依据：

1. **代码事实**：两套实现的输入/输出/职责高度重叠（90%+）
2. **维护成本**：每个 Runner 修复一个 bug 要在两处更新
3. **架构演进**：ADR-0003 已经指明了"Peer Agent + SQLite 状态机"是正确方向
4. **可移植性**：Core 实现不绑定 OpenClaw，符合 ADR-0001 服务边界目标
5. **可观测性**：统一状态机的可观测性远高于"文件+SQLite"双源

不合并的代价（保持现状）会随着代码增长而**放大而非收敛**。

---

## 7. 替代方案（已拒绝）

### 替代方案 A：保留两套，定义清晰边界
**拒绝理由**：边界无法清晰划分，因为两套实现的目标完全相同（基于 session snapshot 进行多阶段反思）。强行划分边界会导致更多概念冲突。

### 替代方案 B：以 Nocturnal 为基础合并 Internalization 进 plugin
**拒绝理由**：违反 ADR-0001 的服务边界（业务逻辑应该在 core，不在 plugin）；违反 ADR-0003 的 SQLite 状态机决策。

### 替代方案 C：双源对账
**拒绝理由**：增加额外复杂度，且无业务价值。

---

## 8. 参考

- ADR-0001: Runtime V2 Service Boundaries
- ADR-0003: Peer Agent State Machine Orchestration
- `docs/design/2026-04-07-principle-internalization-system.md`（被本 ADR 部分取代）
- `docs/architecture/INTERNALIZATION_PIPELINE.md`（合并后的目标设计）
- `docs/architecture/GLOSSARY.md` §5（弃用映射）
