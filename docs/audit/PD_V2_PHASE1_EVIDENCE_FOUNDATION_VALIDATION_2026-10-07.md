# PD v2 Phase 1 Evidence Foundation — Engineering Integration Validation

> 日期：2026-10-07（Asia/Shanghai）
> 分支：`ai/adhoc-20261007-pdv2-evidence-7a49dd`（基线 f330acb3）
> 架构依据：ADR-0027 / ADR-0028 / receipt-design SPEC §13
> 本报告记录 Phase 1 六段实施（PR1–PR6）的工程集成验证，不构成真实宿主/Agent Runtime Acceptance。验证驱动脚本为一次性脚本（未入库）；以下记录其构造、命令与结果，供复核者按同样步骤重建。16/16 指本报告列出的集成断言通过，不代表 ADR-0027 §6 的真实宿主旅程已通过。

## 1. 验证方法

- **OpenClaw 工程集成链**：隔离临时 workspace（`.pd/config.yaml` + state.db）内由验证脚本直接播种治理事实（tasks/runs/pi_artifacts/approvals/activations/activation_control_states），随后直接调用生产入口 `handleBeforeToolCall`（openclaw-plugin `src/hooks/gate.ts`）处理 `protected/critical.txt` 的 `write`。无 mock 的 RuleHost、RuleCode、event-log、state.db 和 recorder 均参与；但没有由 OpenClaw 宿主进程启动 Agent session 或从宿主发出工具调用。
- **Codex hook 子进程集成**：`packages/codex-adapter/dist/pd-hook.js`（tsc 构建产物）以真实子进程运行（stdin JSON → stdout JSON），隔离 `CODEX_HOME`；这没有启动 Codex Agent/CLI 会话。
- **审计读路径**：直接调用 `SqliteInterventionEvidenceStore.readAuditRelations`，不代表真实 Console 页面/API 用户旅程。
- **Owner outcome ingress 集成**：验证脚本直接通过共享 ingress 以 `owner_console_input` 来源写入；未调用 POST `/api/v1/evidence/outcomes` 路由，也没有由真实 Console Owner 操作提交。

运行命令（worktree 根）：

```bash
npm run build -w packages/principles-core
npm run build -w packages/host-runtime
npm run build -w packages/codex-adapter
# OpenClaw 链（一次性 tsx 驱动脚本，位于 packages/openclaw-plugin/，运行后删除）
npx tsx validate-phase1-runtime.mts   # → RESULT: 16/16 checks passed
```

## 2. 工程集成检查结果（16/16 PASS；不等于宿主验收通过）

| # | 检查 | 结果 |
|---|---|---|
| 1 | 隔离 SQLite 直接播种治理事实（approved rule artifact + live activation + eligible control state） | PASS（fixture setup） |
| 2 | 直接调用生产 gate hook 拦截受保护写入（blockReason 含「princ-gj」原则署名） | PASS（非宿主发起） |
| 3 | 证据链四类记录落库（delivery/application/behavior_episode/effect，单批原子） | PASS |
| 4 | delivery = runtime_enforcement / **runtime_loaded / delivered** | PASS |
| 5 | application = **runtime_verified / tool_blocked** + 显式 proof boundary（pd_gate_block_returned_to_host） | PASS |
| 6 | application + effect 以**精确 episode key** 关联 | PASS |
| 7 | 直接通过共享 ingress 写入 owner_console_input outcome | PASS（非 Console 路由/Owner 操作） |
| 8 | Q1 principle → delivery+application+effect+outcome 可见 | PASS |
| 9 | Q2 activation → runtime_verified application 单列 | PASS |
| 10 | Q3 episode → 关联 effect | PASS |
| 11 | Q4 effect → 关联 outcome | PASS |
| 12 | openclaw 能力矩阵声明（含诚实的 outcome_observation=unknown） | PASS |
| 13 | 同一 hook 重放：拦截不变、证据零新增（5 行 = 4 链 + 1 outcome） | PASS |
| 14 | codex hook 子进程：stdout 恰一个 JSON 对象（UserPromptSubmit 形状） | PASS（非 Agent session） |
| 15 | codex hook 子进程证据落库（delivery attempted/submitted + 6 条能力声明） | PASS（hook 集成） |
| 16 | codex hook 子进程重放：行数不变（幂等） | PASS（hook 集成） |

## 3. Evidence Chain Demo（本次运行的观察键链）

```
Activation   act-gj（code_tool_hook / live / artifact art-gj / approved appr-gj）
   ↓
Delivery     openclaw|delivery|enforcement|sess-gj|tool-gj|act-gj
             （runtime_enforcement · runtime_loaded · delivered）
   ↓
Application  openclaw|application|runtime_verified|sess-gj|tool-gj|act-gj
             （runtime_verified · tool_blocked · boundary=pd_gate_block_returned_to_host）
   ↓
Episode      openclaw|episode|sess-gj|tool-gj
             （closed · "write on protected/critical.txt" → blocked by rule）
   ↓
Effect       openclaw|effect|sess-gj|tool-gj|act-gj
             （observed · rule blocked write on protected/critical.txt）
   ↓
Outcome      owner|outcome|openclaw|episode|sess-gj|tool-gj
             （owner_feedback · "受保护文件未被删除" · actor=服务端解析 Owner）
```

每条记录另持久化 `evidenceId = sha256(sourceKind|sourceLocator|observationKey)` 与内容指纹 `recordDigest`（不含 recordedAt/scope —— 同一事实不同时间重放幂等）。原生宿主身份（sessionId/toolUseId/runId/toolName）完整保留在 nativeRefs。

## 4. Known Limitations / Unknown / Deferred（诚实边界）

| 项 | 状态 | 说明 |
|---|---|---|
| 真实 OpenClaw **宿主进程** session（OpenClaw 主体加载插件跑一轮真实 agent 会话） | **未执行** | 需经 installer 发布候选构建（AGENTS §1.1 禁止改 `~/.openclaw`/`~/.pd`）；本次以真实插件 hook 生产入口 + 真实 RuleCode/RuleHost/store 代替（工程全链），宿主进程层验证留待发布后 GJ 复跑 |
| ADR-0027 §6 的真实 OpenClaw Owner → Agent → 宿主工具调用 → Console/Owner outcome journey | **未验收 / 不可由 16/16 推导** | 当前材料只有隔离 SQLite fixture、直接生产 hook 调用、直接 ingress 写入；没有真实宿主启动的 Agent session、宿主自身发出的工具事件或 Owner 在 Console 的 outcome 操作。发布候选需由受支持 installer 流程进入隔离测试安装与隔离 workspace 后执行；不得直接改写 `~/.openclaw`、`~/.pd/runtime`、扩展目录或 workspace `.pd/`。Installer 与宿主/Agent 环境未在本次审计中运行，因此具体命令、版本和安全可执行性仍需 Owner/操作者在隔离环境核实。 |
| Codex enforcement_delivery / application_runtime_verified / behavior_observation | **Unknown** | PRI-780：Codex 未注入 V2 rule context provider，live 规则挂起；能力矩阵如实声明 Unknown，不伪造 deny 链 |
| Codex application_self_report | **Unsupported** | Codex 无自述采集通道（能力矩阵声明） |
| Codex agent-context delivery 确认程度 | 最高 **submitted** | stdout hookSpecificOutput 为提交通道；宿主消费不可确认 |
| OpenClaw agent-context delivery 确认程度 | 最高 **submitted** | prompt hook 返回注入块；宿主消费不可确认（与既有 presence 行同口径） |
| "Host 已实际阻止工具"的独立原生回执 | **Unknown** | 当前最强证明边界 = PD gate 返回 block（OpenClaw）/ permissionDecision deny 编码（Codex）；宿主执行侧独立回执本期无来源 |
| Episode 的 assistant 输出来源 | Deferred | 本期 episode 仅覆盖工具干预链；llm_output→episode 留待后续 |
| 关联 BDD 场景 | Deferred | 未新增 .feature 场景（未删/未降任何既有场景）；四问与链路由 model/route/UI/集成测试覆盖 |
| Learning/Evaluation | 明确排除 | 无 effectiveness/score/ranking 字段，无自动原则变更（ADR-0027 §2.5） |

### 4.1 真实宿主验收的安全前提与执行路径（本次未执行）

真实宿主验收必须先有 Owner 选定并经正式 Owner 流程批准、激活的安全测试原则。AI 不得从 fixture 或用户 state.db 手写 approval/activation，也不得复制 Owner 治理记录到另一 workspace。对当前 `D:\.openclaw\workspace\.pd\state.db` 的只读元数据检查发现有已批准且仍激活的 prompt principles，但没有已批准且仍激活的 Rule artifact；这些记录属于真实 Owner workspace，不能据此直接触发运行或把它们搬入测试库。此次未选定或激活任何记录。

满足上述 Owner 前提后，最小可执行路径为：

1. 用独立临时 OS home、OpenClaw config/state 和 PD workspace 建隔离测试环境。仓库 installer 按 `HOME` / `USERPROFILE` 解析安装根；OpenClaw 支持独立 `OPENCLAW_HOME`、`OPENCLAW_STATE_DIR`、`OPENCLAW_CONFIG_PATH` 和 workspace 配置。所有值须指向 disposable profile/workspace，不能落回 Owner 的真实 home 或 `.pd/`。
2. 通过正式候选 installer 安装目标构建并验证产品身份与插件运行时注册；不得手工覆盖已安装文件。当前 PR 分支尚不是已发布候选，正式 installer artifact 是否可用于隔离验收需要操作者确认。
3. 在隔离 Gateway 中启动插件，再由真实 OpenClaw Agent session 发出一项由 Owner 批准原则覆盖的安全工具操作；保留实际 host/session/tool identities、Agent transcript、宿主响应和 PD 原始/规范化记录。
4. 经真实 Console 路由，由 Owner 提交 outcome；重新打开审计读模型核对 exact content/activation references、delivery proof boundary、execution/Episode/Effect/Outcome 与相同 source 的幂等重放。任何缺失或 unsupported 链路都记为 Unknown/partial，不以直接 ingress 调用补成通过。

2026-10-08 的环境可行性探测中，OpenClaw CLI `--help` 通过两种直接 launcher 方式（含禁用 compile cache）均约 60 秒无 stdout 后中止；没有启动 Gateway、安装插件或改动宿主配置。该 CLI 环境阻塞和缺少 Owner 选定的隔离测试原则，使真实宿主 GJ 继续保持 **NOT RUN**。

## 5. 开发期事故披露（已清理，未经独立验证）

PR4 开发中，全路径测试未隔离 `CODEX_HOME`，用户 workspace 解析采纳了本机真实 `~/.codex/pd-workspace`，导致 2 条 evidence 行 + 6 条 capability 行 + 10 行事件日志被测试写入真实 Owner workspace。已按 §18 流程处理：先备份（`state.db.backup-before-evtest-cleanup`、`events_2026-10-07.jsonl.backup-before-evtest-cleanup`，与原文件同目录，Owner 可择期删除），再有界删除恰好该批测试行；测试已改为隔离 `CODEX_HOME` 并复验零泄漏。此事故不影响任何治理数据（无 Principle/Approval/Activation 行被触碰）。

> 诚实声明：上述精确删除范围（2/6/10）与“未触碰治理数据”结论来自开发期手工核对，**未经独立可复核证据支撑**（无脱敏的前后表行数、抽样 ID 与可重跑命令输出）。按 `docs/process/DATA_CLEANUP_GUIDELINES.md` 应补充清理核对结果；本报告暂将其标记为**未经独立验证**，follow-up 补齐。

## 6. 自动化测试汇总（本次六段提交）

| 套件 | 规模 | 结果 |
|---|---|---|
| core：契约不变量 + normalizer 验证矩阵 | 45 | 全绿 |
| core：SQLite store 集成（幂等/冲突/作用域/不可变/快照/可用性/busyTimeout） | 14 | 全绿 |
| host-runtime：ingress | 8 | 全绿 |
| openclaw-plugin：recorder + 真实 gate 路径集成 | 11 | 全绿 |
| codex-adapter：recorder + 真实 processHookInvocation | 6 | 全绿 |
| pd-console：model 四问 + 路由（含 Owner outcome）+ UI client | 16 | 全绿 |
| 相邻回归（barrel 冻结/architecture-regression/pragma/readonly/schema-version/receipt 系列/pd-hook 系列/ingestion） | — | 全绿 |

已知存量环境问题（与本次改动无关，主检出复现一致）：openclaw-plugin `tests/bdd/principle-application-ledger.steps.test.ts` 2 个场景在 Windows 上 afterEach `rmSync` EPERM（断言本身通过）。

## 7. 2026-10-08 评审修复与独立复验

结论：实现问题已修复，工程验证通过；真实宿主 Golden Journey 仍为 **NOT RUN**。本节不把自动化回归、生产入口集成或直接调用 ingress 当作真实 Agent / Owner 旅程验收。

复验基线：原 PR head `b20b31c1b1eb8882511d3c7bcd8bcf3cd1d19da5`；已同步 main `0b981bbedd2f7831153a6bc5f3c92c7622658d90`；代码修复 head `5ebe0284`。GPT6 luna 子代理在独立工作区实施，主代理在独立集成工作区复验；没有修改安装运行时、ADR 或真实 Owner 治理数据。

修复范围：

- 工作区搬迁后复用 SQLite 已持久化 scope；错误 scope 显式拒收，不改写源身份。首次并发写入、临时读取失败恢复均有回归。
- 原则正文 digest 与激活元数据 snapshot digest 分开。缺少正文或历史正文无法证明时，版本保持未解析，不填造出的 digest。
- 四问按记录类型分页，保留 native、content、activation 引用。旧 Application 不会被新 Delivery 遮蔽；未解析关系、截断和损坏数据分别披露。
- 过期正文与独立 correction reason 在首次摄取、只读查询和有界清理中均受控脱敏。原 identity、digest、关系和治理事实保留；任意改写和 DELETE 仍被拒绝。
- 真实 OpenClaw event log 与 Codex 短期来源正文最多保留 7 天。自述的真实来源 `openclaw_application_ledger`、旧 event-log 标签下的 application-ledger locator，以及 Owner Console feedback 均沿用 90 天。按来源决定期限，不按 native host 决定。Codex 32-turn 来源可用性没有被推定为已确认。
- 自述镜像失败后从原始持久行重试，保留原 claim、激活编号和发生时间。新旧来源标签兼容，健康旧镜像复用；矛盾镜像明确降级，不自动合并或删除。
- 原事件在激活停用后可重放；唯一历史元数据可读时保留原发生关系，不能证明历史正文时保留版本缺口。已写入的原引用按完整来源三元组复用，改变来源内容仍触发冲突；重放不重新激活原则。
- 保留期常量通过 core 纯叶子入口共享，避免把模型 SDK 图引入审计卫星。包体积预算和安全检查没有放宽。

| 复验范围 | 结果 |
| --- | --- |
| core 契约、normalizer、SQLite store、架构与叶子导出合同 | 586/586 PASS |
| OpenClaw 自述账本、recorder、gate、注入配对 | 33/33 PASS |
| host-runtime ingress | 15/15 PASS |
| Codex recorder / hook 消费者 | 11/11 PASS |
| Console 新审计与既有收据 model、Owner outcome route、API 客户端 | 51/51 PASS |
| 合计 | **696/696 PASS**，所列套件没有跳过测试 |
| `npm run verify:merge` | **PASS**，exit 0；本机使用 `NODE_OPTIONS=--max-old-space-size=8192`，默认 4GB 检查进程曾内存不足 |
| 真实 satellite bundle | PASS；禁止模型依赖数 0；governance-audit 703831 bytes，低于 866390 上限 |
| GPT6 luna 独立只读复核 | PASS；已修复复核发现的保留期、来源分类及历史重放边界 |
| 实宿主 GJ-01 / GJ-02 | **NOT RUN**；安全前置与执行路径见 §4.1 |

696 项是本次明确选取的五包测试，不是全仓所有测试。子代理工作区曾出现 TypeBox 安装缺文件，相关测试未收集；上述结果来自依赖完整的独立集成工作区。额外 core 包级全量 lint 包含未修改测试文件的错误，首个错误文件在提交基线复现 9 errors；项目规定的根级 lint 与完整合并检查已通过。本次没有重新执行前述 Windows EPERM 的两项旧 BDD 场景。

后续验收仍需要 Owner 选定安全测试原则，经合法 installer 与真实宿主 / Agent session 执行，并从真实 Console 提交结果。完成之前，不应把本报告作为“Phase 1 真实闭环已验收”的证据。
