# EXAMINER V0101 BASELINE AUDIT

**日期：** 2026-11-03  
**执行：** ZCode 自主执行（SPEC-PD-EXAMINER-001 v0.10.1 全量产品化 Mandate）  
**代码基线：** `origin/main@9a2bd5efbdfeea5c01468f1beff5f86e4078c3ae`  
**分支：** `ai/adhoc-20261103-examiner-v0101`（worktree `D:\Code\_worktrees\principles\adhoc-20261103-examiner-v0101`，writer=zcode，lease+git lock 已持有）

---

## 1. 基线事实（Evidence Over Assumption）

| 项 | 事实 | 证据 |
|---|---|---|
| Examiner v0.9 已在 main | PR #2257 于 2026-11-01 合并（merge commit `e7c86b3d5`，135 文件 +23,202/−410） | `gh pr view 2257` → state=MERGED |
| v0.7 已在 main | PR #2239 于 2026-10-31 合并 | `gh pr view 2239` → state=MERGED |
| main HEAD | `9a2bd5efb`（Merge PR #2295 changeset-release） | `git log origin/main` |
| v0.10.1 SPEC 草稿 | 前会话产物，未跟踪于主检出 `docs/specs/SPEC-PD-EXAMINER-001 v0.10.1.md`（1615 行，PROPOSED） | 主检出只读取证后复制入本 worktree，状态更新为 IMPLEMENTING |
| 未合并 Examiner PR | 无（#2257/#2239 均已合并；open PR 2296/2297/2298/2299/2287/2283 均为 release/pain/deps 线，与 Examiner 无重叠） | `gh pr list --state open` |
| 主检出未跟踪文件 | 全部为 docs/plans/specs 草稿与 pnpm 文件，不属于本任务写入范围，未触碰（git-4） | `git status` |

## 2. 已有能力（复用矩阵，全部验证存在于 main）

### 2.1 Examiner 研究引擎（`scripts/dev/principle-learning-lab/lib/`）

- `examiner-study.mjs`（1203 行）：`writeExaminerStudyArtifacts()`（唯一建库路径，冻结 manifest/prereg/pair/HEPS/rulecode/arms/suite/mapping + PREREGISTRATION_FROZEN 锚）、`buildHostEffectivePrincipleSet()`、`buildRuleCodePolicy()`（不可识别→`INTERVENTION_NOT_IDENTIFIABLE` 拒绝）、`buildDualModeArmPayloads()`（isolated=空对照 / full-library=库±目标，skip_and_continue_v1 预算）、`assignPairs()`（种子化平衡随机）、`runExaminerPreflight()`（fail-closed）、`computeExaminerStudyBindings()`/`verifyExaminerStudyBindings()`。
- `examiner-injection-evidence.mjs`：六级链 CONFIGURED→…→RUNTIME_LOADED，`HOST_MAX_PROVABLE_LEVEL`（openclaw/codex/workbuddy 均为 SUBMITTED），producer 白名单。
- `challenge-runner.mjs` / `challenge-behavior-report.mjs`：`runChallengeStudy()`、`writeBehaviorReportV2()`/`verifyBehaviorReportV2()`（ITT 四格 + Fidelity + Randomization）。
- `challenge-openclaw-host.mjs`（F2 真实宿主 transport）、`challenge-actor-transport.mjs`（真实模型 actor + JSON Action Protocol）、`challenge-stage-r-gate.mjs`（Stage R 授权 `challenge-stage-authorization.v1`，F1/F2 模式，`readStageRAuthorization()`/`verifyStageRAuthorization()`）。
- `examiner-v07-cases.mjs`：`examinerV3CalibrationCases()`（7 策略）+ `examinerV3SupplementalScenarios()` + `makeExaminerV3Case()`。
- 提交内验收资产：`examiner-studies/EXM-V09-ACC-{ISO,FULL}` + `acceptance-summary.json`（PASS）+ 593 文件历史基线 SHA。

### 2.2 Console 已接入面（v0.9，`packages/pd-console/`）

- 路由 `src/server/routes/examiner.ts`（370 行）+ 执行器 `examiner-executor.ts`（676 行）：overview/principles/studies CRUD/preflight/run(offline-stub only)/report；服务端铸造 `EXM-C-<UUID>` 身份；所有权标记 `.console-study-owner.json`；枚举界定路径解析（无请求字符串构造路径）；可写根 `<workspace>/.pd/examiner/studies` 与历史资产根隔离；漂移→409 零副作用。
- UI `src/ui/pages/examiner/ExaminerPage.tsx`（364 行）：单页全旅程（选原则→模式→创建→preflight→run→report 卡片），loading/error/empty 状态，sonner toast，gates 面板。
- 侧边栏入口 `/examiner`（无条件挂载），Principle 详情页入口链接。
- 测试：`tests/server/routes/examiner.test.ts`（15 it，真实后端）、`examiner-path-boundary.test.ts`（13 it）、UI product-surface 断言、lab 契约 `scripts/__tests__/principle-learning-lab-examiner-v09.test.ts`（1481 行）。

### 2.3 生产证据生态（复用，不建第二套）

- `ReceiptsConsoleModel`（`getPrincipleReceipts` / `getEvidenceAudit(selector)` 四问审计 + coverage + asOf + 降级契约），路由 `/api/v1/receipts/*`。
- `SqliteInterventionEvidenceStore.readAuditRelations()`（deliveries/applications/episodes/effects/outcomes + unresolvedReferences + capabilityDeclarations + 分页）；ingress 单一入口 `getInterventionEvidenceIngress()`。
- `readPromptActivationInjectionStatuses()` / `resolveLivePromptInjectionProjection()` / `buildLivePromptInjectionProjection()`（host-runtime 导出，pd-console 已直接消费于 ActivationsConsoleModel）——真实路由/budget/注入状态/预算来源。
- 动态 Prompt Budget：`resolvePromptBudget()`（model_aware_v1，1250–16000）+ runtime observation（`selectConsoleRuntimeBudgetFacts()`）。
- RuleCode：activations 表 `channel='code_tool_hook'`，`ActivationsConsoleModel` 全量读取（mode/status/control state/decisions/pause/shadow evidence）。
- Owner Outcome：`POST /api/v1/evidence/outcomes`（封闭字段集，owner_console_input，服务端铸 actorId，幂等 observationKey）。
- Owner 决策：`OwnerDecisionViewModel`（只读投影）、`/api/v1/governance/owner-decisions`（任务决策）+ activations/approvals 生命周期动作。
- Pain 链：ledger `derivedFromPainIds`（`getPrincipleDetail` 返回）、`PainChainReadModel`/`pain-recall-read-model`。

## 3. 缺口（v0.10.1 要补的）

1. **UI 深度**：单页 → 需要四页 Owner 旅程（Principle Evaluation / Study Configuration / Execution & Evidence / Evaluation Report）；生产证据（activation、projection、budget、receipts、evidence audit、RuleCode 状态）完全未进入 Examiner UI；无 readOnly/access 原因渲染；无 report dimensions/limitations。
2. **只读集成 API 缺失**：无 per-principle evidence 聚合端点；无 suite 目录端点；无 host readiness 端点。
3. **Study 输入**：Console study 固定 2 个 didactic case、固定 budgetChars=2000、ruleCodeFacts 仅来自 ledger ruleCount；无 suite 选择；无生产 vs 实验配置差异记录；无 production snapshot 冻结。
4. **执行模型**：`/run` 仅同步 offline-stub；无 202 异步契约、无 runId、无并发/重复拒绝、无重启恢复、无 host dry-run。
5. **Owner 闭环**：报告与 Principle 治理无 handoff 入口；无 Owner Outcome 反馈入口（接口存在但 Examiner 面未接）。
6. **验收**：无 examiner 浏览器 E2E（`smoke-all-pages` 未含 /#/examiner）、无 examiner BDD feature。

## 4. 关键依赖与风险

- lab 以 `PD_EXAMINER_LAB_ROOT` / `<console>/lab` / repo fallback 解析——测试沿用现有 env 注入模式。
- `writeExaminerStudyArtifacts` 的绑定校验按固定文件清单计算哈希：向 study 目录**追加**新文件（production snapshot、console run 事件）不破坏绑定（events.jsonl/adjudications.jsonl 同为先例）——仍需以回归测试钉住。
- E2E seed 的 ledger 原则多为 `candidate`：Examiner 目标需要 `active`（HEPS 资格），E2E 需补充 active 原则或复用现有 active 项（实施时核实）。
- `HOST_MAX_PROVABLE_LEVEL.* = SUBMITTED`：真实宿主结论等级边界由能力表钉住，禁止篡改（spec §8.2）。

## 5. 实施顺序（自主执行，不等审批）

```text
Phase A  docs：SPEC 固化 + 本审计                     （本提交）
Phase B  服务端：ExaminerEvidenceModel + GET /principles/:id/evidence
Phase C  服务端：suite 目录 + study 创建 v2（真实 HEPS/RuleCode 快照/生产基线/预算差异）
Phase D  服务端：异步执行契约（202/runId/幂等/并发/恢复）+ host readiness + F2 dry-run + 授权门
Phase E  UI：四页 Owner 旅程 + i18n(en/zh) + product-surface 测试更新
Phase F  测试：路由/lab/BDD feature/安全负向（越权/路径穿越/只读/并发/重复/历史不可变）
Phase G  真实浏览器验收（场景 A–F）+ 截图证据
Phase H  全量回归 + 验收报告 + 最终交付报告 + PR（Owner 合并）
```

## 6. 当前测试状态（基线）

- pd-console vitest：examiner 路由 15 it + path-boundary 13 it + UI surface 1 file（基线绿，实施中随改随跑）。
- 根 vitest：`principle-learning-lab-examiner-v09.test.ts` 等 lab 契约（基线绿）。
- Playwright e2e：`smoke-all-pages.spec.ts` 不含 examiner（本任务补）。
