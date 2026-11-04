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
| 1b | **累计 HEAD（块 4 修测试后）** | `3bb70c16d` | C1–C8b + P（同一命令、同一断言；前台分批，副本 `.tmp/gfi-removal/current-head4` 独立 `npm ci` + build，含 `.git` 隔离标记） | 40 文件 / 571 用例 / 0 失败 | 40 文件 / **568** 用例 / **568 通过 / 0 失败**；schema v2、gfi 列 0、INSERT 回读 1 行成功 | **-3 用例，0 失败** | 允许差异①：`llm-pain-source-retirement.test.ts` 的 GFI differential pin（describe 3 例）随 llm.ts GFI 健康度分支删除而移除（删除层 `dcf53fba1`；SPEC §3.5，§7.1 明确要求删除 GFI 专属测试与 fixture）。其余各组与基线逐项等量：C1 46、C2 35、C3 94、C4 10、C5 175、C6 50、C7 18（21−3）、C8 140 | **通过** |
| 2 | L1 core（`runtime-v2/gfi/` 删除、schema/migration） | `4b3ea5421` | setup+build（C1–C8b 未跑） | build 通过 | **build exit=1** | — | 前缀不可构建：core `operator-health-read-model.ts:16` 仍 import 已删的 `./gfi/gfi-read-model.js`（由 L11 `7c1325ea6` 修）、`golden-trace.ts:218` 仍带 `currentGfi`（由 L14 修）、plugin `session-tracker.ts` 仍 import 8 个已删导出（由 L2 修） | **NOT_RUN（前缀不可构建）** |
| 3 | L2 session tracker | `31a60e1e5` | setup+build | build 通过 | **build exit=1** | — | 同 L1（core 侧三处消费方未改；plugin 侧 `session-tracker` 本层已改） | **NOT_RUN（前缀不可构建）** |
| 4 | L3 tool execution | `b7c17a692` | setup+build | build 通过 | **build exit=1** | — | 同 L1（errors: golden-trace / index.ts `SignalClassificationOutputV2*` / operator-health） | **NOT_RUN（前缀不可构建）** |
| 5 | L4 manual pain | `fa86f0943` | setup+build | build 通过 | **build exit=1** | — | 同 L1 | **NOT_RUN（前缀不可构建）** |
| 6 | L5 LLM/prompt hook | `dcf53fba1` | setup+build | build 通过 | **build exit=1** | — | 同 L1 | **NOT_RUN（前缀不可构建）** |
| 7 | L6 correction detection (core) | `782bf8aca` | setup+build | build 通过 | **build exit=1** | — | `index.ts` 的 V2 导出已由本层修；还剩 `golden-trace.ts:218` currentGfi（L14）与 `operator-health-read-model.ts:16` gfi-read-model（L11） | **NOT_RUN（前缀不可构建）** |
| 8 | L7 correction detection (host/plugin) | `13c067e2f` | setup+build | build 通过 | **build exit=1** | — | 同 L6 | **NOT_RUN（前缀不可构建）** |
| 9 | L8 correction detection (triage) | `972664050` | setup+build | build 通过 | **build exit=1** | — | 同 L6 | **NOT_RUN（前缀不可构建）** |
| 10 | L9 rule host | `2bae37491` | setup+build | build 通过 | **build exit=1** | — | `golden-trace.ts` 已修；还剩 `operator-health-read-model.ts:16-18` import 已删的 `./gfi/{gfi-read-model,gfi-types}.js`（L11） | **NOT_RUN（前缀不可构建）** |
| 11 | L10 event log | `36968fac4` | setup+build | build 通过 | **build exit=1** | — | 同 L9 | **NOT_RUN（前缀不可构建）** |
| 12 | L11 operator health | `7c1325ea6` | setup+build | build 通过 | **build exit=1** | — | core 已可编译；阻塞转移到 plugin `src/commands/pain.ts:1` 仍 import 已删的 `resetFriction`、`:139` 仍读 `currentGfi`（由 L14 `3433204a1` 修） | **NOT_RUN（前缀不可构建）** |
| 13 | L12 pd-cli | `8acd1027d` | setup+build | build 通过 | **build exit=1** | — | 同上（core 可编译，plugin `commands/pain.ts` 仍阻塞） | **NOT_RUN（前缀不可构建）** |
| 14 | L13 pd-console | `603af28d4` | setup+build | build 通过 | **build exit=1** | — | 同上 | **NOT_RUN（前缀不可构建）** |
| 15 | L14 /pd-status | `3433204a1` | setup+build | build 通过 | **build exit=0** | — | 首个全绿前缀；测试未跑（块内按规则停在 L1，且该层测试树早于块 4 的 5 条修测试） | **NOT_RUN（测试未执行）** |
| 16 | L15 flags/config + shipped template | `c7ab619e9` | setup+build | build 通过 | **build exit=0** | — | 同上 | **NOT_RUN（测试未执行）** |
| 17 | L16 schema/migration | `62e2cab15` | setup+build | build 通过 | **build exit=0** | — | 同上 | **NOT_RUN（测试未执行）** |
| 18 | L17 tests/fixtures | `f00c62f86` | setup+build | build 通过 | **build exit=0** | — | 同上 | **NOT_RUN（测试未执行）** |
| 19 | L18 docs | `60c44a346` | setup+build | build 通过 | **build exit=0** | — | 同上；该层生产代码 = 累计 HEAD，测试结果已在 1b 行实测（568/568） | **NOT_RUN（测试未执行，结果见 1b）** |

---

## 块 5 前置实测：18 个层前缀能否构建（决定「逐层对照」是否可执行）

> 逐层对照的前提是「该层 commit 的完整树能 build，否则测试无意义」。本前置实测直接判定该前提。

**方法（实测，非推断）**：用同一个副本 `.tmp/gfi-removal/current-L1`（自带 `node_modules` + `.git` 隔离标记），按 18 个 commit 的**升序**逐个 `git archive <sha> -o L<n>.tar` → `tar -x -f … -C current-L1` 覆盖 → `npm run build --workspace=@principles/core --workspace=@principles/install-layout --workspace=@principles/host-runtime --workspace=principles-disciple`，逐层记 `$LASTEXITCODE`。
（升序覆盖是安全的：某层删除的文件在更早的层已经不在盘上，不会残留。）

**命令**：

```powershell
& .tmp/gfi-removal/probe-prefix-build.ps1 -From 2  -To 7
& .tmp/gfi-removal/probe-prefix-build.ps1 -From 8  -To 13
& .tmp/gfi-removal/probe-prefix-build.ps1 -From 14 -To 18
```

**证据**：`.tmp/gfi-removal/prefix-build-verdicts.log`（逐层 `build_exit` + 首个 `error TS`）与 `.tmp/gfi-removal/L1-build.log` … `L18-build.log`。

**实测结果**：

| 层范围 | 层数 | build exit | 结论 |
| --- | --- | --- | --- |
| L1–L13 | 13 | **全部 =1** | 前缀不可构建 → C1–C8b 无法执行 |
| L14–L18 | 5 | **全部 =0** | 可构建（其中 L16–L18 生产代码与累计 HEAD 相同） |

**为什么不可构建（三个未闭合的跨层消费方）**：

1. `packages/principles-core/src/runtime-v2/operator-health-read-model.ts:16-18` 仍 `import './gfi/gfi-read-model.js'`、`'./gfi/gfi-types.js'`，而 `runtime-v2/gfi/` 在 L1 已删——该文件直到 **L11 `7c1325ea6`** 才改。
2. `packages/principles-core/src/runtime-v2/golden-trace.ts:218` 仍依赖 `currentGfi` 必填签名——直到 **L14 `3433204a1`** 才改；L6 之前 `index.ts:2244/2269` 还导出已删的 `SignalClassificationOutputV2*`。
3. `packages/openclaw-plugin/src/commands/pain.ts:1/:139` 仍 `import resetFriction` / 读 `currentGfi`——直到 **L14 `3433204a1`** 才改。

**判定**：这是**构建顺序依赖**（18 个 commit 按「删除域」切分，被删符号的消费方在更靠后的层才处理），**不是能力退化**。最终树（= L18 生产代码 = 累计 HEAD `3bb70c16d`）已实测 **40 文件 / 568 用例 / 568 通过 / 0 失败**（1b 行）。

**因此**：块 5 原定的「L1–L18 每层前缀跑测试」在该 commit 序列上**没有可执行的语义**（L1 起 13 层无法 build）。已按「任一层不通过即停在该层」规则停在 L1，等待 Owner 裁定替代验证方法（候选见 HANDOFF §3）。

---

## 累计 HEAD 失败明细（5 条，全部为「测试未随生产层更新」）

| # | 用例（文件:行） | 基线实际 | 当前实际 | 应做成什么 | 归属层 / commit | SPEC 审计背书 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `tests/core/event-log.test.ts:87` > `EventLog > DailyStats > should have correct DailyStats structure` | `stats.gfi` 为对象（samples/total/peak） | `stats.gfi === undefined`（`AssertionError: expected undefined to be defined`） | 删除该断言（`DailyStats.gfi` 已按设计移除）；不删其它 stats 断言 | L10 `36968fac4` | 审计表 #24（`DailyStats.gfi` 聚合删除，SPEC §4.1） |
| 2 | `tests/hooks/gate-block-trajectory-persistence.test.ts:395` > `T8: session GFI tracking failure degrades with reasonCode, persistence unaffected` | 警告含 `gfi_track_failed` | 警告含 `block_track_failed`（`expected '…Session block tracki…' to contain 'gfi_track_failed'`） | 断言改为 `block_track_failed`（reasonCode 不得再命名已删除机制）；T8 的降级语义保留 | L9 `2bae37491` | 审计表 #21 语境 + SPEC §2.1「评分删、事实留」；理由码属 GFI 专属命名 |
| 3 | `tests/hooks/gate-legacy-contract-compatibility.test.ts:213` > `Test B: compatibility block does NOT increase GFI / block tracking` | `session.currentGfi === 0` | `undefined`（`expected undefined to be +0`） | 删除 `currentGfi` 断言；保留「block 只做 blockedAttempts 事实、不产生 Pain」语义 | L2 `31a60e1e5` | 审计表 #21（`RuleHostInput.session.currentGfi` 删除，SPEC §3.8） |
| 4 | `tests/hooks/gate-b-only-runtime-guard.test.ts:62` > `Owner-driven paths still reach the TriggerController` | `llm.ts` 含 `evaluateTriggerController` | `llm.ts` 不再含该符号（GFI 健康度路径已删） | 该断言只保留 `pain.ts`（Owner 手动路径）；删除 `llm.ts` 断言 | L5 `dcf53fba1` | 审计表 #15（`hooks/llm.ts` highGfiThreshold/currentGfi 分支删除，SPEC §3.5） |
| 5 | `tests/hooks/llm-pain-source-retirement.test.ts:161` > `GFI crossing the high threshold keeps its health-side pain writes` | `recordPainSignal` 调用 1 次 | 调用 0 次（`expected "vi.fn()" to be called 1 times, but got 0 times`） | 删除该用例（其前提「GFI 分支行为不变」已失效）；保留其它 Pain 来源退休断言 | L5 `dcf53fba1` | 审计表 #15（同 #4）；SPEC §7.1「GFI 专属测试与 Fixture」须删除 |

## 块 4 判定台账（5 条过期断言，先判定后改测试）

> 每条先答三问：① 原本保护什么（防哪种退化）；② 现在由谁承担（a/b/c）；③ 判定与删改一致。
> 约束：本块只改测试，不改生产代码；不 skip / 不 todo / 不注释掉断言来变绿；一条一个 commit。

| # | 用例 | ① 原本保护什么 | ② 现在由谁承担（a/b/c + 证据） | ③ 判定与改动 | commit |
| --- | --- | --- | --- | --- | --- |
| 1 | `tests/core/event-log.test.ts:87` | `DailyStats` 结构契约里含 GFI 日聚合（防止日统计聚合被静默删掉/漏生成） | **(b) 保护对象已不存在**：`DailyStats` 接口/schema 已无 `gfi`（`event-types.ts:1065-1106`）；删除层 `36968fac4`。读端实测为 0：`commands/pain.ts:128` 只取 `tools/hooks/evolution`，event-log 内部聚合无 gfi，`packages/pd-console/src` 无 gfi 使用 | 删 `expect(stats.gfi).toBeDefined()`，留原位置注释说明字段已删 + 读端为空；其余 `tools/toolCalls/errors/evolution/hooks` 断言不动 | `2b23c0d60` |
| 2 | `tests/hooks/gate-block-trajectory-persistence.test.ts:395` | tracker 抛错时降级**可观测**（带 reasonCode 的 warn）且轨迹行/事件日志仍落库（rc-9 + never-throws） | **(c) 保护仍需要且仍被承担**：生产 `gate-block-helper.ts:112` 输出 `reasonCode=block_track_failed`，改名层 `2bae37491` | 断言字符串改为 `block_track_failed`；用例标题与 fixture 名去 GFI（`s-gfi`→`s-block-track`）；`toHaveBeenCalledWith`、轨迹行数、`gate_block` 事件断言全部保留 | `28431f526` |
| 3 | `tests/hooks/gate-legacy-contract-compatibility.test.ts:213/219` | compatibility guard 产生的 block **不进入行为证据链**：不涨 friction、不涨 blockedAttempts、不产出 gate_block | **(b)** `SessionState.currentGfi` 已删（`31a60e1e5`）；`RuleHostInput.session.currentGfi` 同属该字段删除（审计 #21 / SPEC §3.8）。同测试中 `blockedAttempts===0` 与「无 gate_block 事件」仍在原位承担该保护 | 删两处 `currentGfi` 断言 + `RuleHostInput` fixture 里的 `currentGfi: 0`；`blockedAttempts` 两处与 `gate_block` 零事件断言原样保留 | `cc23ee008` |
| 4 | `tests/hooks/gate-b-only-runtime-guard.test.ts:62` | 只有 Owner 驱动路径能到 Gate B TriggerController；自动/失败路径不得进入 | **(a)+(b) 混合**：(a) TriggerController **仍在生产路径**——唯一非测试调用点为 `pain.ts:31`（import）+ `pain.ts:450`（`handleManualPain` 内调用），全仓 `packages/*/src` grep 无第二个调用者，故 `pain.ts` 断言保留并注明真实调用点；`llm.ts` 半条为 (b)：GFI 健康度路径 `dcf53fba1` 删除（审计 #15 / SPEC §3.5），`llm.ts` 已无该符号 | 保留 `pain.ts` 断言（迁注到 `:450` 真实调用点）；删 `llm.ts` 半条；头部 docstring 去掉「llm.ts GFI health path」并说明这是设计内移除；`DUAL_GATE_HOOKS` 三项的 Gate A/flag 负断言不动 | `e88511955` |
| 5 | `tests/hooks/llm-pain-source-retirement.test.ts:161`（describe 3 例） | 用差分 pin 冻结当时 GFI 分支的 pain 写入（score clamp 60、`user_empathy`、canonicalPainId、evidence_only 不入 Gate B），防止 Phase 0 顺手改坏 GFI | **(b) 保护对象已不存在**：`llm.ts` 的 GFI 健康度分支 `dcf53fba1` 删除（审计 #15 / SPEC §3.5）；SPEC §7.1 明确要求删除 GFI 专属测试与 fixture。同文件 `Semantic Confusion / empathy tag / LLM Paralysis` 三条退休断言仍在承担非 GFI 保护 | 删整个 GFI differential pin describe（3 例）+ `currentGfi` fixture 三处；用例 7→4；保留断言逐条未动 | `4264d847d` |

**块 4 结论**：5 条均判定为「测试未随生产层更新」，**无一条是能力退化**；其中 #4 的 TriggerController 有实测生产调用点证据。改动仅测试文件（5 个），未动生产代码。

---

## 不变量的实测通过项（累计 HEAD `0bb1bcc1e`，块 4 修复前）

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

**2026-11-04 / 块 5 前置实测（18 层前缀可构建性）**
- 命令：`probe-prefix-build.ps1 -From 2 -To 7 / -From 8 -To 13 / -From 14 -To 18`（前台，逐层 `$LASTEXITCODE`）。
- 结果：**L1–L13 build exit=1（13/18 不可构建）；L14–L18 build exit=0（5/18 可构建）**。逐层首个 `error TS` 见 `.tmp/gfi-removal/prefix-build-verdicts.log`。
- 根因：18 个 commit 按「删除域」切分，三个跨层消费方（core `operator-health-read-model.ts` → L11、core `golden-trace.ts` → L14、plugin `commands/pain.ts` → L14）在更靠后的层才闭合。
- 结论：**不是能力退化**；原定「每层前缀跑 8 组」对 L1–L13 无执行语义。按规则停在 L1，等待 Owner 裁定替代方法。
- 下一步（待裁定后执行）：见 `.tmp/gfi-removal/HANDOFF.md` §3 的候选 A/B/C。
