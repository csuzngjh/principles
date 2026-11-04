# GFI 移除 —— 回归对照台账（Layer-by-layer Regression Ledger）

> 规则：每推进一层改动，用 `docs/reports/GFI_BEHAVIOR_BASELINE.md` 的同一组观测跑一次；
> 记录「层 → 命令 → 基线值 → 当前值 → 差异 → 差异原因 → 判定」。
> **任何一条不变量不通过 → 停在该层，禁止叠加下一层。**
> 允许差异只有两类：① 被移除对象自身的断言（如 `gfi_before/gfi_after`、`stats.gfi`），且必须点名
> 「哪个用例、为什么该消失、由哪条 SPEC 结论背书」；② 已记录的既有环境失败。
> **说不清原因的数量减少 = 不通过。**

基线提交：`35d12815bc08e509c6e54fd908d0ae22b1395d2a`
基线副本：`.tmp/gfi-removal/baseline-35d12815bc`（自带 `node_modules` + `.git` 隔离标记）
被测副本（累计 HEAD）：`.tmp/gfi-removal/current-0bb1bcc1e`（同样加 `.git` 标记）
观测口径：8 条不变量（I1–I8），40 个测试文件，571 个用例

### 观测组（同一命令、同一断言，不得改动）

| 组 | 命令（cwd=对应 package） |
| --- | --- |
| C1 | plugin: `npx vitest run tests/hooks/pain.test.ts tests/hooks/pain-funnel-ingress.test.ts tests/commands/samples-reject-no-pain.test.ts` |
| C2a | core: `npx vitest run src/runtime-v2/evidence-triage/__tests__/trigger-controller.test.ts` |
| C2b | plugin: `npx vitest run tests/hooks/trigger-cooldown-tracker.test.ts tests/internalization-auto-consumer-gate.test.ts` |
| C3a | core: `npx vitest run src/runtime-v2/__tests__/trajectory-store.test.ts src/runtime-v2/__tests__/trajectory-schema.test.ts` |
| C3b | plugin: `npx vitest run tests/core/trajectory.test.ts tests/core/trajectory-store-round-trip.test.ts tests/hooks/trajectory-collector.test.ts` |
| C4 | plugin: `npx vitest run tests/core/pd-task-reconciler.test.ts` |
| C5 | core: `npx vitest run src/runtime-v2/__tests__/pain-chain-read-model.test.ts src/runtime-v2/__tests__/pain-recall-*.test.ts src/runtime-v2/runner/__tests__/pain-signal-bridge-*.test.ts src/runtime-v2/__tests__/pain-signal-bridge-*.test.ts`（实际 12 个文件，名单见基线文档 §3） |
| C6a | plugin: `npx vitest run tests/core/event-log.test.ts tests/hooks/gate-block-trajectory-persistence.test.ts tests/hooks/gate-legacy-contract-compatibility.test.ts` |
| C6b | core: `npx vitest run src/runtime-v2/__tests__/append-event-log-line.test.ts` |
| C7 | plugin: `npx vitest run tests/hooks/gate-b-only-runtime-guard.test.ts tests/hooks/lifecycle-fatal-intercept-no-pain.test.ts tests/hooks/llm-pain-source-retirement.test.ts` |
| C8a | plugin: `npx vitest run tests/core/reflection-context.test.ts tests/core/rule-context-assembler.test.ts tests/core/workspace-context.test.ts tests/core/workspace-context-factory.test.ts tests/core/workspace-context-state-dir.integration.test.ts tests/bdd/pd-context-receipt.steps.test.ts` |
| C8b | core: `npx vitest run src/runtime-v2/store/context/resilient-context-assembler.test.ts src/runtime-v2/store/context/sqlite-context-assembler.test.ts src/runtime-v2/config/__tests__/pd-config-context-injection.test.ts` |
| P | 副本根：`node probe-*-schema.mjs`（tool_calls/gate_blocks 实际列） |

---

## 台账

| # | 层名 | commit | 命令 | 基线值 | 当前值 | 差异 | 差异原因 | 判定 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | **基线** | `35d12815bc` | C1–C8b + P | 40 文件 / 571 用例 / 0 失败；schema v1、gfi 列 2 | 同左 | — | — | **基准** |
| 1 | **累计 HEAD** | `0bb1bcc1e` | C1–C8b + P（同一命令，副本独立安装/build） | 40 文件 / 571 用例 / 571 通过 | 40 文件 / 571 用例 / **566 通过 / 5 失败**；schema v2、gfi 列 0；手动 Pain 实际值一致 | **-5 通过** | 5 个用例仍断言已删除的 GFI 行为；测试未随生产层更新（详见下方失败明细）。不是能力退化，但**测试层未完成** | **不通过** |
| 2 | L1 core（`runtime-v2/gfi/` 删除、schema/migration） | `4b3ea5421` | — | — | — | — | 累计 HEAD 未通过，按规则未执行逐层 | NOT_RUN（阻塞） |
| 3 | L2 session tracker | `31a60e1e5` | — | — | — | — | 同上（静态归因：失败 #3 来自本层，未实测） | NOT_RUN（阻塞） |
| 4 | L3 tool execution | `b7c17a692` | — | — | — | — | 同上 | NOT_RUN（阻塞） |
| 5 | L4 manual pain | `fa86f0943` | — | — | — | — | 同上 | NOT_RUN（阻塞） |
| 6 | L5 LLM/prompt hook | `dcf53fba1` | — | — | — | — | 同上（静态归因：失败 #4/#5 来自本层，未实测） | NOT_RUN（阻塞） |
| 7 | L6 correction detection (core) | `782bf8aca` | — | — | — | — | 同上 | NOT_RUN（阻塞） |
| 8 | L7 correction detection (host/plugin) | `13c067e2f` | — | — | — | — | 同上 | NOT_RUN（阻塞） |
| 9 | L8 correction detection (triage) | `972664050` | — | — | — | — | 同上 | NOT_RUN（阻塞） |
| 10 | L9 rule host | `2bae37491` | — | — | — | — | 同上（静态归因：失败 #2 来自本层，未实测） | NOT_RUN（阻塞） |
| 11 | L10 event log | `36968fac4` | — | — | — | — | 同上（静态归因：失败 #1 来自本层，未实测） | NOT_RUN（阻塞） |
| 12 | L11 operator health | `7c1325ea6` | — | — | — | — | 同上 | NOT_RUN（阻塞） |
| 13 | L12 pd-cli | `8acd1027d` | — | — | — | — | 同上 | NOT_RUN（阻塞） |
| 14 | L13 pd-console | `603af28d4` | — | — | — | — | 同上 | NOT_RUN（阻塞） |
| 15 | L14 /pd-status | `3433204a1` | — | — | — | — | 同上 | NOT_RUN（阻塞） |
| 16 | L15 flags/config + shipped template | `c7ab619e9` | — | — | — | — | 同上 | NOT_RUN（阻塞） |
| 17 | L16 schema/migration | `62e2cab15` | — | — | — | — | 同上 | NOT_RUN（阻塞） |
| 18 | L17 tests/fixtures | `f00c62f86` | — | — | — | — | 同上 | NOT_RUN（阻塞） |
| 19 | L18 docs | `60c44a346` | — | — | — | — | 同上 | NOT_RUN（阻塞） |

---

## 累计 HEAD 失败明细（5 条，全部为「测试未随生产层更新」）

| # | 用例（文件:行） | 基线实际 | 当前实际 | 应做成什么 | 归属层 / commit | SPEC 审计背书 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `tests/core/event-log.test.ts:87` > `EventLog > DailyStats > should have correct DailyStats structure` | `stats.gfi` 为对象（samples/total/peak） | `stats.gfi === undefined`（`AssertionError: expected undefined to be defined`） | 删除该断言（`DailyStats.gfi` 已按设计移除）；不删其它 stats 断言 | L10 `36968fac4` | 审计表 #24（`DailyStats.gfi` 聚合删除，SPEC §4.1） |
| 2 | `tests/hooks/gate-block-trajectory-persistence.test.ts:395` > `T8: session GFI tracking failure degrades with reasonCode, persistence unaffected` | 警告含 `gfi_track_failed` | 警告含 `block_track_failed`（`expected '…Session block tracki…' to contain 'gfi_track_failed'`） | 断言改为 `block_track_failed`（reasonCode 不得再命名已删除机制）；T8 的降级语义保留 | L9 `2bae37491` | 审计表 #21 语境 + SPEC §2.1「评分删、事实留」；理由码属 GFI 专属命名 |
| 3 | `tests/hooks/gate-legacy-contract-compatibility.test.ts:213` > `Test B: compatibility block does NOT increase GFI / block tracking` | `session.currentGfi === 0` | `undefined`（`expected undefined to be +0`） | 删除 `currentGfi` 断言；保留「block 只做 blockedAttempts 事实、不产生 Pain」语义 | L2 `31a60e1e5` | 审计表 #21（`RuleHostInput.session.currentGfi` 删除，SPEC §3.8） |
| 4 | `tests/hooks/gate-b-only-runtime-guard.test.ts:62` > `Owner-driven paths still reach the TriggerController` | `llm.ts` 含 `evaluateTriggerController` | `llm.ts` 不再含该符号（GFI 健康度路径已删） | 该断言只保留 `pain.ts`（Owner 手动路径）；删除 `llm.ts` 断言 | L5 `dcf53fba1` | 审计表 #15（`hooks/llm.ts` highGfiThreshold/currentGfi 分支删除，SPEC §3.5） |
| 5 | `tests/hooks/llm-pain-source-retirement.test.ts:161` > `GFI crossing the high threshold keeps its health-side pain writes` | `recordPainSignal` 调用 1 次 | 调用 0 次（`expected "vi.fn()" to be called 1 times, but got 0 times`） | 删除该用例（其前提「GFI 分支行为不变」已失效）；保留其它 Pain 来源退休断言 | L5 `dcf53fba1` | 审计表 #15（同 #4）；SPEC §7.1「GFI 专属测试与 Fixture」须删除 |

## 不变量的实测通过项（累计 HEAD）

| 不变量 | 实际值 | 与基线比较 |
| --- | --- | --- |
| I1 手动 Pain | 46/46；syslog `outcome=manual_owner_admitted, score=100`；无 session `context_unbound` | **无差异** |
| I2 触发与去重 | 25/25 + 10/10 | **无差异** |
| I3 轨迹落库 | 17/17 + 77/77；schema v2；`tool_calls` 列集合 = 基线减去 `gfi_before,gfi_after`；插入/回读成功 | 允许差异（审计 #1 / SPEC §2.1） |
| I4 安全断路器 | 10/10 | **无差异** |
| I5 历史 Pain 读取 | 175/175 | **无差异** |
| I6 EventLog/轨迹 | `append-event-log-line` 2/2；plugin 45/48（3 失败见明细 #1–#3） | 失败 3 条（测试未更新） |
| I7 失败事实不产 Pain | 19/21（2 失败见明细 #4–#5） | 失败 2 条（测试未更新） |
| I8 Context 注入 | plugin 60/60 + core 80/80 | **无差异** |

---

## 隔离探针（累计 HEAD 副本）

- 从 `current-0bb1bcc1e/packages/openclaw-plugin` 向上解析 `.git`：`resolved_repo_root=D:\...\.tmp\gfi-removal\current-0bb1bcc1e` → **未回落到主工作区**。
- 对照证据：基线/当前副本都需该标记，否则 `gate-b-only-runtime-guard` 会读到实施 worktree 源码（已实测，见基线文档 §0）。

---

## 对照执行记录（逐次追加，不覆盖）

**2026-11-04 / 累计 HEAD `0bb1bcc1e`**
- 副本：`git archive HEAD` → `.tmp/gfi-removal/current-0bb1bcc1e`；`.git` 标记；`npm ci --prefer-offline`；build `@principles/core`/`@principles/install-layout`/`@principles/host-runtime`/`principles-disciple`。
- 命令：与基线完全相同的 C1–C8b + P。
- 结果：40 文件 / 571 用例 / 566 通过 / 5 失败（逐条见上表）。
- 结论：**不通过**（失败均为测试未随生产层更新，非核心能力退化）。按规则停止，未执行 L1–L18 逐层对照。
- 下一步：先补齐 5 条测试断言（独立块，≤15 文件），重跑累计 HEAD；通过后再逐层对照。
