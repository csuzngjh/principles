# PRI-807 Phase 0 — Worker F: Tests / Protection Gaps

> 问题：现在 4000+ 测试到底真正保护了哪些核心 contract？哪些地方可以 CI 全绿但核心链已经断？

---

## 1. Scope

本报告是 PRI-807 Phase 0「current-main Reality Audit」Worker F（Tests / Protection Gaps）的产出。

- **只读审计**：不改 `packages/**`、不修 bug、不建 subsystem、不改 config、不碰源码。
- **唯一写入**：本文件。
- **方法**：静态阅读 test 文件 + 逐条核实其是否打在生产边界上 + 阅读 CI 配置。未运行全量 vitest（云端预算不足，且任务书明确禁止）。
- **允许并实际运行的只读检查**：`node scripts/check-docs-structure.cjs`（见 §9）。

判定词：CONFIRMED / FIXED / DRIFTED / PARTIAL / NEW / UNVERIFIABLE。

---

## 2. Baseline

### BASELINE: DRIFTED

| 项 | 值 |
|---|---|
| 任务书指定基线 | `cdec05d4bc4252151c7f9f118bdad90f25067594` |
| 实际 checkout SHA | `191ae1af588a68950af1de5a3b9265771a7b3e8d` |
| 能否解析指定基线 | **否** —— `git cat-file -t` 返回 `could not get object info`；`git fetch origin <sha>` 返回 `remote error: upload-pack: not our ref` |
| 是否 shallow clone | 否（`.git/shallow` 不存在，`git rev-list --count HEAD` = 3533） |
| 是否含 `docs/audit/agent-pipeline-audit-2026-09-15/REPORT.md` | **否**（该目录不存在） |

**Drift Warning 说明**

`cdec05d4b` 在本 checkout 与 remote 上均**不可达**，因此无法产出
`git log --oneline <HEAD>..cdec05d4b` 与 `git log --oneline cdec05d4b..<HEAD>` 两个方向的 commit 列表——
这不是「落后若干 commit」，而是**基线锚点在本仓库不可解析**。

本 checkout HEAD 为 `191ae1af`（`Merge pull request #1705 from csuzngjh/ai/PRI-785-runbook-allow-events`），
即一个**比任务书所述审计现场更晚**的 main 快照。

**影响面**（对结论适用性的限制）：

1. 所有判定**仅对实际 checkout SHA `191ae1af` 负责**，不代表 `cdec05d4b` 时点的状态。
2. 任务书 §5 引用的 Carry-forward 标识（R-04 / R-19 / R-20 / R-22）、历史审计编号（#1707 / #1710）在本 checkout 中**全部检索不到**（见 §5 逐项裁决）。这说明任务书描述的是**另一个（更早的、或含未合并审计产物的）现场**，其编号体系未随代码落地。
3. 因此本报告对 §5 的裁决**不引用任何历史结论作为前提**，全部回源 `191ae1af` 的代码与测试文件；历史编号一律标注为 UNVERIFIABLE 并给出物证。

---

## 3. Current Authorities：现有验证体系的权威入口

### 3.1 `verify:merge` 的真实组成（`package.json:44`）

逐项拆解（顺序即执行顺序）：

| # | 命令 | 实际是什么 | 是否含测试 |
|---|---|---|---|
| 1 | `check:generated-artifacts` | `node scripts/check-generated-artifacts.cjs` 生成物一致性 | 否 |
| 2 | `check:error-handbook` | ERR 手册结构校验 | 否 |
| 3 | `check:telemetry-events -- --strict` | 遥测 union ↔ emit-site 双向 diff（ERR-060） | 否 |
| 4 | `check:repo-hygiene` | 仓库卫生（tmp/linear 草稿/PD 运行时态） | 否 |
| 5 | `check:runtime-contract` | **仅扫 PR diff 新增行**的 ERR-001/005/013 违规 | 否 |
| 6 | `check:docs-structure` | docs 四层结构 | 否 |
| 7 | `check:security-baseline` | 供应链基线静态扫描 | 否 |
| 8 | `npm test -w create-principles-disciple -- --run tests/release-target-matrix.test.ts` | **唯一一个 vitest**，且只跑 1 个文件 | 仅 1 文件 |
| 9 | `build -w @principles/core` | tsc | 否 |
| 10 | `test:website` | website 包测试（4 个 test 文件） | 仅 website |
| 11 | `lint` | eslint（build core/install-layout/host-runtime + eslint） | 否 |
| 12 | `build` | 全仓 tsc + bundle | 否 |
| 13 | `build -w @principles/pd-cli` | tsc | 否 |
| 14 | `typecheck:openclaw-plugin` | tsc --noEmit | 否 |
| 15 | `typecheck:pd-console` | tsc --noEmit | 否 |
| 16 | `typecheck:pd-companion` | tsc --noEmit | 否 |

**`verify:merge` 不包含什么**（这是本报告最关键的单项事实）：

- 不含 `principles-core` 测试（402 个 test 文件，**一个都不跑**）；
- 不含 `openclaw-plugin` 测试（196 个 test 文件，**一个都不跑**）；
- 不含 `pd-console` 测试（139 个 test 文件，**一个都不跑**）；
- 不含 `pd-cli` 测试（123 个）；
- 不含 `host-runtime` 测试（26 个）；
- 不含 `codex-adapter` 测试（18 个）；
- 不含 `pd-companion` 测试（10 个）；
- 不含 `create-principles-disciple` 的 **fast 套件**（53 个中除 release-target-matrix 外的全部）；
- 不含 2 个 installer smoke（`test:smoke:packaged` / `test:smoke:release-asset`）；
- 不含 `scripts` 测试（`test:scripts`）；
- 不含任何 E2E / BDD / Playwright / nightly。

也就是说：**`verify:merge` ≈ 7 个静态 guard + 类型检查 + lint + build + 1 个 release 矩阵测试。**

### 3.2 真正的覆盖率来自 CI 的平行 job，而非 merge gate

`.github/workflows/ci.yml` 中，包级测试由**独立 job** 承担（文件内注释亲自承认："verify:merge does NOT run package tests. These jobs are the real coverage for every package."，`ci.yml:169-170`）：

| Job | 覆盖 | 触发条件 |
|---|---|---|
| `test-principles-core` | `vitest run --coverage` | PR/push，needs: lint |
| `test-pd-cli` | `npm run build && npm test` | 同上 |
| `test-pd-companion` | build + test | 同上 |
| `test-pd-console` | `vitest run --coverage` | 同上 |
| `test-create-principles-disciple` | `test:fast` **（排除两个 smoke）** | 同上 |
| `smoke-packaged-install` | `test:smoke:packaged` | 同上（独立 job） |
| `smoke-release-asset` | `test:smoke:release-asset` | 同上（独立 job） |
| `test-scripts` | `scripts/` vitest | 同上 |
| `test-host-runtime` | build + test | 同上 |
| `test-host-runtime-parity` | `test:host-runtime-parity` | 同上 |
| `test-codex-adapter` | `npm test` | 同上 |

**未进入任何 PR-required job 的资产**（只能靠 schedule / dispatch）：

| Workflow | 触发 | 内容 |
|---|---|---|
| `e2e-nightly.yml` | `schedule: 0 2 * * *` + dispatch | Story A' 全链，**需真实模型**（`SENSENOVA_API_KEY`） |
| `pd-console-e2e.yml` | 仅 `workflow_dispatch` | Playwright（含 `playwright.owner.config.ts`） |
| `regression-e2e.yml` | 见 workflow | 仅 `tests/core/regression-v1-9-1.test.ts` 一个文件 |
| `ci.yml#impact` | PR | **SHADOW 模式**，只报告不 gate |

> 注意：`verify-merge` job 在 CI 里是 blocking 的，但它**不跑包测试**。
> 「CI 绿」若指 merge gate 绿，则覆盖不到 packages 的行为；若指全 CI 绿，才含包测试。
> 这个语义鸿沟是 §7 排序的核心依据。

---

## 4. Contract Map：invariant 保护矩阵

字段含义：**Production path?** = 测试是否调用生产入口（而非仅 helper）；**Installed runtime?** = 是否覆盖安装后的运行时产物；**Real host? / Real model?** = 是否用真实 Host / 真实模型。

### Topology（DAG 权威）

| 字段 | 值 |
|---|---|
| Test file | `packages/principles-core/src/runtime-v2/internalization/__tests__/internalization-job-graph.test.ts` |
| Test type | unit |
| 保护的 invariant | runner 链只允许 `dreamer→philosopher→scribe→artificer→evaluator→rollout_reviewer`；拒绝反向、跳级、自环 |
| Production path? | **否** —— 直接 import `../internalization-job-graph.js` 的纯函数（`validateEdge`/`isAcyclic`/`ALLOWED_EDGES`），未经过 orchestrator 调度 |
| Deterministic? | 是 |
| Installed runtime? | 否 |
| Real host? / Real model? | 否 / 否 |
| Gap? | 测试锁死了**当前**的边集合，但没有任何测试断言「调度器实际按该 DAG 派工」；DAG 与真正的任务派发之间的连线无保护。且 PRI-720 引入 channel-aware 拓扑后，此文件仍只表达单一 v1 链 |

### Prompt-schema parity

| 字段 | 值 |
|---|---|
| Test file | `packages/principles-core/src/runtime-v2/adapter/__tests__/schema-prompt-adapter.test.ts`；`packages/openclaw-plugin/tests/hooks/prompt-golden.test.ts` |
| Test type | unit + golden |
| 保护的 invariant | 输出 schema 经 adapter 转成 prompt 时字段不丢失；prompt 组装对已知输入保持字节稳定 |
| Production path? | 部分 —— `prompt-golden` 走 hooks 层；`schema-prompt-adapter` 只测 adapter |
| Deterministic? | 是 |
| Installed runtime? | 否 |
| Real host? / Real model? | 否 / 否 |
| Gap? | 无「schema 定义变更 ⇒ prompt golden 必须同步更新」的**强制联动**：两边各自可单独变绿。golden 文件是快照，不是从 schema 派生的 |

### Semantic validator parity

| 字段 | 值 |
|---|---|
| Test file | `packages/principles-core/src/runtime-v2/__tests__/pain-ingress-shared-semantics.test.ts`；`packages/host-runtime/tests/host-semantic-projection-wiring-guard.test.ts`；`packages/openclaw-plugin/tests/core/tool-semantics.test.ts` |
| Test type | unit + wiring guard |
| 保护的 invariant | tool 语义投影（host → core）在共享层一致；投影确实被接线 |
| Production path? | 部分是 —— `host-semantic-projection-wiring-guard` 是**源码文本 guard**，非行为测试 |
| Deterministic? | 是 |
| Installed runtime? | 否 |
| Real host? / Real model? | 否 / 否 |
| Gap? | `wiring-guard` 型测试断言「文件里出现某字符串」，**注释里出现同样的字符串即可通过**——这是结构性弱保护（见 §6 NEW-2） |

### Lineage 完整性

| 字段 | 值 |
|---|---|
| Test file | `packages/principles-core/src/runtime-v2/internalization/__tests__/candidate-lineage.pri717.test.ts`、`candidate-lineage.property.test.ts`、`peer-runner-lineage-injection.test.ts`；`packages/openclaw-plugin/tests/core/principle-internalization/lineage-source-retired.test.ts` |
| Test type | unit + **property-based** |
| 保护的 invariant | candidate lineage 的祖先集合自洽；peer runner 注入 lineage 不丢链；已退役 source 不再产生 lineage |
| Production path? | **是**（`shared-information-plane-runner.test.ts:538` 明确「the REAL DiagRouterRunner dual-write is what makes the diag_router tier2 node exist」，用真 runner） |
| Deterministic? | 是（property test 使用固定 seed 语义） |
| Installed runtime? | 否 |
| Real host? / Real model? | 否（LLM 为 scripted/test-double，状态机与治理为被测对象）/ 否 |
| Gap? | 覆盖 **core 侧** lineage 很强；但 **OpenClaw/Codex 两侧写入的事件日志里 lineage 标识是否与 core 一致**（rc-6）无跨 host 一致性测试 |

### Exact artifact identity

| 字段 | 值 |
|---|---|
| Test file | `packages/principles-core/src/runtime-v2/internalization/__tests__/artifact-content-hash.property.test.ts`；`artifact-summary.property.test.ts`；`packages/principles-core/src/runtime-v2/store/artifact/__tests__/sqlite-pi-artifact-store-fk.test.ts` |
| Test type | unit + property + integration（真 SQLite，外键） |
| 保护的 invariant | artifact content hash 与内容一一对应；artifact 引用受 FK 约束，不产生孤儿 |
| Production path? | **是**（真 SQLite store） |
| Deterministic? | 是 |
| Installed runtime? | 否 |
| Real host? / Real model? | 否 / 否 |
| Gap? | hash 只对 **core 侧写入**的 artifact 做身份保证；bundle / 安装产物里的 artifact 身份（跨 delivery surface）无等价断言 |

### Writer uniqueness

| 字段 | 值 |
|---|---|
| Test file | `packages/principles-core/src/runtime-v2/activation/__tests__/low-risk-writers.test.ts`；`activation/writers/__tests__/rule-host-writer.test.ts` |
| Test type | unit |
| 保护的 invariant | 低风险渠道（prompt / defer_archive）只有一个写入者写出激活态；rule-host writer 写出内容可唯一识别 |
| Production path? | 部分 —— 测 writer 单元，非「谁被允许调用 writer」的编排约束 |
| Deterministic? | 是 |
| Installed runtime? | 否 |
| Real host? / Real model? | 否 / 否 |
| Gap? | **没有测试能证明「同一激活只有一个 writer 在写」**——现有测试逐个 writer 验证，没有互斥/唯一性断言。第二个 writer 被接线进来不会有任何测试变红 |

### Owner gate

| 字段 | 值 |
|---|---|
| Test file | `packages/pd-console/tests/server/routes/activations-disable.test.ts:245-274`；`packages/openclaw-plugin/tests/bdd/...owner-approve-prompt*`；`docs/specs/features/story-a/owner-approve-prompt.feature` |
| Test type | integration（路由处理器 + 真 SQLite）+ BDD |
| 保护的 invariant | 无已认证 Owner 身份时，治理变更被拒（403 `owner_authentication_required` + nextAction）；break-glass 只做全局暂停、不伪造 Owner 身份 |
| Production path? | **是** —— 直接调用 `handleActivationsRoute`（生产路由处理器），真 SQLite，真实 actor 上下文 |
| Deterministic? | 是 |
| Installed runtime? | 否 |
| Real host? / Real model? | 否 / 否 |
| Gap? | 403 断言强；但**「谁算已认证 Owner」的判定源**（identity 解析）在 host 侧与 console 侧是否同一真相，无跨端一致性测试 |

### Activation

| 字段 | 值 |
|---|---|
| Test file | `principles-core/src/runtime-v2/activation/__tests__/activation-dispatcher.test.ts`、`activation-re-dispatch.test.ts`、`approval-completion-service.test.ts`、`approval-queue.test.ts`；`internalization/__tests__/mvp-core-loop-journeys.test.ts` |
| Test type | unit + **journey E2E（真 store + 真 runner + 真 dispatcher）** |
| 保护的 invariant | 审批完成后自动 dispatch；低风险 prompt 渠道直接落 activation 行；无 rollout 旁路；reopen 语义正确 |
| Production path? | **是**（`mvp-core-loop-journeys.test.ts` 头部声明：真 store + 真 runner + 真 dispatcher，仅 LLM 用 scripted adapter） |
| Deterministic? | 是 |
| Installed runtime? | 否 |
| Real host? / Real model? | 否 / 否（LLM scripted） |
| Gap? | 这是**保护得最好的一段**。断点在「core 触发 ⇒ host 真的强制」这一跳：journey 到 activation 行为止，不延伸到 host 侧 hook 真的用它做决策 |

### Host parity

| 字段 | 值 |
|---|---|
| Test file | `packages/openclaw-plugin/tests/bdd/openclaw-shared-host-runtime-parity.steps.test.ts`；`packages/openclaw-plugin/tests/package/published-host-runtime-bundle.test.ts`；`packages/codex-adapter/tests/g1-host-runtime-contract.test.ts` |
| Test type | BDD（真插件注册 + 真 SQLite + 真 RuleHost）+ 契约 |
| 保护的 invariant | OpenClaw 与 Codex 走同一 shared host-runtime，行为一致；发布出去的 bundle 与源码一致 |
| Production path? | **是**（BDD 用真插件注册与真 dispatcher；`published-host-runtime-bundle` 检查已发布产物） |
| Deterministic? | 是 |
| Installed runtime? | **部分是**（`published-host-runtime-bundle` 针对已发布 bundle；但不是「安装后运行」的端到端） |
| Real host? | **否** —— OpenClaw 侧是真实插件注册但 host SDK 经 mock/适配；Codex 侧 `g1-host-runtime-contract` 是读取 fixture + 文件，**不是真 host 跑起来** |
| Real model? | 否 |
| Gap? | **parity 只在「共享同一段代码」层面被证明，不在「两端真跑出同样结果」层面**。Codex 侧最大的空白见 §5 R-22 |

### Installed runtime

| 字段 | 值 |
|---|---|
| Test file | `packages/create-principles-disciple/tests/smoke-packaged-install.test.ts`；`smoke-release-asset.test.ts` |
| Test type | smoke（真 `npm pack` → 真 install → 真 release asset 构建） |
| 保护的 invariant | 打包后的安装器能真实安装出可运行产物 |
| Production path? | **是**（文件内注释：hermetic 自建真实 artifact） |
| Deterministic? | 是（本地 tarball，无网络依赖除非 registry 慢） |
| Installed runtime? | **是** —— 这是唯一的安装后覆盖 |
| Real host? / Real model? | 否 / 否 |
| Gap? | 只覆盖**安装成功**，不覆盖**安装后管道仍能端到端贯通**（无 LLM，无真 host）。且这两个 smoke 在 CI 里是独立 job、**在 fast 套件里被排除** |

### Upgrade

| 字段 | 值 |
|---|---|
| Test file | `packages/create-principles-disciple/tests/legacy-migration.test.ts`（217 行）；`packages/openclaw-plugin/tests/core/migration.test.ts`（79 行） |
| Test type | integration |
| 保护的 invariant | overlay 迁移 dry-run 不落盘；迁移保留 overlay 只读；缺失/已迁移/非官方安装器时**拒绝**；畸形 manifest **fail loud**；journal 在副作用之前写入（每个写入点注入崩溃） |
| Production path? | **是** |
| Deterministic? | 是 |
| Installed runtime? | 部分是（走安装器路径） |
| Real host? / Real model? | 否 / 否 |
| Gap? | 覆盖 **legacy overlay → 当前** 的迁移；**没有 N-1 → N 的版本对版本升级矩阵**。任务书问的「PRI-671 相关资产」在本 checkout 中**完全不存在**（§5 已证） |

### Rollback

| 字段 | 值 |
|---|---|
| Test file | `packages/create-principles-disciple/tests/rollback-policy.test.ts`；`packages/pd-cli/tests/commands/runtime-activation-deactivate-flag-wiring.test.ts` |
| Test type | unit + flag-wiring |
| 保护的 invariant | 回滚策略存在；deactivate 命令的 flag 被正确注册 |
| Production path? | **否（关键缺口）** —— deactivate 测试是 **flag-wiring**（命令注册层），不验证 deactivate 真的让一条已激活规则停止生效 |
| Deterministic? | 是 |
| Installed runtime? | 否 |
| Real host? / Real model? | 否 / 否 |
| Gap? | **「停用后规则立即不再 block」这一行为由 `rule-host-cache-invalidation.test.ts` 覆盖**（真 SQLite + 真 RuleHost，显式针对 ERR-024「cache 不得绕过强制」），但那是在 core/host 层；console/CLI 的停用路径**没有**同等的行为断言。分层断点见 §7 |

### Behavior adaptation

| 字段 | 值 |
|---|---|
| Test file | `mvp-core-loop-journeys.test.ts`（Journey 5-8）；`evaluator-repair-loop.test.ts`；`docs/pipeline-evolution/reports/episode-002-r2/r3-report.md` |
| Test type | journey E2E + 人工 episode 报告 |
| 保护的 invariant | evaluator `needs_revision` → repair → reopen；repair 耗尽 → `needs_human_review`，无后继；rollout `approve_rollout` → 自动 dispatch |
| Production path? | **是**（真 runner/dispatcher/store） |
| Deterministic? | 是 |
| Installed runtime? | 否 |
| Real host? / Real model? | 否 / **否** |
| Gap? | 「行为适应」的**最终一环——模型行为真的改变——完全没有自动化保护**。EP002 是人工 episode 报告（`docs/pipeline-evolution/reports/episode-002-r2-report.md`），不是断言。这是从「机制存在」到「机制有效」的断点 |

---

## 5. Confirmed / Fixed / Drifted：对 §5 Carry-forward 各项的裁决

> 前置结论：任务书 §5 引用的编号体系（R-04/R-19/R-20/R-22、#1707、#1710）与 `PRI-671`、`docs/audit/agent-pipeline-audit-2026-09-15/` 在本 checkout 中**全部不存在**。
> 检索证据：`grep -rn "R-19" docs/` 只命中 `docs/plans/2026-05-roadmap/*` 中同名但**语义无关**的历史风险编号（"Activation Probation Window" / "PRRR 指标被过度解释"）；
> `grep -rn "1710|1707" docs/` 无命中；`grep -rln "PRI-671"` 无命中；`find . -path "*agent-pipeline-audit*"` 无命中。
> 故以下裁决**全部基于 191ae1af 的物证重建**，并明确标注编号可验证性。

### 5.1 `verify:merge` 覆盖面 vs「merge gate 绿 = 安全」的直觉差距 — **CONFIRMED**

历史发现（「不含 pd-console 全量测试、不含大多数包 vitest 全量」）在 current main **完全成立且更强**。

物证：`package.json:44` 全文列出（§3.1 已逐项拆解）。`verify:merge` 中唯一的 vitest 是
`npm test --workspace=create-principles-disciple -- --run tests/release-target-matrix.test.ts`，
即**一个文件**。其余 15 个环节全是静态 guard / 类型检查 / lint / build。

`ci.yml:169-170` 的注释是仓库自身的确认：「verify:merge does NOT run package tests. These jobs are the real coverage for every package.」

**判定：CONFIRMED（且比历史描述更严重——不只是「不含 pd-console 全量」，而是不含 8 个包中 7 个的任何一个测试）。**

### 5.2 R-04（P1）：Stage C 缓存复用旁路校验 — **PARTIAL / 编号 UNVERIFIABLE**

- 编号 `R-04` 在本 checkout 的审计文档中不存在（`docs/plans/2026-05-roadmap/04-risks-and-mitigations.md` 里的 R-04 是另一主题）。
- **事实重建**：`diag-router-runner.ts` 中**检索不到 cache/reuse 关键字**（`grep -n "cache|reuse" diag-router-runner.ts` 只命中注释「reuses existing committer」）。Stage C 的「缓存复用」在当前 main 不以该形态存在。
- **负例覆盖**（真正相关的负例资产）存在且质量高：
  - `golden-trace-replay-validator.test.ts:101` 「false positive blocked: rule that allows negative case fails」
  - `:131` 「invalid rule returns structured failure with repair hints」
  - `:145` 「mismatched proposedParams fails with diff」
  - `:214` 「applicationMode mismatch fails with repair hint」
  - `diag-chain-e2e.test.ts:177/182/189` Stage A/B/C 输出各过 TypeBox schema 校验
- **判定：PARTIAL**——「非法 payload 有负例覆盖」这一诉求在 **replay/validator** 路径已满足；但**若** Stage C 存在绕过校验的复用路径，当前 main **找不到该路径的实现或测试**，故原命题**无法在当前代码上验证**。建议后续 Worker 以实际调用链重新定位。

### 5.3 R-20（P2）：Console 停用路径的授权语义 — **FIXED**

物证：`packages/pd-console/tests/server/routes/activations-disable.test.ts:245-274`

```
it('refuses governance mutation when server has no authenticated Owner identity', ...)
  → handleActivationsRoute(..., { ownerActor: null, breakGlassActor: {...} })
  → expect(res.statusCode).toBe(403)
  → expect(body).toMatchObject({ error: 'owner_authentication_required', nextAction: expect.any(String) })

it('allows local break-glass global pause without fabricating Owner identity', ...)
  → 真 SQLite 插入 tasks/pi_artifacts/activations/activation_control_states
  → expect(res.statusCode).toBe(200); expect(data.status).toBe('paused')
```

- 直接调用**生产路由处理器** `handleActivationsRoute`，非 mock 的 HTTP 层；
- 真 SQLite（`SqliteConnection` 写真实表结构）；
- 显式覆盖两个授权语义边界：**无 Owner 身份必须 403** + **break-glass 只暂停不伪造身份**；
- 请求体校验另有 5 条负例（非 JSON / 缺 confirmed / confirmed=false / 非布尔 / 数组体）。

**判定：FIXED。** 授权语义有真实负例覆盖，且打在生产路径上。

### 5.4 R-22（P2）：Codex rulehost_evaluated 缺失 — **CONFIRMED（不是「测试假装它存在」，而是「测试根本没提它」）**

物证（双侧同向）：

1. **生产侧**：`grep -rn "rulehost_evaluated" packages/codex-adapter/` → **零命中**。
   Codex 的事件写入在 `packages/codex-adapter/src/pd-hook.ts:28-34`（`runtime_v2_prompt_activations_injected`）与 `:43-49`（`tool_call`），**仅此两种**。
2. **对照**：`rulehost_evaluated` 只由 OpenClaw 的 `packages/openclaw-plugin/src/core/event-log.ts:192/267/489` 与 `src/hooks/gate.ts:131` 发出。
3. **消费侧**：`packages/pd-console/src/server/models/ActivationsConsoleModel.ts:233/242` 以 `rulehost_evaluated` 为唯一数据源来算 live 激活指标。
4. **测试侧**：Codex 的测试**没有声称它存在**，也没有断言它缺失——即**没有任何测试在守这个 contract**，无论正反方向。

**判定：CONFIRMED。** 修正任务书的表述：不是「测试假装它存在」，而是「**测试对它的存在与否完全不表态**」——因此这是一个**双向无保护**的缺口，CI 全绿与 Codex 端激活可观测性断裂可以同时成立。严重度见 §6 NEW-1。

### 5.5 J1-J4 四条 Journey 的测试资产现状

任务书列出的 J1-J4（Pain→Approval→Activation→Receipt / RuleCode 全链 / Revision-Recovery / Rollback）在代码中**没有以 J1-J4 命名**。
现有命名是 `mvp-core-loop-journeys.test.ts` 的 **Journey 5-8**（evaluator needs_revision / repair 耗尽 / rollout needs_revision / rollout approve_rollout）。

按任务书的语义重建四条链，逐条给出已有资产与断点位置：

**J1 — Pain → Approval → Activation → Receipt**

| 环节 | 资产 | 断点 |
|---|---|---|
| Pain 入口 | `pain-evidence-ingress.test.ts`、`pain-pipeline-roundtrip.test.ts`、`pain-ingress-shared-semantics.test.ts` | — |
| Approval | `approval-queue.test.ts`、`approval-completion-service.test.ts`、BDD `owner-approve-prompt.feature` | — |
| Activation | `activation-dispatcher.test.ts`、`mvp-core-loop-journeys.test.ts` | — |
| **Receipt** | `docs/specs/features/receipt/*.feature`（5 个）、`pd-console/tests/ui/owner-decision-ui-contract.test.ts` | **断点：四条链中 Receipt 一环最薄**——feature 存在，但缺一条**从真实 pain 到真实 receipt 的贯通 E2E**；各环节分别有测试，串起来的那条链没有单一断言 |

**J2 — RuleCode 全链**

| 环节 | 资产 | 断点 |
|---|---|---|
| 编译 | `rule-code-validator.ts` + `sandbox-escape-regression.test.ts` | — |
| 落库 | `rule-host-sqlite-source.test.ts`、`rulehost-seed-mvp-e2e.test.ts` | — |
| 评估 | `gate-rule-host-real-pipeline.test.ts`（**真 SQLite + 真 RuleHost + 真 handleBeforeToolCall，显式无 mock**） | — |
| 决策 | `gate-rule-host-pipeline.test.ts`、BDD `rulecode-owner-live-decision.feature` | — |
| **Codex 端** | `codex-adapter/tests/*` | **断点：Codex 侧完全不产生 `rulehost_evaluated`**（§5.4）→ 「全链」在 Codex host 上断在可观测性 |

**J3 — Revision-Recovery**

| 环节 | 资产 | 断点 |
|---|---|---|
| evaluator needs_revision | `mvp-core-loop-journeys.test.ts` Journey 5 | — |
| repair 循环 | `evaluator-repair-loop.test.ts`、`split-diagnostician-runner-retry.test.ts` | — |
| 耗尽 → human review | `mvp-core-loop-journeys.test.ts` Journey 6（「无后继无审批无激活」） | — |
| **真实模型下的 revision 质量** | 无 | **断点：全部 scripted adapter；「LLM 真返回 needs_revision 时链路仍正确」无保护**（`signal-stage2-real-adapter.e2e.test.ts` 覆盖真实 adapter，但需真实模型，不在 PR CI） |

**J4 — Rollback**

| 环节 | 资产 | 断点 |
|---|---|---|
| deactivate 命令注册 | `runtime-activation-deactivate-flag-wiring.test.ts` | **仅 flag-wiring** |
| 停用后规则立即失效 | `rule-host-cache-invalidation.test.ts`（真 SQLite + 真 RuleHost，ERR-024：「cache 不得绕过强制」；ERR-079：deactivate/promote 必须立即可见） | — |
| 回滚策略 | `rollback-policy.test.ts` | — |
| **端到端回滚** | 无 | **断点：三层分别有保护，但没有一条测试从「Owner 在 console 点停用」走到「host 侧下一次 tool call 不再被 block」** —— 中间隔着 CLI/console ↔ core ↔ host 两跳，各跳单独绿、合起来无断言 |

---

## 6. NEW Findings

### NEW-1 — Codex 端 RuleHost 评估遥测单向缺失，双向无测试保护

- **ID**：NEW-1
- **Severity**：**P1**
- **Claim**：Codex host 从不产生 `rulehost_evaluated` 事件，而该事件是 Console 计算 live 激活指标的唯一数据源；正反两个方向都**没有任何测试**覆盖这个 contract。
- **Evidence**：
  - `grep -rn "rulehost_evaluated" packages/codex-adapter/` → 0 命中（含 src 与 tests）
  - 生产侧仅两类事件：`packages/codex-adapter/src/pd-hook.ts:28-34`（`runtime_v2_prompt_activations_injected`）、`:43-49`（`tool_call`）
  - 唯一发出方：`packages/openclaw-plugin/src/core/event-log.ts:192/267/489`、`src/hooks/gate.ts:131`
  - 唯一消费方：`packages/pd-console/src/server/models/ActivationsConsoleModel.ts:233/242`（`entry.type !== 'rulehost_evaluated'` 即 `continue`，静默跳过）
- **Why it matters**：`ActivationsConsoleModel` 对不匹配的事件类型 `continue`（静默跳过），因此 Codex 用户的 live 激活面板**永远显示为空**，且**不报错、不降级、不提示**——违反 rc-9（graceful degradation 必须可观察）。这是典型的「CI 全绿但核心链已断」。
- **Affected stage**：RuleCode 执行 → 可观测性 → Owner 决策（J2 全链末端）
- **Current protection**：**无**。无正向断言（Codex 应产生该事件），也无反向断言（若缺失应 fail loud）。跨 host 消费一致性测试不存在。

### NEW-2 — 架构 guard 是源码文本子串匹配，注释即可"通过"

- **ID**：NEW-2
- **Severity**：**P2**
- **Claim**：承担架构边界保护的测试以「源文件里包含某字符串」为主要断言形式，这类断言无法区分**真实接线**与**注释/字符串字面量中的同名文本**。
- **Evidence**：
  - `packages/principles-core/src/runtime-v2/__tests__/architecture-regression.test.ts` 共 4367 行、841 处 `expect(`，典型断言为 `expect(src).toContain('PainToPrincipleService')`（:690）、`expect(src).toMatch(/service\.recordPain\(/)`（:705）、`expect(src).not.toContain('createPainSignalBridge')`（:691）
  - 同类形态出现在 `packages/openclaw-plugin/tests/core/sandbox-escape-regression.test.ts:95-130`：`expect(source).toContain('spawnSync')`、`expect(source).toMatch(/timeout:\s*\w+/)` —— 这些断言的存在意义是「防重构删边界」，但断言本身可被注释满足
  - `packages/host-runtime/tests/host-semantic-projection-wiring-guard.test.ts` 同为 wiring-guard 型
- **Why it matters**：guard 的**存在**被误当成不变量被**保护**。P2 而非 P1，因为多数此类 guard 旁边都有行为级测试兜底（如 rule-host 的真实 pipeline 测试）；但单看 guard 本身，它保护的是「文件布局」而非「不变量」，与 AGENTS.md §20 的取向（protect invariants over historical file layout）存在偏差。
- **Affected stage**：跨包边界（core ↔ plugin ↔ host-runtime）
- **Current protection**：guard 自身绿；其声称保护的不变量部分由行为测试独立覆盖，部分（如 `not.toContain` 型负断言）**仅由该 guard 独占**。

### NEW-3 — Writer 唯一性无互斥断言

- **ID**：NEW-3
- **Severity**：**P2**
- **Claim**：低风险激活写入路径有逐 writer 的正确性测试，但没有**唯一写入者**的互斥断言；接入第二个 writer 不会让任何测试变红。
- **Evidence**：
  - `packages/principles-core/src/runtime-v2/activation/__tests__/low-risk-writers.test.ts`（逐 writer）
  - `packages/principles-core/src/runtime-v2/activation/writers/__tests__/rule-host-writer.test.ts:250`（注释：「This assertion uniquely identifies the …」——唯一性用于**识别内容**，不是**约束写入者**）
  - `grep -n "unique|single|duplicate"` 于 `activation/**` 仅命中上述注释
- **Why it matters**：违反 P4（One Source of Truth）的典型失败模式是「多了一条写入路径」，而这在测试上不可见。
- **Affected stage**：Activation 写入（J1 第三跳）
- **Current protection**：每个 writer 各自有测试；写入者之间的互斥**无**。

### NEW-4 — 真实模型只在 nightly/dispatch，PR gate 全绿不代表 LLM 链可用

- **ID**：NEW-4
- **Severity**：**P2**
- **Claim**：所有需要真实模型的验证（含 adapter 真实性、revision 质量）都在 `schedule` 或 `workflow_dispatch` 上；PR 阶段 100% 使用 scripted / test-double adapter，因此「PR 全绿」与「LLM 链可用」之间没有稳定连接。
- **Evidence**：
  - `e2e-nightly.yml`：`cron: '0 2 * * *'` + `workflow_dispatch`，需 `secrets.SENSENOVA_API_KEY`；PR 事件不触发
  - `pd-console-e2e.yml`：仅 `workflow_dispatch`（`on:` 中只有该一项）
  - `packages/principles-core/src/runtime-v2/observer/__tests__/empathy-observer.real-e2e.test.ts:11-30`：真实路径 gated 在 `LLM_E2E_ENABLED=true`，**否则回落到 mock**并仍然"通过"（测试名即 "otherwise falls back to stable mock validation"）
  - `mvp-core-loop-journeys.test.ts` 头部自陈：「仅 LLM 用 scripted adapter」
- **Why it matters**：这不是缺陷本身（成本权衡合理），而是**风险归属未被承认**：绿 PR 被读成「管道可用」。回落到 mock 且仍然 pass 的模式尤其危险——它在形式上总是绿。
- **Affected stage**：全链的真实 LLM 环节
- **Current protection**：机制层有强保护；真实模型层仅在 nightly 有人看时才有保护。

---

## 7. Protection Gaps：Top 10 contract gaps（按「管道瘫痪风险」排序）

排序依据：**一条核心链断了但 CI（PR gate）全绿**的可能性 × 断裂后的可观测性（越静默越靠前）。不按 coverage 百分比。

| # | Gap | 严重度 | 为什么它能"绿着断" | 现状证据 |
|---|---|---|---|---|
| 1 | **merge gate 不含任何包的测试** | P1 | `verify:merge` 是 PR 的 blocking 检查，但它只跑 7 个静态 guard + 类型 + lint + build + 1 个测试文件。若某 PR 只改 `packages/principles-core` 的行为，merge gate 完全无法察觉 | `package.json:44`；`ci.yml:169-170` 自陈 |
| 2 | **Codex 端 `rulehost_evaluated` 缺失且双向无测试** | P1 | 消费侧 `continue` 静默跳过 → Codex 用户 live 激活面板恒空，无报错无降级。无正向也无反向断言 | NEW-1 |
| 3 | **Activation 触发 → host 强制缺贯通断言** | P1 | activation 落在 DB 里（core 侧有强 journey 测试），但「host 下一次 tool call 真的被这条 activation 影响」只在 `gate-rule-host-real-pipeline` 中覆盖；两条链之间**没有单一测试从审批走到强制**，中间任一跳静默失效都不影响各自测试绿 | `mvp-core-loop-journeys.test.ts`（止于 activation 行）vs `gate-rule-host-real-pipeline.test.ts`（起点已是 SQLite 中的 activation） |
| 4 | **J4 Rollback 端到端无断言** | P1 | 三层（命令行注册 / cache 失效 / 回滚策略）各自有测试。从「console 停用」到「host 不再 block」跨 CLI↔core↔host 两跳，**没有一条测试穿过** | `runtime-activation-deactivate-flag-wiring.test.ts`（仅注册）＋ `rule-host-cache-invalidation.test.ts`（仅 core/host 层） |
| 5 | **Writer 唯一性无互斥断言** | P2 | 第二条写入路径接入后，所有逐 writer 测试仍绿 | NEW-3 |
| 6 | **真实模型链仅在 nightly / dispatch** | P2 | PR 阶段 100% scripted；`empathy-observer.real-e2e` 在未启用时**回落到 mock 并仍然 pass** | NEW-4 |
| 7 | **架构 guard 是文本子串匹配** | P2 | 注释里写上目标标识符即可满足 `toContain`；`not.toContain` 型负断言无法区分「真的没接线」与「改名了」 | NEW-2 |
| 8 | **Topology DAG 与真实派工之间无连线** | P2 | DAG 纯函数测试锁死边集合；没有任何测试断言调度器按该 DAG 派工。PRI-720 的 channel-aware 拓扑未反映在该文件中 | `internalization-job-graph.test.ts`（import 纯函数） |
| 9 | **Prompt-schema parity 无强制联动** | P2 | schema 侧与 prompt golden 侧可各自变绿；golden 是快照而非由 schema 派生 | `schema-prompt-adapter.test.ts` + `prompt-golden.test.ts` |
| 10 | **无 N-1 → N 版本对版本升级矩阵** | P2 | 只有 legacy overlay → 当前的迁移测试；跨版本升级组合无覆盖。任务书提及的 PRI-671 资产在本 checkout 不存在 | `legacy-migration.test.ts`（217 行）+ `migration.test.ts`（79 行） |

---

## 8. Suggested Contract Invariants

> 只写 invariant，不写方案。筛选标准：高价值、deterministic、低维护成本。
> 「值得进 `check:pipeline-contract`」= 该 invariant 可用**纯静态 / 纯文件级**判定，无需起服务、无需模型、无时间依赖。

### 值得进 `check:pipeline-contract`（deterministic + 低维护）

| # | Invariant | 为什么 deterministic 且低维护 |
|---|---|---|
| I-1 | **每个 host adapter 产生的遥测事件类型，必须是 Console 消费方的已知集合的子集** | 两端都是**代码中的枚举/常量**；比对是集合运算。当前 NEW-1 正是这个 invariant 的反例。零运行时依赖 |
| I-2 | **同一激活写入路径的 writer 集合必须被显式声明，且实现的写入者数量 == 声明数量** | 「声明」是常量表，「实现」是导出符号；比对是符号计数。防止静默接入第二条写入路径（NEW-3） |
| I-3 | **`verify:merge` 的组成中，必须至少覆盖每个 package 的一个测试入口** | 可对 `package.json` 的 scripts 字符串做结构断言。当前 §3.1 的缺口（7 个包无测试）由一条静态断言即可被永久暴露 |
| I-4 | **Topology 边集合的唯一真相源，必须被所有派工方引用（无第二份硬编码边表）** | 静态可判定：全仓只允许出现一份 edge 表定义。P4 的语言化表达 |
| I-5 | **架构 guard 使用的断言形式中，`toContain`/`not.toContain` 型断言不得成为某不变量的唯一保护** | 可静态枚举 guard 文件中的断言形态，并与行为测试文件的覆盖范围做交叉核对（advisory 起步） |

### 值得作为测试 invariant，但不适合进静态 guard

| # | Invariant | 理由 |
|---|---|---|
| I-6 | **审批完成 → host 强制**：一条 activation 从审批落库到 host 拒绝一次 tool call，必须是**同一条测试** | 需要真 SQLite + 真 dispatcher + 真 hook，属行为测试 |
| I-7 | **停用端到端**：console/CLI 的停用动作后，host 侧下一次 tool call 不再被该 activation 影响 | 同上 |
| I-8 | **Codex 与 OpenClaw 的事件日志对同一语义事件产生同构记录**（lineage 标识一致） | 需要两端真跑，属跨 host 契约测试 |
| I-9 | **真实模型链可用性**：nightly 必须 fail loud（而非回落 mock 后 pass） | 时间/成本敏感，不适合 PR gate；但「回落必须可观察」（rc-9）本身可作为 invariant |

### 需要 Owner 裁决（我不给方案，只列选项）

1. **是否把包级测试并入 merge gate**：选项 A = 保持现状（并行 job 各自 blocking，但 merge gate 语义更窄）；选项 B = merge gate 引入轻量聚合（如跑各包 fast 套件）；选项 C = 重命名 `verify:merge` 以消除语义误导。**这是治理/成本决策，超出 Worker 权限。**
2. **Codex 端 `rulehost_evaluated` 的归属**：选项 A = Codex 补齐事件；选项 B = Console 消费方放宽为「多来源事件」；选项 C = 显式声明 Codex 不支持该指标并在 UI 明示。**影响面涉及产品边界，停手交 Owner。**

---

## 9. Out of Scope

明确**未做**的事，以及**做了但不算结论**的事：

1. **未修改任何源码、配置、CI、test 文件** —— 只读审计。
2. **未运行全量 vitest**（任务书禁止；云端预算不足）。因此本报告**不含任何覆盖率数字**，也**不声称**任何测试当前是绿的。所有结论来自静态阅读。
3. **未 `npm install`** —— 依赖未安装，故未执行任何需要依赖的检查。
4. **唯一实际运行的命令**：
   - `git rev-parse HEAD`、`git log`、`git cat-file`、`git fetch`（基线核实）
   - `node scripts/check-docs-structure.cjs` → 输出 `[check:docs-structure] OK: docs/.private/ 0 tracked, 9 required files exist, 0 stray root .md files.`，EXIT=0
   - 纯 `grep`/`find`/`wc` 静态检索
5. **未裁决任何设计决策** —— §8 的两个开放问题已按要求以选项形式列出，交 Owner。
6. **未提出修复方案**（R-19 F 面按要求只记事实）：
   - **R-19 F 面事实记录**：沙箱信任边界的现有测试资产为
     `packages/openclaw-plugin/tests/core/sandbox-escape-regression.test.ts`（130 行）。
     **有回归覆盖的对抗性输入**（每条均断言 `checkForbiddenPatterns` 至少命中一个 pattern）：
     `this.constructor.constructor("return process")()`（constructor 链）、`globalThis` 访问、
     `import.meta`、`WeakRef`、`FinalizationRegistry`、`SharedArrayBuffer`、`Atomics`、
     `Reflect.construct(Function, [...])()`、`new Proxy(...)`、`require(...)`、`import fs from "fs"`、
     `eval(...)`、`Function("return process")()`、`globalThis["process"]`（括号访问）、`globalThis["WeakRef"]`（括号访问）。
     **无回归覆盖的对抗性输入**（本报告仅记录事实，不评价是否应覆盖）：
     该文件自陈 "NON-EXHAUSTIVE — they cover canonical escape patterns, not all possible exploits"，
     并有一处**常真的 documentation-only 测试**（"documents accepted residual risk: node:vm 0day V8 escape"，
     测试体为模板字符串，无断言）。此外，静态层之外的子进程边界断言全部是
     **源码文本匹配**（`toContain('spawnSync')`、`toContain('--max-old-space-size=32')`、
     `toMatch(/timeout:\s*\w+/)`、`toContain('Object.create(null)')`），
     它们是防重构删除的**存在性守卫**，不是对抗性输入的**行为验证**。
   - **编号可验证性**：`R-19` 在本 checkout 的审计文档中不存在（`docs/plans/2026-05-roadmap/` 中的 R-19 是 "Probation 让审批不可理解"，语义无关）；`#1710` 检索无命中。故「#1710 CONFIRMED 的 P1」这一前提**无法在 current main 上验证**。
7. **未触碰 Linear**（零密钥姿态，章程 §6）。
8. **未评估 docs 之外的历史审计产物**（`docs/audit/agent-pipeline-audit-2026-09-15/` 在本 checkout 不存在）。

---

## 附：本报告的来源分布

| 来源类型 | 说明 |
|---|---|
| 生产测试文件 | §4 与 §5 的每一条判定均给出 test file 路径 |
| 测试配置 | `package.json` scripts、各包 `vitest.config.ts`、`.github/workflows/*.yml` |
| 文档 | `docs/specs/features/**`、`docs/pipeline-evolution/reports/**`（**仅作导航，未被当作实现真相**） |
| 推断 | 已显式标注（如 §7 第 3、4 项的「中间隔两跳」表述） |

**未使用**：历史审计结论（因不可达）、覆盖率数字（因未运行）、任何密钥或运行时状态。
