# PD v2 Phase 1 Evidence Foundation — Runtime Validation Report

> 日期：2026-10-07（Asia/Shanghai）
> 分支：`ai/adhoc-20261007-pdv2-evidence-7a49dd`（基线 f330acb3）
> 架构依据：ADR-0027 / ADR-0028 / receipt-design SPEC §13
> 本报告为 Phase 1 六段实施（PR1–PR6）的运行时验收记录。验证驱动脚本为一次性脚本（未入库）；以下记录其构造、命令与结果，供复核者按同样步骤重建。

## 1. 验证方法

- **OpenClaw 链**：隔离临时 workspace（`.pd/config.yaml` + state.db）内播种完整治理事实（tasks/runs/pi_artifacts(kind=rule, validated)/approvals(approved)/activations(live)/activation_control_states(eligible)），随后以**无 mock** 的生产入口 `handleBeforeToolCall`（openclaw-plugin `src/hooks/gate.ts`）驱动一次对 `protected/critical.txt` 的 `write` 调用：真实 RuleHost 加载并执行真实 RuleCode（`implementationCode` 内联 JS 规则）、真实 event-log JSONL、真实 state.db、真实证据 recorder。
- **Codex 链**：`packages/codex-adapter/dist/pd-hook.js`（真实 tsc 构建产物）以真实子进程运行（stdin JSON → stdout JSON），隔离 `CODEX_HOME`（空 pd-workspace → 项目目录解析），workspace 播种 prompt 渠道激活。
- **Console 四问**：通过 `SqliteInterventionEvidenceStore.readAuditRelations`（PR5 路由/模型同一读路径）在连接重启后查询。
- **Owner 结果**：经共享 ingress 以 `owner_console_input` 来源写入（PR5 POST /api/v1/evidence/outcomes 的同一写路径）。

运行命令（worktree 根）：

```bash
npm run build -w packages/principles-core
npm run build -w packages/host-runtime
npm run build -w packages/codex-adapter
# OpenClaw 链（一次性 tsx 驱动脚本，位于 packages/openclaw-plugin/，运行后删除）
npx tsx validate-phase1-runtime.mts   # → RESULT: 16/16 checks passed
```

## 2. 检查结果（16/16 PASS）

| # | 检查 | 结果 |
|---|---|---|
| 1 | 治理事实播种（approved rule artifact + live activation + eligible control state） | PASS |
| 2 | 真实 gate hook 拦截受保护写入（blockReason 含「princ-gj」原则署名） | PASS |
| 3 | 证据链四类记录落库（delivery/application/behavior_episode/effect，单批原子） | PASS |
| 4 | delivery = runtime_enforcement / **runtime_loaded / delivered** | PASS |
| 5 | application = **runtime_verified / tool_blocked** + 显式 proof boundary（pd_gate_block_returned_to_host） | PASS |
| 6 | application + effect 以**精确 episode key** 关联 | PASS |
| 7 | Owner outcome 落库（owner_console_input 来源） | PASS |
| 8 | Q1 principle → delivery+application+effect+outcome 可见 | PASS |
| 9 | Q2 activation → runtime_verified application 单列 | PASS |
| 10 | Q3 episode → 关联 effect | PASS |
| 11 | Q4 effect → 关联 outcome | PASS |
| 12 | openclaw 能力矩阵声明（含诚实的 outcome_observation=unknown） | PASS |
| 13 | 同一 hook 重放：拦截不变、证据零新增（5 行 = 4 链 + 1 outcome） | PASS |
| 14 | codex 真实 hook 子进程：stdout 恰一个 JSON 对象（UserPromptSubmit 形状） | PASS |
| 15 | codex 证据落库（delivery attempted/submitted + 6 条能力声明） | PASS |
| 16 | codex hook 重放：行数不变（幂等） | PASS |

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
| Codex enforcement_delivery / application_runtime_verified / behavior_observation | **Unknown** | PRI-780：Codex 未注入 V2 rule context provider，live 规则挂起；能力矩阵如实声明 Unknown，不伪造 deny 链 |
| Codex application_self_report | **Unsupported** | Codex 无自述采集通道（能力矩阵声明） |
| Codex agent-context delivery 确认程度 | 最高 **submitted** | stdout hookSpecificOutput 为提交通道；宿主消费不可确认 |
| OpenClaw agent-context delivery 确认程度 | 最高 **submitted** | prompt hook 返回注入块；宿主消费不可确认（与既有 presence 行同口径） |
| "Host 已实际阻止工具"的独立原生回执 | **Unknown** | 当前最强证明边界 = PD gate 返回 block（OpenClaw）/ permissionDecision deny 编码（Codex）；宿主执行侧独立回执本期无来源 |
| Episode 的 assistant 输出来源 | Deferred | 本期 episode 仅覆盖工具干预链；llm_output→episode 留待后续 |
| 关联 BDD 场景 | Deferred | 未新增 .feature 场景（未删/未降任何既有场景）；四问与链路由 model/route/UI/集成测试覆盖 |
| Learning/Evaluation | 明确排除 | 无 effectiveness/score/ranking 字段，无自动原则变更（ADR-0027 §2.5） |

## 5. 开发期事故披露（已清理）

PR4 开发中，全路径测试未隔离 `CODEX_HOME`，用户 workspace 解析采纳了本机真实 `~/.codex/pd-workspace`，导致 2 条 evidence 行 + 6 条 capability 行 + 10 行事件日志被测试写入真实 Owner workspace。已按 §18 流程处理：先备份（`state.db.backup-before-evtest-cleanup`、`events_2026-10-07.jsonl.backup-before-evtest-cleanup`，与原文件同目录，Owner 可择期删除），再有界删除恰好该批测试行；测试已改为隔离 `CODEX_HOME` 并复验零泄漏。此事故不影响任何治理数据（无 Principle/Approval/Activation 行被触碰）。

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
