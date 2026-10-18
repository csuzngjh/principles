# SPEC-PD-PI12-COMPAT-001 — Phase 3 AC-6 真实模型验收报告（零授权轮）

- 日期：2026-10-18
- 执行者：ZCode（一次性自主执行，无运行中交互，未在执行中请求 Owner 审批）
- SPEC：`docs/specs/SPEC-PD-PI12-COMPAT-001-v0.2.md`（origin/main `aee538012`）
- 前序：Phase 2 升级后验收（`SPEC-PD-PI12-COMPAT-001-phase2-post-upgrade-20261018.md`，本 PR 同时将其入库并施用两处已核实勘误）
- 本轮边界：**零生产写入 / 零安装零升级零发版 / 零付费模型调用**；隔离 worktree 内完成 AC-6 真实调用的全部零费用准备

---

## 0. 最终裁决（任务书 §九 口径，逐项）

```text
AC6_PREFLIGHT       : READY（9 项前置全部核清；三场景 opt-in 测试就绪；唯一缺项=Owner 授权开关）
DREAMER_REAL_LLM    : NOT_RUN（无授权）
ARTIFICER_REAL_LLM  : NOT_RUN（无授权）
ONESHOT_REAL_LLM    : NOT_RUN（无授权）
AC6_OVERALL         : NOT_RUN（三态状态机：非 FAIL、非 OWNER_WAIVED）
PI12_REGRESSION     : PASS（隔离证据维持 Phase 2 两轮 308/308；本轮入口复跑 214/214；无反证）
IAER_REAL_PILOT     : NOT_RUN（生产 Pi 模型路径零活动，维持 Phase 2 判定）
DEPLOYMENT          : KEEP（与 Phase 2 CONDITIONAL GO 一致；条件不变：AC-6 处置 + Pi 模型面首流量复核）
```

Owner Review Card（摘要）

1. **Problem**：AC-6（真实 LLM E2E）是 SPEC §12 生产切换硬门，Phase 2 因授权缺席维持 NOT_RUN；本轮补齐"真实调用的所有零费用准备"并按任务书核验授权。
2. **Before**：AC-6 机制存在（`llm-e2e-config.ts` opt-in），但 SPEC AC-6 要求的三个 L2/One-shot 场景没有现成的真实调用测试（既有 real-llm 测试为 v2 Runner 级，不经 L2 agent loop、非 json_schema 确定性路径）；授权记录无处可查。
3. **After**：三场景 opt-in 测试 + 线缆观测 harness 就绪（默认零费用 SKIP）；授权核验完成（不存在）；Phase 2 报告入库并勘误；AC-6 维持 NOT_RUN，部署维持 KEEP。
4. **Existing mechanism reused**：`getLlmE2eConfig` opt-in 门、L2AgentLoopAdapter/ArtificerL2Adapter/PiAiRuntimeAdapter 生产装配、`createProductionGateDeps` 生产 vm 沙箱、`DefaultArtificerValidator`、`outputPathStrategy: 'json_mode_first'` 生产策略、pi12-spike 套件、pi-ai-http-transport 注册 I/O seam。**未新增任何生产机制**。
5. **Complexity Delta**：New source of truth/persisted state/subsystem/public abstraction/feature flag/cross-package dependency/host behavior/external capability：**全部 NO**。新增物仅为 4 个测试文件 + 2 份报告（净测试覆盖增加，生产代码零改动）。
6. **Design reason**：任务书明令"不重新建设一套 E2E 框架"，最小改动 = 复用 opt-in fixture + 三适配器 + 观测性 fetch 包装；无授权时零费用是硬约束。
7. **Verification**：typecheck/eslint 全绿；新测试无开关 3 SKIP（零费用证明）；spike+契约 7 文件 214/214 PASS；生产零写入由构造与快照对照证明（§2.4）。
8. **Risk**：sensenova 不在 pi-ai 1.2.0 目录（42 provider），经 catalog-borrow/字面量回退解析——机制已核实但真实连通性只能由授权后的实跑证明（§5）。
9. **Rollback**：PR 不合并即完全回退；测试默认 SKIP，无运行时面。
10. **Follow-ups**：§8 列明（含 37 pending/83 failed 存量 Artificer 队列独立后续事项，本轮不触碰生产队列）。

---

## 1. 真实 SDK 与 Provider 接线证据（AC6_PREFLIGHT: READY）

### 1.1 SDK 解析

隔离 worktree `D:\Code\_worktrees\principles\PRI12-PHASE3-pi12-phase3-ac6-preflight`（branch `ai/PRI12-PHASE3-pi12-phase3-ac6-preflight`，base = origin/main `aee538012` = 生产 sourceCommit，READY L1–L3，writer=zcode 租约认领）。实测解析：

```text
@principles/core@1.293.4
├── @earendil-works/pi-agent-core@1.2.0
│   └── @earendil-works/pi-ai@1.2.0 (deduped)
└── @earendil-works/pi-ai@1.2.0
```

三条路径的"真实 Pi 1.2"证据与 Phase 2 spike 同构：`pi12-spike-*` 直接驱动 **真实 `runAgentLoop`（pi-agent-core 1.2.0）** 与 **真实 `completeSimple`/`streamSimple`（pi-ai 1.2.0 compat）**，仅 provider 为 faux。本轮入口复跑 7 文件 **214/214 PASS**（退出码 0）。

### 1.2 Provider 解析（重要披露）

- `getLlmE2eConfig()` 默认 provider `sensenova` / model `deepseek-v4-flash` / baseUrl `https://token.sensenova.cn/v1` / timeout 120s / maxRetries 2；`LLM_E2E_ENABLED !== 'true'` 时**恒返回 null**（opt-in 硬门）。
- **`sensenova` 不在 pi-ai 1.2.0 目录中**（实测 `getProviders()` 共 42 个 provider，无 sensenova；1.2 相对 0.85 有目录增删）。真实调用经 `resolveModel`/`resolveL2Model` 的三层解析：configured-namespace → 目录扫描（仅采 `api === 'openai-completions'` 条目，借其 metadata 仅覆写 provider/baseUrl）→ 保守字面量（openai-completions + deepseek thinkingFormat）。**机制层面 READY**；真实连通性（鉴权、工具调用、json_schema 支持）属模型面证据，只能在授权执行时产生——这正是不授权时 AC-6 不能记 PASS 的原因之一。
- 自定义 fetch 传输面：`getPiAiFetchForApi`（注册 I/O seam `pi-ai-http-transport`）对 openai-completions 返回专用 undici transport（300s cap 禁用）；Google 系拒绝集合不含 openai-completions。

### 1.3 本轮新增的 AC-6 设施（仅当现有设施不足时的最小补充）

既有 real-llm 测试（`dreamer/scribe/philosopher-runner-real-llm` + `full-chain`）走 **v2 Runner + One-shot**，不覆盖 SPEC AC-6 点名的 L2 agent loop 场景与 json_schema 确定性路径。最小补充 4 文件（`packages/principles-core/src/runtime-v2/adapter/__tests__/`）：

| 文件 | 作用 |
|---|---|
| `pi12-ac6-harness.ts` | 线缆观测 harness：包装**真实** `getPiAiFetchForApi`（同一 undici 路径，真实 HTTP 双向，零 stub），逐请求计数、发送前硬上限（超限抛错保护授权预算）、redact 快照（roles/工具名/`tool_choice`/`response_format`；**header 值永不读取**，仅记 Authorization 存在性；预览有界） |
| `pi12-ac6-dreamer-real-llm.test.ts` | B1：Dreamer L2 真实全链 |
| `pi12-ac6-artificer-real-llm.test.ts` | B2：Artificer L2 真实治理链 |
| `pi12-ac6-oneshot-real-llm.test.ts` | B3：One-shot json_schema 确定性路径 |

三文件均为 `describe.skipIf(!config)`——**无授权开关时默认跳过，零费用**。每场景恰 1 个完整用例、独立裁决，无汇总。

## 2. 三个 E2E 场景的独立验收记录（授权执行时按此判定）

### 2.1 B1 Dreamer（`dreamer_l2_submit_output`）

- 装配：生产 `L2AgentLoopAdapter`，`l2FallbackToL1:false`、`maxEmptyRetries:0`（关闭一切自动重试/回退）、`maxTurns:5`、budget=`timeoutMs`(120s)、只读 reader deps（零存储）。
- 判定项：输出过 `Value.Check(DreamerOutputV1Schema)`；`dreamer_l2_complete` telemetry `usedFallback=false`/`timedOut=false`；线缆级断言——每请求首条 `system`（含分层标记 + `--- Tool protocol (L2 mode) ---`）、`user` 全程恰一次、工具声明含 `read_principles/read_artifact/submit_output`；SystemMessage 完整传达、UserMessage 不重复、submit 捕获后 loop 终止（finishTurn `{action:'end'}`），无 submit 后额外请求。
- 硬上限 3 请求。

### 2.2 B2 Artificer（`artificer_l2_validate_replay_submit`）

- 装配：生产 `ArtificerL2Adapter` + **真实 `createProductionGateDeps()`**（禁则检查→return-shape 静态检查→hardened vm 沙箱回放）+ **真实 `DefaultArtificerValidator`**（submit 前强制校验，模型无法绕过——绕过即捕获失败）。`maxTurns:8`、budget=2×timeout、无 L1 回退（PRI-439 设计不变式）。
- 判定项：四工具全链 telemetry（`read_rulecode_spec→validate_rulecode→replay_rulecode→submit_rulecode`）；输出过 `ArtificerRuleOutputSchema`；PRI-795 evidence（elapsedMs/tokenUsage）由生产适配器浮出；线缆同 B1 断言；**不写生产 RuleCode/激活记录**（适配器全内存，隔离 golden trace）。
- 硬上限 6 请求。

### 2.3 B3 One-shot（`oneshot_json_schema`）

- 装配：生产 `PiAiRuntimeAdapter`，`outputPathStrategy:'json_mode_first'`（既有生产策略，确定性选中 PRI-559 json_schema 路径）、`maxRetries:0`。
- 判定项：线缆实测 `response_format:{type:'json_schema',json_schema:{...}}` **真实到达 HTTP 请求**（onPayload 改写只发生在 per-API HTTP 适配器内——faux 盲区，audit R1 的正面对证）；消息形状 [system,user]；无工具声明；输出过 `DiagnosticianOutputV1Schema`；`runtime_invocation_succeeded` telemetry。Timeout/Provider 错误映射由既有 139 用例契约套件锁定（真实错误注入不做——预算纪律）。
- 硬上限 3 请求。

### 2.4 生产状态零写入证明

- 三场景全部 **adapter 级**：运行态在适配器内存 `Map`；L2 测试零磁盘（连临时 SQLite 都不建——B1/B2 只读 reader、内存 emitter）；`StoreEventEmitter` 为纯 Node EventEmitter（无持久化汇）。
- 预检环境对照：生产工作区 state.db 快照（只读复制到 `.tmp/pi12-phase3/`）在预检前后无需变化——本轮对 `D:\.openclaw\workspace`、`~/.pd/**` 仅读不写；未重启 Console/Gateway；未触碰 `~/.pd/runtime`。
- 零费用证明：无开关环境实测新测试 **3 skipped**（vitest 输出），无任何网络出口；spike 214 例全 faux。

## 3. 实际调用次数、Token、费用与耗时

**付费 Provider 请求：0 次；Token：0；费用：0 元/$；耗时：无（未发起）。**
授权执行时按 harness 汇总行（`[ac6-b1/b2/b3-summary]`：requests/hardCap/durationMs/tokenUsage）与报告模板回填；B2 token/耗时由生产 evidence 块提供，B1/B3 token 生产遥测未浮出（如实披露，不编造）。

## 4. 工具执行及终止条件

- 终止：submit 捕获 → finishTurn `{action:'end'}`（B1/B2）；轮上限（B1=5/B2=8）；预算 timer→AbortController（`totalBudgetMs`）；每请求 timeout 120s（`AbortSignal.timeout` 经 `SimpleStreamOptions.timeoutMs`）；线缆硬上限**发送前**抛错（B1=3/B2=6/B3=3）；vitest 用例超时（150s/300s/150s）。
- 工具白名单双层防御（loop 级 `beforeToolCall` + 工具集白名单）由既有契约测试锁定；B2 的 validator/replay 为生产组件非测试替身。
- PD 侧 `maxRetries:0`（库内）+ AC-6 场景显式关闭自管重试（`maxEmptyRetries:0`、无 runWithRetry）→ 隐式调用面为零；全部 HTTP 经单一 wrapper 计数（含任何未来重试路径）。

## 5. 真实模型授权依据与预算使用情况（NOT_RUN 原因）

**任务书 §五明令：任务书本身不构成授权。** 本轮在任务开始时对全部可得授权源做了核验：

| 授权源 | 结果 |
|---|---|
| 任务书内建授权建议（≤12 请求/≤$1 等） | 明文"仅供 Owner 批准，不是默认授权" |
| SPEC v0.2 §5/§12 | AC-6 需 Owner 授权执行或 OWNER_WAIVED；生产切换硬门 |
| Phase 2 报告 §4/§11.5 | NOT_RUN，解锁条件待 Owner |
| 私有文档（principles-private specs/plans/runbooks/okr 全量 grep：真实模型/付费调用/费用上限/LLM_E2E） | 无 PI12/AC-6 授权记录（仅无关命中：RuleHost ADR 修订、ERR 手册技术条目） |
| Linear（近 25 张更新工单全文+PRI-1015 详情） | 无 Pi 1.2/AC-6 工单；PRI-1015 的授权是另一任务（RuleCode/Codex V2）的会话内授权，明示不覆盖本任务 |
| 环境变量 | `LLM_E2E_*` = 0 个；`SENSENOVA_API_KEY` 存在（仅记存在性，未读取值） |

**结论：无含 Provider/模型/测试范围/请求数/费用上限的 Owner 授权记录 → 不设 `LLM_E2E_ENABLED`、不动用 key、不自行宣布 OWNER_WAIVED；按任务书完成测试代码、预检与 Faux 回归，AC-6 维持 NOT_RUN。**

预算框架（授权就绪形态，已固化在测试内）：每场景 1 次完整执行、总硬上限 3+6+3=12 请求（发送前强制）、只走既有低成本 provider（sensenova/deepseek-v4-flash）、一切自动重试关闭、超时/预算/异常立即终止、不使用真实私人历史数据（golden trace/诊断输入均为合成）。Token 单价不在仓库内，报告以请求次数+token 计数披露，请求次数由发送前硬上限保障；费用不能仅由请求次数保证，仍须 Owner 基于指定模型的输入/输出价格、上下文规模与单次输出上限核准。当前测试无实时美元费用熔断，不得宣称 1 USD 硬门已满足。

## 6. 修复对应的代码与回归测试

**无生产代码修复**（Phase B 未执行 → 无 Pi 1.2 真实回归可触发；Phase C 按任务书仅"如果真实测试发现回归"才启动，条件未成立）。

新增代码全部为测试面（§1.3 四文件），其自身验证：

| 验证 | 结果 |
|---|---|
| `tsc --noEmit`（core 全包） | 0 error（退出码 0） |
| eslint（4 新文件） | 0 problem |
| 无开关运行 3 新文件 | 3 skipped（零费用门生效；退出码 0） |
| spike+契约 7 文件 faux 回归 | 214/214 PASS（退出码 0），与 Phase 2 两轮逐套件一致 |

## 7. 实际测试退出码、CI 状态

- 本地（隔离 worktree，Pi 1.2.0）：上表四项全绿，退出码均为 0。
- 合并门禁：**`npm run verify:merge` 于本 PR head（amend 后）本地执行 exit 0**（全链：Release Intent Guard / generated-artifacts / error-handbook / telemetry strict / repo-hygiene / runtime-contract / docs-structure / security-baseline / workspace-tools / guard-contracts / release-target-matrix / core build / website / lint / 全仓 build / pipeline-contract / pd-cli+pd-console build / workspace-artifacts / release-artifact-hygiene / 四包 typecheck / satellite-bundle-deps / runtime-writers）。首跑曾 FAIL 1 项（check:runtime-contract ERR-001：harness 对 `JSON.parse` 结果使用 `as` 断言，rc-2 违规）——已改为结构性类型守卫 `asPlainRecord`（逐成员重建 plain record）后复跑 exit 0；该修复即本报告 §6 所述"新增代码自身验证"的一部分。
- PR CI：**PENDING（截至本报告定稿）**——以 `gh pr checks` 与 PR 页面实际状态为准，不冒称全绿。

## 8. 当前生产部署裁决：KEEP（维持）

维持 Phase 2 的 CONDITIONAL GO / KEEP：

1. 安装面（2.3.7/1.2.0 七模块一致）、服务面、隔离回归（308 两轮 + 本轮 214 入口复跑）无回归证据；
2. 升级后插件/证据面持续有真实流量（本轮复取：378 条、五会话、**仍 100% `submitted/attempted`**——投递尝试留痕，非遵循/改善证据）；
3. 无任何升级引入的 P0/P1 证据；回滚链完整在位未动。
KEEP 不代表 AC-6 已过。生产切换前仍须（SPEC §12）：AC-6 → PASS 或 OWNER_WAIVED；Pi 模型面首流量复核；干净环境安装干跑；Owner 审批。

## 9. 尚缺少的真实 IAER Pilot 证据（维持 NOT_RUN）

- 生产 Pi 1.2 模型路径（L2 Dreamer/Artificer 真实推理→Evaluator）零活动样本——机器升级后无 host 管线流量，插件证据面不经 Pi 模型；
- 存量 artificer 任务 **pending 37 / failed 83** 为升级前已知积压：本轮不恢复、不处理、不改写生产队列（任务书 §七）；作为独立后续事项保留（Owner 经 Console failed-tasks/单任务恢复面处置，或随 IAER Pilot 授权一并安排）;
- Pilot 解锁前置不变：Owner 授权 + 可消费任务。

---

## 10. 交付物清单（本 PR）

| 类别 | 文件 |
|---|---|
| 测试（AC-6 授权就绪形态） | `packages/principles-core/src/runtime-v2/adapter/__tests__/pi12-ac6-harness.ts`、`pi12-ac6-dreamer-real-llm.test.ts`、`pi12-ac6-artificer-real-llm.test.ts`、`pi12-ac6-oneshot-real-llm.test.ts` |
| 文档 | 本报告；`SPEC-PD-PI12-COMPAT-001-phase2-post-upgrade-20261018.md`（入库 + 两处勘误，勘误处有行内标注） |
| 变更声明 | `.changeset/` 空 changeset（显式 no-release：纯测试+文档，无生产代码变更） |

生产代码改动：**0 行**。


## 11. Review Fix (verified against Pi v1.2.0)

Scope: AC-6 tests and report only; no production runtime or credential changes.

- Pi Chat Completions serializes messages as objects with role and content.
  Previously the AC-6 observer passed a whole message into a string/array-only
  helper and returned undefined. Correctly traverse the message content field.
- Artificer AC-6 now requires ordered, successful read/validate/replay/submit,
  rechecks final code with the real static validators, and replays the submitted
  code and trace through the production VM gate. A validate tool event with
  ok=true means execution completed; it does NOT imply static result VALID.
- Pi may append up to two corrective user messages. The test checks that the
  original user task occurs once while allowing bounded follow-up instructions.
- Artificer and One-shot tests now set 4096/1024 output-token ceilings.
  Dreamer has no exposed maxTokens config on its adapter and remains dependent
  on the SDK/model ceiling. The per-test 3/6/3 HTTP request caps are real
  hard caps, but they are NOT USD spending caps. Provider-specific prices and
  the total worst-case cost must be reviewed by Owner before any paid run.
  No realtime dollar-budget breaker exists in this PR.
- Five offline harness tests cover message-object and multimodal content,
  follow-up messages, bounded/redacted observations, and pre-send request cap.

AC-6 real-provider E2Es remain NOT_RUN. This Review Fix neither grants paid
model authorization nor waives production gates.

## 12. Review Fix verification (2026-10-18)

Changed files: three AC-6 test fixtures/harness modules, one additional
offline harness test file, and this implementation report. Production code:
zero lines changed.

- Core typecheck: PASS, exit 0.
- Targeted ESLint: PASS with --max-warnings 0.
- Offline Pi 1.2 spikes + new harness suite: 19/19 PASS (14+5).
- Three real-provider suites without Owner switch: 3 SKIPPED, exit 0.
- Full npm run verify:merge: PASS, exit 0; pre-existing repository-wide
  lint warnings in unrelated files do not affect this pass.
- All tests in this Review Fix were offline; no paid provider requests.

The earlier four-test-file count refers to the initial PR. This fix adds a
fifth test file, pi12-ac6-harness.test.ts. Real AC-6 remains NOT_RUN.
