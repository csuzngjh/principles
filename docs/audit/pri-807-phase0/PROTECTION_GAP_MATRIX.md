# PRI-807 Phase 0 — Worker F：Tests / Protection Gaps 审计

> 只读审计产物。本文件是 Worker F 的唯一写入。
> 任务：回答「现有 4000+ 测试真正保护了哪些核心 contract？哪些地方可以 CI 全绿但核心链已断？」
> 判定以 **current main 代码为最终证据源**；历史审计 #1707 / #1710 仅作事实种子。

判定词：CONFIRMED / FIXED / DRIFTED / PARTIAL / NEW / UNVERIFIABLE
严重度：P1 = 某 invariant 完全无保护且破坏可致管道静默瘫痪；P2 = 有测试但只测 helper/mock，非生产路径；P3 = 覆盖可改进。

---

## 1. Scope

### 1.1 在范围内

- `verify:merge` 合并门禁的**真实组成**（读 `package.json`，不读文档转述）。
- CI（`.github/workflows/ci.yml` 及各旁路 workflow）实际执行的测试 job。
- 各 package `vitest.config.ts` 的 `include` 口径与测试文件实际落位的一致性。
- 覆盖管道契约的测试：topology / prompt-schema parity / validator parity / lineage / artifact identity / writer / Owner gate / activation / host parity / installed runtime / upgrade / rollback / behavior adaptation。
- R-19（RuleCode 沙箱信任边界）现有测试的保护面。
- Carry-forward 项：R-04 / R-20 / R-22、J1–J4 四条 Journey 的测试资产现状。

### 1.2 明确不在范围内

- **不写测试、不修 bug、不改 config、不动源码**（只读审计）。
- 不做覆盖率百分比评估（本任务按**管道瘫痪风险**排序，不按 coverage 百分比）。
- 不评估 LLM 行为质量、不评估 prompt 文案质量（#1707 已覆盖）。
- 不做运行时实测（无 npm install / 不跑全量 vitest）。

### 1.3 方法

- 静态阅读测试文件 + 测试配置 + CI workflow + `package.json` scripts。
- 关键结论均回源到具体 `文件:行号`。
- 对 **R-19 的对抗输入**做了本地最小机制复现（`node:vm` + 复制的 masking 代码），作为「静态门是否拦得住」的实证，而非推断。
- 「是否 mock 生产依赖」按 `vi.mock(` / 真实 `SqliteConnection` / 真实 `spawnSync` 三类实测文件判定。

### 1.4 规模事实（用于校准比例，不作为结论）

| 项 | 数值 | 证据 |
|---|---|---|
| 测试文件数 | 990（`packages/**` + `scripts/**` + 根 `tests/`） | 文件系统扫描 |
| `it(` / `test(` 声明数 | 约 15,510 | 正则行扫（含 `it.each` 展开前的声明行） |
| 含 `vi.mock(` 的测试文件 | 171 / 974（`packages/**`） | 文件内容扫描 |
| 触碰真实 SQLite 的测试文件 | 165 / 974 | 文件内容扫描 |
| `architecture-regression.test.ts` | 4,368 行 / 269 个 `it()` / 627 处 `.toContain(` / 403 处 `readFileSync` | 文件扫描 |

> 注：测试数与保护强度无因果关系。下文的结论全部来自「是否打在生产边界上」的判定。

---

## 2. Baseline

```
BASELINE: SYNCED
$ git rev-parse HEAD
cdec05d4bc4252151c7f9f118bdad90f25067594
```

- 与任务书指定基线 `cdec05d4bc4252151c7f9f118bdad90f25067594` **完全一致** → 无 Drift Warning。
- 实际 checkout 分支：`audit/pri-807-phase0-base`（开工时）→ 交付分支 `ai/cnb-dev/issue-52`。
- 历史事实种子：`docs/audit/agent-pipeline-audit-2026-09-15/REPORT.md` 存在（2,347 行）+ `VERIFICATION-{A..D}.md`（1,729 行）。

**基线声明**：本报告全部结论仅对 `cdec05d4b` 负责。该 SHA 之后 main 的任何提交都可能使个别结论失效。

---

## 3. Current Authorities — 现有验证体系的权威入口

### 3.1 `verify:merge` 的真实组成（16 步，不是文档说的 9 步）

`package.json:40` 的 `verify:merge` 实际串行执行 **16 步**：

| # | 步骤 | 类别 | 是否跑测试 |
|---|---|---|---|
| 1 | `check:generated-artifacts` | 静态 | 否 |
| 2 | `check:error-handbook` | 静态 | 否 |
| 3 | `check:telemetry-events --strict` | 静态 | 否 |
| 4 | `check:repo-hygiene` | 静态 | 否 |
| 5 | `check:runtime-contract` | 静态（**仅 diff 行**） | 否 |
| 6 | `check:docs-structure` | 静态 | 否 |
| 7 | `check:security-baseline` | 静态 | 否 |
| 8 | `create-principles-disciple` 的 `release-target-matrix.test.ts` | **唯一被点名跑的测试文件** | 是（单文件） |
| 9 | `build @principles/core` | 构建 | 否 |
| 10 | `test:website` | 测试 | 是（website 包） |
| 11 | `lint` | 静态 | 否 |
| 12 | `build`（全 workspace） | 构建 | 否 |
| 13 | `build pd-cli` | 构建 | 否 |
| 14 | `typecheck:openclaw-plugin` | 类型 | 否 |
| 15 | `typecheck:pd-console` | 类型 | 否 |
| 16 | `typecheck:pd-companion` | 类型 | 否 |

**verify:merge 不包含**：

- `principles-core` / `openclaw-plugin` / `pd-cli` / `pd-console` / `pd-companion` / `codex-adapter` / `install-layout` 的 **vitest 全量**；
- **任何** BDD `.feature` 场景（`docs/adr/0018-bdd-specification-layer.md:62` 已明文声明「BDD 不在 verify:merge 内」）；
- `install-layout` 的测试（CI 中该包**没有 test job**，只有 8 处 `build --workspace`）；
- `test:scripts`、`scripts/nocturnal` 的测试；
- `release-asset-smoke` / `smoke-packaged-install`（这两个在 CI 中是**独立 job**，不在门禁内）。

**文档漂移（DRIFTED，P3）**：`docs/process/TESTING.md:163-171` 仍写「runs 9 checks」并列出 9 项，与 `package.json:40` 的 16 步不符（缺 telemetry-events-strict、repo-hygiene 之外的 security-baseline、website、pd-companion typecheck、release-target-matrix）。`docs/adr/0018-...md:28` 也沿用「9 个静态门」表述。

### 3.2 CI 的真实覆盖分布

`.github/workflows/ci.yml` 有 **21 个 job**（`impact` / `telemetry-guard` / `verify-merge` / `release-parity` / `lint` + 16 个测试/构建/类型 job）。每个 package 的 vitest 在 CI 里由**独立 job** 跑：

| Package | CI job | 说明 |
|---|---|---|
| principles-core | `test-principles-core` | `npm run test -- --coverage` |
| pd-cli | `test-pd-cli` | `npm run build && npm test` |
| pd-companion | `test-pd-companion` | `npm run build && npm test` |
| pd-console | `test-pd-console` | `npm run test -- --coverage` |
| create-principles-disciple | `test-create-principles-disciple` | **仅 `test:fast`**（排除两个 smoke） |
| create-principles-disciple | `smoke-packaged-install` | 只跑 `tests/smoke-packaged-install.test.ts` |
| create-principles-disciple | `smoke-release-asset` | 只跑 `tests/release-asset-smoke.test.ts` |
| scripts | `test-scripts` | `cd scripts && vitest run` |
| host-runtime | `test-host-runtime` | 全量 |
| openclaw-plugin（unit） | `test-openclaw-plugin-unit` | `vitest.unit.config.ts`（排除 integrationTests 名单） |
| openclaw-plugin（integration） | `test-openclaw-plugin-integration` | 只 `tests/integration/` |
| openclaw-plugin（coverage） | `test-openclaw-plugin-coverage` | `vitest run --coverage`（全量） |
| openclaw-plugin（parity） | `test-host-runtime-parity` | 只 2 个文件 |
| codex-adapter | `test-codex-adapter` | 全量 |
| install-layout | **无** | 只被 `build` |

**CI 全绿≠ verify:merge 全绿，反之亦然。** 两者是互补而非包含关系：verify:merge 跑静态门 + lint + build + typecheck，CI 测试 job 跑 vitest。**但** verify:merge **不含** `test-principles-core` / `test-pd-cli` / `test-pd-console` 等 vitest job——若这些 job 因 path filter / 平台故障被跳过或未设为 required check，verify:merge 仍会绿。仓库内**没有** branch protection / required checks 的声明文件（`.github/` 下无 ruleset 文件），无法从仓库自证哪些 job 是 required。

### 3.3 测试配置口径问题（NEW，P2）

对各 package 的 `vitest.config.ts` `include` glob 与包内实际 `*.test.ts` 文件做机械匹配（glob → regex，逐文件比对），结果如下（`OUTSIDE` = 落位在 include 口径外的测试文件数）：

| Package | include 口径 | 包内 `*.test.ts` | OUTSIDE |
|---|---|---|---|
| principles-core | 30 条 glob | 403 | **4** |
| openclaw-plugin | `tests/**/*.test.ts(x)` | 197 | **2** |
| pd-cli | `tests/**` + `src/**/*.test.ts` | 123 | 0 |
| pd-console | `tests/**` + `src/ui/utils/__tests__/**` | 128 | 0 |
| pd-companion | `tests/**` + `tests/bdd/**` | 10 | 0 |
| codex-adapter | `tests/**` + `src/**` | 18 | 0 |
| create-principles-disciple | `tests/**` + `tests/bdd/**` | 53 | 0 |

（pd-console 另有 11 个 Playwright `.spec.ts`，由 `playwright.config.ts` / `playwright.owner.config.ts` 独立驱动——非 vitest 口径问题，属正常分层。）

**确有「测试文件写了但从未执行」的包有两个：**

| Package | 永不执行的测试文件 | 未执行断言数 |
|---|---|---|
| principles-core | `src/runtime-v2/internalization/deprecated-readiness.test.ts` | 6 |
| principles-core | `src/runtime-v2/internalization/lifecycle-metrics.test.ts` | 13 |
| principles-core | `src/runtime-v2/internalization/lifecycle-read-model.test.ts` | 12 |
| principles-core | `src/runtime-v2/internalization/routing-policy.test.ts` | 6 |
| openclaw-plugin | `src/core/__tests__/focus-history.test.ts` | 7 |
| openclaw-plugin | `src/core/principle-compiler/__tests__/compiler-replay-gate.test.ts` | 5 |

**principles-core 的 4 个文件**：`include` 只列 `'src/runtime-v2/internalization/__tests__/**/*.test.ts'`（`vitest.config.ts:6`），而这 4 个文件位于 `internalization/` 根目录、不在 `__tests__/` 之下 → **永不执行**。其被测模块均为公共导出：`runtime-v2/index.ts:776-789`（`computeRuleMetrics` / `computePrincipleAdherence` / `assessDeprecatedReadiness` / `recommendLifecycleRoute` / `buildLifecycleReadModel`）。

`architecture-regression.test.ts:501-502` 有一行注释承认了这件事并主动放弃看护：

```
// PRI-56 (lifecycle-read-model.test.ts is at internalization/lifecycle-read-model.test.ts, not in __tests__/)
// Skipping — test file lives at ../internalization/ not __tests__/internalization/
```

**openclaw-plugin 的 2 个文件**：`include` 只有 `'tests/**/*.test.ts'`（`vitest.config.ts:40`），`src/**` 完全不在口径内。而 `vitest.unit.config.ts` / `vitest.parity.config.ts` 都继承该 `include`，也无补丁。

**后果**：这两个包的这 6 个文件共 **49 个断言**在 `verify:merge`、全部 CI job、pre-push hook 中**从不运行**。CI 全绿不能推出它们通过。

---

## 4. Contract Map — Invariant 保护矩阵

字段：Test file / Test type / Production path?（是否打在生产边界）/ Deterministic? / Installed runtime? / Real host? / Real model? / Gap?

> §4.14 是任务书 §4.4 要求的「R-19 的 F 面」——按契约面归属放入本矩阵（沙箱信任边界 = Security invariant），不单独占一级章节。

### 4.1 Topology（DAG 权威）

| 字段 | 内容 |
|---|---|
| Test file | `principles-core/src/runtime-v2/__tests__/internalization-job-graph.test.ts`、`.../internalization-peer-runner-contracts.test.ts:237+`、`.../internalization-state-machine.test.ts:538+`、`.../internalization/__tests__/c2-live-runner-chain.test.ts:439-500`、`.../internalization/__tests__/philosopher-toggle-characterization.test.ts:202` |
| Test type | unit（纯函数）+ integration（`c2-live-runner-chain` 用真实 store + 真实 orchestrator） |
| Production path? | **部分是**。`c2-live-runner-chain.test.ts` 通过真实 `InternalizationOrchestrator.commitNextTaskProposal` 断言真实 store 里的后继 taskKind（EP-09 明示「not inferred from ALLOWED_EDGES」）→ **真生产路径**。`internalization-job-graph.test.ts` 只测纯函数 → 非生产路径 |
| Deterministic? | 是 |
| Installed runtime? | 否 |
| Real host? | 否 |
| Real model? | 否 |
| Gap? | **`validateInternalizationGraph` 在生产代码中零调用方。** 该函数（`internalization-state-machine.ts:394`）做「无环 + 边合法 + 依赖存在」三项结构校验，但全仓 `rg` 只命中它自身、`__tests__` 与 `architecture-regression.test.ts:1637` 的源码字符串断言——**没有生产 caller**。即：图结构校验是一个「有测试、无执行」的能力。生产实际靠 `validateInternalizationTaskReady`（`internalization-orchestrator.ts:239`）逐任务做依赖门，不做全图无环校验。 |

严重度：**P2**（有测试但非生产路径；且图校验能力未接线）。

### 4.2 Prompt-schema parity

| 字段 | 内容 |
|---|---|
| Test file | `principles-core/src/runtime-v2/tools/__tests__/artificer-output-typebox.test.ts:50-58`（property set 相等）、`.../dreamer-output-typebox.test.ts:114-125`（同上）；各 package 的 schema validator 单测：`diagnostician-output-schema.test.ts`、`diag-rootcause-output.test.ts`、`diag-distiller-output.test.ts`、`evaluator-output-v2.test.ts`、`scribe-runner-vslice.test.ts:944+`、`artificer-rule-output.test.ts` |
| Test type | contract（双 schema 行为等价 + property-set 相等） |
| Production path? | **是（就 schema 本身而言）**——两个 schema 都是生产构建产物（`@sinclair/typebox` 版供 LLM 工具面，`typebox` 版供 `submit_rulecode` 工具参数） |
| Deterministic? | 是 |
| Installed runtime? | 否 |
| Real host? | 否 |
| Real model? | 否 |
| Gap? | **parity 测试覆盖「schema ↔ schema」，不覆盖「prompt 示例 ↔ schema」。** 具体证据：`artificer-prompt-builder.ts:169-186` 的 `OUTPUT FORMAT` 示例块**不含** `requiresContextVersion` / `evidenceRefs` / case 级 `ruleContext`（本地抽取该块逐字确认：三者均 false）；而 `artificer-output.ts:271-284,386-392` 对 `requiresContextVersion:2` 的 v2 规则**要求** case 级 `ruleContext` 与 `evidenceRefs` 非空；`artificer-runner.ts:537` + `validateV2OutputContract` 更是**强制** `requiresContextVersion === 2`。→ 逐字模仿该示例的 LLM 输出**必然**被拒。测试侧只有 `artificer-prompt-builder.test.ts:100-102` 断言示例**不含** `write_file` 幻影词汇，**没有任何**测试把示例 JSON 抽出来喂给 validator。 |

严重度：**P1**（prompt 与自身 schema/validator 的契约在示例层面无任何机械保护，且已知会确定性失败 → 每次走到 artificer 都烧重试）。

### 4.3 Semantic validator parity

| 字段 | 内容 |
|---|---|
| Test file | `rule-code-dialect.test.ts`、`activation/__tests__/production-gate-deps.test.ts`（20 test）、`internalization/__tests__/refiner-sandbox-wrapper.test.ts`（40+ test）、`internalization/__tests__/refiner-rulehost-gate.test.ts`、`rule-reliability-validation.test.ts`、`rulehost-oob-defense-simulation.test.ts`（78 test） |
| Test type | unit + integration |
| Production path? | **是**。`production-gate-deps.test.ts` 直接构造 `createProductionGateDeps()`——这是 `RuleHostWriter` 在 pd-cli / pd-console / host-runtime 三处生产 wire 用的**同一个 canonical 工厂** |
| Deterministic? | 是 |
| Installed runtime? | 否 |
| Real host? | 否 |
| Real model? | 否 |
| Gap? | 静态层与运行时校验器的**双向不重合**没有测试：prompt 要求而校验不查（`confidence` 承诺、`adversarialCases` 数量、`needs_revision ⇒ requiredChanges` 非空）、校验拒绝而 prompt 未教（artificer 20+ 禁模式）都无对拍测试。已有测试各自覆盖「静态层拦住了什么」和「validator 拒了什么」，**没有一条测试断言「prompt 里教的东西被 validator 接受」。** |

严重度：**P2**。

### 4.4 Lineage 完整性

| 字段 | 内容 |
|---|---|
| Test file | `peer-runner-lineage-injection.test.ts`（`injectRunnerLineageIfAbsent` + `reconcileLineageEcho`，17 test）、`candidate-lineage.property.test.ts`、`candidate-lineage.pri717.test.ts`、`chain-integrity-attack.test.ts`、`chain-integrity-real-path.test.ts`、`internalization-chain-integrity-read-model.test.ts`、`scribe-runner-vslice.test.ts:1040-1065`、`artificer-runner-vslice.test.ts:834-1030` |
| Test type | property + unit + integration（real-path 变体用真实 store） |
| Production path? | **是**。`chain-integrity-real-path.test.ts` 明示「Real Production Path」，用真实 `RuntimeStateManager`；`reconcileLineageEcho` 被 5 个 runner 生产调用（`scribe-runner.ts:416`、`artificer-runner.ts:1119`、`dreamer-runner.ts:379`、`evaluator-runner.ts:2447`、`philosopher-runner.ts:388`） |
| Deterministic? | 是（property 测试用 seeded 随机） |
| Installed runtime? | 否 |
| Real host? | 否 |
| Real model? | 否 |
| Gap? | **R-01 的静默段无回归测试。** `philosopher-output.ts:24,42` 的字段名是 `sourceDreamerArtifactId`（必填、有 validator）；`scribe-prompt-builder.ts:78` 让 LLM 去找 `dreamerArtifactId`。全仓 `sourceDreamerArtifactId` 在 scribe 侧（prompt-builder / runner / output）**零命中**——即 scribe 从不读 philosopher 的真实字段名。当 LLM 按 prompt 省略该可选字段时，`artificer-runner.ts:274-280` 在 `Object.hasOwn(sourceTrace,'dreamerArtifactId')` 失败时**静默 return undefined**（该分支**不发事件**，与相邻的 `dreamer_context_skipped` 分支不一致）。**没有任何测试覆盖这个「字段名不匹配 → 静默丢上下文」的回路**：`peer-runner-lineage-injection.test.ts` 测的是通用 echo 机制，`scribe-runner-vslice.test.ts:1040+` 测的是 scribe **输出**里 `dreamerArtifactId` 的形状合法性，没有一条测试把 philosopher 的真实输出喂给 scribe prompt 再检查 artificer 拿到 `dreamerContext`。 |

严重度：**P1**（血缘链有一处静默断点，破坏可致代码化阶段永久丢失 dreamer 五维上下文，且 CI 全绿）。

### 4.5 Exact artifact identity

| 字段 | 内容 |
|---|---|
| Test file | `internalization/__tests__/artifact-content-hash.property.test.ts`（canonicalStringify 确定性 + 截断）、`activation/__tests__/promotion-evidence-snapshot.test.ts:41`、`promotion-readiness-reader.test.ts:53`（`artifact_digest_mismatch`）、`promotion-readiness-evaluator.test.ts:68` |
| Test type | property + unit |
| Production path? | **部分是**。`computeArtifactDigest`（`promotion-evidence-snapshot.ts:27`）是导出的公共 API，测试断言快照里的 digest 与之相等（真生产边界） |
| Deterministic? | 是 |
| Installed runtime? | 否 |
| Real host? | 否 |
| Real model? | 否 |
| Gap? | **digest 存在三处平行实现，无一致性测试。** `principles-core/.../promotion-evidence-snapshot.ts:28`、`pd-cli/src/commands/runtime-activation.ts:584`、`pd-console/src/server/models/ActivationsConsoleModel.ts:465`（另 `:443`/`:663` 两处内联同式）各自手写 `sha256:${createHash('sha256').update(JSON.stringify(artifact)).digest('hex')}`。**没有测试断言「CLI 算的 digest == Console 算的 digest」。** 一旦任一处改变序列化方法（如换 canonicalStringify），`expectedArtifactDigest` 校验会在另一入口恒 mismatch → 晋级该入口永久 blocked，而 CI 不会红。 |

严重度：**P2**（三源同形但无对拍 guard）。

### 4.6 Writer uniqueness

| 字段 | 内容 |
|---|---|
| Test file | `tests/principle-tree-ledger.lock.test.ts:118`（「a second writer fails LOUD」）、`activation/writers/__tests__/rule-host-writer.test.ts`（27 test）、`activation/__tests__/low-risk-writers.test.ts`、`activation/__tests__/activation-dispatcher.test.ts`（`idempotency_artifact_mismatch`）、`architecture-regression.test.ts:2418-2465`（CORE_PURE / SHADOW_AFTER_APPROVAL / USES_GATE / IMPLEMENTS_CHANNEL_WRITER） |
| Test type | unit + integration + architecture guard |
| Production path? | **是**。`RuleHostWriter` 在 4 处生产 wire（`pd-cli:322/570/1378`、`pd-console/ActivationsConsoleModel:453`、`pd-console/ApprovalsConsoleModel:410`、`host-runtime/internalization-consumer-governance:113`），测试直接断言其行为 |
| Deterministic? | 是 |
| Installed runtime? | 否 |
| Real host? | 否 |
| Real model? | 否 |
| Gap? | 「同一原则同时只有一份 live」的**唯一性**只有 `sqlite-activation-safety-store.test.ts:217`（`atomically supersedes the prior live version for the same Principle`）一条测试，且是**手工构造的 store 单测**，不是「两个 dispatcher 并发 dispatch」的生产并发场景。`activations` 表的唯一索引只有 `idx_activations_idempotency`（`sqlite-connection.ts:450`），**没有**「(principle_id) WHERE action='…live_activate' AND deactivated_at IS NULL」的部分唯一索引——即唯一性由应用层 supersede 逻辑而非 DB 约束保证。 |

严重度：**P2**。

### 4.7 Owner gate

| 字段 | 内容 |
|---|---|
| Test file | `activation/__tests__/rulecode-owner-decision-service.test.ts`（10 test）、`promotion-readiness-evaluator.test.ts`、`promotion-readiness-reader.test.ts`、`openclaw-promotion-checks.test.ts`、`approval-queue.test.ts`、`sqlite-approval-store.test.ts`、`sqlite-activation-safety-store.test.ts`、`story-a-acceptance.test.ts:203-262`、`pd-console/tests/server/routes/activations-disable.test.ts:246-254`、`pd-console/tests/ui/owner-decision-ui-contract.test.ts`、`pd-console/tests/bdd/rulecode-owner-live-decision.steps.test.ts`、`.feature: rulecode-owner-live-decision`（17 scenario，`steps.test.ts:10` 断言「all seventeen」可执行）、`pd-console/tests/e2e-owner/rulecode-owner-governance.spec.ts`（真实 Playwright + 真实 console + 真实 Owner token） |
| Test type | unit + integration + BDD + E2E |
| Production path? | **是**。`e2e-owner` 用真实 console 进程 + 真实 `Console` token + 真实 HTTP，断言 DB 里的 `activation_decisions` 记录（`spec.ts:31-40`） |
| Deterministic? | 是（LLM 不参与） |
| Installed runtime? | 否（跑的是 repo checkout 构建产物） |
| Real host? | 否 |
| Real model? | 否 |
| Gap? | **`POST /activations/:id/disable` 这条停用路径不经过 Owner gate，且无授权语义测试。** `activations.ts:138-201` 的 disable 分支不读 `authority`（该分支既无 `ownerActor` 检查，也不像同文件 `:101` 的 mutation 分支那样 `if (!actor) → 403`）；model 侧 `deactivateActivation`（`ActivationsConsoleModel.ts:673-708`）用 `authorizeGovernanceAction` 只写**审计日志行**（`actions.ts` 的 `actor: 'session'`），**不写 `activation_decisions`**，也不读 `activation_control_states`。对照 `emergency-deactivate`（同文件 mutation 分支）要求 Owner identity。现有 `activations-disable.test.ts` 的 7 处 disable 调用**全部不传 authority 参数**——即完全没有「未认证能不能 disable」的负例。 |

严重度：**P2**（与 R-20 一致：授权不对称且无测试守住这条不对称）。

### 4.8 Activation

| 字段 | 内容 |
|---|---|
| Test file | `activation/__tests__/activation-dispatcher.test.ts`（30+ test，含 dry-run/confirm、`F9-3` 幂等、rollback 相关）、`activation-re-dispatch.test.ts`、`approval-completion-service.test.ts`、`edit-then-approve.test.ts`、`story-a-acceptance.test.ts`（六步价值链 + rollback + 幂等 + flag-off + malformed JSON）、`mvp-core-loop-journeys.test.ts`（Journey 5–8）、`openclaw-plugin/tests/integration/rulehost-seed-mvp-e2e.test.ts`（PRI-492 全链 pain→deactivate） |
| Test type | integration（真实 SQLite + 真实 dispatcher + 真实 runner，仅 LLM 用 scripted adapter） |
| Production path? | **是**。`rulehost-seed-mvp-e2e.test.ts` 明示「No artifacts or activations are inserted directly into the DB — the chain goes through real runners → real validators → real approval queue → real dispatcher → real RuleHostWriter → real RuleHost」 |
| Deterministic? | 是 |
| Installed runtime? | 否 |
| Real host? | 否（`RuleHost` 是 plugin 类，但 host hook 未接入） |
| Real model? | 否（scripted adapter） |
| Gap? | ①`rulehost-seed-mvp-e2e.test.ts` 是**单文件长链**，任一环节改动即整体失败——保护强度高但**定位能力差**，且它归属 openclaw-plugin integration job（不在 verify:merge）。②**零 LLM** 意味着 prompt 契约的缺陷（§4.2 / §4.4）在这条「全链」上完全看不见——scripted adapter 直接产出合法形状。 |

严重度：**P3**（保护本身可靠，是定位与真实性缺口）。

### 4.9 Host parity

| 字段 | 内容 |
|---|---|
| Test file | `openclaw-plugin/tests/bdd/openclaw-shared-host-runtime-parity.steps.test.ts`（+ `published-host-runtime-bundle.test.ts`，二者由 `vitest.parity.config.ts` 同 worker 跑）、`codex-adapter/tests/pd-hook.production.test.ts`（绑定 `codex-shared-host-runtime.feature`，spawn 真实 `dist/pd-hook.js`）、`codex-adapter/tests/g1-host-runtime-contract.test.ts`、`host-runtime/tests/production-host-runtime.test.ts`（25 test）、`host-tool-semantic-resolver.test.ts`（codex + openclaw 双宿覆盖）、`pd-skill...` |
| Test type | BDD + integration + contract |
| Production path? | **是**。Codex 侧 `spawnSync(dist/pd-hook.js)` 是真实生产入口；OpenClaw 侧走 `createProductionHostRuntime` |
| Deterministic? | 是 |
| Installed runtime? | 否 |
| Real host? | **Codex：是（真实 subprocess + 真实 fixture payload，v0.148.0/v0.150.1）**；OpenClaw：否（in-process 模拟） |
| Real model? | 否 |
| Gap? | **Codex 侧无 shadow 证据通道，且没有任何测试发现这件事。** `HostEventEmitter`（`host-adapter.ts:181-184`）只有 `recordRuntimeV2ActivationsInjected` / `recordToolCall`——**没有** `recordRuleHostEvaluated`。Codex 的 emitter（`codex-adapter/src/pd-hook.ts:25-47`）也只实现这两个。而 shadow 证据的唯一读入口 `rulecode-shadow-summary.ts:32` 只认 `type === 'rulehost_evaluated' && data.activationMode === 'shadow'`（写入方是 OpenClaw 独占的 `EventLogService.recordRuleHostEvaluated`，`openclaw-plugin/src/hooks/gate.ts:117`）。→ **Codex 宿主上 promote 结构性不可达**（`promotion-readiness-evaluator.ts:40-42` 见 `observed === null` 即 `shadow_telemetry_source_unavailable`）。`rg 'rulehost' packages/codex-adapter/` **零命中**——Codex 侧没有一条测试断言 shadow 事件的存在或缺失。 |

严重度：**P2**（与 R-22 一致；「测试没有假装它存在」，而是**整块面缺失**）。

### 4.10 Installed runtime

| 字段 | 内容 |
|---|---|
| Test file | `create-principles-disciple/tests/smoke-packaged-install.test.ts`（15 test，含「install to clean temp HOME succeeds」「pd console starts and /api/health returns 200 on loopback」「console refuses --no-auth with non-loopback host」「failure injection: missing console triggers rollback」「never mutates the repository source tree」）、`release-asset-smoke.test.ts`（5 test）、`installer.test.ts`、`legacy-rule-preflight.test.ts`（26 test） |
| Test type | **E2E smoke（最接近真实安装的资产）** |
| Production path? | **是**。临时 HOME + 真实 `npm pack` 产物 + 真实子进程启动安装后的 console server + 真实 HTTP 探活 |
| Deterministic? | 是（但依赖真实 npm registry 解析：`Registry-resolved dependency install (npx parity)` 那一条；`self-contained bundle installs with no npm invocation` 用 npm poison marker 保证不走 npm） |
| Installed runtime? | **是**（这是唯一真正跑安装后运行时的资产） |
| Real host? | 部分（fake `openclaw` binary 只用于 version 探测） |
| Real model? | 否 |
| Gap? | ①**安装后不跑任何 hook**：smoke 只启动 console + 探活 HTTP，**不执行 `pd-hook`、不检查安装后的 RuleCode 执行能力、不检查安装后的 `~/.pd/runtime` 与 repo 的一致性**。②该 smoke 在 CI 是**独立 job**，不在 verify:merge。③`scripts/dev/codex-r1-installed-gate.mjs`（针对真实安装运行时的 4-gate 验证）**不在任何 workflow 中**（`rg` 无命中）——即它是手工脚本，CI 从不运行。④仓库根的 `tests/tools` 类资产（`tests/e2e-harness.test.ts` 等）**不在任何 vitest include / workflow 中**。 |

严重度：**P2**（有真实安装 smoke，但安装后行为面几乎未覆盖；且 CI 不跑）。

### 4.11 Upgrade

| 字段 | 内容 |
|---|---|
| Test file | `create-principles-disciple/tests/{release-contracts,release-manager,release-manager-apply,release-manager-authority,channel-promotion,transaction-recovery,installer-active-record,rollback-policy}.test.ts`、`tests/bdd/update-system.steps.ts`（绑 `commercial-update-system.feature`，用真实 ReleaseManager + 真实 journal + 本地 TUF fixture）、`pd-console/tests/server/routes/update.test.ts`（83 test）/ `update-gateway-coordination.test.ts` / `update-history.test.ts` |
| Test type | unit + contract + BDD + integration |
| Production path? | **是**（ReleaseManager/installer 是生产更新入口；update route 是 console 生产入口） |
| Deterministic? | 是 |
| Installed runtime? | **否** |
| Real host? | 否 |
| Real model? | 否 |
| Gap? | **没有 N-1 → N 的「真实上一版安装 → 升级到新版」端到端测试。** 现有资产分两半：①`installer-active-record.test.ts:105-123` 用**两个手工构造的 journal payload**（`plugin: 1.230.2` → `1.231.0`）验证 `previousReleaseId` 链接与 generation 推进——是**纯记录层**，不涉及真实安装树；②`release-manager-apply.test.ts:97+` 的 happy path 在**一个 fixture HOME** 上跑一次 `manager.apply()`，不是「先装旧版再装新版」。同类：`rollback-policy.test.ts:96-121` 的数据兼容窗口判定是**纯函数**（`evaluateDataCompatibility`），`smoke-packaged-install.test.ts:531` 的 rollback 是「安装中途失败回滚」，**不是**「升到新版后发现不对 → 回退到旧版」。全仓无 `PRI-671` 相关资产（`git log --all --grep=PRI-671` 空）。 |

严重度：**P1**（升级路径是「能不装坏机器」的核心 invariant，当前只有记录层/纯函数级保护，「真实旧版 → 新版」的整链零覆盖；且 `docs/audit/install-upgrade-investigation-2026-09-05.md:66` 已实证过 upgrade 曾 FAIL）。

### 4.12 Rollback

| 字段 | 内容 |
|---|---|
| Test file | `activation/__tests__/story-a-acceptance.test.ts:465-515`（rollback 后 reader 不再返回规则）、`activation/__tests__/sqlite-activation-safety-store.test.ts:336`（promotion 事务回滚）、`create-principles-disciple/tests/rollback-policy.test.ts`（host 协调 + 数据窗口 + 熔断）、`smoke-packaged-install.test.ts:531`（安装失败回滚）、`pd-console/tests/server/routes/update.test.ts:745+`（`POST /rollback`）、`pd-console/tests/e2e-owner/rulecode-owner-governance.spec.ts:37-48`（`reject-after-shadow` → 真实 deactivate） |
| Test type | integration + E2E + unit |
| Production path? | **是**（激活层 rollback 与 console rollback route 都是生产入口） |
| Deterministic? | 是 |
| Installed runtime? | **仅安装失败回滚那一条**（`smoke-packaged-install` 含真实 install） |
| Real host? | 否 |
| Real model? | 否 |
| Gap? | **激活层 rollback 只覆盖「单条规则停用」，不覆盖「全局紧急暂停 → 恢复」的完整授权链。** `emergency-pause` / `emergency-pause/:id/release` 有测试（`activations-disable.test.ts:257-272` 覆盖 break-glass 暂停），但**没有**测试覆盖「暂停期间 host 调用确实放行（fail-open）」在真实 host 路径上的行为（`host-runtime/tests/production-host-runtime.test.ts:366` 有 `fails open while the durable global RuleCode pause latch is active`——**这一条是覆盖的**）。缺的是：**升级侧的真实回退**（见 §4.11）与**跨入口 rollback 一致性**（CLI deactivate vs Console disable vs emergency-pause 三条路径写不写 `activation_decisions` 各不相同，无对拍测试）。 |

严重度：**P2**（激活层单点回滚覆盖良好；升级侧与跨入口一致性是缺口）。

### 4.13 Behavior adaptation

| 字段 | 内容 |
|---|---|
| Test file | `activation/__tests__/prompt-activation-reader-contract.test.ts`（filterPromptActivations / trimToBudget / renderPrinciplesToDirectives）、`openclaw-plugin/tests/bdd/{principle-application-ledger,receipt-self-report,principle-receipt-block-copy,pd-context-receipt}.steps.test.ts` + 对应 4 个 `.feature`、`openclaw-plugin/tests/hooks/{gate-receipt-integration,receipt-runid-binding}.test.ts`、`openclaw-plugin/tests/core/{principle-application-ledger,principle-receipt-metadata}.test.ts`、`pd-console/tests/{bdd/console-receipt-history.steps.test.ts,models/receipts-console-model.test.ts,ui/receipt-semantics.test.ts}`、`host-runtime/tests/receipt-runid-emission.test.ts` |
| Test type | BDD + integration + unit |
| Production path? | **是**（receipt 写入走真实 `principle_applications` 表；`console-receipt-history` 走真实 console 数据源） |
| Deterministic? | 是 |
| Installed runtime? | 否 |
| Real host? | 否 |
| Real model? | 否（自述行由测试文本注入） |
| Gap? | ①**「行为是否真的改变」的度量**只有 `pd-console/src/server/models/ActivationsConsoleModel.ts:537` 的 `behaviorDrift{approvedBlockRate, liveBlockRate, delta}`——**唯一**的测试是 `activation-page.test.ts:72` 的「null 透传 + 脏数据拒绝」，即只测**校验器**，`delta` 的算术与语义无测试。②receipt 侧的 self-report 明确声明是 probabilistic（`.feature` 的「诚实边界」段），捕获侧有 `PRI-755` 的「id 必须在注入集合中」校验（`principle-application-ledger.test.ts:46-170`，覆盖良好）。③**无「原则生效后 agent 行为实际改变」的端到端资产**——`.feature` 全是「模板渲染 / 行写入 / 去重」的机械断言。 |

严重度：**P2**（度量字段存在但语义无保护；E2E 行为观察面为空）。

---

### 4.14 R-19 的 F 面（只记事实，不提供修复方案）

R-19（#1710 CONFIRMED 的 P1）：RuleCode 沙箱信任边界——静态禁门可被字符串/模板拼接绕过；core 侧两条 vm 预处理路径把宿主 realm 的 input/helpers 直接注入 vm。

#### 4.14.1 现有测试对静态禁门的保护

| 测试资产 | 覆盖 | 是否打在生产边界 |
|---|---|---|
| `openclaw-plugin/tests/core/sandbox-escape-regression.test.ts`（非穷尽回归网，自述如此） | 15 个 payload：`this.constructor.constructor("return process")`、`globalThis`、`import.meta`、`WeakRef`、`FinalizationRegistry`、`SharedArrayBuffer`、`Atomics`、`Reflect.construct`、`Proxy`、`require`、`import`、`eval`、`Function`、`globalThis["process"]`、`globalThis["WeakRef"]` | 是（直接调用 core 的 `checkForbiddenPatterns`） |
| `rule-code-dialect.test.ts:377-403`（SEC-BASE-2 段） | `import.meta` / `WeakRef` / `FinalizationRegistry` / `SharedArrayBuffer` / `Atomics` + `globalThis['WeakRef']` 括号访问 | 是 |
| `architecture-regression.test.ts:4082-4107`（SEC-BASE-2） | 同上 5 类 + `rule-implementation-runtime.ts` 的 `spawnSync`/`maxBuffer`/`--max-old-space-size`/`timeout` 源码字符串断言 | 部分（源码字符串断言，非行为） |
| `host-runtime/tests/rule-implementation-runtime.test.ts:12` | **`constructor.constructor` 链的对抗 payload**：遍历 `input` / `helpers` 两个注入对象，尝试 `attempts[i].constructor.constructor` → `Function('return process')()`，断言**逃逸被阻断**（期望 `reason: 'escape_blocked_all_vectors'`） | **是（真实 `createNodeRuleImplementationRuntime().evaluateBatch`，真实 subprocess）** |
| `activation/__tests__/production-gate-deps.test.ts` | 20 条，含 `rejects code with forbidden patterns (e.g., require)`（`:82`）、`matched=false` 组合、vm 输出枚举校验、prototype-pollution 键（`:407`） | 是（真实 `createProductionGateDeps`） |
| `internalization/__tests__/refiner-sandbox-wrapper.test.ts` | 40+ 条，含 `triggers forbidden_pattern before evaluation and does not evaluate`（`:95`，payload 为 `require('fs')`） | 是 |

#### 4.14.2 对抗性输入的覆盖判定（逐类）

| 攻击形态 | 静态门当前结果 | 是否有回归覆盖 | 判定 |
|---|---|---|---|
| `this.constructor.constructor("return process")()` 字面 | **拦截**（`\bconstructor\b` 命中） | **有**（`sandbox-escape-regression.test.ts`） | CONFIRMED 覆盖 |
| `globalThis['WeakRef']` / `globalThis["process"]` 括号访问 | **拦截**（专门的 bracket-access pattern） | **有**（两处） | CONFIRMED 覆盖 |
| `constructor` 作为标识符出现（如 `field: 'constructor'`） | **拦截** | 有（`correction-proposal.test.ts`、`rulehost-oob-defense-simulation.test.ts`） | CONFIRMED 覆盖 |
| **字符串拼接绕过**：`input['con'+'structor']['con'+'structor']('return process')()` | **未拦截**（本地复现：`checkForbiddenPatterns` 返回 `[]`） | **无任何测试** | **NEW / 零覆盖** |
| **模板拼接绕过**：``input[`con${''}structor`]`` | **未拦截**（返回 `[]`） | **无** | **NEW / 零覆盖** |
| **转义 unicode**：`input['\u0063onstructor'](...)` | **未拦截**（返回 `[]`） | **无** | **NEW / 零覆盖** |
| **`String.fromCharCode` 构造**：`input[String.fromCharCode(99)+'onstructor']` | **未拦截**（返回 `[]`） | **无** | **NEW / 零覆盖** |

**机制说明（本地复现，非推断）**：
1. 复现 `input['con'+'structor']['con'+'structor']('return process')()` 在宿主 realm 对象注入的 vm context 下**成功取到宿主 `process`**（打印出 `v24.21.0`）。
2. 同一 payload 过 `checkForbiddenPatterns` → **`[]`**（无任何 label 命中）。
3. 关键区别：`host-runtime/src/rule-implementation-runtime.ts:33` 的**子进程路径**只把 `JSON.stringify(input)` 传入，context 内 `JSON.parse` 重建对象 → 逃逸无路（`rule-implementation-runtime.test.ts:12` 正是覆盖了这个**已受保护**的路径）。
4. 而 core 侧两条路径把**宿主 realm 对象直接传给 rule 函数**：
   - `activation/production-gate-deps.ts:91`（`vm.createContext`）+ `:112`（`Reflect.apply(evaluateFn, undefined, [input, helpers])`，input/helpers 来自宿主）
   - `internalization/refiner-sandbox-wrapper.ts:153`（`createSyntheticRuleHostInput(...)` 宿主构造）+ `:171`（`evaluateFn(input, helpers)`）
   - 两条路径都**先查** `checkForbiddenPatterns`（`production-gate-deps.ts:166`、`refiner-sandbox-wrapper.ts:264`）——即拼接变体会**通过静态门**，然后进入含宿主对象的 vm。

#### 4.14.3 事实判定

- 静态门（`rule-code-validator.ts:83` 的 `checkForbiddenPatterns`）对**字面** `constructor` 在**标识符语境**有效；对**运行期拼接出的字符串**在括号访问语境**无效**——这是 masking 设计的直接后果（字符串字面量内容被空白化，只有 bracket-access 那条 pattern 扫原始源，而它只匹配**字面**的禁用全局名清单，不匹配拼接结果）。
- **4 类拼接/编码变体当前回归覆盖为 0**，其中「拼接 + 宿主对象注入」组合可实际逃逸（本地复现成立）。
- 生产 live gate 走子进程（`rule-implementation-runtime.ts`）**不受影响**，且其逃逸面有 `rule-implementation-runtime.test.ts:12` 覆盖。
- **受影响面**：评估/激活预检（`createProductionGateDeps`）、refiner sandbox replay——两者均是 core 公共工厂，被 pd-cli / pd-console / host-runtime 生产 wire。
- **受影响断言**：`sandbox-escape-regression.test.ts` 头部自述「NON-EXHAUSTIVE — they cover canonical escape patterns, not all possible exploits」，因此现有测试**没有错误声称**覆盖完整性；缺的是拼接类变体的独立负例。

严重度判定：**P1**（与 R-19 的 #1710 定级一致；且新增事实是「现有测试对拼接变体覆盖为 0」，这是 R-19 的 F 面结论）。

---


---

## 5. Confirmed / Fixed / Drifted（对任务书 §5 Carry-forward 各项的裁决）

### 5.1 verify:merge 覆盖面 vs「merge gate 绿 = 安全」的直觉差距 — **CONFIRMED**

- `package.json:40` 实测：16 步，其中**只有 1 个测试文件**（`release-target-matrix.test.ts`）+ website 包测试。
- **不含** `principles-core` / `openclaw-plugin` / `pd-cli` / `pd-console` / `pd-companion` / `codex-adapter` / `install-layout` 的 vitest 全量。
- **不含**任何 BDD 场景（`docs/adr/0018-...md:62` 明文声明）。
- **不含** `test:scripts`、`smoke-packaged-install`、`release-asset-smoke`、`e2e-nightly`（后两者是独立 CI job；`e2e-nightly` 是 scheduled，**PR 不跑**）。
- 附加漂移：`docs/process/TESTING.md:163` 与 `docs/adr/0018-...md:28` 仍称「9 checks」。
- **结论**：verify:merge 是「静态门 + lint + build + typecheck」门禁，**不是**测试门禁。`verify:merge` 绿**不能**推出任何 invariant 被保护。
- 严重度：P1（这条直觉本身就是最大风险源）。

### 5.2 R-04（P1）Stage C 缓存复用旁路校验 — **PARTIAL**

- 代码现状：`split-diagnostician-runner.ts:179-206`。`JSON.parse` 失败 → `cacheUsable=false` → 重跑 Stage C（**parse 失败分支是 fail-safe**）；parse **成功**时 `parsedOutput as DiagnosticianOutputV1` 直接作为结果（`:205`）。
- 测试现状：`split-diagnostician-runner-retry.test.ts:508-619` 有**两条**测试：`falls through to re-run Stage C when cached outputPayload is corrupt JSON`（负例，用 `'{ this is not: [valid json, }'`）与 `uses cached succeeded output when outputPayload is valid JSON`（正例）。
- **缺口确凿**：**没有**「payload 是合法 JSON 但结构非法」的负例。即 `'{"valid":true}'`（可 parse、缺 `diagnosisId/summary/rootCause/confidence`）这条路径**无测试**，而它会**原样**作为 `DiagnosticianOutputV1` 流向 admission/落库/seed。
- 严重度：P1（rc-1/rc-2 违反且负例缺失；CI 全绿）。

### 5.3 R-20（P2）Console 停用路径授权语义 — **CONFIRMED**

- `activations.ts:138-201`：disable 分支**不读 `authority`**，无 `403 owner_authentication_required`（对照同文件 `:101` 的 mutation 分支有）。
- `ActivationsConsoleModel.ts:684-695`：用 `authorizeGovernanceAction(..., { actor: 'session', reasonCode: 'console_disable_confirmed' })` → 该 helper（`openclaw-plugin/src/governance-audit.ts:18-26`）只**写审计日志 + 执行 mutation**，**不写 `activation_decisions`**，不读 `activation_control_states`。
- 测试：`activations-disable.test.ts` 的 7 处 disable 调用**全部不传 authority**；唯一授权测试在 `owner-review` / `continue-observing` / `emergency-pause` 上（`:224-272`）。
- **结论**：授权语义不仅缺失，而且**没有任何测试断言它缺失**（即不对称被固化为隐式契约）。
- 严重度：P2。

### 5.4 R-22（P2）Codex `rulehost_evaluated` 缺失 — **CONFIRMED（比 R-22 更宽）**

- `HostEventEmitter`（`host-adapter.ts:181-184`）只有 2 个方法；`RuleHost` 评估事件的写入方是 OpenClaw 独占的 `EventLogService.recordRuleHostEvaluated`（`openclaw-plugin/src/hooks/gate.ts:117/134/584`）。
- Codex emitter（`codex-adapter/src/pd-hook.ts:25-47`）只实现 2 个方法 → Codex 宿主上**不存在** shadow 证据写入路径。
- 读侧：`rulecode-shadow-summary.ts:32` 只认 `rulehost_evaluated`，`ActivationsConsoleModel.ts:233/242`（live metrics）同样只认 `rulehost_evaluated`。
- `rg 'rulehost' packages/codex-adapter/` **零命中** → 测试**没有假装它存在**，而是**整块面缺失**（既无正例也无「预期缺失」的声明性断言）。
- 严重度：P2（Codex 上 promote 结构性不可达，且无 guard 记录这个事实）。

### 5.5 J1–J4 四条 Journey 的测试资产现状

任务书定义的 J1–J4 与仓库现有 Journey 编号**不同**（仓库有 Journey 5–8 在 `mvp-core-loop-journeys.test.ts`，Journey 11 在 `restart-safety.e2e.test.ts`，**没有** J1–J4）。按任务书的语义归属逐一裁决：

#### J1 = Pain → Approval → Activation → Receipt

- **已有资产**：
  - pain → approval → activation：`activation/__tests__/story-a-acceptance.test.ts:67-202`（真实 SQLite 六步价值链，含 prompt channel 与 code_tool_hook channel 两条）；`openclaw-plugin/tests/integration/rulehost-seed-mvp-e2e.test.ts:641+`（pain → … → shadow → promote → live block → flag-off → deactivate，全链无 DB 直插）。
  - approval → activation 的 Console 侧：`pd-console/tests/integration/governance-approve-activation.test.ts`、`pd-console/tests/e2e/focus-approve-flow.spec.ts`。
  - activation → receipt：`pd-console/tests/bdd/console-receipt-history.steps.test.ts`、`openclaw-plugin/tests/bdd/principle-application-ledger.steps.test.ts`、`host-runtime/tests/receipt-runid-emission.test.ts`。
- **断点位置**：**没有任何单条测试把四段串起来。** 全仓搜索「同时含 `principle_applications` 且含 approval 且含 activation」的测试文件 → 仅 `architecture-regression.test.ts`（字符串断言，非行为）。四段各自有 integration/BDD 覆盖，但**「pain 事件 → approval 行 → activation 行 → receipt 行」的一次端到端断言不存在**。`story-a-acceptance.test.ts` 的「Step 1: Capture pain（simulated as a validated principle artifact）」——**pain 是模拟的**，receipt 也未断言（全文件 `principle_applications` 零命中）。
- 严重度：**P1**（J1 是 MVP-Core 主链，其「端到端」目前是四段拼接的信任，不是验证过的事实）。

#### J2 = RuleCode 全链

- **已有资产**：`rulehost-seed-mvp-e2e.test.ts`（最完整：真实 runner 链 + 真实 adversarial loop + 真实 approval + 真实 dispatcher + 真实 RuleHostWriter + 真实 RuleHost）；`activation/__tests__/production-gate-deps.test.ts`（canonical 工厂）；`openclaw-plugin/tests/hooks/gate-rule-host-real-pipeline.test.ts`（真实 SQLite activation → 真实 `handleBeforeToolCall`）；`openclaw-plugin/tests/hooks/gate-rule-context-v2.vm-e2e.test.ts`（真实 VM）；`codex-adapter/tests/pd-hook.production.test.ts`（spawn 真实 pd-hook）。
- **断点位置**：①**零 LLM**——`rulehost-seed-mvp-e2e.test.ts` 用 scripted adapter，因此 §4.2 / §4.4 的 prompt 契约缺陷在这条「全链」上不可见。②J2 的**宿主面不对称**：OpenClaw 侧有真 hook 集成，Codex 侧有真实 subprocess 但没有 shadow 证据（§5.4）。③该文件在 `openclaw-plugin/tests/integration/`，属 `test-openclaw-plugin-integration` job（10 min timeout），**不在 verify:merge**。
- 严重度：P2。

#### J3 = Revision-Recovery

- **已有资产（本项覆盖最厚）**：`mvp-core-loop-journeys.test.ts` Journey 5–8（evaluator needs_revision 无旁路 + repair reopen、级联 reopen、repair 耗尽 → needs_human_review、rollout needs_revision → scribe reopen）；`internalization-transition-decision.test.ts`（`decideInternalizationTransition` 纯函数 9 条 + orchestrator gate 7 条）；`evaluator-{approved-replay-failed-repair,artificer-repair-replay,repair-loop}`；`owner-retry.test.ts`；`restart-safety.e2e.test.ts`（Journey 11）；`recovery-sweep-service.test.ts`、`store/lifecycle/{recovery-sweep,retry-policy,lease-manager}`。
- **断点位置**：①修订轮的真实 LLM 行为无覆盖（同 J2）。②`host-runtime/src/internalization-consumer-governance.ts`（生产 auto-consumer 的 revision reopen 实现）只有 `internalization-consumer-cycle-*.test.ts` 三个文件覆盖，其中与 revision 相关的断言集中在 per-agent-profile 与 telemetry 两侧，**不是** revision 语义本身。
- 严重度：P3（覆盖足够，缺真实 LLM 面）。

#### J4 = Rollback

- **已有资产**：激活层（§4.12）；升级层（§4.11）；`sqlite-activation-safety-store.test.ts:336`（promotion 事务原子回滚）；`pd-console/tests/server/routes/update.test.ts:745+`（`POST /rollback`）。
- **断点位置**：**「升到新版 → 发现不对 → 回退到旧版并在旧版上继续工作」的端到端不存在**（§4.11 已详）。另：`update.test.ts:745` 的 rollback 测试是**手工建 `targetDir`/`backupDir` + 写两个 package.json**，只断言 route 返回 200——**不校验回退后运行时可用**。
- 严重度：**P1**（回退是最后一道保命线，当前只有「route 返回成功」级别的保护）。

---

## 6. NEW Findings

### NEW-F1 — 6 个测试文件永不执行（配置口径漏）

- **ID**：NEW-F1
- **Severity**：**P2**
- **Claim**：`principles-core` 与 `openclaw-plugin` 各有测试文件落在 `vitest.config.ts` 的 `include` 口径外，共 **6 个文件 / 49 个断言**永不执行。
- **Evidence**：
  - principles-core：`vitest.config.ts:6` 的 `include` 只含 `'src/runtime-v2/internalization/__tests__/**/*.test.ts'`；落位在外的是 `src/runtime-v2/internalization/{deprecated-readiness(6),lifecycle-metrics(13),lifecycle-read-model(12),routing-policy(6)}.test.ts`
  - 这 4 个模块是公共导出：`src/runtime-v2/index.ts:776-789`（`computeRuleMetrics` / `computePrincipleAdherence` / `assessDeprecatedReadiness` / `recommendLifecycleRoute` / `buildLifecycleReadModel`）
  - `architecture-regression.test.ts:501-502` 注释承认「`lifecycle-read-model.test.ts` is at internalization/lifecycle-read-model.test.ts, not in `__tests__/`」并主动注释掉存在性断言
  - openclaw-plugin：`vitest.config.ts:40` 的 `include` 只有 `'tests/**/*.test.ts(x)'`；落位在外的是 `src/core/__tests__/focus-history.test.ts`（7）与 `src/core/principle-compiler/__tests__/compiler-replay-gate.test.ts`（5）；`vitest.unit.config.ts` / `vitest.parity.config.ts` 继承该 include 且无补丁
- **Why it matters**：`verify:merge` 与 CI 全绿**不代表**这 49 个断言通过——它们从不运行。真实回归会静默进入 main。
- **Affected stage**：内化生命周期读模型 / 路由策略 / 弃用就绪（Owner 可见的 lifecycle 视图）
- **Current protection**：**零**（无其他测试覆盖这 6 个模块的行为）

### NEW-F2 — Stage C 缓存「可 parse 但非法」payload 无负例

- **ID**：NEW-F2
- **Severity**：**P1**
- **Claim**：R-04 的负例只覆盖「JSON 不可 parse」，不覆盖「JSON 可 parse 但结构非法」。
- **Evidence**：
  - 代码：`split-diagnostician-runner.ts:190-206`；`:205` 为 `output: parsedOutput as DiagnosticianOutputV1`
  - 测试：`split-diagnostician-runner-retry.test.ts:509`（corrupt JSON，唯一负例）、`:567`（valid JSON，正例）；两例的 payload 分别是 `'{ this is not: [valid json, }'` 与完整合法对象
- **Why it matters**：`'{}'` 或 `'{"valid":true}'` 会原样当作 `DiagnosticianOutputV1` 直达 admission / 落库 / seed——违反 rc-1/rc-2，且 CI 全绿。
- **Affected stage**：诊断 Stage C（router）→ admission → candidate seed
- **Current protection**：仅「parse 失败」分支（该分支已 fail-safe）

### NEW-F3 — Prompt 示例与自身 validator 的双向不重合无任何机械保护

- **ID**：NEW-F3
- **Severity**：**P1**
- **Claim**：artificer 的 `OUTPUT FORMAT` 示例不含 v2 硬契约字段，而 validator 强制要求；无任何测试把示例喂给 validator。
- **Evidence**：
  - 示例块：`artificer-prompt-builder.ts:169-186`（本地逐字抽取：`requiresContextVersion` / `evidenceRefs` / `ruleContext` 三者均缺失）
  - validator 要求：`artificer-output.ts:271-284`（`requiresContextVersion` 必须为 2）、`:305-329`（v2 时 case 级 `ruleContext` 必填）、`:386-392`（v2 时 `evidenceRefs` 非空）
  - 强制门：`artificer-runner.ts:537`（`validateV2OutputContract`：`output.requiresContextVersion !== 2` → 错误）
  - 现有测试：`artificer-prompt-builder.test.ts:100-102` 只断言示例**不含** `write_file`；`artificer-prompt-builder-v2.test.ts:53` 断言 systemPrompt 里**提到** `requiresContextVersion`——非「示例合法」
- **Why it matters**：逐字模仿示例的 LLM 输出**必然**被拒 → 每次走到 artificer 白烧重试（历史 EP002 单轮 165 分钟级）；而这是 `docs/audit/.../REPORT.md:2330` 家族一（示例机械合成）的 F 面——**测试侧对此零防护**。
- **Affected stage**：artificer（代码化）→ evaluator → rollout
- **Current protection**：零（schema↔schema parity 有，prompt↔schema parity 无）

### NEW-F4 — 血缘字段名不匹配导致的静默丢上下文无回归测试

- **ID**：NEW-F4
- **Severity**：**P1**
- **Claim**：philosopher 输出真实字段名 `sourceDreamerArtifactId`，scribe prompt 让 LLM 找 `dreamerArtifactId`；字段名不匹配 → artificer 静默 undefined 且不发事件。无任何测试覆盖该回路。
- **Evidence**：
  - `philosopher-output.ts:24,42`（`sourceDreamerArtifactId`，必填 + validator）
  - `scribe-prompt-builder.ts:78`（`"dreamerArtifactId": "<from philosopher artifact if available, or omit>"`）
  - `rg 'sourceDreamerArtifactId' scribe-{prompt-builder,runner,output}.ts` → **零命中**
  - `artificer-runner.ts:274-280`：`Object.hasOwn(sourceTrace,'dreamerArtifactId')` 失败 → `return undefined`（**不发事件**）；相邻的 `:277-284` `dreamerArtifactId_not_string` 与 `dreamer_artifact_missing` 分支**都发事件**——不一致
  - 测试：`peer-runner-lineage-injection.test.ts` 测通用 echo 机制；`scribe-runner-vslice.test.ts:1040+` 测 scribe **输出**字段形状合法性；**无**交叉喂入测试
- **Why it matters**：dreamer 五维上下文对代码化阶段**静默消失**（违反 rc-9），代码化质量的输入面悄悄退化，CI 全绿。
- **Affected stage**：scribe → artificer（dreamerContext 注入）
- **Current protection**：零（只测了各段字段形状，没测跨段字段名一致性）

### NEW-F5 — 升级路径无「真实旧版 → 新版」端到端

- **ID**：NEW-F5
- **Severity**：**P1**
- **Claim**：N-1 → N 的整链零覆盖；现有资产是记录层单测 + 纯函数判定 + 单次 apply。
- **Evidence**：
  - `installer-active-record.test.ts:105-123`：手工构造两个 journal payload 验 `previousReleaseId` 链接（记录层）
  - `rollback-policy.test.ts:96-121`：`evaluateDataCompatibility` 纯函数
  - `release-manager-apply.test.ts:97-200`：单次 `manager.apply()`，非「先装旧版」
  - `smoke-packaged-install.test.ts:531`：安装中途失败回滚，非版本回退
  - `git log --all --grep=PRI-671` → 空（任务书提到的「PRI-671 相关资产」在仓库历史中不存在）
  - `docs/audit/install-upgrade-investigation-2026-09-05.md:66-67`：曾实测 upgrade `PARTIAL`/`FAIL`
- **Why it matters**：升级是「不装坏机器」的核心 invariant；当前保护级别低于其风险级别。
- **Affected stage**：installer / ReleaseManager / console update
- **Current protection**：记录层 + 纯函数 + 单次 apply（无一覆盖真实旧安装树 → 新安装树）

### NEW-F6 — Codex 宿主无 `rulehost_evaluated` 通道且无 guard

- **ID**：NEW-F6
- **Severity**：**P2**
- **Claim**：R-22 的完整形态——不是「测试假装它存在」，而是 Codex 侧的 rulehost 面**整块缺失**，且无任何声明性 guard。
- **Evidence**：
  - `principles-core/src/host/host-adapter.ts:181-184`（`HostEventEmitter` 只有 2 方法，无 `recordRuleHostEvaluated`）
  - `codex-adapter/src/pd-hook.ts:25-47`（Codex emitter 只实现这 2 个）
  - 唯一写入方：`openclaw-plugin/src/hooks/gate.ts:117,134,584`（OpenClaw 独占）
  - 唯一读方：`principles-core/.../rulecode-shadow-summary.ts:32`、`pd-console/.../ActivationsConsoleModel.ts:233,242`
  - `rg 'rulehost' packages/codex-adapter/` → 0 命中（测试与源码均无）
  - 后果：`promotion-readiness-evaluator.ts:40-42` → `shadow_telemetry_source_unavailable` → Codex 上 promote 结构性不可达
- **Why it matters**：Codex 是 MVP-Core 宿主之一；其 `rulecode` 通道的 shadow 观察面不可得，而 CI 不记录这一事实。
- **Affected stage**：host parity → shadow → promote（Codex 侧）
- **Current protection**：零（连「预期不可用」的断言都没有）

### NEW-F7 — artifact digest 三处平行实现，无一致性 guard

- **ID**：NEW-F7
- **Severity**：**P2**
- **Claim**：同一语义的 digest 在三处手写，无对拍测试。任一处变更序列化方式 → 另一入口恒 mismatch 且 CI 不红。
- **Evidence**：
  - `principles-core/.../promotion-evidence-snapshot.ts:27-29`（`export function computeArtifactDigest`，内部 `JSON.stringify(artifact)`）
  - `pd-cli/src/commands/runtime-activation.ts:584`（内联同式）
  - `pd-console/src/server/models/ActivationsConsoleModel.ts:465`（内联同式）；另 `:443`、`:663` 两处同式
  - 消费点：`promotion-readiness-reader.ts:35-36`（`artifactDigest !== request.expectedArtifactDigest` → `artifact_digest_mismatch` → blocked）
  - 测试：`promotion-evidence-snapshot.test.ts:41` 断言快照内 digest == `computeArtifactDigest`（**只覆盖 core 一处**）
- **Why it matters**：digest 是晋级硬门；跨入口不一致会让某入口永久 blocked，而 CLI/Console 各自的单测全绿。
- **Affected stage**：Owner gate（promote）→ activation
- **Current protection**：仅 core 内部自洽

### NEW-F8 — 安装后运行时几乎无行为面验证，且相关脚本不在 CI

- **ID**：NEW-F8
- **Severity**：**P2**
- **Claim**：唯一跑安装后运行时的 smoke 只验「console 起得来 + HTTP 200」，不验安装后 hook / RuleCode / runtime 一致性；针对真实安装的 4-gate 脚本不被任何 workflow 调用。
- **Evidence**：
  - `smoke-packaged-install.test.ts:438`（`pd console starts and /api/health returns 200`）、`:503`（`refuses --no-auth with non-loopback host`）——**无 hook 执行断言**
  - `rg 'pd-hook|openclaw' smoke-packaged-install.test.ts` 仅命中 fake `openclaw` version 探测（`:156-170`）
  - `scripts/dev/codex-r1-installed-gate.mjs`（针对 `~/.pd/runtime` 真实安装的 4-gate）：`rg` 在 `.github/workflows/` **零命中**
  - `scripts/dev/codex-owner-journey-e2e.mjs`、`scripts/acceptance-gate-rulehost.mjs`、`scripts/dev/pipeline-closure-lab/**`（`npm run dev:closure-lab`）：**均不在任何 workflow**
  - 根 `tests/` 目录的 `e2e-harness.test.ts`（19 test）：不在任何 vitest `include` 或 workflow（根 `package.json` **没有** `test` script）
- **Why it matters**：安装后运行时（`~/.pd/runtime`）是用户实际使用的形态；#1707 的 Incident 2026-09-03 正是「安装目录与仓库同路径混淆」类事故。当前 CI 对安装后面几乎零验证。
- **Affected stage**：installed runtime / host parity / upgrade
- **Current protection**：仅「安装成功 + console 探活」

---

## 7. Protection Gaps — Top 10 Contract Gaps（按管道瘫痪风险排序）

排序原则：**一条核心链断了但 CI 全绿的风险**。不按 coverage。

| # | Gap | Severity | 为什么排这个位置 |
|---|---|---|---|
| 1 | **Prompt 示例 ↔ schema/validator 零对拍**（NEW-F3 / §4.2） | P1 | 走到 artificer 即确定性失败，且每次失败消耗真实 LLM 预算（历史单轮 165 min 级）。管道能跑通但代价被系统性放大。无任何测试发现。 |
| 2 | **血缘字段名不匹配 → 静默丢 dreamerContext**（NEW-F4 / §4.4 / R-01） | P1 | 违反 rc-9；代码化阶段输入面静默退化，行为无可见事件，CI 全绿。 |
| 3 | **Stage C 缓存「可 parse 但非法」直达下游**（NEW-F2 / R-04） | P1 | rc-1/rc-2 违反；非法诊断结果落库并 seed，下游基于错误事实推进。负例只有一半。 |
| 4 | **升级「真实旧版 → 新版」零端到端**（NEW-F5 / §4.11 / J4） | P1 | 「不装坏机器」的核心 invariant；当前保护级别低于风险级别；曾实测 FAIL。 |
| 5 | **`verify:merge` 不含任何包 vitest 全量 + 无 required-check 自证**（§3.1 / §5.1） | P1 | 整份报告的前提风险：门禁绿 ≠ 测试绿。且仓库无 branch protection 声明可自证 required set。 |
| 6 | **J1 端到端（pain→approval→activation→receipt）不存在**（§5.5-J1） | P1 | MVP-Core 主链目前是四段拼接的信任；pain 段在 story-a 里是「simulated」。 |
| 7 | **R-19 静态门可被字符串/模板拼接绕过**（§4 沙箱面 / R-19 F 面） | P1 | 见 §4.14.2 的机制复现：`input['con'+'structor']['con'+'structor']('return process')()` 通过静态门（返回 `[]`），在 host-realm 对象注入的 vm 语境下**成功逃逸**。评估/激活预检路径受影响。 |
| 8 | **Console disable 路径授权不对称且无负例**（R-20 / §4.7） | P2 | 治理面不对称被隐式固化为契约；停用与紧急停用的授权要求不同，无测试记录。 |
| 9 | **Codex 宿主 rulehost/shadow 面整块缺失且无 guard**（NEW-F6 / R-22 / §4.9） | P2 | Codex 上 promote 结构性不可达；CI 不记录该事实，也不会因「面消失」而红。 |
| 10 | **6 个测试文件 / 49 个断言永不执行（配置口径漏）**（NEW-F1 / §3.3） | P2 | 最容易被误判为「已覆盖」的一类缺口：文件在、名字对、CI 绿、断言从不跑。 |

补充（未入 Top 10 但值得记录）：artifact digest 三源无对拍（NEW-F7，P2）、安装后运行时行为面近乎为空（NEW-F8，P2）、`validateInternalizationGraph` 有测试无生产调用（§4.1，P2）、writer 唯一性只有手工构造的单测 + 无 DB 部分唯一索引（§4.6，P2）、`behaviorDrift.delta` 语义无测试（§4.13，P2）。

---

## 8. Suggested Contract Invariants

**只写 invariant，不写方案。** 筛选条件：高价值 + deterministic + 低维护成本（适合进入 `check:pipeline-contract`——该脚本当前**不存在**，`rg 'check:pipeline-contract'` 零命中）。

| # | Invariant（可机械判定） | 为什么 deterministic | 为什么低维护 |
|---|---|---|---|
| I-1 | **每个 prompt builder 的示例 JSON 必须能被它自己的 validator 接受。** 对每个 `*-prompt-builder` 暴露的示例块做「抽取 → 喂 validator → 必须 valid」 | 纯函数：示例是常量，validator 是纯函数 | 示例或 validator 改动时同步验证，无需人工维护期望值 |
| I-2 | **每个 `vitest.config.ts` 的 `include` 必须覆盖该包内全部 `*.test.ts` 文件（或在配置中显式列出排除与理由）。** | 文件系统 + glob 匹配，无运行期状态 | 新增测试文件自动纳入检查范围 |
| I-3 | **跨段血缘字段名必须一致：上游 output schema 的字段名集合 ⊇ 下游 prompt 让 LLM 回显的字段名集合。** | 静态读取两侧常量/类型 | 字段重命名时立刻暴露 |
| I-4 | **同一语义的 digest/canonical 序列化必须只有一处实现，或必须有一致性测试。** | 纯函数对拍 | 实现变化时对拍失败即暴露 |
| I-5 | **任何「可 parse 的外部 payload」进入下游前必须有结构校验：对每个 `JSON.parse` 后接 `as T` 的信任边界，存在一条「可 parse 但非法」的负例。** | 静态模式匹配 + 存在性检查 | 新增信任边界时自动要求补负例 |
| I-6 | **`verify:merge` 与「被点名执行的测试文件集合」必须显式对齐，且任何「gate 声称覆盖 X 但实际不跑 X」必须 fail loud。** | 读 `package.json` + 文件存在性 | 门禁组成变化时立刻暴露 |
| I-7 | **禁用模式静态门必须对「拼接/编码变体」有独立负例：对每类禁用名，至少一个 `'a'+'b'` / 模板 / unicode 转义 / `fromCharCode` 变体。** | 常量 payload 集 + 纯函数 | 新增禁用名时按模板补一行 |
| I-8 | **每个宿主 adapter 声明的事件通道能力必须与 promotion 判据一致：宿主不支持 shadow 证据时，promotion 必须显式报「不可用」而非「0 证据」。** | 静态对比 `HostEventEmitter` 方法集与 `shadowSummary` 读侧的 type 过滤 | 新宿主接入时自动对齐 |
| I-9 | **每条「dispatcher → 激活写入」路径必须写入 `activation_decisions`（或显式声明为 audit-only 并附理由）。** | 静态检查调用点 + 声明清单 | 新增写入路径时暴露不对称 |
| I-10 | **安装后运行时必须至少有一条 E2E 断言「安装产物可执行其宿主 hook」。** | 可执行断言（spawn 安装后的 hook 入口） | 安装布局变化时自动覆盖 |

**优先建议进 `check:pipeline-contract`（最小高价值集）**：I-1、I-2、I-3、I-7。
理由：四者均为纯静态 / 纯函数判定，零外部依赖，零运行期状态，且各自对应本报告 Top 10 中的 #1、#10、#2、#7。

**不建议立即机械化**：I-5（需要语义判断「哪些 `as` 是信任边界」，误报风险高）、I-10（需真实安装树，成本高，属 CI job 而非静态 check）。

---

## 9. Out of Scope

本报告**不做**以下事：

1. **不提供修复方案**：所有 finding 只记事实与判定；I-1..I-10 只写 invariant，不写实现路径（D9：设计决策交 Owner）。
2. **不修改任何源码、测试、配置、CI**：本次为只读审计（D1/D2）。
3. **不新增任何测试**：本报告的 `Suggested Contract Invariants` 是**建议**，落地需 Owner 授权后的独立工单。
4. **不评估覆盖率百分比**：按任务书要求，排序基于管道瘫痪风险。
5. **不评估 prompt 文案质量 / LLM 行为质量**：#1707 已覆盖。
6. **不做运行时实测**：无 `npm install`、未跑全量 vitest；所有结论来自静态阅读 + 配置解析 + 最小机制复现（§4.14.2）。
7. **不触碰 Linear**：零密钥姿态，未做工单关联（章程 §6）。
8. **不裁决 R-19 / R-04 / R-20 / R-22 的修复优先级**：仅登记 F 面事实。
9. **不评估 `docs/` 之外的文档时效性**：仅记录 `TESTING.md` / ADR-0018 的 verify:merge 步数漂移为一处 DRIFTED。
10. **不对 #1707 的 34 条 NEW findings 做逐条 F 面复核**：仅复核任务书点名的 R-04 / R-19 / R-20 / R-22。

---

---

# Final-main Delta Sync（合并前对账，2026-09-15 追加）

## 变化源

`WORKER_BASELINE_SHA`（cdec05d4b）.. `FINAL_MAIN_SHA`（28e1de74）之间的唯一实质提交 = **PRI-797 / PR #1709**（signalCollector 默认启用 + needs_setup 显性提醒），4 提交、8 文件。

## 对 Worker F 结论的影响

Worker F 的 Top-10 / 各 Gap 行**均未按面提及 signal ingestion**（在 WORKER_BASELINE 时点，`signal_collector` 默认 OFF，LLM 深判面默认关闭，故该面未被列入管道瘫痪风险缺口）。因此 PRI-797 的新增测试**不推翻任何现有 Gap 行**。

但值得记录：PRI-797 为该面新增了三组 contract 回归，事实如下（不夸大为"完整保护"）：

| PRI-797 新增/改写测试 | 覆盖面 | 相对 Worker F 时点 |
|---|---|---|
| `feature-flag-contract.test.ts` +2 条 | signal_collector 默认 ON + 可 config override 关闭 | 新增（WORKER_BASELINE 时无） |
| `signal-classifier-needs-setup.test.ts`（新增 119 行） | 未配置 profile → WARN（每 workspace 一次）+ needs_setup + `return null` 降级，含 SystemLogger 断言 | 新增 |
| `j12-fresh-install-defaults.test.ts` 改写 | installer fresh config 默认 signalCollector enabled:true（配/不配 provider 两种） | 改写（原断言 enabled:false） |

**判定**：这三组测试保护的是 **PRI-797 自己的新行为**（default-on / needs_setup 显性提醒），不是本报告 Top-10 所列缺口（prompt-example↔validator、血缘字段名、Stage C 缓存、升级 E2E、verify:merge 组成等）。**Top-10 其余 9 项结论在 FINAL_MAIN 仍然成立**；唯一"新增保护面"的事实已如实登记，未据此下调任何缺口的严重度。

---

*审计基准：`cdec05d4bc4252151c7f9f118bdad90f25067594`（WORKER_BASELINE_SHA，BASELINE: SYNCED）；FINAL_MAIN_SHA = 28e1de74c64c2c7fd8cf8a1ccba55ec7b51939ee*
*全部行号与文件路径引用均对应上述 SHA。*
