# PD MCP Architecture Delta Audit（2026-10-31）

| 字段 | 内容 |
|---|---|
| 审计类型 | 架构增量审计（只读；本轮不实现 MCP、不修改生产代码） |
| 审计基准 | `csuzngjh/principles` origin/main `9f0888a168def3b57a5e85fbb6b88273e82fe3fe`（2026-10-31 fetch） |
| 增量区间 | PR #2217 实际合并（`636fa62116fc56e93c64f39114e8a11f89007da5`，2026-10-30T00:16:05Z）→ origin/main `9f0888a16` |
| 被审 SPEC | `docs/archive/specs/SPEC-PD-AGENT-CAPABILITY-API-001.md`（v0.4-draft，基线 `3a2de95c8` = PR #2214） |
| 交付物 | 本报告；为 SPEC v0.5 提供修订依据 |
| 方法 | 只读 Git 操作 + 独立审计 worktree（`D:\Code\_worktrees\principles\adhoc-20261031-mcp-delta-audit-7b2b62` @ `9f0888a16`，--skip-bootstrap）；关键 PR 逐一阅读真实 diff；符号级 rg 溯源；本机 Codex CLI 非侵入式核查 |

**基线保护记录（任务 §2.1）**

1. 审计起点：主 checkout `D:\Code\principles`，分支 `main`，HEAD `0246e1dc1`。
2. 工作区存在用户修改（6 个已删除跟踪文件 + 18 个未跟踪路径，含多个 SPEC/报告草稿）。**未做任何 reset/clean/checkout/stash**，全部保持原样。
3. fetch 后 origin/main = `9f0888a16`，本地 main 落后 19 个提交；旧基线 `288ed6eff`（PR #2237 合并提交）仅是历史点，未复用。
4. 代码审计在独立 worktree 进行（由 `npm run dev:worktree -- adhoc mcp-delta-audit --skip-bootstrap` 创建，自带 git-12 mutation mutex）；主 checkout 零写入、零 git 变异。
5. `npm run dev:lease` 在主 checkout 正确拒绝授约（control plane 只读守卫按设计工作，见 git-3/git-9）；本报告是 Owner 明确指定的唯一新增交付文件，以未跟踪文件形式落于 `docs/implementation-reports/`，不提交、不建 PR。

---

## A. Executive Summary

1. **MCP 方向仍然成立，v0.4 架构决策全部经最新主干复核无一被推翻。** §1 十项核心决策、§5 依赖规则、§8 安全不变量、Gate 结构均 UNCHANGED；本审计没有发现任何需要重写架构契约的理由。
2. **PR #2218 新增的是治理生命周期能力，不是业务应用能力。** HostLivenessContract 管理的是 RuleCode promotion 的恢复通道活性（pd_status / rulecode_deactivate / rulecode_global_pause / owner_review_access × 宿主工具别名 × 中性探针）；五路宿主解析 fail-closed；`tool_calls` 表新增 `host_kind` 宿主归属列。MCP 既不该依赖它，也**不需要**它——普通只读业务查询（如 Pain Recall）的输入输出不包含任何宿主生命周期事实。
3. **PR #2227 是影子阶段契约，三件事被代码证据严格区分开。** ①`authorizesGeneration` 恒为 `false`（类型字面量硬编码）；②`proposeShadowAssociations`/`validateDiagnosticianAssociations` 目前**只有测试消费者**，未导出、未接入生产调用链；③`trustedContextReceipt`（router-context-v1）只证明**路由系统输入的内容完整性**（taskId/runId + message/systemPrompt/前驱工件 SHA-256 摘要），其 `canonicalPrinciples` 字段恒为 `unavailable`（`router_has_no_system_canonical_principle_allowlist`）。它不含调用者身份、来源、授权或披露资格——**trustedContextReceipt ≠ MCP 数据访问授权**。MCP 查询 Principle↔Pain 关联应继续使用 recallPains() 的两条权威边，不使用 shadow 关联。
4. **PR #2235 证实发布产物 cohort**（codexAdapter 0.6.1 / hostRuntime 0.14.2 / core 1.297.7 / plugin 0.2.11，main 已演进至 core 1.297.9）；**PR #2244 把"structure is not provenance"落进诊断管线**（Stage A 证据引用必须绑定当次可信上下文，伪造引用在成为 PIArtifact 前失败）——为 MCP 字段披露提供了仓库内先例模式。
5. **最合适的接入位置：不创建新包、不预抽取。** `recallPains()` 已是宿主无关业务服务：只依赖 `@principles/core` 三个公共出口（ledger / trajectory-store / runtime-v2），输入输出类型化且版本化（`pd.pain-recall.v1`），严格只读证据完备（830 行 / 25 用例 readonly 测试），自 SPEC 基线以来零改动。Gate 2 原型可直接调用（SPEC §2.2 已允许）；共享抽取推迟到 Gate 3 用真实消费者证据决策（见 D.3 的三个具体选项）。
6. **首个 MCP 工具仍是 `pd_recall_principle_pains` + 元数据投影。** 本报告 E 节给出逐字段 ALLOW / DENY / OWNER_DECISION_REQUIRED 判定表，可直接作为 D-03 的冻结提案。
7. **Codex 宿主条件较 v0.4 实质改善。** 本机 codex-cli 0.166.0 实测支持 MCP Client（`codex mcp add/list/get` 可用，stdio 配置一条命令完成；本机已在运行 7 个 MCP server）。PD Server 可被连接、PD Tool 可被调用仍为 NOT_VERIFIED（本轮未建 Server，符合边界）。
8. **`pd_trace_pain` 的构造路径在最新主干仍非严格只读**：`PainChainReadModel.getStateManager()` 用默认参数构造 `RuntimeStateManager`（`bootstrapIfMissing` 默认 true），缺库工作区会创建 `.pd/` 与 state.db（WAL 模式）。"暂缓"判定维持，并作为独立后续项（与 MCP 无关的既有缺口）。
9. **Gate 裁定**：Gate 0 **PARTIAL（实质推进）**——本审计补齐了 Host 能力边界、发布 cohort、真实 Client 版本三项；Gate 1 **PARTIAL**（字段白名单仍待 Owner 冻结）；Gate 2 **NOT_RUN**（对照协议仍然适用，12 场景设计无需改动）；Gate 3/4/5 **BLOCKED**（依据不变）。没有任何 Gate 需要改结构。
10. **下一步唯一推荐行动**：Owner 使用 E 节字段表冻结 D-03 字段白名单，并批准 Gate 2 预注册材料（12 合成场景 + 阈值 + 合成投影 + Client 版本钉 + 原型隔离方式）。在此之前不启动任何 MCP 实现。

---

## B. PR Evolution（PR #2217 实际合并以来的全部相关变化）

### B.1 全量清单与关联度

PR #2217（v0.4 SPEC 入库）之后共 24 个合并 PR。注意 **PR 编号 ≠ 合并顺序**：#2218 实际合并于 #2217 之前（2026-10-29T16:08:59Z），按任务要求一并核实。

| PR | 标题（缩写） | Merge Commit | 合并时间(UTC) | 变更规模 | 关联度 | 对 MCP 的影响 |
|---|---|---|---|---|---|---|
| **#2218** | RuleCode Host Promotion（五路宿主解析/按宿主能力合同/影子归属/WB V2 provider） | `ac11a2a43` | 10-29 16:08 | 53 文件 +4441/-228 | **直接** | 间接：宿主身份/归属基建；无业务能力变化 |
| #2212 | installer console 认证姿态（PRI-1054） | `085959d70` | 10-30 02:13 | 3 文件 +531 | 无 | 无 |
| #2228 | ERR-173/174 记录 | `5b0d8cae7` | 10-30 02:31 | 记录 | 无 | 无 |
| #2230 | correction-detection 成本上限 | `173a045e4` | 10-30 05:03 | 12 文件 +384 | 低 | 无（信号采集性能） |
| **#2227** | Rule Association Shadow Contracts | `bee7c45c1` | 10-30 05:21 | 12 文件 +1611/-3 | **直接** | 间接：关联权威边界 + 回执契约 |
| #2226/#2232/#2224/#2239 | Examiner 系列（离线管线 v4/v0.7） | `f60ce5363` 等 | 10-30~31 | — | 无 | 无（离线评审管线） |
| **#2235** | Codex 运行时 pins 更新 | `745f463b4` | 10-30 10:30 | 2 文件 | **直接** | 证实发布 cohort |
| #2236 | 产品版本推进 2.5.0（PRI-874） | `e9c2b7db2` | 10-30 10:46 | manifest | 无 | 无 |
| #2237 | Abyss LOG #008（网站） | `288ed6eff` | 10-30 14:31 | 10 文件 | 无 | 无（纯网站内容） |
| #2238/#2241/#2242 | Console 工作台/UTF-16 守卫/双发修复 | `0246e1dc1` 等 | 10-31 | — | 低 | 无（Console UI） |
| **#2244** | PRI-1059 Stage A 证据引用绑定 | `ee5ed6ceb` | 10-31 08:22 | 18 文件 +549/-16 | **直接** | 间接：证据信任边界先例 |
| #2229/#2231/#2233/#2240/#2243/#2245 | Version Packages | — | 10-30~31 | 锁文件 | 无 | 无 |

### B.2 PR #2218 深查（RuleCode Host Promotion）

**四态区分（源码存在 / 生产接线 / 发布产物 / 真实宿主验证）**：本 PR 的宿主能力代码**已存在 + 已生产接线 + 已随 0.6.1/0.14.2/0.2.11 cohort 发布**（pins 说明 capability check 对包字节演练 Owner 控件）；"真实宿主验证"证据在各宿主 hook 生产测试（如 workbuddy-adapter `pd-hook-production.test.ts` +233 行）。

核心事实（均在工作副本 `9f0888a16` 复核）：

- **HostLivenessContract**：类型定义在 core（`packages/principles-core/src/runtime-v2/activation/openclaw-promotion-checks.ts:7-22`）；三个宿主实现在 host-runtime（`packages/host-runtime/src/host-liveness-contract.ts:8/51/81`，版本标记 `openclaw-legacy@1` / `codex-v2@1` / `workbuddy-v1@1`）。它管理的是 **4 个治理恢复能力**（`pd_status`、`rulecode_deactivate`、`rulecode_global_pause`、`owner_review_access`）× 每宿主真实工具别名 + 2 条中性探针 + 3 个带外控件（activation_deactivate / global_rulecode_pause / owner_review_console）。
- **五路宿主解析**（`resolvePromotionHostLiveness`，host-liveness-contract.ts:284-356）：无非 OpenClaw 声明/证据 → OpenClaw 历史默认；已知宿主有持久证据但声明文件缺失 → `host_declaration_missing_for_configured_host`（fail closed，不回退 OpenClaw）；多宿主 → `multi_host_promotion_ambiguous`；单一已知宿主 → 该宿主合同；未知宿主 → `promotion_host_unsupported`。
- **双源宿主事实读取器**（`readWorkspaceHostKindFacts`，:214-248）：声明（`.pd/host-tool-semantics/<hostKind>.json`）∪ 证据（`trajectory.db pain_events.host_kind`，只读打开 :156）→ `effectiveKinds`；与 prompt-injection 路由共享同一事实源（"one truth, no second registry"，:186-197）。
- **宿主归属**：`tool_calls` 表新增 `host_kind` 列（`workspace-behavior-evidence.ts` 内 `ALTER TABLE`），按宿主戳去重，防止 Codex 会话 ID 碰撞借用给 WorkBuddy（workbuddy-rule-context-provider.ts:100-105 注释）。
- **WorkBuddy V2 provider**（workbuddy-rule-context-provider.ts:44-69）：**Hook 事件绑定**——构造需要 sessionId / payload cwd 推导的 projectDir / hook 解码后 cutoffAt / 当前 toolCallId；不给 designGate 事实（Codex-only 来源），缺输入返回显式 unavailable 而非借用他宿主。
- **消费者**：`resolvePromotionHostLiveness`/`readWorkspaceHostKindFacts` 的生产消费者 = pd-cli `runtime-activation.ts`（promotion gate）、pd-console `ActivationsConsoleModel.ts`、host-runtime `prompt-injection-projection.ts`。**全部是治理/生命周期面。**
- **exports 变化**：host-runtime index.ts 新增 `export * from './cli-recovery-probe.js'` 与 `export * from './workbuddy-rule-context-provider.js'`；`HostLivenessContract` 类型进入 core 公共 barrel（`runtime-v2-barrel-surface.json` 夹具钉住）。

**对 §3.2 七问的回答**：

1. HostLivenessContract 管理 RuleCode promotion 的恢复通道活性（4 能力 × 别名 × 探针），见上。
2. 与 Application Capability Contract 的区别：前者验证**治理逃生通道在宿主工具面上可达**（可恢复性），后者定义**业务用例的请求/响应/权限/披露**。两者类型、消费者、失效语义完全不同。
3. MCP 可复用的部分：仅 `readWorkspaceHostKindFacts` 这类**只读宿主事实读取**（若未来 MCP 需要工作区宿主构成信息）；且它只读、fail-closed，模式可借鉴。
4. 必须留在 Host Lifecycle / RuleHost 的：4 个受保护能力、中性探针、恢复注册表、RuleContext provider——它们以真实 Hook 事件为存在前提。
5. MCP 不需要依赖 Host Runtime（Pain Recall 只依赖 core 即可运行，见 D.1）。
6. MCP 不需要宿主身份或 Hook 上下文即可执行普通只读业务查询——`PainRecallQuery` 不含任何 session/turn/hostKind 字段（pain-recall.ts:150-157）。
7. **可以完全不依赖宿主生命周期**。依赖链证据：pain-recall.ts 仅 import `@principles/core` 三出口 + node 内建（pain-recall.ts:44-48）。

### B.3 PR #2227 深查（Rule Association Shadow Contracts）

- **关联结构**：`PrincipleAssociationSchema`（`diagnostician-output.ts:87-106`）——`linked`（relation=implements，target=recommendation_ref | canonical_principle，rationale，evidenceRefs≥1）或 `unresolved`（4 个原因枚举）。它出现在 DiagnosticianOutputV2 的 rule 建议内（:108-128），是**诊断输出的一部分**，不是独立的关联存储表。
- **Shadow 的确切含义**：`proposeShadowAssociations`（`diagnostician-association-shadow.ts:25-87`）产出的 `ShadowAssociationProposal.mode='shadow'`，注释原文："Offline/read-only composition… **Proposals are never production identity receipts.**"（:23-24）。canonical_principle 目标一律 `trusted_context_producer_unavailable`（:51-54）。
- **`authorizesGeneration`**：类型为 `Type.Literal(false)`（:20），恒 false——当前不存在任何把它置 true 的代码路径。
- **验证器语义**：`validateDiagnosticianAssociations`（`diagnostician-association-validation.ts:27`）注释："Checks reference integrity only… **a linked result does not authorize binding or prove the implements relationship.**"
- **trustedContextReceipt**（`router-context-evidence.ts:6-22`）：`router-context-v1` = taskId + runId + outputSchemaRef + contextHash + messageDigest + systemPromptDigest + 2 个前驱工件 contentDigest + **`canonicalPrinciples: { status: 'unavailable', reason: 'router_has_no_system_canonical_principle_allowlist' }`**。签发在 diag-router-runner（系统对"当次提交的确切输入"记账，"System-owned evidence from the exact message submitted, never model output"）；校验用于重启后重建输入的重放（`verifyRouterContextReceipt`，:40-64）。**它证明的是上下文来源可信（内容完整性 + 任务血缘），不证明关联真实性（linked≠implements 成立），更不证明披露授权。**
- **生产接线状态**：`diag-router-runner.ts`（含 invocationEvidence 回执）的生产消费者 = pd-cli `diagnose.ts` / `pain-retry.ts` 等（经 runtime-v2 index 导出）；但 **`proposeShadowAssociations`/`validateDiagnosticianAssociations` 仅被自身测试引用**，未进入 runtime-v2 index 导出、未接入任何生产调用方。即：**回执机制已进生产诊断链；影子关联提案本身是"代码存在 + 测试保护"，未生产接线。**
- **SPEC 边界原文**（`docs/specs/SPEC-PD-RULE-ASSOCIATION-005-shadow-implementation.md`）："保持所有默认生产诊断生成/校验为 V1，保持 Owner 显式 binding、审批、shadow/live 权威不变"；"shadow结果不能写Owner binding或启动Scribe"；"来源不完整不启用canonical自动关联"。

**对 §3.3 九问的直接回答**：

1. Principle Identity 权威来源：ledger（`readLedgerFileState`）+ 既有 principle-only canonical resolver；shadow proposal 明确不是身份回执。
2. Shadow = **候选关联提案**（未验证到可 binding，未生产接线，不权威）。
3. trustedContextReceipt 证明：当次路由输入的内容完整性与任务/运行血缘。
4. 不含调用者身份、来源宿主、授权或披露资格（字段清单即证据）。
5. 能证明"上下文来源可信"的：receipt 的摘要链 + taskId/runId 血缘。
6. 仍需独立授权的：数据披露（字段级）、binding 授权（Owner 显式）、生成授权（authorizesGeneration 语义）。
7. MCP 查询 Principle 关联 Pain：**不使用**当前关联结构，使用 recallPains() 的两条权威边（`Principle.reuseEvidence[]` 真实 painId；`derivedFromPainIds` 经 candidate→task→`tasks.input_ref`，pain-recall.ts:1-16）。
8. 缺的不是"生产能力"而是**生产权威性**——shadow→生产的提升路径在 SPEC 与代码中均不存在（刻意缺失，等可证明的 canonical 允许集来源）。
9. MCP 可复用现有校验：recallPains 的关联边验证 + 可用性降级语义；不可复用：shadow 关联提案、trustedContextReceipt（语义不匹配）。

### B.4 PR #2235 与发布/安装事实

- pins（`plugins/principles-disciple/runtime-version.json`）：codexAdapter **0.6.1** / hostRuntime **0.14.2** / core **1.297.7** / plugin **0.2.11**（注释：exact versions only，capability check 对包字节演练）。
- main 当前版本：core **1.297.9**（pins 落后两个 patch，来自 #2245 等后续 changeset——属正常演进，不影响 pin 语义）；host-runtime 0.14.2、codex-adapter 0.6.1 与 pins 一致。
- PD plugin manifest（`.codex-plugin/plugin.json` 0.2.11）**全文 0 处 mcp 字段**；已安装插件缓存 `~/.codex/plugins/cache/principles/principles-disciple/0.2.11/` 同样无 MCP 字段。
- **Codex Adapter 无 MCP Client 能力**：集成模型是 stdin/stdout JSON hook 子进程；全仓源码 `mcp` 命中仅 5 处（注释/测试夹具工具名）；`@modelcontextprotocol/sdk` 仅作为 `@google/genai` 的 **optional peerDependency** 出现在 release-lock 锁文件中，未安装。**不存在可复用的 MCP 工具注册框架**（最接近的是 core `tool-semantic-registry`——纯语义映射，不承载执行）。

---

## C. Current Architecture（基于 `9f0888a16` 的真实架构）

### C.1 包与依赖图（全部来自 package.json 实读）

```
                    install-layout(0.4.0)      principles-core(1.297.9)
                    （叶子）                    （叶子；21 个公共出口；10 个 io-seam）
                         ↑                          ↑
                         +-----------+--------------+--------------+
                                     ↓              ↓              ↓
                          host-runtime(0.14.2)（宿主中立共享层）
                                     ↑
          +--------------------------+---------------------------+
          ↓                          ↓                           ↓
  codex-adapter(0.6.1)     workbuddy-adapter(0.2.15)    openclaw-plugin(2.2.8,
  （stdin/stdout JSON hooks） （镜像布局）                 esbuild 打包 core+host-runtime）
          ↓                          ↓                           ↓
          +------------------------------------------------------+
          ↓
  pd-cli(1.162.3)（顶聚合；bin=dist/index.js；**无 exports 字段**）
  pd-console(0.1.0, private) → core + host-runtime + install-layout
  pd-companion(0.1.5, private) → install-layout
  create-principles-disciple(1.145.37) → install-layout（打包分发其余包）
  website(1.0.0, private)
```

事实：严格有向无环；`host-runtime` 是唯一被三个宿主适配器共享的宿主中立层；pd-cli 是唯一同时依赖全部适配器的包。**当前不存在 Application Capability 层，也不存在 MCP Adapter——两者在主干上均为零实现。**

### C.2 与 SPEC §5 目标图的对照

SPEC §5 目标图中的 "Host-neutral Application Use Cases" 层**尚未存在**；现状是 CLI 命令直接调用分散在 pd-cli services / core read models / host-runtime 读模型中的能力函数。目标图中 "approved public services / principles-core + host-runtime" 的下半部分已成立（pain-recall 的实际依赖即为此形状）。**结论：目标架构图不需要修改；它描述的缺口真实存在，但按 Gate 顺序不应提前填补。**

### C.3 五层区分（任务 §4.2 要求）

| 层 | 定义 | 当前实例 |
|---|---|---|
| Domain Capability | core 内纯域逻辑/读模型 | PainChainReadModel（read-model seam）、reuse-retrieval |
| Application Use Case | 宿主无关、类型化、可版本化的业务服务 | **recallPains()（唯一完全合格者）** |
| Host Lifecycle Capability | 以真实 Hook 事件为前提的治理能力 | HostLivenessContract、RuleContext provider、prompt 注入路径 |
| CLI Command | 参数解析 + 呈现 + 退出码 | `pd pain recall` 等 130+ 注册命令 |
| MCP Tool | 协议注册 + 输入 Schema + 生命周期 | **不存在（待 Gate 2/4）** |

---

## D. Application Capability Assessment

### D.1 Pain Recall（首选候选——复核维持）

| 问题 | 答案（证据） |
|---|---|
| 权威业务入口 | `recallPains(workspaceDir, query)` — `packages/pd-cli/src/services/pain-recall.ts:490`；自 SPEC 基线 `3a2de95c8` 以来**零改动**（git log 验证） |
| 完整关联/排序/身份/状态映射 | 是：两条权威边（reuseEvidence 真实 painId；derivedFromPainIds 经 candidate→task→`tasks.input_ref`）+ unresolvedAssociations 显式上报 + 三源可用性（ledger/trajectoryDb/stateDb） |
| 是否依赖 CLI 呈现 | 否——纯函数式服务（输入 `PainRecallQuery` 输出 `PainRecallResult`）；CLI 依赖仅在命令外壳 `commands/pain-recall.ts`（fail() 用 console+exit） |
| 是否依赖宿主 | 否（pain.host 只是数据字段） |
| 路径依赖 | workspace 约定路径：`.state/principle_training_state.json` / `.pd/state.db` / `.state/trajectory.db` |
| 严格只读 | **已证明**：WAL 暂存快照 + main→wal→main 线性化点（pain-recall.ts:23-58）；`tests/commands/pain-recall-readonly.test.ts` 830 行 25 用例（ro-1..ro-11 WAL 矩阵、race-1..4、ABA-1..4、interleave-1..2） |
| Schema | 版本化 `pd.pain-recall.v1`；limit 1–10 默认 3（:69-71）——与 SPEC §6.1 建议一致 |
| 消费者 | 仅 CLI 命令（:146）+ 测试；pd-console / openclaw-plugin / host-runtime 均无调用 |
| 适合开放吗 | 技术上最合格；开放与否是 D-03 字段授权问题，不是工程问题 |

**回答 §4.3 关键问题**：不存在更底层的宿主无关服务可替代（它本身就是底层组合）；与 CLI 包的耦合仅是"文件住在 pd-cli 包里"，不是职责耦合（依赖已纯）；最小抽取（Gate 3 时）= 移动该文件 + 其 WAL 快照机制，**不必**动 CLI 契约。

### D.2 其余候选复核

| 能力 | 权威实现 | 消费者 | 只读 | Schema | 判定 |
|---|---|---|---|---|---|
| Runtime Features | `buildRuntimeFeaturesStatus()` — `pd-cli/src/commands/runtime-features.ts:41` | 仅自身 CLI 命令 | 是（纯配置读取） | **未版本化**（无 schemaVersion） | 维持"内部候选，不默认注册" |
| Workspace Guidance | `readPromptActivationCandidates`（active-principle-prompt.ts:70）/ `buildActivePrinciplePromptContext`（:134） | host-runtime 生产注入路径（index.ts:299）、prompt-injection-projection（:410/:443）、**pd-console 两个 Approval 模型**（ApprovalsConsoleModel.ts:492 等）——已是多消费者 | 读模型只读（state.db readonly :97）；注入回执写入属于注入行为不属读模型 | 未版本化 | 维持"暂缓"；函数签名不需 Hook 上下文（宿主事实由调用方解析传入），但**注入资格/回执语义必须区分** |
| Pain Trace | `PainChainReadModel.traceByPainId` — `core/runtime-v2/pain-chain-read-model.ts:135-274`（read-model seam 成员） | pd-cli `trace.ts:99` + core 测试 | **SQL 全 SELECT，但构造路径非只读**：`getStateManager()` 用默认 `RuntimeStateManager`（:125），`bootstrapIfMissing` 默认 true（runtime-state-manager.ts:81），缺库工作区会创建 `.pd/`+state.db（WAL） | 未版本化 | **维持"暂缓"**；作为独立后续项登记（非 MCP 范围的既有缺口） |
| Rule Association（#2227 新增） | `proposeShadowAssociations` / `validateDiagnosticianAssociations` | **仅测试**；未导出未接线 | 是（离线组合） | typebox schema | **不列为 MCP 候选**（影子阶段，非生产权威） |
| Host Capability（#2218 新增） | HostLivenessContract ×3 + 五路解析 + 恢复探针 | runtime-activation / console / prompt-injection-projection | 事实读取器只读；探针会执行命令 | — | **不列为 MCP 候选**（治理生命周期专属） |

### D.3 三方案评估（Gate 3 预研，现在不执行）

新事实：`@principles/pd-cli` **无 `exports` 字段**（仅 `bin` + `files: dist`）——"稳定公共出口"当前不存在，方案 A 的纯形态需要先给 pd-cli 增加公共出口（公共契约变化）。

| 维度 | A：直接复用（pd-cli 加窄出口） | B：最小抽取（移动 pain-recall 到宿主中立层） | C：独立 pd-application 包 |
|---|---|---|---|
| 代码改动 | 最小（package.json exports + 一条公共出口） | 中（移动 ~895 行服务 + 快照机制 + 测试路径） | 大（新包 + 全部接线） |
| 依赖方向 | MCP Adapter → pd-cli（拖入 commander/js-yaml/适配器；SPEC §5.1 规则 2 "业务服务不依赖 pd-cli" 是反向表述，此形态是消费者依赖 CLI 包，边界可接受但语义别扭） | MCP Adapter → core 或 host-runtime（干净） | 同 B 且边界最清晰 |
| 复用/重复 | 无重复 | 无重复 | 无重复 |
| CLI 兼容 | 零影响 | 零影响（同文件移动+re-export 或直接改 import） | 零影响 |
| 回滚 | 容易 | 容易（git revert 一次移动） | 较难 |
| 维护成本 | 低，但 CLI 包长期兼作库 | 低（core read-model seam 描述已自述 "exposed for CLI and console reuse"） | 新增包维护面 |

**推荐**：维持 SPEC 顺序——Gate 2 原型直接调用 `recallPains()`（SPEC §2.2 已允许，零仓库改动）；**Gate 3 时**在 B 的两个落点间用真实依赖图决策：默认候选是 **core read-model seam**（既有注册 seam，语义匹配"只读组合读模型"；WAL 快照的 fs/os/crypto I/O 需随移动注册进 seam，守卫自动更新），备选是 pd-cli 窄出口。C 继续按 D-06 冻结（第二消费者出现前不建包）。

---

## E. MCP Interface Assessment（`pd_recall_principle_pains`）

### E.1 工具颗粒度

维持 v0.4：**一个业务 Use Case = 一个 MCP Tool**，不与 CLI 命令一一对应，首期只此一个。复核无新增低风险独立查询能力值得提前扩白名单（Runtime Features 未版本化、Guidance 有资格语义、Trace 有构造副作用、Association/Host 能力被排除，见 D.2）。

### E.2 字段披露表（D-03 冻结提案）

依据 `PainRecallResult` 实际类型（pain-recall.ts:87-180）逐字段判定：

| 字段 | 权威来源 | 真实性验证 | 披露风险 | 任务必要性 | 建议 |
|---|---|---|---|---|---|
| principle.requestedId / identityStatus | 调用输入 + ledger 解析 | 既有权威身份解析 | 低 | 必需（Agent 需知道解析结果） | **ALLOW** |
| principle.canonicalId | ledger | 权威解析 | 低（内部标识，v0.4 列为未决） | 有用非必需 | **OWNER_DECISION_REQUIRED** |
| principle.text | ledger 原则正文 | 权威 | 敏感正文类 | 首个工作流不需要 | **DENY**（摘要需另行冻结来源/长度/目的） |
| association.type / confidence | 两条权威边 | 边级验证（reuseEvidence 写边界校验） | 低 | 必需（核心价值：关联真实性） | **ALLOW** |
| association.evidenceRefs（candidateId/taskId/decisionId/decidedAt） | 边引用 | 血缘可验证 | 内部标识暴露 | 元数据投影下不需要 | **DENY**（v0.4 候选投影明言"不返回关联证据 ID"） |
| painId | trajectory.db | 权威 | v0.4 明列未决 | 目标工作流（按已知 principleId 回查）不需要 | **OWNER_DECISION_REQUIRED** |
| occurredAt | pain 行 | 权威 | v0.4 明列未决 | 排序/时效判断需要 | **OWNER_DECISION_REQUIRED** |
| pain.source / host | pain 行 | 权威（host_kind 机制后更可靠） | v0.4 明列未决 | 弱 | **OWNER_DECISION_REQUIRED** |
| pain.score / severity | pain 行 | 权威 | 低 | 弱 | OWNER_DECISION_REQUIRED（随 occurredAt 一并裁决） |
| pain.text / pain.reason / rawStatement | pain 行 | — | **高（Owner 原话域）** | 首期不需要 | **DENY**（D-04 默认拒绝维持） |
| diagnoses[].rootCause / category / supportingEvidence.note | 诊断 | 权威但为模型产出 | 高（诊断正文） | 首期不需要 | **DENY** |
| correctionEvidence.text / sessionId / channel | 纠错证据 | Owner 原话域 | **最高** | 首期不需要 | **DENY** |
| availability 三态（painEvent/diagnoses/correctionEvidence） | 服务计算 | 可测试 | 低 | 必需（部分可用语义） | **ALLOW** |
| status / statusDetail / sources（枚举）/ summary / truncated / contextUsedForRanking | 服务计算 | 可测试 | 低（不含路径） | 必需 | **ALLOW** |
| unresolvedAssociations[].reason | 服务计算 | 可测试 | 中（含 candidateId） | 诚实降级必需 | **ALLOW（reason 字段）+ DENY（id 字段）** |
| query.limit / 回显 | 输入回显 | — | 低 | 可选 | ALLOW（仅非敏感字段回显） |
| trustedContextReceipt | router-context-v1 | — | — | **不存在于本能力响应中**，语义亦不匹配 | **NOT_AVAILABLE**（不得挪用为授权凭据） |

补充约束（全部继承 v0.4，复核无变化）：内部可读≠可披露；拒绝字段返回 `denied` 或冻结投影，不得回退原文；关联建议不得提升为权威原则身份（#2227 证据强化了这一条的必要性）。

### E.3 身份边界

- MCP Client 身份 = Owner 在本机显式配置的 Codex 进程；MCP Server **无法证明**调用来自哪个宿主（stdio 子进程无宿主身份凭据）——工作区身份只能来自**可信启动配置**（§8.1 单工作区绑定），模型参数不得自报 hostKind/sessionId/turnId。
- 无 Hook 上下文时仍可安全执行的查询：**Pain Recall 全部**（请求 Schema 无任何会话字段）；Runtime Features/Guidance 读模型亦不依赖。必须要求可信宿主上下文的：pain explicit 登记路径、注入回执类查询（`unconfirmed` 语义为此保留）。
- MCP 工具调用 ≠ 一次真实 Hook 事件；不得把 MCP 查询计入注入/门禁统计。

### E.4 严格只读复核

| 能力 | 结论 | 证据 |
|---|---|---|
| Pain Recall | 通过（独立证明完备） | 25 用例 readonly 测试 + WAL 线性化点 |
| Pain Trace | **不通过**（构造路径 bootstrap 风险） | pain-chain-read-model.ts:125 + runtime-state-manager.ts:81 默认 true；无文件不变性测试 |
| Runtime Features / Guidance 读模型 | 初步只读（readonly 打开），**但各自缺 SPEC §11.2 级文件不变性矩阵** | active-principle-prompt.ts:97；无对应不变性测试 |
| 关联/宿主新能力 | 不进入白名单，无需证明 | 见 D.2 |

SPEC §11.2 "每个新只读能力独立通过矩阵；Recall 的证据不能替代 Trace 或 Guidance 的证据" ——最新代码继续印证该条款的必要性（Trace 即为反例）。

---

## F. Host Compatibility（Codex CLI 非侵入式核查，2026-10-31）

| 核查项 | 结果 | 证据 |
|---|---|---|
| 本机安装版本 | **codex-cli 0.166.0**（npm shim `C:\Users\Administrator\AppData\Roaming\npm\codex`） | `codex --version` 实测 |
| MCP Client 支持 | **VERIFIED**：`codex mcp` 子命令（list/get/add/remove/login/logout）全部可运行 | `codex --help` / `codex mcp --help` |
| 本地 stdio 配置方式 | `codex mcp add <name> -- <command> [args...]` + `--env KEY=VALUE`；`add` 无 `cwd` 旗标（`get` 输出含 `cwd` 展示字段） | 帮助文本 + `codex mcp get playwright` 实测 |
| 本机已有 MCP 运行事实 | 7 个已配置 server（4 stdio，含 playwright `npx @playwright/mcp@latest`），config.toml `[mcp_servers.*]` 结构实测确认 | `codex mcp list` |
| 工具审批 | `mcp add` 无 per-server 审批开关；审批为会话级（`-a on-request/never`、`--approve-for-me`） | 帮助文本 |
| MCP 与 Hook 生命周期 | 帮助文本无集成点描述；仓库文档确认 **MCP 工具调用触发 PreToolUse**（`CODEX_CLI_ADAPTER_SPEC.md:175/:915`，`dispatcher.rs:61-63`）→ PD 门禁覆盖 MCP 工具调用；Server 启动本身非 Hook 事件。交互细节 **NOT_VERIFIED** | 文档 + 帮助文本 |
| Skill 与 MCP 并存 | Skill 以插件形态存在（PD plugin 0.2.11 含 `skills` 字段）；无冲突证据，无集成点证据 | plugin.json 全文 |
| 官方支持 / 本机版本 / PD 可连接 / PD 可调用 | VERIFIED / VERIFIED / **NOT_VERIFIED** / **NOT_VERIFIED** | 四态严格区分 |
| PD 配置侵入 | 零——未修改 `~/.codex` 任何内容 | 本轮边界 |

侧面观察（非 MCP 阻塞项，提请 Owner 知悉）：本机 `~/.codex/config.toml` 存在明文第三方 API key；本轮输出已遮蔽，未做任何修改。

---

## G. SPEC Delta Matrix（v0.4 → v0.5 建议）

| SPEC 章节 | v0.4 原设计 | 最新代码事实（`9f0888a16`） | 判定 | 建议 |
|---|---|---|---|---|
| 头部/元数据 | 基线 `3a2de95c8`，2026-10-28 | 新基线 `9f0888a16`，2026-10-31 | **UPDATE_FACT** | v0.5 更新基线 SHA/日期，追加本审计为新证据来源 |
| §1 核心决策（10 项） | 共享业务逻辑/入口独立/不包装 CLI/不替代 Hook/… | 全部经复核成立；#2218/#2227 未产生任何冲突 | **UNCHANGED** | 不改 |
| §1 Owner decision record | D-01..D-09 | 批准范围与未冻结事项依旧；D-07 部分推进（见 §10 行） | **UNCHANGED**（D-07 状态注记随 Gate 0 行更新） | 不改决策内容 |
| §3 当前基线事实表 | 8 行事实 | 全部仍真；新增事实：#2218 宿主归属/恢复合同、#2227 影子关联+回执、#2244 证据绑定、#2235 发布 cohort、`tool_calls.host_kind` schema 演进、本机 codex-cli 0.166.0 MCP 能力 | **UPDATE_FACT** | 增补 5–6 行新事实；旧行保留 |
| §5 目标架构与依赖规则 | 目标图 + 8 条依赖规则 | 目标图不变；现状图复核成立（C.1）；新事实：pd-cli 无 exports 字段（Gate 3 输入） | **UNCHANGED**（附 1 条 UPDATE_FACT 注记） | 不改契约 |
| §6 能力目录 | 5 候选及状态 | 映射路径全部仍存在且未改动；新增两条**排除**记录：Rule Association（影子非权威）、Host Capability（生命周期专属）；`pd_get_capability_status` 维持移除 | **UPDATE_FACT** | 目录表加"排除项"两行，其余不动 |
| §6.1 首个候选 Schema | 请求/响应投影建议 | 服务常量（limit 1-10/默认 3）与建议一致；字段表细化完成（E.2） | **UNCHANGED**（E.2 作为 D-03 材料附上） | 不改 |
| §7 业务结果契约 | pd.capability.v1 建议 | 无实现，契约未受任何新代码影响 | **UNCHANGED** | 不改 |
| §8 安全不变量 | 8.1–8.4 | 全部成立；新增佐证：#2244 "structure is not provenance" 先例；#2218 host_kind 为未来工作区绑定提供持久宿主事实源（非依赖项）；ADR-0020 与 MCP 方向的边界张力（见 H 注） | **UNCHANGED**（建议 §8.2 加一条先例引用） | 最小注记 |
| §9 候选实现映射 | 6 行映射 | 4 个映射文件路径零改动；新增排除项两行；Pain Trace 的 bootstrap 缺口在最新主干**仍存在**（原文警示继续有效） | **UPDATE_FACT** | 更新注记与排除项 |
| §10 Gate 0 | PARTIAL | 三项缺口中"Host 能力边界/发布 cohort/Client 版本"已补齐（B.4/F 节）；剩余：字段 allowlist（属 Gate 1）、Server 连接/工具调用（Gate 2 原型产物） | **UPDATE_GATE**（状态描述更新，判据不变） | Gate 0 可在本审计被 Owner 采信后标记实质收口，进入 Gate 1 收口 |
| §10 Gate 1 | PARTIAL | 字段白名单提案已就绪（E.2）；Gate 1 前整改项：Pain Trace 构造只读性（独立项） | **UNCHANGED** | 等待 D-03 |
| §10 Gate 2 | NOT_RUN；12 场景×3 | 对照协议仍适用（CLI Arm A 基线更丰富：130+ 只读命令清单）；操作门风险下降（mcp add 一条命令；Client 已验证）；准入五项仍未冻结 | **UNCHANGED** | 不改协议；补充操作门证据注记 |
| §10 Gate 3 | BLOCKED_BY_GATE_2 | 抽取落点选项具体化（D.3：core read-model seam 默认候选 / pd-cli 窄出口备选） | **UNCHANGED** | Gate 3 正文可预置 D.3 作为决策输入 |
| §10 Gate 4 | BLOCKED | 前置机制已核实（stdio 配置方式、Client 版本）；仍无 Server | **UNCHANGED** | 不改 |
| §10 Gate 5 | BLOCKED | #2218 宿主身份基建（五路 fail-closed 解析、host_kind 归属）为多宿主未来提供可信底座；"每宿主单独验证"原则不变 | **UNCHANGED**（注记底座改善） | 不改 |
| §11 测试矩阵 | 5 组 | 不变；#2227/#2244 的管线测试与本矩阵无关（不充当 MCP 证据） | **UNCHANGED** | 不改 |
| §13 风险登记 | 9 行 | 全部维持；可补一行"MCP Server 生命周期与宿主 hook 信任机制交互未验证（NOT_VERIFIED）" | **UPDATE_FACT**（可选） | 增 1 行 |
| §14 Owner 决策卡 | D-01..D-09 | 状态全部维持；D-07 部分推进（Client 版本已核实，SDK 锁定仍在实现前） | **UPDATE_FACT**（仅状态注记） | 不新增决策项 |
| §15 本版状态 | Gate 快照 | 随 §10 更新；完成清单第 1 条"完整 Host Capability Matrix"可注记为"治理侧已由 #2218 交付；应用侧矩阵=本报告 D 节" | **UPDATE_FACT** | 勾选注记 |
| §16 参考证据索引 | 固定到 3a2de95c8 | 追加 #2218/#2227/#2235/#2244 与本审计 | **UPDATE_FACT** | 追加条目 |
| §17 结论 | 一段话 | 仍然准确 | **UNCHANGED** | 不改 |

**统计**：UNCHANGED 13 项 · UPDATE_FACT 8 项 · UPDATE_CONTRACT 0 项 · UPDATE_GATE 1 项（仅状态描述） · OBSOLETE 0 项 · OWNER_DECISION 0 项（D-03 本已存在，非新增）。**v0.5 应是最小增量版本：更新事实、追加排除项、推进 Gate 0/1 状态描述——不重写任何架构契约。**

**治理注记（ADR 张力）**：ADR-0020 曾 Reject "Make Codex an MCP server"（理由：PD 从被动观察者变为主动工具，破坏 inbound-only 模型）。SPEC v0.4 的 MCP 方向与此不矛盾——它改的是**业务能力访问面**（第二条集成面），Hook/lifecycle 的 inbound-only 模型原样保留；且 ADR-0020 同时确认 MCP 工具调用会触发 PreToolUse（PD 门禁不失效）。建议 v0.5 在 §2 或 §8 加一段显式对照，避免后续被误读为推翻 ADR-0020。

---

## H. Gate Assessment（重新裁定）

| Gate | 裁定 | 证据 |
|---|---|---|
| **Gate 0 — Reality Audit** | **PARTIAL（实质推进，建议 Owner 采信本审计后视为收口）** | 已具备：真实依赖图（C.1）；宿主能力边界完整（B.2：治理矩阵≠应用能力）；发布 cohort 已核实（B.4）；目标宿主真实版本与 MCP Client 能力已核实（F：codex-cli 0.166.0）；Skill+CLI 基线充分（130+ 只读命令，含 `pd pain recall`）。仍欠：对外字段 allowlist（Gate 1 范围）；PD Server 可连接/可调用证据（须由 Gate 2 原型产生，Gate 0 不可能预产） |
| **Gate 1 — Application Capability Contract** | **PARTIAL（状态不变）** | 已具备：契约框架（§7）、状态语义、只读边界、E.2 字段表提案。未冻结：D-03 逐字段 allowlist；输出上限数值。阻塞者：Owner 裁决，非工程缺口 |
| **Gate 2 — MCP Value Validation** | **NOT_RUN（协议适用性复核通过）** | 12 合成场景设计无需调整（场景类型与最新架构无交集变化）；准入五项（场景/投影/阈值/Client 版本/隔离方式）仍未冻结；无执行授权。新增有利证据：Client 已验证、mcp add 单命令、隔离原型可直接调用 recallPains()（SPEC §2.2） |
| **Gate 3 — Shared Application Use Case** | **BLOCKED_BY_GATE_2（依据不变，落点预研完成）** | D.3 三方案比较完成：默认落点 core read-model seam，备选 pd-cli 窄出口；无依赖环风险（依赖图已验证）；抽取范围 ≈ 1 文件 + WAL 快照机制 + 测试迁移 |
| **Gate 4 — MCP Pilot** | **BLOCKED_BY_GATE_3_AND_OWNER_APPROVAL（不变）** | 无 Server/SDK/安装改动；stdio 机制与 Client 已核实使实施条件更成熟，但准入次序不变 |
| **Gate 5 — Multi-host** | **BLOCKED_BY_GATE_4（不变）** | #2218 提供宿主身份底座（host_kind 持久归属 + fail-closed 五路解析），改变的是未来 Gate 5 的**证据可得性**，不是接入方式；每宿主单独验证原则不变 |

无任何 Gate 因"代码存在"被标 PASS——每个 PARTIAL 均附明确欠账清单。

---

## I. Owner Decision Card（仅保留真正需要 Owner 裁决的事项）

**OD-A｜冻结对外字段白名单（对应既有 D-03）**
- 问题：`pd_recall_principle_pains` 元数据投影的逐字段 allowlist 是否按 E.2 表冻结？
- 推荐：按 E.2 冻结——ALLOW（解析状态/关联类型与置信度/可用性三态/状态与来源枚举/截断语义）+ DENY（正文类与引用 ID）+ OWNER_DECISION（painId、occurredAt、source/host、canonicalId、score/severity 五项可另行裁决）。
- 替代：更紧（全部 ID 类 DENY）或更宽（加 painId+occurredAt）。
- 不决策的影响：Gate 1 停留 PARTIAL；Gate 2 无法预注册；整个 MCP 线停滞（无其他阻塞项）。

**OD-B｜批准 Gate 2 预注册并授权合成对照实验（对应既有 §15 未勾选项 3/4）**
- 问题：是否冻结 12 合成场景与评分规则、阈值提案（SPEC §2.3 数值）、合成字段投影（E.2 的 ALLOW 列）、Client 版本（codex-cli 0.166.0 + 届时锁定的 SDK）、原型隔离方式，并授权执行？
- 推荐：批准。安全边界完整（合成数据、无 SDK 入库、隔离临时目录、PRR v1.3 边界不变）。
- 替代：仅批准预注册、执行另批（多一轮往返，无额外安全收益）。
- 不决策的影响：MCP 线停在"设计已完备但永不验证净增量"，SPEC §1.6 的"先证明增量价值"永远无法兑现。

**（无其他新增决策项。）** Pain Trace 构造只读性缺口建议作为**独立后续工单**处理（与 MCP 无关的既有缺口，不应捆绑进 MCP SPEC）；ADR-0020 对照注记随 v0.5 编辑处理，不需决策。

---

## J. Next-step Recommendation（唯一推荐行动）

**Owner 完成 OD-A + OD-B 后，唯一下一步是执行 Gate 2 合成对照实验**（一次性隔离原型：注册 `pd_recall_principle_pains` 单工具、元数据投影、12 场景 × 2 臂 × 3 次、零真实数据、零仓库依赖变更）。

不并行任何其他路线：不抽包、不建 MCP Adapter 骨架、不做 Trace 修复捆绑、不做多宿主预研。实验产物（GO_TO_GATE_3_PROPOSAL / STOP / UNPROVEN）再决定 Gate 3 是否启动。

---

## K. Evidence Index

| # | 结论 | 证据位置 |
|---|---|---|
| 1 | 审计基准与 PR 区间 | origin/main `9f0888a168def3b57a5e85fbb6b88273e82fe3fe`；#2217 merge `636fa62116fc56e93c64f39114e8a11f89007da5`（gh pr view 2217） |
| 2 | #2218 宿主能力合同 | `packages/host-runtime/src/host-liveness-contract.ts:8/51/81/103/151/214/284`；类型 `packages/principles-core/src/runtime-v2/activation/openclaw-promotion-checks.ts:7-22`；消费者 `packages/pd-cli/src/commands/runtime-activation.ts`、`packages/pd-console/src/server/models/ActivationsConsoleModel.ts`、`packages/host-runtime/src/prompt-injection-projection.ts`；merge `ac11a2a43ee19a7cc820811f4b58821e6d4a3df9` |
| 3 | #2218 宿主归属 | `tool_calls.host_kind` ALTER + 按宿主去重（`packages/host-runtime/src/workspace-behavior-evidence.ts`，diff ac11a2a43）；WB provider Hook 绑定 `packages/host-runtime/src/workbuddy-rule-context-provider.ts:44-69,100-105` |
| 4 | #2227 影子关联 | `packages/principles-core/src/runtime-v2/diagnostician-association-shadow.ts:20-24,51-54`（authorizesGeneration 字面量 false；"never production identity receipts"）；`diagnostician-association-validation.ts:27`（"does not authorize binding"）；消费者仅测试（rg 全仓）；未进 runtime-v2 index |
| 5 | trustedContextReceipt 语义 | `packages/principles-core/src/runtime-v2/internalization/router-context-evidence.ts:6-22`（canonicalPrinciples 恒 unavailable）/:40-64（重放校验）；签发 `diag-router-runner.ts`（#2227 diff）；SPEC `docs/specs/SPEC-PD-RULE-ASSOCIATION-005-shadow-implementation.md:9-23` |
| 6 | #2244 证据绑定 | `packages/principles-core/src/runtime-v2/internalization/diag-rootcause-runner.ts`（diff ee5ed6ceb："structure is not provenance"）+ `diagnostician/evidence-ref-binding.ts`（新增 140 行）+ `evidence-ref-binding.test.ts`（128 行） |
| 7 | 发布 cohort | `plugins/principles-disciple/runtime-version.json`（0.6.1/0.14.2/1.297.7/0.2.11）；main 版本 core 1.297.9 / host-runtime 0.14.2 / codex-adapter 0.6.1 / pd-cli 1.162.3；merge `745f463b448ab26dfeba81834775090c7d232e00` |
| 8 | Pain Recall 权威性/只读 | `packages/pd-cli/src/services/pain-recall.ts:1-16（双权威边）:23-58（WAL 快照）:44-48（仅 core 依赖）:67-71（schema/limit）:150-157（Query 无会话字段）:490（recallPains）`；`packages/pd-cli/tests/commands/pain-recall-readonly.test.ts`（830 行 25 用例）；自基线零改动（git log 3a2de95c8..origin/main 空） |
| 9 | pd-cli 无公共库出口 | `packages/pd-cli/package.json`（仅 bin+files，无 exports）；103+29 处命令注册 |
| 10 | Pain Trace 构造缺口 | `packages/principles-core/src/runtime-v2/pain-chain-read-model.ts:125`（默认构造）；`runtime-v2/store/runtime-state-manager.ts:74-81`（bootstrapIfMissing 默认 true）；消费者 `packages/pd-cli/src/commands/trace.ts:99` |
| 11 | Workspace Guidance | `packages/host-runtime/src/active-principle-prompt.ts:70/97/134`；消费者含 pd-console `ApprovalsConsoleModel.ts:492`、`ApprovalsGroupedConsoleModel.ts:501` |
| 12 | 依赖图/DAG | 11 包 package.json 实读（C.1）；io-seam-registry 10 seams（`packages/principles-core/io-seam-registry.json`，read-model seam 描述） |
| 13 | MCP 零实现 | 全仓 rg：源码 5 处命中均为注释/夹具；`@modelcontextprotocol/sdk` 仅为 `@google/genai` optional peerDep（release-locks 锁文件）；`pd_recall_principle_pains` 仅存在于 SPEC 文档 |
| 14 | Codex 宿主核查 | codex-cli 0.166.0（`codex --version`）；`codex mcp add/list/get` 实测；本机 7 个 MCP server；plugin 0.2.11 零 mcp 字段；`docs/architecture/CODEX_CLI_ADAPTER_SPEC.md:91-92,175,513,915`（PreToolUse 覆盖 MCP 工具；"PD does not expose itself as an MCP server in MVP"） |
| 15 | PRR 边界 | `docs/specs/SPEC-PD-PRR-001-principle-pain-recall-v1.3.md:12（范围外）:259:513:705（MCP OUT_OF_SCOPE）` |
| 16 | ADR-0020 张力 | `docs/adr/0020-codex-cli-host-adapter.md:141-142（选项 B Rejected）:175（MCP 工具触发 PreToolUse）` |
| 17 | Runtime pins 语义 | `runtime-version.json` note（exact versions only，capability check 对包字节演练） |

**复核说明**：本报告所有文件引用均可在 worktree `D:\Code\_worktrees\principles\adhoc-20261031-mcp-delta-audit-7b2b62`（= origin/main `9f0888a16`）或主仓库 `git show 9f0888a16:<path>` 复现。审计过程零生产文件改动、零宿主配置改动、零依赖变更、零模型调用、未访问真实 Owner 历史/生产 Pain 原文/真实 correctionEvidence。
