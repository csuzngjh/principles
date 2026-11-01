# SPEC-PD-AGENT-CAPABILITY-API-001（v0.5）
## PD Application Capability：共享读取模型、受限能力门面与可选 MCP Adapter

| 字段 | 内容 |
|---|---|
| SPEC ID | SPEC-PD-AGENT-CAPABILITY-API-001 |
| 版本 | **v0.5-proposed** |
| 状态 | PROPOSED — 待 Owner 以 **OG-1** 采信后冻结 |
| 类型 | 架构与接口契约；**Gate 3 实施的直接规范**；不构成 MCP Server 实施授权 |
| 调查基线 | csuzngjh/principles origin/main `0d0ea7eb560af15729f2a7f81b4e8a11a1bb0e8e`（2026-11-01） |
| 版本沿革 | v0.2-draft（2026-10-28，`docs/specs/SPEC-PD-AGENT-CAPABILITY-API-001-v0.2.md`）→ v0.4-draft（基线 `3a2de95c8`，`docs/specs/SPEC-PD-AGENT-CAPABILITY-API-001.md`）→ **本版**。v0.3 原件从未入主干（v0.4 已声明）。 |
| 本版上游证据 | ① PD-MCP-ARCHITECTURE-DELTA-AUDIT-20261031；② PD-MCP-GATE2-001（72 运行，`GO_TO_GATE_3_PROPOSAL`）；③ PD-MCP-HOOK-INTEGRATION-VERIFICATION-001（`READY_FOR_GATE_3_PROPOSAL`）；④ PD-MCP-GATE3-PROPOSAL-001（原版 + OPTIMIZED 评审版）；⑤ PD-MCP-GATE3-LATEST-SOURCE-DELTA-AUDIT（基线复核，2026-11-01） |
| Owner 决策输入 | 2026-11-01 Owner 九项已决事项（见 §14 决策记录） |
| 本版目标 | 冻结 Gate 3 实施所需的全部契约：Read Model 迁移、Capability Facade（含 OD-A 披露策略）、CLI 兼容硬约束、MCP 边界（仅契约）、Hook 协作、测试与验收、停止条件 |
| 明确非目标 | 不实现 MCP Server、不引入 MCP SDK、不修改 Hook/宿主配置/生产治理逻辑、不创建 pd-application、不做数据库迁移、不覆盖 Agent-facing CLI 的输出披露（Owner 已决：OD-A 首期仅辖 MCP） |

> **使用约定**：本文"要求"条款 = Gate 3 实施与验收的强制契约；"事实"条款 = 基线 `0d0ea7eb5` 的源码现实（引用见 DELTA-AUDIT §F 证据索引）；仍待 Owner 裁决的数值以 ⏳ 标注。本文与 `PD-MCP-GATE3-IMPLEMENTATION-READINESS-001.md`（机械实施清单）配套使用：本文件定**契约**，该文件定**步骤**。

---

## 1. 摘要与核心决策

PD 建立一层**宿主无关的共享业务能力**：一个权威 Read Model 承载 Pain Recall 的全部业务读取语义，一个受限 Capability Facade 承载对外披露契约；CLI 与（未来的）MCP Adapter 作为并列交付入口分别消费两者。Gate 3 只做抽取与迁移，MCP Server 属 Gate 4。

核心决策（含 2026-11-01 Owner 已决标注 ✅）：

1. ✅ **Read Model 与 Capability Facade 分离。** 权威读取/编排/快照/排序归 Read Model；OD-A 投影、披露断言、协议无关结果契约归 Capability Facade。不把全部逻辑统称 Read Model 并整体登记 IO seam。
2. ✅ **落点 = 现有 Core（`@principles/core`），不新建 `pd-application`。** 复用既有 core 原语与受控 IO seam；专用子路径导出，不扩大冻结 barrel。
3. ✅ **OD-A 首期是且仅是 MCP Tool 响应披露策略。** 不宣称全局 Agent 数据保密边界；Agent 仍可经既有 CLI（Skill 指导）读取完整 `pd.pain-recall.v1` 输出——这是 Owner 明确接受的产品现状，非本层安全缺陷。文档与代码注释不得声称 OD-A 阻止 CLI 路径。
4. ✅ **CLI 完整兼容 = 硬约束。** 命令、参数、默认值、JSON 结构、退出码、错误语义、Skill 用法全部不变；CLI 不返回 `pd.capability.v1` 信封。
5. **MCP Adapter（Gate 4）只依赖受限 Capability 子路径**，不得直接依赖 Read Model 子路径或 `PainRecallResult` 完整类型；由架构守卫检查。Gate 3 先建立 core 内部守卫与导出面断言。
6. **Hook 不承担 Capability 授权或字段安全**；PostToolUse 继续提供治理观测；Hook 缺失不影响业务安全，只降低观测完整性。首期零 Hook 改动。
7. **MCP Server（Gate 4）与启动用户同权限，不是沙箱。** 应用层只读 ≠ 进程只读；stdio ≠ 网络隔离。进入 Gate 4 前 Owner 须显式接受该信任模型（D-06）。
8. **测试钩子不是公共 API。** `painRecallSnapshotTestHooks` 机制收进 core 内部，不经公共子路径导出。
9. **只读必须是可证明属性。** "对业务工作区与业务数据源严格只读、执行受控系统临时目录 I/O"的完整矩阵证明随服务迁移，不得退化。
10. **一项 Gate 未过不进下一项**；Gate 3 实施需 OG-2 单独授权，本 SPEC（OG-1 采信）是其前置。

## 2. 背景与已完成的证明链

v0.4 提出的 Gate 序列已推进：

- **Gate 0/1**（Reality Audit + 契约草案）：v0.4 成文；增量审计（2026-10-31）确认 v0.4 十项决策经最新主干零推翻。
- **Gate 2**（MCP 净增量）：72 运行预注册对照实验完成——Arm B（MCP）任务成功率 100% vs Arm A（Skill+CLI）77.8%（+22.2pp）、中位工具调用 1 vs 14（−92.9%）、输入 token 约 7× 差距、敏感泄露 0、**工作区业务数据副作用 0/36**（口径：运行工作区全树指纹；72 次正式运行未装 PD hooks，治理遥测由 Phase 3 独立矩阵证明增量 0）。两支效用门同时通过，裁定 `GO_TO_GATE_3_PROPOSAL`。这些数字证明**该预注册场景集内**的增量，不外推到所有任务/宿主/能力。
- **Hook 机制验证**：codex 0.166.0 上 deny JSON 是唯一可靠阻断（exit1/exit2/坏JSON/超时全 fail-open）；`writes` 审批模式 + 诚实 `readOnlyHint:true` 可无旁路免审批执行；lying_tool 证明宿主不验证 annotation 真实性；MCP server 子进程不受宿主 agent sandbox 约束；生产 matcher `Bash|apply_patch` 对 MCP 工具名零命中（覆盖缺口，非破坏）。
- **Gate 3 Proposal**：原版 + OPTIMIZED 评审版完成；Owner 2026-11-01 裁决九项（§14）。
- **最新源码复核**（2026-11-01，基线 `0d0ea7eb5`）：方案 C 依赖的全部架构面零变化；OD-A 冻结工件 6 项哈希验证全 MATCH（DELTA-AUDIT §C.10）。

## 3. 当前基线事实（@ `0d0ea7eb5`）

以下事实全部经本轮直证（行号见 DELTA-AUDIT §F），是本契约的实施基础：

| # | 事实 |
|---|---|
| F1 | `recallPains()` 位于 `packages/pd-cli/src/services/pain-recall.ts`（895 行，21 导出，blob 零变化）；imports 仅 node 四内建 + core 三子路径（principle-tree-ledger / trajectory-store / runtime-v2）；零 pd-cli 本地依赖、零直接 sqlite 导入 |
| F2 | 全仓恰好 3 个代码文件 import 该服务：CLI 外壳 `commands/pain-recall.ts:22` + 两份测试；`painRecallSnapshotTestHooks` 唯一消费者是 readonly 测试，零生产消费者 |
| F3 | `pd pain recall` CLI 契约完整在档：6 选项（严格 limit 解析 `/^\d+$/`）、退出码表（仅 ok/no_matches/partial→0）、fail() 结构化信封 + return 守卫、四宿主 Skill 合同测试钉住 |
| F4 | core read-model seam（`io-seam-registry.json:40-50`）6 成员、5 个直接 import fs——read model 受控文件 I/O 是既有常态；eslint 只限制 fs/path（crypto/os 不受限）；架构守卫从 registry 派生，注册即绿 |
| F5 | core exports 24 键；专用子路径先例 21 个；barrel 守卫只扫描 barrel 文件本身——新子路径零 fixture 触碰 |
| F6 | 12 包 DAG 无环；core 零工作区依赖、零反向导入；全部 core 依赖方范围 `^1.297.x` 已容纳新 minor |
| F7 | `PainChainReadModel` 构造不传 `readonly`（bootstrap 默认开）vs `recallPains` 显式 `readonly:true, bootstrapIfMissing:false`——两者契约相反，禁止合并构造 |
| F8 | `ambiguous_principle` 状态与 `identityStatus:'ambiguous'` 声明未生产（实际仅 resolved/not_found） |
| F9 | OD-A 白名单可执行清单（27 叶路径）与 DENY 集完整恢复且哈希锚定；`statusDetail` 在可执行版中不发射（仅参与 error.code 派生）——保守分歧，本 SPEC 按可执行版冻结 |
| F10 | 发布机制：changesets → Version PR（依赖方自动 patch bump）→ publish 列车 → runtime pins 自动刷新；C4 守卫（plugin⇒installer 同批）；release-locks 手工再生政策（ERR-131） |

## 4. 目标与非目标

### 4.1 目标（Gate 3 范围）

1. 将 `recallPains()` 服务迁移入 core 为 **Pain Recall Read Model**，行为逐字节等价。
2. 新建 **Pain Recall Capability Facade**：OD-A `od-a-v1` 投影 + `pd.capability.v1` 协议无关信封 + 披露断言。
3. 建立两个**专用子路径导出**（Read Model / Capability），不触碰冻结 barrel。
4. CLI 外壳改为经子路径消费 Read Model，全部既有行为不变。
5. 测试按服务/外壳边界拆分迁移；新增 CLI 黄金等价测试、导出面断言、架构守卫。
6. 冻结 OD-A 白名单为 core 内版本化代码契约。

### 4.2 非目标

- 不实现 MCP Server / Tool 注册 / Transport / Annotation（Gate 4，OG-3）。
- 不引入 MCP SDK 或任何新外部依赖。
- 不修改 Hook、hooks.json、tool-semantics、宿主配置、RuleHost、Pain 准入。
- 不创建 `pd-application`（升格条件见 §13.2）。
- 不改变 CLI 对 Agent 的输出披露（OD-A 不辖 CLI——Owner 已决）。
- 不新增 feature flag、数据库 schema、迁移。
- 不重构 `PainChainReadModel` 或统一两者构造（F7）。

## 5. 目标架构与依赖规则

### 5.1 目标结构

```text
Agent / Human
   │            │
CLI Adapter   MCP Adapter（Gate 4，本版仅契约）
   │            │
   │            └──只允许──► Capability 子路径（受限）
   │                            │
   └──────完整业务结果──────────┤（Facade 相对引用 Read Model）
                               ▼
              Pain Recall Read Model 子路径
                               │
                               ▼
        core 既有原语（ledger / trajectory / RuntimeStateManager）
                               │
                               ▼
              权威数据（.state/principle_training_state.json、
                .state/trajectory.db、.pd/state.db）

Host Hook Adapter（独立；PreToolUse 治理 / PostToolUse 观测）
   ——与 Capability 层互不调用、互不为运行前提——
```

### 5.2 文件落点（core 现有规范，平铺无新目录）

```text
packages/principles-core/src/runtime-v2/
  pain-recall-read-model.ts        # 迁移自 pd-cli services/pain-recall.ts（895 行）
  pain-recall-snapshot-hooks.ts    # 新内部模块：测试钩子机制（不经公共子路径导出）
  pain-recall-capability.ts        # 新增：OD-A 投影 + 信封 + 断言（零文件 IO）
```

命名遵循 core 平铺惯例（先例 `diagnostician-capability.ts`）；**不建 `capabilities/` 子目录**（DELTA-AUDIT §D-1 修正）。

### 5.3 依赖规则（Gate 3 强制）

| # | 规则 | 验证方式 |
|---|---|---|
| R1 | Read Model 仅依赖 node 内建 + core 内部模块（三原语改相对引用）；不依赖 pd-cli/宿主/MCP | import 审查 + 既有 IO seam 守卫 |
| R2 | Capability Facade 零文件 IO（纯内存投影）→ **不登记 IO seam**；只相对引用 Read Model | eslint 自动通过（无受限导入）+ 守卫 |
| R3 | core 两个 barrel（`src/index.ts`/`src/runtime-v2/index.ts`）**不得 re-export 新模块** | barrel fixture 守卫自动（零触碰即零 re-export） |
| R4 | 外部消费者规则：**Capability 子路径** = 未来 MCP Adapter 唯一允许入口；**Read Model 子路径** = CLI 与 core 内部消费。Gate 3 建立导出面断言 + core 内相对引用白名单（**生产代码与测试代码分域扫描**：生产域仅 Facade 可引用 Read Model；授权测试文件可直接引用，见 §11 E）；Gate 4 增加 Adapter 包依赖白名单守卫 | 新增架构守卫（READINESS §8 G-1/G-2/G-3） |
| R5 | 测试钩子模块 `pain-recall-snapshot-hooks.ts` 不出现在任何 exports 键 | 导出面断言测试 |
| R6 | CLI（pd-cli）对 core 的新增依赖面 = 仅 Read Model 子路径；Capability 子路径在 pd-cli 中**零引用**（CLI 不消费 OD-A） | rg 守卫 + PR 审查 |
| R7 | 无新外部依赖、无 feature flag、无 schema 变更 | diff 审查 + 停止条件 |

## 6. Pain Recall Read Model 契约（层级 A）

### 6.1 行为等价要求

迁移是**位置移动而非重写**：

- `recallPains(workspaceDir, query)` 签名、`PainRecallQuery`/`PainRecallResult` 全部字段、`PAIN_RECALL_SCHEMA_VERSION='pd.pain-recall.v1'`、limit 常量（默认 3，范围 1-10）逐字节保持。
- 两条权威关联边（`reuseEvidence[].painId` 显式边；`derivedFromPainIds[]` 实存 candidateId → task → `tasks.input_ref` 血缘边）、确定性排序、截断语义、三源可用性、单条三态、unresolvedAssociations 全部不变。
- **只读契约保持**：显式 `readonly:true, bootstrapIfMissing:false` 的 RuntimeStateManager 构造（禁止向 PainChainReadModel 的默认构造"统一"——F7）；WAL 暂存快照全部写操作限于 `os.tmpdir()` 下的 staging 根；失败与成功路径的 finally 清理；缺库不建库；`planReadonlyOpen` 的 fail-closed 三态。
- 服务仍不重复校验 `limit`（上游校验注释保留）。

### 6.2 IO seam 登记

- `pain-recall-read-model.ts` 登记入 **read-model seam** `files[]`（覆盖其 `fs`/`path` 导入；`crypto`/`os` 不受限无需登记）。seam 描述补充一句：该成员的受控临时目录 I/O 仅为 WAL 只读快照 staging，业务工作区零写入。
- `pain-recall-snapshot-hooks.ts`：钩子接口仅引用 `fs.Stats` 类型（type-only），无运行时 IO 导入——不登记。
- `pain-recall-capability.ts`：零 IO——不登记（✅ Owner 决策 4 附带条件：仅真正执行受控 IO 的文件登记）。

### 6.3 测试钩子机制迁移

`painRecallSnapshotTestHooks` 的四个注入位（statSync/mkdtempSync/afterCopyFile/afterT1MainFingerprint）迁至 `pain-recall-snapshot-hooks.ts` 内部模块：Read Model 相对引用之；core 内测试（迁移后的 readonly 矩阵）相对引用之。**任何 exports 键不包含它**；导出面断言测试钉死（R5）。

## 7. Capability Facade 契约（层级 B）

### 7.1 功能定义

单一用例函数 + 契约类型 + profile 标识：

```text
recallPrinciplePainsCapability(input) → Promise<PainRecallCapabilityResult>
  input:  { workspaceDir: string（可信，由 Adapter 注入，绝不来自模型参数）,
            principleId: string（1..200）,
            limit?: number（1..10，缺省 3） }
```

职责序列：输入校验（rc-1/2：unknown 守卫 + 逐字段校验，拒绝一切未声明属性）→ 调用 `recallPains` → OD-A 投影构造信封 → 键路径断言自检 → 返回。**不构造 MCP `content`、不设置 `isError`、不含任何 SDK 类型**（✅ 分层合同：isError 是 MCP Adapter 的协议层责任）。

### 7.2 `pd.capability.v1` 信封契约

```text
PainRecallCapabilityResult
├─ schemaVersion: 'pd.capability.v1'
├─ capability: 'pd_recall_principle_pains'
├─ disclosureProfile: 'od-a-v1'
├─ status: 'ok' | 'no_matches' | 'partial' | 'not_found' | 'unavailable' | 'invalid_input'
├─ data: 投影后数据对象（结构见 §8.1 ALLOWED_PATHS；null 仅当 status=unavailable/invalid_input）
├─ provenance: { workspaceBinding: 'configured', sources: [{name, status}] }
├─ warnings: [{code, message}]
├─ error: null | {code, message}
└─ nextAction: null | {code, message}
```

相比 Gate 2 原型新增 `disclosureProfile` 字段（版本化披露策略标识）——这是对原型信封的唯一结构性增项，用于审计与契约测试锚定；**不改变既有字段语义**。

### 7.3 状态映射（OUTER_STATUS，唯一权威表）

| Read Model 状态 | Capability 状态 | error.code | 备注 |
|---|---|---|---|
| `ok` / `no_matches` / `partial` | 同名透传 | null | |
| `principle_not_found` | `not_found` | `principle_not_found` | |
| `pain_not_found` | `not_found` | `pain_not_found` | 经 `statusDetail` 派生（`errorFor` 语义） |
| `source_missing` | `unavailable` | `source_missing` | |
| `source_unreadable` | `unavailable` | `source_unreadable` | |
| 输入违反 Schema/约束 | `invalid_input` | `invalid_input` | Facade 层拒绝 |
| `ambiguous_principle` | — **reserved** | — | 声明未生产（F8）；保留映射 `invalid_input`/`ambiguous_principle` 于表中但标注 reserved；首期测试以单测覆盖映射函数而非端到端 |
| `denied` / `unconfirmed` | — **首期不启用** | — | 预留：denied=未来字段级运行时拒绝；unconfirmed=未来需权威回执的语义。本能力 DENY 是结构性缺省，不产生运行时 denied |

适配器层执行错误（超时/崩溃）由 **Adapter** 映射（`tool_execution_failed`，Gate 4 契约），不进入本表。

### 7.4 披露断言（内建防漂移）

- **构造即白名单**：信封按 ALLOWED_PATHS 逐字段构造（不是先填后剥）——DENY 字段结构性缺省。
- **每次调用自检**：`collectPaths()` 键路径断言（数组下标归一 `[]`）；任何越界叶路径 = 内部断言失败 → Facade 返回 `unavailable` + 内部错误码（不返回违规负载）。生产自检**不含**实验哨兵正则（那是测试技术）。
- **契约测试**：字段树快照 + DENY 哨兵扫描（§11 测试矩阵 B 组）。
- profile 变更治理：`od-a-v1` → 任何变更 = 新 profile 版本 + Owner 裁决 + 契约测试快照更新；实现者不得静默改白名单。

### 7.5 资源限制与责任归属 ⏳

以下三项数值为 **v0.5 冻结提案，随 OG-1 一并确认**（数值保留原提案，不调整；v0.4 §7.2 提出、Gate 2 原型 10s 已实测、OPTIMIZED D-03 要求 Owner 明确）。**三项分属两个责任层级、两个实施 Gate**——不得混同：

#### 7.5.1 责任归属总表

| 数值 | 责任层级 | 实施 Gate | 验收 Gate |
|---|---|---|---|
| 单次最多 **10 条** | **Core Capability Facade**（业务能力约束） | **Gate 3**（实现+测试） | Gate 3 |
| 结构化响应 ≤ **32 KiB** | **MCP Adapter**（传输约束） | Gate 4 | Gate 4 |
| 调用截止 **10 s** | **MCP Adapter**（执行边界） | Gate 4 | Gate 4 |

截断语义（既有，两层共用）：服务已显式返回 `truncated`，禁止静默截断。

#### 7.5.2 单次最多 10 条 —— Core Capability 约束（Gate 3 实施范围）

- 输入 `limit` 必须在 1–10 内，缺省沿用既有服务常量（`PAIN_RECALL_DEFAULT_LIMIT=3`）；非法输入 **fail-closed**（`invalid_input`）。
- 单次查询最多返回 10 条；条数由既有服务截断语义保证 ≤ limit ≤ 10。
- Read Model 不得因迁移改变既有查询/截断语义。
- **Gate 3 必须实际实现并测试此约束**（READINESS §5 实现约束 + §10 泄露/契约测试第 7 项）。

#### 7.5.3 结构化响应 ≤ 32 KiB（32768 bytes）—— MCP Adapter 传输约束（Gate 4）

- **不属于** Core Read Model 职责，**不属于** Capability Facade 的传输层职责；Gate 3 **不实现**此限制。
- **测量口径**：沿用单一 text content block 约定，测量其中 **JSON 文本的 UTF-8 编码字节数**——不是 JS 字符串长度，不是整个 JSON-RPC 网络报文长度。
- **超限处理**：不得静默截断结果；不得删除 OD-A 白名单字段后继续返回成功；不得 false-success。返回**有界、符合既有契约的失败信封**：外层状态 `unavailable`（既有状态集，**不新增顶层状态**）+ 明确稳定的错误码（建议 `response_budget_exceeded`，随 Gate 4 契约冻结确认）。
- **"10 条必然满足 32 KiB"不成立为已证不变量**：OD-A 投影不含数据域自由文本（均为枚举/计数/有界回显）只是分析性依据；**超限处理列为 Gate 4 必测场景**（以允许字段最大合理长度构造 10 条合成夹具实测序列化字节数并验证超限路径——READINESS §17.1）。

#### 7.5.4 调用截止 10 秒 —— MCP Adapter 执行边界（Gate 4）

- 10s 是**单次工具调用的响应截止时间**：从 MCP Server 工具处理器**开始处理请求**时计时，包括参数校验、Core 调用、OD-A 投影、响应序列化；**不包括** Server 进程启动时间与客户端排队时间。
- **超时要求**：超时不得返回成功；使用既有 `unavailable` 信封 + 明确超时错误语义（沿用 Gate 2 已验证的 `tool_execution_failed` 或其超时细分，随 Gate 4 冻结）。**诚实性**：`Promise.race` 类机制只停止等待，**不等于底层任务已取消**——底层只读调用若不支持真正取消，必须如实记录；超时后迟到的结果不得再次发送、不得被记录为成功。
- **Gate 3 不实现** MCP Server、超时控制器或取消机制（✅ 决策 6）；Gate 4 通过可控延迟合成测试验证（READINESS §17.2，Gate 2 `slow-server.mjs` 为模板）。

`structuredContent`：目标宿主验证前不启用，维持单 text content block（Gate 4 复核）。

## 8. OD-A 披露策略（`od-a-v1`，冻结）

### 8.1 冻结白名单（逐字段，源自哈希验证的冻结工件，不得从摘要重建）

**ALLOWED_PATHS（27 叶路径，= Gate 2 `project.mjs:23-37` 可执行清单）**：

```text
schemaVersion · capability · status
data.principle.requestedId · data.principle.identityStatus
data.query.limit · data.query.contextUsedForRanking · data.query.truncated
data.results[].association.type · data.results[].association.confidence
data.results[].availability.painEvent · data.results[].availability.diagnoses
data.results[].availability.correctionEvidence
data.summary.returned · data.summary.availableCandidates · data.summary.truncated
data.sources.ledger · data.sources.trajectoryDb · data.sources.stateDb
data.unresolvedAssociations[].reason
provenance.workspaceBinding · provenance.sources[].name · provenance.sources[].status
warnings[].code · warnings[].message
error{,.code,.message} · nextAction{,.code,.message}
```

（v0.5 增项 `disclosureProfile` 加入 ALLOWED 集合，随 §7.2 一并冻结。）

**DENY 集（= `project.mjs:12-16` 头注，任何泄露 = 契约违规）**：

```text
canonicalId · painId · evidenceRefs{candidateId,taskId,decisionId,decidedAt}
pain.{text,reason,rawStatement,occurredAt,source,host,score,severity}
diagnoses.*{diagnosisId,taskId,category,rootCause,supportingEvidence.note,…}
correctionEvidence.* · lineage hops · trustedContextReceipt · session/turn ids
principle.text · unresolvedAssociations[].{painId,candidateId} · statusDetail（作为 data 字段）
```

**冻结语义细则**：

1. `statusDetail` 不进 MCP data 输出（预注册文本列 ALLOW 但可执行版未发射——按更窄者冻结，F9）；仅参与 `pain_not_found` error.code 派生。
2. DENY 字段在响应、错误、warnings、日志中**一律不得出现**（值与键皆不出现）。
3. 扩权 = 新 Owner 裁决 + profile 版本升级；`ambiguous` 等未生产状态不构成扩权理由。
4. 原始工件位置与哈希锚定见 DELTA-AUDIT §C.10（预注册 JSON/MD + project.mjs + 原型三件套，6 项 MATCH）。

### 8.2 适用范围（Owner 已决 ✅）

- **OD-A = MCP Tool 响应披露策略**。MCP 不返回 DENY 字段；CLI 保持完整 `pd.pain-recall.v1` 输出。
- 文档与代码不得声称 OD-A 构成全局 Agent 数据边界或阻止 CLI/Bash 路径读取。
- 若未来 Owner 要求覆盖所有 Agent-facing 入口，另立 SPEC 变更（重设计 CLI 可信调用边界与兼容策略），不隐式并入本线。

### 8.3 投影位置与防绕过

- 投影唯一代码权威 = core 内 `pain-recall-capability.ts`；MCP 受限输出的唯一构造点。
- 防误接线（代码治理边界，非对抗恶意本地代码的 OS 边界）：①Capability 子路径独立存在；②架构守卫断言 core 内仅 Facade 相对引用 Read Model、pd-cli 仅引用 Read Model 子路径；③Gate 4 增加"Adapter 包禁止导入 Read Model 子路径"守卫；④投影契约测试逐项验证 DENY 缺省。
- 诚实边界声明：以上防的是**误接线和回归**；同用户恶意代码/被攻陷进程不受此约束（那是 D-06 进程信任模型与 OS 层职责）。

## 9. CLI Adapter 契约（层级 C，Owner 已决 ✅ 硬约束）

### 9.1 不变量（全部既有测试保护）

| 不变量 | 保护测试 |
|---|---|
| 命令 `pd pain recall`（树位置不变） | cli-A 组 + skill-contract :124-131 |
| 六选项 + 严格 limit 解析 | cli-A1-A5 + parse 组 |
| 默认 limit=3 | cli-B 组 |
| `pd.pain-recall.v1` JSON 完整直出（**不套信封**） | cli-B1-B6 端到端 |
| 退出码表（ok/no_matches/partial→0，其余→1） | 既有断言 |
| fail() 信封 + return 守卫 | cli-2 既有 |
| Skill 用法（四宿主） | skill-contract 实测 built CLI |

### 9.2 迁移要求

- `commands/pain-recall.ts:22` 的 import 改为 core Read Model 子路径；删除 `src/services/pain-recall.ts`（同一变更集，无副本残留）。
- `resolveWorkspaceDir` 等本地机制不动；handler 签名与行为不变。
- **新增黄金等价测试**：同一合成工作区，迁移前后 `pd pain recall --json` 输出逐字节等价（READINESS §9）。
- CLI 不因 Facade 存在而改变任何输出（R6：pd-cli 零引用 Capability 子路径）。

## 10. MCP 边界与宿主协作（本版仅契约）

### 10.1 MCP Adapter（Gate 4 预定契约，本版不实施）

- Tool：`pd_recall_principle_pains`，inputSchema = `principleId`(1..200 必填) + `limit`(1..10 默认 3)，拒绝一切未声明属性（无 workspace/host/session/SQL/排序/context/painId 参数）。
- 依赖白名单：仅 Capability 子路径（§5.3 R4）；Annotation `readOnlyHint:true` 必须诚实声明（以只读矩阵背书；宿主不验证真实性——虚报=治理面伪装）。
- 结果装配：单 text content block 携带 `pd.capability.v1` JSON；`isError:true` 仅用于披露断言失败与 Adapter 执行失败两类。
- 传输与执行边界：响应 ≤32 KiB（§7.5.3：UTF-8 字节口径 + 超限失败信封语义）与调用截止 10s（§7.5.4：计时范围 + 超时诚实性语义）——均为 Adapter 层实施与验收要求（READINESS §17）。
- 工作区绑定：启动配置（trusted launch config），Tool 参数不可覆盖；绑定失败 = 工具不可用，不回退 cwd/home。
- 进程安全：与启动用户同权限（非沙箱）——D-06 风险接受是 Gate 4 准入条件；环境变量白名单、SDK 精确锁版 + lockfile、生命周期监控等十条准入要求沿用 OPTIMIZED §10.2。

### 10.2 Hook 协作（首期零改动 ✅）

- 首期只读 MCP 工具**不新增** PreToolUse matcher；不依赖 RuleHost 做业务授权/披露；PostToolUse `.*` 观测保留。
- Hook 缺失影响表：Capability 输入校验/工作区绑定/OD-A 披露/Read Model 只读——均不受影响；仅治理观测可能缺失。
- Codex 0.166.0 deny-only/fail-open 是版本实测事实，不写成跨版本安全合同；目标宿主版本在 Gate 4 重验。
- 未来 MCP 写类工具的治理接入（matcher + tool-semantics 条目）= OG-4 单独授权，本版只留设计位。

## 11. 测试与验收矩阵

### A. Read Model（core，迁移随行）

- 既有 25 用例只读矩阵整体迁移（ro-×11 WAL 全模式 / race-×4 / inj-×3 / aba-×5 / interleave-×2）+ assoc/avail/sem/rank 四组 29 用例迁移；夹具构造器随迁。
- 新增：迁移等价性（同夹具新旧实现输出深度相等——在移动 PR 内以黄金夹具实现）。
- 停止条件：任一 ro/race/inj/aba/interleave 红 = P0 停。

### B. Capability Facade（core，新增）

- ALLOW 逐项存在 / DENY 逐项缺省（含键与值）；键路径断言负例（注入额外字段→自检拒绝）；
- DENY 哨兵扫描：夹具敏感文本植入唯一标记，断言信封全文（含 error/warnings）零命中；
- OUTER_STATUS 全行映射（含 reserved 行的单测级覆盖）+ error.code 稳定性；
- 输入校验负例（未知属性/超长/越界 limit/非整数）；
- 导出面断言：两个子路径导出名集合精确快照（含"无 snapshot-hooks"断言）；
- profile 版本化：快照测试钉 `od-a-v1`；
- **单次 ≤10 条 Core Capability 约束**（§7.5.2）：limit 上/下界/缺省/非法值（0、负、11、99、非整数）逐项断言 fail-closed；>10 条关联夹具断言条数 ≤ limit 且 `truncated` 语义不退化。

### C. CLI Adapter（pd-cli）

- 既有 cli-A/parse/cli-B + skill-contract 全绿（shell 测试原地不动，仅 B5 的服务直调断言改 import 来源）；
- **黄金等价**：迁移前后 `--json` 逐字节等价；
- 启动宿主无关测试（PRI-1061 既有）继续绿。

### D. Cross-Adapter Parity（Gate 3 以单侧断言预铺）

- 同一合成工作区：Capability 信封的 data 必须是 Read Model 结果的严格投影（每 ALLOW 字段值 == 完整结果对应字段值）——core 内可直接测试，无需 MCP 存在。

### E. 架构守卫（新增；生产代码与测试代码分域）

- **G-1 生产域**（`src/**` 排除 `__tests__`/`*.test.ts`）：仅 `pain-recall-capability.ts` 可引用 Read Model；其他生产模块禁止（含 re-export、动态 import 等间接方式）；零 Core→pd-cli 反向依赖。
- **G-1 测试域**：授权测试文件（`pain-recall-readonly.test.ts` / `pain-recall-service.test.ts` / `pain-recall-capability.test.ts`）**允许直接引用 Read Model 与内部 snapshot hooks**——合法测试引用不触发 G-1；测试钩子仍不得进入公共 exports（G-2 钉死）。
- 守卫验收含正负自测试（合法测试引用不报错 / 越权生产引用必报错），防止扫描范围错误导致的平凡通过（READINESS §8 C）。
- G-3 pd-cli 引用面：仅 Read Model 子路径（零 Capability 引用）；barrel 零触碰（既有守卫自动）+ REQUIRED_SOURCE_FILES 补两文件（房例）。

### F. MCP Adapter / Security / Host（Gate 4 范围，此处仅索引）

沿用 OPTIMIZED §14 D/E/G 组 + Hook 验证 15 实验模板（进程边界/lying-tool/审批语义/宿主版本重验）；**必测场景新增**：①32 KiB 超限（最大合理长度 10 条夹具实测 UTF-8 字节数 + 超限失败信封路径，§7.5.3）；②10s 超时（可控延迟合成测试 + 超时不成功 + 迟到结果不重发不误记，§7.5.4）；WorkBuddy 实机合成验证为 Gate 4 前置（Owner 待裁决延期与否）。

## 12. 风险登记（v0.5 增量更新）

| 风险 | 等级 | 缓解 | 变化 vs v0.4 |
|---|---|---|---|
| Core 发布与插件/安装器联动 | 中 | PRI-1065 changeset 三包联动模式；Version PR 自动 bump；pins 自动刷新 | 不变；机制已直证（F10） |
| CLI 修复耦合 core 发版节奏（迁移后 pain-recall 行为修复需 core 版本承载，不再能 pd-cli 单包热修） | 低-中 | 接受（core 发版节奏高频：1.297.x 数日内多版；Version PR 自动联动）；重大行为缺陷时 revert 路径仍在 | 新增（方案 C 的固有代价，如实披露） |
| OD-A 与字段演进漂移 | 中 | 构造即白名单 + 每调用自检 + 契约快照 + profile 版本化 | 强化（F9 分歧已定按窄冻结） |
| 测试钩子泄入公共 API | 中 | 内部模块 + 导出面断言（R5） | 新增守卫 |
| 只读契约退化（bootstrap 统一陷阱） | 高 | F7 显式化：迁移 PR 禁止合并构造；readonly 矩阵随行 | 新增显式风险条目 |
| CLI 可见回归 | 高 | §9.1 全表 + 黄金等价 + 停止条件 | 不变 |
| 双实现残留 | 中 | 同一变更集删除旧文件 + rg 完整性（3 importers 基线） | 不变 |
| OD-A 被误称全局边界 | 中 | §8.2 强制表述 + 文档审查 | 新增（Owner 决策 1/3 落实） |
| MCP Server 同权限风险 | 高（Gate 4） | D-06 显式接受前不进 Gate 4 | 不变 |
| `ambiguous_principle` 不可达却在合同 | 低 | reserved 标记 + 单测覆盖 | 已处置 |

## 13. 迁移路线与 Gate 边界

| 阶段 | 内容 | 授权 | 状态 |
|---|---|---|---|
| Gate 3 Proposal | 原版 + OPTIMIZED + Owner 九项裁决 | — | ✅ 完成 |
| **P1：本 SPEC v0.5** | 契约冻结（含 ⏳ 数值确认） | **OG-1** | 本文档 |
| Gate 3 Implementation（P2+P3） | Read Model 迁移 + Facade + 子路径 + CLI 接线 + 测试拆分（单变更集） | **OG-2** | READY_PENDING_OG2 |
| Gate 4（P4） | MCP Adapter 新包 + 单工具 + 进程安全 + 宿主验证 | **OG-3** | BLOCKED（D-06 待决 + WB 前置） |
| Optional Hook Adaptation（P5） | 写类工具治理映射 | **OG-4** | 设计位 |
| Gate 5（P6） | 逐宿主验收 | **OG-5** | BLOCKED |

### 13.1 Gate 3 实施停止条件（任一触发即停）

只读矩阵失败；CLI 输出/退出码非授权变化；core 出现反向依赖或环；OD-A DENY 字段进入受限响应；守卫无法阻止 Capability→Read Model 之外的误接线；迁移引入 schema/flag/未批依赖；发布联动无法证明可回滚。（与 OPTIMIZED §16.1 一致，本版收编。）

### 13.2 `pd-application` 升格条件（不变，成文触发）

跨 core/host-runtime 的多业务用例需共同应用层；core 发布/运行时边界不再适合承载编排；多独立交付 Adapter 需稳定应用层契约而 core 不应承担；授权/审计/多工作区路由成为独立子系统。出现任一 + Owner 单独批准才重新评估；MCP 工具数量增加本身不触发。

## 14. Owner 决策记录

**2026-11-01 Owner 已决（九项，不再开放讨论）**：

| # | 决策 | 对应本 SPEC |
|---|---|---|
| ✅1 | OD-A 首期仅约束 MCP Tool 响应披露 | §8.2 |
| ✅2 | CLI 保持现有完整输出/参数/JSON/退出码 | §9 硬约束 |
| ✅3 | 不要求本次覆盖所有 Agent-facing 接口 | §8.2/§10 |
| ✅4 | 采用 Core Read Model + Capability Facade | §5/§6/§7 |
| ✅5 | 首期不创建 pd-application | §13.2 |
| ✅6 | Gate 3 不实现 MCP Server、不引入 SDK | §4.2/§10.1 |
| ✅7 | Gate 3 不修改 Hook/宿主配置/生产治理逻辑 | §10.2 |
| ✅8 | Gate 3 只做共享能力抽取、披露契约、CLI 迁移 | §4.1 |
| ✅9 | Gate 4 另行授权 | §13 表 |

**仍待 Owner（详见 PD-MCP-GATE3-OWNER-DECISION-CARD.md）**：OG-1 本 SPEC 采信（含 §7.5 三项数值**及其责任归属**确认：10 条=Core Capability（Gate 3）；32 KiB 与 10s=Gate 4 MCP Adapter）；OG-2 实施授权；D-06 进程风险接受（Gate 4 前置）；WB 实机验证安排（Gate 4 前置）；（远期）OG-4/OG-5。

## 15. 本版状态与完成条件

- [x] 最新基线复核完成（DELTA-AUDIT，十项 CONFIRMED）
- [x] OD-A 白名单从冻结工件逐字段恢复并哈希验证
- [x] Read Model / Facade / CLI / MCP 边界四层契约成文
- [x] 状态映射、错误语义、输出断言冻结（数值三项 ⏳ 随 OG-1）
- [x] 测试矩阵与停止条件冻结
- [x] 实施机械清单配套（READINESS 文档）
- [ ] **OG-1：Owner 采信本 SPEC（冻结生效）**
- [ ] OG-2：实施授权（独立动作）

**本 SPEC 不授权任何代码变更。Gate 3 Implementation 以 OG-2 为唯一启动条件。**

---

## 16. 参考证据索引

1. 基线复核与十项调查：`docs/implementation-reports/PD-MCP-GATE3-LATEST-SOURCE-DELTA-AUDIT.md`（本批交付）
2. 实施机械清单：`docs/implementation-plans/PD-MCP-GATE3-IMPLEMENTATION-READINESS-001.md`（本批交付）
3. 决策卡：`docs/implementation-reports/PD-MCP-GATE3-OWNER-DECISION-CARD.md`（本批交付）
4. 上游提案：`docs/specs/PD-MCP-GATE3-PROPOSAL-001-OPTIMIZED.md`（974 行）+ `docs/proposals/PD-MCP-GATE3-PROPOSAL-001.md`（原版）
5. v0.4：`docs/specs/SPEC-PD-AGENT-CAPABILITY-API-001.md`；v0.2：`docs/specs/SPEC-PD-AGENT-CAPABILITY-API-001-v0.2.md`
6. Gate 2 工件：gate2 worktree `docs/implementation-reports/PD-MCP-GATE2-{PREREGISTRATION,EXPERIMENT-REPORT}-20261031.*`（sha256 锚定）+ `.tmp/pd-mcp-gate2/proto/project.mjs`
7. Hook 验证：hook-verify worktree `docs/implementation-reports/PD-MCP-HOOK-INTEGRATION-VERIFICATION-001.md` + `%TEMP%\pd-hook-verify-001`
8. 增量审计（前轮）：`docs/implementation-reports/PD-MCP-ARCHITECTURE-DELTA-AUDIT-20261031.md`
9. 关键源码锚点：见 DELTA-AUDIT §F（全部 `0d0ea7eb5` 现测行号）

## 17. 结论

**一套权威业务读取（Read Model）、一个受限披露出口（Capability Facade）、两个并列交付入口（CLI 现在、MCP Gate 4）、Hook 独立观测——OD-A 只辖 MCP 响应、CLI 契约零变化、全部只读证明随行迁移。** 本 SPEC 达到冻结条件，待 OG-1。
