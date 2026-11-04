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

## 为何不能用前缀对照（三个阻塞点各由哪层闭合）

> Owner 裁定要求本节写清：L1–L13 单独构建 exit=1 属于**按删除域分层的正常中间态**，不是能力退化。以下为逐层实测（`.tmp/gfi-removal/prefix-build-verdicts.log` + `L1-build.log`）。

**L1 前缀的 3 个阻塞点（`npm run build` exit=1 的首批报错）**

| # | 阻塞点（首个报错） | 出现层 | 由哪层闭合 | 闭合方式 |
| --- | --- | --- | --- | --- |
| B1 | `src/runtime-v2/golden-trace.ts(218,5)` TS2322：`currentGfi?: number` 不能赋给 `currentGfi: number` | L1–L8（L9 起该报错消失，但 golden-trace 尚未对齐） | **L14 `3433204a1`** | 该层把 `golden-trace.ts` 的 `currentGfi` 字段删除/对齐（golden-trace 的消费域属 L14） |
| B2 | `src/runtime-v2/index.ts(2244,3)` TS2724：`SignalClassificationOutputV2Schema` 未被导出 | L1–L5 | **L6 `782bf8aca`** | 该层完成 signal-collector V1→V2 契约切换与 barrel 导出 |
| B3 | `src/runtime-v2/operator-health-read-model.ts(16,71)` TS2307：找不到 `./gfi/gfi-read-model.js` | L1–L10 | **L11 `7c1325ea6`** | 该层删除 operator health 的 friction/GFI 项与其 import |

**时序上后出现的第 4 个阻塞点（L11 才暴露，同样属正常中间态）**

| # | 阻塞点 | 出现层 | 由哪层闭合 |
| --- | --- | --- | --- |
| B4 | `src/commands/pain.ts(1,10)` TS2305：`session-tracker` 无 `resetFriction` 导出；`pain.ts(139,35)` `currentGfi` 不在 `SessionState` 上 | L11–L13 | **L14 `3433204a1`**（同一层也闭合了 plugin `commands/pain.ts`） |

**为什么这是正常中间态，不是退化**

1. 18 层是**按删除域**切分（core 内核 → session → trajectory → hook → signal → host → triage → internalization → event-log → health → CLI → console → schema → guards → docs），不是按"每层可独立编译"切分。
2. 每次删除一个域，被删除符号的**跨域消费者**必然短暂悬空；这些消费者按设计在**更靠后的层**一起迁移。所以中间态编译失败只证明"删除顺序有跨层依赖"，不证明"能力丢失"。
3. 判据是**最终树**与**可构建前缀**：最终树 `3bb70c16d` 8 组 568/568；L14–L18 前缀实测 0 失败（见下抽测表）。若真有能力退化，最终树必然出现非"被测对象被删"类的失败——没有出现。

**因此**：对 L1–L13 不能用"每层前缀跑 8 组"作为判据（无执行语义）；改用下方 A 矩阵（层归属 + 具名用例 + 最终树实测）+ B 抽测（L14–L18 前缀实证）。

---

## 块 5 主方案 A：层归属矩阵（最终树 + 层归属，Owner 裁定 2026-11-04）

> 说明：因 L1–L13 前缀不可构建（见上节实测），本矩阵对每层给出「该层改了什么 → 谁在验它（具名）→ 实测值」。实测值来源：最终树 `3bb70c16d`（8 组 568/568）＋补充观测集（supp/supp2/supp3）＋ L14–L18 前缀抽测。**未标"实测"的单元格一律视为未实测**，不得读作通过。

| 层 | SHA | 该层实际改变的业务语义 | 检查组 / 具名用例或断言 | 实测 | 灰区 |
| --- | --- | --- | --- | --- | --- |
| L1 | `4b3ea5421` | 删除 core friction 内核（friction/decay/relief/stage/read-model/迁移） | C3a `trajectory-schema` 迁移用例（17/17）；随实现删除 77 条：`gfi-kernel.test.ts` 64 + `gfi-read-model.test.ts` 13（baseline 全过，final 文件已不存在） | C3a 17/17、C3b 77/77（L16 前缀实测 94） | 其消费方 `operator-health-read-model.ts` 由 L11 闭合 → 见 L11 行 |
| L2 | `31a60e1e5` | session tracker 去掉 `trackFriction/gfiBySource/currentGfi` | C6a `event-log.test.ts` → `should have correct DailyStats structure`（块 4 已删 `stats.gfi` 断言） | C6a 50/50（最终树） | **无独立用例**断言"session 不再累计 friction" → 归 ①（值不再被生产），风险见缺口 G4 |
| L3 | `b7c17a692` | tool execution 的 trajectory 记录去掉 friction 字段 | C3b `tests/core/trajectory.test.ts` → `aggregates daily metrics without multiplying user corrections`；C3a 17/17 | C3b 77/77（L16 前缀） | 无 |
| L4 | `fa86f0943` | 手动 Pain 删 `computePainScore` 与 friction 升级 | C1 `tests/hooks/pain.test.ts`（46 条）+ `samples-reject-no-pain.test.ts`；随实现删除 `tests/core/pain.test.ts`（baseline 1 条，目标函数本层已删） | C1 46/46（L14 前缀 + 最终树） | 无 |
| L5 | `dcf53fba1` | LLM/prompt hook 删 GFI 阈值与 health 注入、删 `attitude-directive.ts` | C7 `llm-pain-source-retirement.test.ts` → `empathy structured-tag text produces zero pain writes (detection path gone)`；随实现删除 `attitude-directive.test.ts` 14 条 | C7 18/18；prompt-builder 54→40（−14 具名见附录）0 失败 | `evaluateTriggerController` 真实调用点：`pain.ts:31` import / `pain.ts:450` call（gate-b 断言已迁移），非灰区 |
| L6 | `782bf8aca` | signal-collector 换 V2 契约、只保留 STRONG | supp2 `core-signal-collector` 72→69 | 69/69、0 失败；−3 具名见附录 | 无 |
| L7 | `13c067e2f` | host/plugin 删 WEAK(GFI) 路由与 `trackFriction` 累加 | supp2 `plugin-signal-collector-host` | **102 过 / 11 失败** | **新发现：11 条用例未随实现更新**（G1） |
| L8 | `972664050` | evidence-triage 退场 `gfi_threshold` 描述符 | supp2 `core-triage` 106→99 | 99/99、0 失败；−7 具名见附录 | 无 |
| L9 | `2bae37491` | rule host / internalization 契约去 GFI 字段 | supp2 `core-internalization`（`internalization-contracts`、`rule-host-evaluator`、`story-a-demo`） | 53/53 | 无 |
| L10 | `36968fac4` | event log 聚合去掉 GFI 统计 | C6a `event-log.test.ts`（`should have correct DailyStats structure`）+ C6b append-event-log-line | C6a+C6b 50/50（最终树） | 无 |
| L11 | `7c1325ea6` | operator health 去 friction / GFI 健康项 | 随实现删除 14 条：`gfi-workspace-health` 8 + `operator-health-gfi` 3 + `operator-health-gfi-degraded` 3（baseline 全过） | 删除确认（final 文件不存在） | **无替代正向断言**"健康面不含 GFI" → 归 ③（G2） |
| L12 | `8acd1027d` | pd-cli 删 `runtime health gfi` 快照命令、health 文本去 GFI 行 | pd-cli `runtime-canary.test.ts` 5 条 + `runtime-health-snapshot.test.ts` 2 条 | **7 条新失败（baseline 90 例中同名 7 条由 passed→failed）** | **新发现：命令/文本已删但用例未更新**（G1） |
| L13 | `603af28d4` | pd-console 健康检查去掉 GFI 项 | console `health-check-model` + `report-problem-validators`：81→77（−4） | **76 过 / 1 失败**（`checkSystemHealth returns overall status when workspace is empty`：断言 5 项，实际 4 项） | **新发现：计数断言未更新**（G1） |
| L14 | `3433204a1` | `/pd-status` 去掉 friction 分数、拒绝 `reset` | plugin `tests/commands/pain.test.ts` 22→21（新增反向断言 `not.toContain('GFI'/'Friction'/'Mental Mode')`）；C1 46/46 | **L14 前缀实测：C1 46/46、pd-status 21/21，0 失败** | 无 |
| L15 | `c7ab619e9` | 退役 friction flag/config 键 + 更新 shipped 模板 | core config 4 文件 178/178；C8b `pd-config-context-injection` 14/14 | **L15 前缀实测：178/178、14/14，0 失败** | `create-principles-disciple/src/mvp-config.ts` 无测试 → ③（G3，未实测） |
| L16 | `62e2cab15` | schema v2：幂等 DROP `gfi_before/gfi_after`；pending empathy → `abandoned/gfi_removal` | C3a `trajectory-schema.test.ts` + C3b | **L16 前缀实测：C3a 17/17、C3b 77/77；schema 探针 = v2 / gfi columns 0** | 无 |
| L17 | `f00c62f86` | 架构守卫与 canary fixture 对齐（删 GFI 白名单项） | core `architecture-regression` + `production-canary-fixture-gate` | **L17 前缀实测 496/496；−20 具名（见下）** | 无 |
| L18 | `60c44a346` | 文档收尾 | 无行为变更 | 最终树 568/568（1b 行） | 属于 ②（文档，无需测试） |

**L17 的 −20 具名**（baseline 516 → final 496，按用例全名比对，全部 `[passed]` 且 final 中已不存在；来源 `.tmp/gfi-removal/diff-test-names.mjs arch-baseline.json arch-final.json`）：

```
- source file gfi/gfi-types.ts is present
- source file gfi/gfi-policy.ts is present
- source file gfi/gfi-kernel.ts is present
- source file gfi/index.ts is present
- test file __tests__/../gfi/__tests__/gfi-kernel.test.ts is present
- PRI-75/PRI-74/PRI-81 prompt-builder core boundary prompt-builder/attitude-directive.ts has zero infrastructure imports
- PRI-76 GFI core kernel boundary gfi/gfi-types.ts has zero infrastructure imports
- PRI-76 GFI core kernel boundary gfi/gfi-policy.ts has zero infrastructure imports
- PRI-76 GFI core kernel boundary gfi/gfi-kernel.ts has zero infrastructure imports
- PRI-76 GFI core kernel boundary gfi/gfi-read-model.ts has zero infrastructure imports
- PRI-76 GFI core kernel boundary gfi/index.ts has zero infrastructure imports
- PRI-76 GFI core kernel boundary gfi-kernel.ts does not call Date.now()
- PRI-76 GFI core kernel boundary gfi/index.ts exports all public symbols
- PRI-78 GFI observability boundary gfi-read-model.ts has zero infrastructure imports
- PRI-78 GFI observability boundary pd-cli runtime-gfi-snapshot.ts imports from @principles/core/runtime-v2
- PRI-102: Production canary fixture gate stale GFI low不degraded stale sessions with low GFI are healthy
- PRI-102: Production canary fixture gate stale GFI low不degraded stale sessions with high GFI are degraded
- PRI-102: Production canary fixture gate stale GFI low不degraded active session with GFI below threshold is healthy
- PRI-102: Production canary fixture gate stale GFI low不degraded active session with GFI at or above threshold is degraded
- PRI-102: Production canary fixture gate stale GFI low不degraded no sessions at all is healthy (cold start)
```

新增 = **0**。全部因**被守护的对象（`gfi/*` 源文件、`attitude-directive.ts`、pd-cli snapshot 入口、canary GFI fixture）已删/已改**而消失，无断言被放宽。

**L5 / L6 / L8 的 −14 / −9+6 / −9+2 具名**见文末附录（同一 `diff-test-names.mjs` 产出）。

---

## 不变量 × 层矩阵（"每一层都保持"的可核对版本）

四条核心不变量：**① 手动 Pain 入口**（C1 / plugin `hooks/pain.ts`）｜**② TriggerController 真实调用点**（`pain.ts:31` import、`pain.ts:450` call）｜**③ 安全断路器**（C4 job 级 `consecutiveErrors`）｜**④ 历史记录读取**（C3a/C3b trajectory + C6a/C6b event log）。

判定口径：`触碰` = 该层 diff 是否改到该不变量的生产代码；`未触碰` 在"该层可构建"前提下即结构上不可能改变它。

| 层 | ① 手动 Pain | ② TriggerController | ③ 断路器 | ④ 历史记录 | 依据 |
| --- | --- | --- | --- | --- | --- |
| L1 | 未触碰 | 未触碰 | 未触碰 | **触碰** | C3a 17/17（L16 前缀） |
| L2 | 未触碰 | 未触碰 | 未触碰 | **触碰** | C6a 50/50 |
| L3 | 未触碰 | 未触碰 | 未触碰 | **触碰** | C3b 77/77 |
| L4 | **触碰** | 未触碰 | 未触碰 | 未触碰 | C1 46/46 |
| L5 | 未触碰 | **触碰** | 未触碰 | 未触碰 | C7 18/18 + 调用点断言 |
| L6 | 未触碰 | 未触碰 | 未触碰 | 未触碰 | signal-collector 69/69 |
| L7 | 未触碰 | **触碰** | 未触碰 | 未触碰 | 11 条未同步（G1） |
| L8 | 未触碰 | 未触碰 | 未触碰 | 未触碰 | triage 99/99 |
| L9 | 未触碰 | 未触碰 | 未触碰 | 未触碰 | internalization 53/53 |
| L10 | 未触碰 | 未触碰 | 未触碰 | **触碰** | C6a+C6b 50/50 |
| L11 | 未触碰 | 未触碰 | 未触碰 | 未触碰 | 14 条随实现删除（G2） |
| L12 | 未触碰 | 未触碰 | 未触碰 | 未触碰 | 7 条未同步（G1） |
| L13 | 未触碰 | 未触碰 | 未触碰 | 未触碰 | 1 条未同步（G1） |
| L14 | **触碰** | 未触碰 | 未触碰 | 未触碰 | C1 46/46、pd-status 21/21 |
| L15 | 未触碰 | 未触碰 | 未触碰 | 未触碰 | 178/178、14/14 |
| L16 | 未触碰 | 未触碰 | 未触碰 | **触碰** | 94/94 + 探针 v2 |
| L17 | 未触碰 | 未触碰 | 未触碰 | 未触碰 | 496/496 |
| L18 | 未触碰 | 未触碰 | 未触碰 | 未触碰 | 文档层 |

③ 安全断路器（C4）：**18 层中没有任何一层触碰** `pd-task-reconciler` 的 job 级 `consecutiveErrors`；C4 10/10 在最终树通过。

---

## 块 5 方案 B：L14–L18 前缀抽测（实测，含预先声明的预期）

| 层 | 前缀 build | 跑的组 | 结果 | 判定 |
| --- | --- | --- | --- | --- |
| L14 `3433204a1` | exit=0 | C1（46）、pd-status（21） | 46/46、21/21、0 失败 | 通过 |
| L15 `c7ab619e9` | exit=0 | core config 4 文件（178）、C8b（14） | 178/178、14/14、0 失败 | 通过 |
| L16 `62e2cab15` | exit=0 | C3a（17）、C3b（77）+ schema 探针 | 94/94、v2 / gfi columns 0 | 通过 |
| L17 `f00c62f86` | exit=0 | arch + canary（496） | 496/496、0 失败 | 通过 |
| L18 `60c44a346` | exit=0 | 无（文档层） | — | 通过（build） |

**预先声明**：L14–L17 的测试树早于块 4 的 5 条修测试，**预期复现那 5 条**。实测结果是 **5 条均未出现** —— 原因是这 5 条所在的组（C6a event-log / gate-block / gate-legacy、C7 gate-b / llm-pin）**不在 L14–L18 的受影响组内**，故未被触发。这不是"5 条已修"，而是"未抽样到"；它们的状态仍以 1b 行（最终树 568/568）为准。**B 方案抽测未出现任何预期外失败。**

---

## 真实覆盖缺口（单列）

| # | 缺口 | 类型 | 证据 | 交付风险 |
| --- | --- | --- | --- | --- |
| G1 | **19 条层内测试未同步**：L7 plugin signal 11 条、L13 console 1 条、L12 pd-cli 7 条 | ③ 覆盖与实现矛盾（会让 CI 红） | `.tmp/gfi-removal/supp2-final-*.json`、`pdcli-{baseline,final}.json`（同名用例 passed→failed） | **高**：`verify:merge` 会失败；且 11 条中 `PRI-2053 Stage2 归因不变量` 4 条是**仍然有效的能力断言**（纠正词归因），必须修复而非删除 |
| G2 | L11 删除 14 条 GFI 健康断言后，没有"健康面不再出现 GFI"的正向断言 | ③ 无替代断言 | `supp3-deleted.json`（14 条 baseline 全过） | 中：未来回归无人拦截 |
| G3 | `create-principles-disciple/src/mvp-config.ts` 模板键退役无测试 | ③ 未覆盖 | L15 文件清单，无对应 test | 低-中：shipped 配置错误只能靠人工 |
| G4 | session-tracker 的 friction 累加删除无独立用例 | ① 纯删除（值不再被生产） | L2 文件清单；C6a 仅覆盖 `DailyStats` 形状 | 低 |

### G1 明细：19 条「实现已改、测试未改」逐条具名

**来源**：`supp2-run.ps1`（baseline / final 各跑一次同名文件，vitest JSON reporter 落盘）＋ `diff-fail.mjs`（按用例全名比对 `passed → failed`）。三组均满足 `ONLY FINAL = 0`、`ONLY BASELINE = 0`（用例名集合完全一致，仅状态变化）。

**L7 plugin `signal-collector-host`** — 113 → 102 过 / **11 失败**

```
- SignalCollectorHost async routing (LLM confirmation) LLM says empathy → WEAK → trackFriction (no emit)
- SignalCollectorHost async routing (LLM confirmation) LLM unavailable (degraded) → empathy ambiguous routed as WEAK (GFI accumulation preserved)
- SignalCollectorHost async routing (LLM confirmation) trackFriction throws → does not crash host
- SignalCollectorHost edge cases and error handling keyword store with only empathy terms → empathy ambiguous routed as WEAK when LLM unavailable
- PRI-788 G2: LLM 不可用时候选持久化入队 LLM unavailable + empathy-only match → routed WEAK (GFI), NOT enqueued
- PRI-2053: Stage2 归因不变量 仅命中 empathy ambiguous 词 + Stage2 判 correction → 消息确认，但 empathy 词不进入纠正词证据
- PRI-2053: Stage2 归因不变量 两个 ambiguous 词混合命中（correction + empathy）→ 只有 correction 词参与纠正词归因
- PRI-2053: Stage2 归因不变量 Stage2 判非 correction → 不为 empathy 词凭空产生纠正词证据
- PRI-2053: Stage2 归因不变量 LLM 抛错入队时只持久化 correction 类命中词（恢复侧无需历史快照）
- PRI-687 回归：强烈 Owner 纠正端到端可检出 负向：纯宣泄脏话（无纠正语义）→ empathy/WEAK，不翻转标志位、不触发 pain
- Learn→Detect live refresh (无需重启) empathy 降级路径不被破坏: LLM 关闭时 搞什么 仍路由 WEAK(GFI)
```

分类：前 5 条 + 最后 2 条 = **断言随 WEAK/GFI 机制删除而过期**（`WEAK` 路由已不存在，`trackFriction` 已删）；`PRI-2053` 4 条 = **仍有效的能力断言**（Stage2 纠正词归因），但其中仍以 `WEAK` 作为前提编排 → 需要**改写到新位置断言**，不许删除（对应块 4 (b)/(c) 分类里 (c) 类）。

**L12 pd-cli** — 同一 5 文件、同一命令，baseline 90 例（33 失败 / 57 过）→ final 90 例（40 失败 / 50 过）；**NEWLY FAILING = 7 / NEWLY PASSING = 0 / ONLY FINAL = 0 / ONLY BASELINE = 0**

```
- runCanaryChecks GFI config warning degraded status returns healthy when GFI disabled with no warnings
- runCanaryChecks GFI config warning degraded status returns degraded when GFI disabled but config has warnings (malformed YAML)
- runCanaryChecks GFI config warning degraded status returns degraded when GFI disabled but config has malformed override warning
- runCanaryChecks GFI config warning degraded status runs GFI snapshot when flag enabled with no warnings
- runCanaryChecks GFI config warning degraded status recommends session lifecycle review for GFI session issues (not config)
- handleRuntimeHealthSnapshot includes compact GFI line in text output
- handleRuntimeHealthSnapshot shows no active sessions in text when gfi.active is null
```

说明：baseline 那 33 条失败是**副本内的环境性预先存在**（同一命令、同一副本、用例名集合完全一致，因此可排除）；只有上述 7 条状态改变。分类：全部随 `runtime health gfi` 命令与 health 文本 GFI 行被删而过期。

**L13 pd-console `health-check-model`** — 81 → 76 过 / **1 失败**

```
- HealthCheckModel checkSystemHealth returns overall status when workspace is empty
```

分类：断言"5 项检查"，实现已去掉 GFI 项后实际 4 项 → **计数断言未更新**（应改 5→4）。

---

## 结论：18 层里是否有任何一层出现能力退化？

**无。** 依据：

1. 可构建的每一层（L14–L18 前缀）实测 0 失败；最终树 8 组 568/568。
2. L1–L13 无法以前缀形式执行，改用层归属 + 最终树实测：所有"触碰不变量"的层均有具名用例实测通过（C1 46、C3a 17、C3b 77、C6a/C6b 50、C7 18）。
3. 所有用例数下降均已点名到具体用例，且原因都是**被测对象自身被删**（77 + 14 + 14 + 20 + 14 + 3 + 7 + 1 + 4），无"放宽断言"。
4. **但**：存在 19 条"实现已改、测试未改"的矛盾（G1）。它们**不是能力退化**（生产行为符合 SPEC），但会让仓库在 HEAD 上 CI 红，属于必须先修的交付阻塞。

### 附：零失败但用例数下降的三组，逐条点名（baseline → final，按用例全名比对）

**L5 prompt-builder（attitude-directive 删除）** — baseline 54 / final 40

移除 14 条：

- `attitude-directive buildAttitudeDirective returns HUMBLE_RECOVERY mode when GFI >= 70`
- `attitude-directive buildAttitudeDirective returns HUMBLE_RECOVERY mode for high GFI values`
- `attitude-directive buildAttitudeDirective returns CONCILIATORY mode when GFI >= 40 and < 70`
- `attitude-directive buildAttitudeDirective returns CONCILIATORY mode for mid-range GFI values`
- `attitude-directive buildAttitudeDirective returns EFFICIENT mode when GFI < 40`
- `attitude-directive buildAttitudeDirective returns EFFICIENT mode for low GFI values`
- `attitude-directive buildAttitudeDirective returns EFFICIENT mode for zero GFI`
- `attitude-directive buildAttitudeDirective formats GFI as integer`
- `buildAttitudeDirective GFI = 0 → EFFICIENT`
- `buildAttitudeDirective GFI = 39 → EFFICIENT`
- `buildAttitudeDirective GFI = 40 → CONCILIATORY (boundary)`
- `buildAttitudeDirective GFI = 69 → CONCILIATORY`
- `buildAttitudeDirective GFI = 70 → HUMBLE_RECOVERY (boundary)`
- `buildAttitudeDirective GFI = 100 → HUMBLE_RECOVERY`

**L6 signal-collector（V1→V2 + STRONG-only）** — baseline 72 / final 69

移除 9 条：

- `P-3 confidence gate (SPEC v0.3 §3.3/§4.4) empathy keeps its existing OpenClaw meaning and is not a correction`
- `SignalClassificationOutputV1Schema (registered as signal-classification-output-v1) 接受 prompt 承诺的精确形状`
- `SignalClassificationOutputV1Schema (registered as signal-classification-output-v1) 拒绝缺字段 / 错类型 / 越界 confidence`
- `SignalClassificationOutputV1Schema (registered as signal-classification-output-v1) schema 与 validateLlmClassification 对相同样本集判定一致 (单一契约,防漂移)`
- `SignalClassificationOutputV1Schema (registered as signal-classification-output-v1) buildLlmPrompt 声明的字段与 schema 字段一致`
- `collectSync high-precision empathy term → WEAK, no LLM`
- `collectSync correction high-precision takes priority over empathy high-precision`
- `mapLlmResultToOutput LLM says empathy → WEAK`
- `mapLlmResultToOutput LLM empathy with high confidence → WEAK`

新增/改名 6 条：

- `SignalClassificationOutputV2Schema (registered as signal-classification-output-v2) 接受 prompt 承诺的精确形状`
- `SignalClassificationOutputV2Schema (registered as signal-classification-output-v2) 拒绝缺字段 / 错类型 / 越界 confidence`
- `SignalClassificationOutputV2Schema (registered as signal-classification-output-v2) schema 与 validateLlmClassification 对相同样本集判定一致 (单一契约,防漂移)`
- `SignalClassificationOutputV2Schema (registered as signal-classification-output-v2) buildLlmPrompt 声明的字段与 schema 字段一致`
- `collectSync high-precision mutually-exclusive terms stay STRONG (single category)`
- `collectSync multiple high-precision terms resolve deterministically to correction`

**L8 evidence-triage（gfi_threshold 退场）** — baseline 106 / final 99

移除 9 条：

- `resolveSourceKind: per-kind mapping isGfiTriggered → gfi_threshold`
- `resolveSourceKind: field precedence GFI triggered takes precedence over detection source prefix`
- `Pain Phase 0: retired observation builders stay removed GFI mapping is still reachable via inline RawObservation (gfi_threshold)`
- `SOURCE_DESCRIPTORS registry has exactly 13 registered descriptors`
- `Descriptor decision invariants gfi_threshold has defaultDecision=evidence_only (GFI alone cannot admit)`
- `Descriptor reason quality gfi_threshold reason mentions GFI alone cannot create diagnosis`
- `getSourceDescriptor has exactly 13 registered descriptors`
- `gfi_threshold defaults to evidence_only — GFI alone cannot create diagnosis`
- `invariants GFI never admits directly`

新增/改名 2 条：

- `SOURCE_DESCRIPTORS registry has exactly 12 registered descriptors`
- `getSourceDescriptor has exactly 12 registered descriptors`

---

## 块 6 执行记录（G1 → P1 → D1）

- 2026-11-04 / 前置：`better-sqlite3` 13.0.3，运行时 `sqlite_version = 3.53.4`（≥ 3.35，`ALTER TABLE ... DROP COLUMN` 可用）。实测命令：`node -e "const Db=require('better-sqlite3'); console.log(new Db(':memory:').prepare('select sqlite_version() v').get().v)"`。

### G1 处置台账（19 条，逐条一行）

> 依据：L7 `13c067e2f`（SPEC §3.7）、L12 `8acd1027d`（SPEC §4.3）、L13 `603af28d4`（SPEC §4.4）。全部只改测试文件，未改任何生产代码。

| # | 层 | 用例（原文） | 处置 | 依据 / 新断言 |
| --- | --- | --- | --- | --- |
| 1 | L7 | `LLM says empathy → WEAK → trackFriction (no emit)` | 删除 | 夹具 `type:'empathy'` 已不在 `LlmClassificationResult`（`signal-collector/types.ts:type = 'correction'\|'none'`）；断言对象 `trackFriction` 与 WEAK 路由随 `13c067e2f` 删除（SPEC §3.7 L439–441/467–472） |
| 2 | L7 | `LLM unavailable (degraded) → empathy ambiguous routed as WEAK (GFI accumulation preserved)` | 删除 | 同上；断言 `trackFriction(source:'user_empathy')` 的机制已删 |
| 3 | L7 | `trackFriction throws → does not crash host` | 删除 | 被测对象 `trackFriction` 已删；等价幸存路径由同文件 `SIGNAL_CUE_FEEDBACK_FAIL ... learner broke` 用例覆盖（cueFeedbackRecorder 抛错不崩宿主） |
| 4 | L7 | `keyword store with only empathy terms → empathy ambiguous routed as WEAK when LLM unavailable` | 删除 | 夹具 empathy-only 词表 + WEAK 断言；seed 词表已无 empathy 词（`signal-keyword-store.test.ts:118` 断言 `store.terms['搞什么'] === undefined`） |
| 5 | L7 | `PRI-788 G2 ... LLM unavailable + empathy-only match → routed WEAK (GFI), NOT enqueued` | 删除 | 断言依赖 WEAK 分流；PRI-788 G2 的「非零命中候选不得静默丢弃」语义由同 describe 内其它入队用例覆盖（SPEC §3.7 L503） |
| 6 | L7 | `PRI-2053: 仅命中 empathy ambiguous 词 + Stage2 判 correction → 消息确认，但 empathy 词不进入纠正词证据` | **(c) 改写** | 真实调用点：`signal-collector-host.ts:320`（`const correctionTerms = pending.output.matchedTerms`）→ `:323 emitCueFeedback(correctionTerms,true)` → `:329 writeBackConfirmedCorrection`。新断言：pain 1 次、`markUserTurnCorrection(11,'不对')`、`recorder(['不对'],true)`（只取 Stage1 命中词，不补词、不落 `llm:` 判词） |
| 7 | L7 | `PRI-2053: 两个 ambiguous 词混合命中（correction + empathy）→ 只有 correction 词参与纠正词归因` | **(c) 改写** | 类别概念已删（`UnifiedKeyword.category` 随 `13c067e2f` 移除），词表层面不存在 empathy 词；新断言：`recorder(['不对','搞什么'],true)`、`markUserTurnCorrection(11,'不对, 搞什么')` —— 归因只取 Stage1 命中词快照 |
| 8 | L7 | `PRI-2053: Stage2 判非 correction → 不为 empathy 词凭空产生纠正词证据` | **(c) 改写** | 真实调用点 `signal-collector-host.ts:333 emitCueFeedback(correctionTerms,false)`；新断言：`recorder(['搞什么'],false)`（只记 FP）、无 pain 事件 |
| 9 | L7 | `PRI-2053: LLM 抛错入队时只持久化 correction 类命中词` | **(c) 改写** | 真实调用点 `signal-collector-host.ts:375 queueUnconfirmedForBatch`（`terms: matchedTerms`、`suggestedType:'correction'`）；新断言：`terms = ['不对','搞什么']`（检测时快照，不依赖恢复时词库） |
| 10 | L7 | `PRI-687 回归 … 负向：纯宣泄脏话（无纠正语义）→ empathy/WEAK，不翻转标志位、不触发 pain` | 改写 | 夹具改 `type:'none'`（Stage2 只剩 correction/none）；保留三条精确断言：`markUserTurnCorrection` 未调用、`emitPainDetectedEvent` 未调用、`recorder(['什么狗屎'], false)` |
| 11 | L7 | `Learn→Detect live refresh … LLM 关闭时 搞什么 仍路由 WEAK(GFI)` | 删除 | 引用已不存在的 `trackFriction` 标识符（ReferenceError）且 WEAK 已删；seed 词表已无 `搞什么` |
| 12 | L12 | `runCanaryChecks GFI config warning degraded status → returns healthy when GFI disabled with no warnings` | 删除 | `gfi_snapshot` check 随 `8acd1027d` 删除（SPEC §4.3 L630–638） |
| 13 | L12 | `… returns degraded when GFI disabled but config has warnings (malformed YAML)` | 删除 | 同上 |
| 14 | L12 | `… returns degraded when GFI disabled but config has malformed override warning` | 删除 | 同上 |
| 15 | L12 | `… runs GFI snapshot when flag enabled with no warnings` | 删除 | 同上（断言对象为已删的 `buildGfiSnapshot`） |
| 16 | L12 | `… recommends session lifecycle review for GFI session issues (not config)` | 删除 | 同上（断言对象为已删的 `classifyGfiHealth`） |
| 17 | L12 | `handleRuntimeHealthSnapshot includes compact GFI line in text output` | 改写 | 新断言为负向：`allOutput` 不含 `gfi:`，且仍含 `candidateLedger`（SPEC §4.3 L625） |
| 18 | L12 | `handleRuntimeHealthSnapshot shows no active sessions in text when gfi.active is null` | 删除（并入 #17） | 断言对象「gfi.active 文本行」已随命令删除；新的负向断言已覆盖 |
| 19 | L13 | `HealthCheckModel checkSystemHealth returns overall status when workspace is empty` | 改写（5→4） | GFI 健康项随 `603af28d4` 删除（SPEC §4.4 L652–671）；`expect(health.checks).toHaveLength(4)` |

**G1 复测（修复后，逐组前台实测）**

| 组 | 命令 | 结果 |
| --- | --- | --- |
| L7 plugin | `npx vitest run tests/core/signal-collector-host.test.ts tests/core/signal-keyword-store.test.ts` | **77/77 passed，exit=0** |
| L12 pd-cli | `npx vitest run tests/commands/runtime-canary.test.ts tests/commands/runtime-health-snapshot.test.ts` | **23/23 passed，exit=0** |
| L13 console | `npx vitest run tests/models/health-check-model.test.ts` | **18/18 passed，exit=0** |

**PRI-2053 (c) 类能力证据（生产路径仍在）**

- `packages/openclaw-plugin/src/core/signal-collector-host.ts:320` — `const correctionTerms = pending.output.matchedTerms;`（归因词集来自 Stage1 检测时快照）
- 同文件 `:323` — `this.emitCueFeedback(correctionTerms, true)`（Stage2 确认 → TP）
- 同文件 `:329` — `this.writeBackConfirmedCorrection(pending.userTurnRowid, 'user_correction', correctionTerms)`（消息级纠正事实）
- 同文件 `:333` — `this.emitCueFeedback(correctionTerms, false)`（Stage2 非 correction → FP，不产生纠正证据）
- 同文件 `:375` — `queueUnconfirmedForBatch({ terms: matchedTerms, suggestedType: 'correction' })`（入队持久化 Stage1 命中词）
- empathy 类别不可达的结构证据：`13c067e2f` 删除 `UnifiedKeyword.category` / `correctionTermsOf` / `EMPATHY_SEED_OVERLAY`；`governance-signal-admission.ts` 的 `projectLearnedStore` 只产出纠正词；`signal-keyword-store.test.ts:118` 断言 seed 无 `搞什么`。

---

## 块 6 执行记录（G1 修复收尾 + P1 迁移 + verify:merge 转绿）

### 6.1 G1 修复后 8 组累计对照（副本 `current-g1fix` = `51521ebfb`，逐组前台实测）

| 组 | 包 | 结果 |
| --- | --- | --- |
| c1 | openclaw-plugin | 46 / 46 |
| c2a | principles-core | 25 / 25 |
| c2b | openclaw-plugin | 10 / 10 |
| c3a | principles-core | 17 / 17 |
| c3b | openclaw-plugin | 77 / 77 |
| c4 | openclaw-plugin | 10 / 10 |
| c5 | principles-core | 175 / 175 |
| c6a | openclaw-plugin | 48 / 48 |
| c6b | principles-core | 2 / 2 |
| c7 | openclaw-plugin | 18 / 18 |
| c8a | openclaw-plugin | 60 / 60 |
| c8b | principles-core | 80 / 80 |
| **合计** | | **568 / 568，0 failed（与基线逐组一致，无数字漂移）** |

### 6.2 `verify:merge` 修复前后状态（实测，非推断）

| 阶段 | 结果 | 证据 |
| --- | --- | --- |
| 修复前（`current-head4` = `3bb70c16d`） | **红** | 第一个失败步骤是 `RELEASE_INTENT_GUARD`：`mode=normal (base=35d12815bc head=51521ebfb6, reproduction rejected)` —— 分支 20 个提交未声明发版意图（缺 changeset）。日志 `.tmp/gfi-removal/verify-merge-before.log` |
| 修复前，19 条陈旧测试是否造成红？ | **否（实测更正）** | `verify:merge` 不包含这 19 条所在测试文件；`current-head4` 副本四个 typecheck（core / pd-cli / openclaw-plugin / pd-console）全部 `exit=0`。此前把「19 条 → 门禁红」当作因果是**错的**，真实红因是 release intent。日志 `.tmp/gfi-removal/verify-typecheck-before.log` |
| 修复后 | 待本轮提交后在工作树重跑（见 §6.4） | — |

### 6.3 P1（老库未真正迁移）处置与新增发现

| 项 | 内容 |
| --- | --- |
| 前置 1：SQLite 版本 | `better-sqlite3` 13.0.3 → `sqlite_version = 3.53.4`（≥ 3.35，`ALTER TABLE … DROP COLUMN` 可用） |
| 修 1（导出） | `packages/principles-core/src/runtime-v2/index.ts` 新增 `migrateLegacyGfiSchema` / `TRAJECTORY_SCHEMA_VERSION` 等导出 |
| 修 2（判定） | `production-pain-evidence.ts` `hasCanonicalSchema`：`tool_calls` 仍含 `gfi_before`/`gfi_after` 时返回 `false`（不能把 v1 库当 canonical） |
| 修 3（两条裸库链） | `recordVerifiedToolOutcomes` 与 `createProductionPainEvidenceHandler` 在 `hasCanonicalSchema` 之前调用 `migrateLegacyGfiSchema`；失败返回 `trajectory_migration_failed:<reason>` + `nextAction`（链 A `status:'unavailable'`、链 B `decision:'observe'`）。**无静默降级** |
| 新增发现（阻断级） | `62e2cab15` 从 `INSERT INTO tool_calls` 列清单删掉 `gfi_before/gfi_after`，但 `.run(...)` 仍多传两个 `null` → 生产 `recordVerifiedToolOutcomes` 每次写入都抛 `Too many parameter values were provided`。本块按 12 列对齐修正（P1 同日同文件内，属移除自身回归，非顺手改动） |
| 新增发现（陈旧测试 #20） | `production-host-runtime.test.ts:482` 断言 `input.session.currentGfi`；`2bae37491`（SPEC §3.8）已把 `currentGfi` 移出 Rule Host 输入 → 按 (c) 类改写为 `evolution.epTier` + `derived.bashRisk`（生产仍转发，见 `production-rulehost-gate.ts:556-563`），保留 `decision:'deny'` 精确断言 |
| 陈旧夹具（9 个 host-runtime 测试文件） | 因 `hasCanonicalSchema` 变严，v1 夹具（含 `gfi_before/gfi_after`）被判非法 → 夹具改为 canonical v2 形状（`recovery-dedup-host-attribution.test.ts` 两处 INSERT 同步去掉两列与两个 `null`）。不改生产代码语义 |
| P1 复测 | `packages/host-runtime` 全包 **652 / 652 passed，exit=0**（修前该包 71 failed；never-in-scope 的 #20 亦清零） |



