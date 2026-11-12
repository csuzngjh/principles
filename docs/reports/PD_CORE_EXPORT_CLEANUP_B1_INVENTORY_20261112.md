# 核心库零引用导出清理（B1）· 清单与分批计划

> **口径与旧数不同的原因**：早前口头数字（116 条目 / 96 符号 / S=53·L=34·A=9）来自文本 grep 近似计数——它把同文件、注释、文档里的出现当成引用，又漏算桶文件转发，因而无法复现；本报告改用 TypeScript AST + 全仓符号解析重算，**以本文的 269 条目 / 266 符号为准**，旧数不应再被引用。

> 类型：只读统计 + 可执行清单（本文件不含任何代码改动）
> 基线：`origin/main` @ `76d565d2d`（2026-11-12）
> 采集脚本：一次性 AST 扫描（TypeScript 编译器 API），不提交；口径见 §1
> 机器可读清单：`docs/reports/evidence/b1-export-cleanup-20261112/inventory.json`

## 0. 结论摘要

1. 按本文件口径，**不在公开面上、且全仓零引用（含文档）的导出共 266 个符号 / 269 个导出条目**：S=167、L=46、R=44、A=9。
2. 上一轮给的「116 条目 / 96 符号 / S=53·L=34·A=9」**无法在任一整体口径下复现**。唯一在条目数上完全吻合的是 `src/runtime/internalization` 单个子系统的内部零引用导出（116 条），但那是 116 个符号、S=93/L=9/R=14，与 S=53/L=34/A=9 仍不一致。详见 §2。
3. 因此本报告以**重新统计的结果为准**，并把 B1 范围收窄到「**不影响公开面**」的部分：不删任何 27 个公开入口可达的符号，公开面保持 2,351 不变，导出面门禁预期 `+0 / -0`。
4. 分批：**S（167 符号）→ L（46 符号）→ A/R（53 符号）**，每批独立提交、独立 changeset、可单独回退。

## 1. 统计口径

| 术语 | 定义 |
|---|---|
| 导出条目 | 一个 `export` 声明节点：`export interface/type/class/function/const`、`export { A, B as C } [from '...']` 中的每个具名 specifier；`export * from` 单独记录 |
| 引用 | ① 其它文件的相对路径 `import`；② 其它文件的 `export { X } from` 转发（conduit）；③ `import * as ns` + `ns.X` 成员访问；④ 其它包 / `scripts` / `plugins` 对 `@principles/core` 与 `@principles/core/*` 的具名导入、转发、动态 `import()` / `require()`；⑤ 文档（`docs/**`、各包 `*.md`）中的字面出现 |
| 公开面 | `packages/principles-core/package.json#exports` 的 27 个子路径（不含 `./package.json`）递归可达的符号并集 |
| 零引用 | 上述 ①–⑤ 全部为 0（同文件内使用不计入引用，单独统计 `sameFileUses`） |
| S | 声明级导出，声明仍被本文件其它代码使用 → 只删 `export` 修饰符，声明保留 |
| L | 声明级导出，本文件也没人用 → 删 `export` 后声明变成未使用，需连声明一起删（否则 `no-unused-vars` / `noUnusedLocals` 必红） |
| R | 仅桶文件里的转发 specifier，声明在别的文件且仍被使用 → 只删这一条转发 |
| A | 别名条目（`export { X as Y }`），`Y` 零引用 → 只删别名条目 |

自证：
- 公开面符号数 **2,351**，与 #2565 门禁基线一致。
- `src/index.ts` 200 个、`src/runtime/index.ts` 2,032 个符号，与仓库内 PRI-775 快照 fixture 逐字一致。
- 抽查已知高频符号：`SqliteConnection` 162 处外部导入、`getDefaultPdConfig` 74、`RuntimeStateManager` 60、`escapeXml` 23 —— 与审计报告数量级一致。

## 2. 与上一轮数字的差异（事实）

| 口径 | 条目 | 符号 | S | L | A | R |
|---|---:|---:|---:|---:|---:|---:|
| 全部导出条目（core/src，非测试模块） | 6,367 | 2,989 | — | — | — | — |
| 全仓零引用（同文件使用也算引用） | 1,657 | 1,423 | 0 | 82 | 17 | 1,558 |
| 其它文件零引用（同文件使用不算） | 1,913 | 1,664 | 240 | 82 | 21 | 1,570 |
| 其中：**不在公开面**（B1 候选） | 335 | 328 | 203 | 50 | 9 | 73 |
| 其中：B1 候选 **且文档零提及**（本报告采用） | **269** | **266** | **167** | **46** | **9** | **44** |
| 上一轮给数 | 116 | 96 | 53 | 34 | 9 | — |

- 唯一在「条目数」上重合的是 `src/runtime/internalization` 的内部零引用导出：**116 条**；但去重后是 116 个符号（不是 96），分类为 S=93 / L=9 / R=14（不是 53/34/9）。
- 因此判定：上一轮的 96 / 53 / 34 很可能来自「按 grep 文本计数」的近似口径（把同文件、注释、文档里的出现也算作引用，或漏算桶文件转发），**无法作为删除依据**。本报告改用 AST + 全仓符号解析，并把文档提及作为额外保守条件剔除。
- 差异不影响安全性方向：本报告的范围比上一轮更宽，但全部限定在**公开面之外**，删除不会改变对外 API。

## 3. 范围与不变量

- 不删任何公开入口（27 个子路径）可达的符号；`package.json#exports` 不动。
- 不新增 allowlist、不放宽门禁、不用 `export type` 或 `@ts-ignore` 绕过。
- 每批改动后必须：门禁 `CI=true node scripts/check-core-export-surface.mjs` 绿（预期 `+0 / -0`）、`npm run build` 全仓通过、`npm test --workspace=@principles/core` 通过。
- 每个 L 符号删声明前，用 AST（`references` 级）与 `grep` 双重确认「文件内确实没有其它使用」。

## 4. 分批计划

| 批次 | 内容 | 符号数 | 条目数 | 预期 diff |
|---|---|---:|---:|---|
| B1-1 | S：删 `export` 修饰符（声明保留） | 167 | 170 | 约 70 个文件、每处 1 行 |
| B1-2 | L：连声明一起删 | 46 | 46 | 约 25 个文件 |
| B1-3 | A/R：删别名与桶转发 specifier | 53 | 53 | 约 10 个文件 |

> S 批次里，若某符号在桶文件另有转发条目，转发条目一并删除（同一符号必须同批处理，否则删 `export` 会打断转发）。

## 5. 清单

### 5.1 S 类（167 符号，删 `export` 修饰符）

| 符号 | 声明位置 | 类型 | 条目 |
|---|---|---|---|
| `ActivationCompatibilitySkipped` | runtime/activation-compatibility-read-model.ts:38 | interface | 1 条 |
| `ActivationCompatibilitySkipReason` | runtime/activation-compatibility-read-model.ts:29 | type | 1 条 |
| `AdmissionDecisionValue` | runtime/store/candidate/admission-document.ts:33 | type | 1 条 |
| `AppendAdmissionEvaluationResult` | runtime/store/candidate/admission-document.ts:147 | type | 1 条 |
| `ApplyOwnerResolutionArgs` | runtime/internalization/owner-resolution-service.ts:308 | interface | 1 条 |
| `approvalSignalsInText` | runtime/internalization/textual-basis-anchor.ts:89 | function | 1 条 |
| `ARTIFACT_SUMMARY_SCHEMA_VERSION` | runtime/internalization/artifact-summary.ts:58 | const | 1 条 |
| `ArtifactContentPrecondition` | runtime/store/task/sqlite-task-store.ts:17 | interface | 1 条 |
| `ArtifactShowResult` | runtime/cli/diagnose.ts:60 | interface | 1 条 |
| `ArtificerEvidencePreflightParams` | runtime/internalization/consumer-evidence-preflight.ts:160 | interface | 1 条 |
| `ArtificerExecutionMode` | runtime/internalization/artificer-run-correlation.ts:61 | type | 1 条 |
| `ArtificerIntentPreflightParams` | runtime/internalization/artificer-intent-preflight.ts:158 | interface | 1 条 |
| `ArtificerPromptBuildResult` | runtime/internalization/artificer-prompt-builder.ts:186 | interface | 1 条 |
| `ArtificerRunCorrelationInput` | runtime/internalization/artificer-run-correlation.ts:66 | interface | 1 条 |
| `AssociationCheck` | runtime/diagnostician-association-validation.ts:11 | type | 1 条 |
| `AssociationValidation` | runtime/diagnostician-association-validation.ts:16 | type | 1 条 |
| `BuildDreamerSeedFromCandidateOptions` | runtime/internalization/intake-to-internalization-bridge.ts:281 | interface | 1 条 |
| `CandidateIdentityUnresolvedReason` | runtime/types/rule-candidate-binding.ts:32 | type | 1 条 |
| `CandidateListResult` | runtime/cli/diagnose.ts:24 | interface | 1 条 |
| `CandidateShowResult` | runtime/cli/diagnose.ts:36 | interface | 1 条 |
| `CausalChainEntrySchema` | runtime/diagnostician/diag-rootcause-output.ts:42 | const | 1 条 |
| `ChangeDesignGateDecisionInput` | runtime/store/design-gate/sqlite-design-gate-store.ts:24 | interface | 1 条 |
| `classifyHumanReviewAttention` | runtime/internalization/owner-review.ts:446 | function | 1 条 |
| `CONTEXT_BUDGET_SOFT_RATIO` | runtime/adapter/context-budget.ts:34 | const | 1 条 |
| `ContextBudget` | runtime/adapter/context-budget.ts:44 | interface | 1 条 |
| `CreateSyntheticRuleHostInputOptions` | runtime/golden-trace.ts:108 | interface | 1 条 |
| `DELIVERY_OUTCOMES` | runtime/types/intervention-evidence-contract.ts:78 | const | 1 条 |
| `DeriveSummaryFailureReason` | runtime/internalization/artifact-summary.ts:103 | type | 1 条 |
| `DeriveSummaryResult` | runtime/internalization/artifact-summary.ts:108 | type | 1 条 |
| `DesignGateStoreErrorCode` | runtime/store/design-gate/sqlite-design-gate-store.ts:39 | type | 1 条 |
| `DiagDistillerRunnerOptions` | runtime/internalization/diag-distiller-runner.ts:65 | interface | 1 条 |
| `DiagDistillerScopeSchema` | runtime/diagnostician/diag-distiller-output.ts:17 | const | 1 条 |
| `DIAGNOSTICIAN_DISABLED_NEXT_ACTION` | runtime/pain-signal-runtime-factory.ts:557 | const | 1 条 |
| `DiagRootCauseEvidenceSchema` | runtime/diagnostician/diag-rootcause-output.ts:54 | const | 1 条 |
| `DiagRootCauseRunnerOptions` | runtime/internalization/diag-rootcause-runner.ts:78 | interface | 1 条 |
| `DiagRouterRunnerOptions` | runtime/internalization/diag-router-runner.ts:117 | interface | 1 条 |
| `DisabledDiagnosticianRunnerOptions` | runtime/pain-signal-runtime-factory.ts:547 | interface | 1 条 |
| `DistillerContextInput` | runtime/diagnostician/distiller-prompt-builder.ts:59 | interface | 1 条 |
| `DistillerPromptBuilderOptions` | runtime/diagnostician/distiller-prompt-builder.ts:38 | interface | 1 条 |
| `DistillerPromptBuildResult` | runtime/diagnostician/distiller-prompt-builder.ts:94 | interface | 1 条 |
| `DistillerPromptInput` | runtime/diagnostician/distiller-prompt-builder.ts:79 | interface | 1 条 |
| `DreamerCandidateSchema` | runtime/internalization/dreamer-output.ts:68 | const | 1 条 |
| `DreamerProjection` | runtime/internalization/formation-context.ts:274 | interface | 1 条 |
| `DreamerPromptBuilderInput` | runtime/internalization/dreamer-prompt-builder.ts:30 | interface | 1 条 |
| `DreamerPromptBuildResult` | runtime/internalization/dreamer-prompt-builder.ts:48 | interface | 1 条 |
| `DreamerRunnerResultStatus` | runtime/internalization/dreamer-runner.ts:53 | type | 1 条 |
| `EdgeScope` | runtime/internalization/internalization-job-graph.ts:112 | interface | 1 条 |
| `EnforcementItemSchema` | runtime/owner-decision/owner-decision-view-contract.ts:177 | const | 1 条 |
| `EvaluatorCompressionFidelity` | runtime/internalization/evaluator-output.ts:183 | interface | 1 条 |
| `EvaluatorConvergenceContext` | runtime/internalization/evaluator-output.ts:457 | interface | 1 条 |
| `EvaluatorExpectedRequirement` | runtime/internalization/evaluator-output.ts:450 | interface | 1 条 |
| `EvaluatorPainCoverage` | runtime/internalization/evaluator-output.ts:177 | interface | 1 条 |
| `ExtractedExecutionConditions` | runtime/internalization/intent-contract.ts:139 | interface | 1 条 |
| `FamilyReopenInput` | runtime/store/task/sqlite-family-reopen.ts:9 | interface | 1 条 |
| `FORMATION_DIAGNOSIS_RECOMMENDATION_LIMIT` | runtime/internalization/formation-context.ts:54 | const | 1 条 |
| `FORMATION_DIAGNOSIS_VIOLATED_LIMIT` | runtime/internalization/formation-context.ts:53 | const | 1 条 |
| `FORMATION_DREAMER_CONTEXT_REF_LIMIT` | runtime/internalization/formation-context.ts:55 | const | 1 条 |
| `FormationDiagnosisEvidence` | runtime/internalization/formation-context.ts:113 | interface | 1 条 |
| `FormationDiagnosisViolatedPrinciple` | runtime/internalization/formation-context.ts:107 | interface | 1 条 |
| `GovernanceHeadlineCodeSchema` | runtime/governance-projection-contract.ts:109 | const | 1 条 |
| `GovernanceNextActionCodeSchema` | runtime/governance-projection-contract.ts:121 | const | 1 条 |
| `GovernanceReasonCodeSchema` | runtime/governance-projection-contract.ts:115 | const | 1 条 |
| `HostToolKindFact` | runtime/internalization/evaluator-prompt-builder.ts:165 | interface | 1 条 |
| `InterventionEffectStatus` | runtime/types/intervention-evidence-contract.ts:97 | type | 1 条 |
| `InterventionEpisodeStatus` | runtime/types/intervention-evidence-contract.ts:96 | type | 1 条 |
| `InterventionOutcomeSource` | runtime/types/intervention-evidence-contract.ts:98 | type | 1 条 |
| `LanguageDirectiveSubject` | runtime/language-directive.ts:137 | type | 1 条 |
| `LeaseManagerOptions` | runtime/store/lifecycle/lease-manager.ts:102 | interface | 1 条 |
| `LineageEchoTraceRule` | runtime/internalization/peer-runner-contracts.ts:417 | interface | 1 条 |
| `LineageField` | runtime/adapter/output-repair-contract.ts:109 | type | 1 条 |
| `MarkOwnerResolutionAppliedCtx` | runtime/internalization/owner-review.ts:601 | interface | 1 条 |
| `MaterialGateItemSchema` | runtime/owner-decision/owner-decision-view-contract.ts:237 | const | 1 条 |
| `MAX_ABSTRACTED_PRINCIPLE_CHARS` | runtime/runner/default-validator.ts:44 | const | 1 条 |
| `MAX_POST_PROCESSING_ATTEMPTS` | runtime/pain-signal-bridge.ts:57 | const | 1 条 |
| `MAX_SCHEMA_PROMPT_DEPTH` | runtime/adapter/schema-prompt-adapter.ts:11 | const | 1 条 |
| `MIN_ANCHORED_BASIS_CHARS` | runtime/internalization/textual-basis-anchor.ts:27 | const | 1 条 |
| `MIN_CONTEXT_BUDGET_TOKENS` | runtime/adapter/context-budget.ts:42 | const | 1 条 |
| `NextActionContext` | runtime/types/evidence-chain-contract.ts:481 | interface | 1 条 |
| `NO_ACCEPT_HUMAN_REVIEW_REASONS` | runtime/internalization/owner-review.ts:91 | const | 1 条 |
| `NormalizationResult` | runtime/types/evidence-chain-contract.ts:544 | interface | 1 条 |
| `OutOfScopeFailedCase` | runtime/internalization/rule-reliability-validation.ts:227 | interface | 1 条 |
| `OutputPathLabel` | runtime/adapter/pi-ai-runtime-adapter.ts:169 | type | 1 条 |
| `OutputPathStrategy` | runtime/adapter/pi-ai-runtime-adapter.ts:56 | type | 1 条 |
| `OwnerDecisionApplicationsSchema` | runtime/owner-decision/owner-decision-view.ts:80 | const | 1 条 |
| `OwnerDecisionCandidateSchema` | runtime/owner-decision/owner-decision-view.ts:43 | const | 1 条 |
| `OwnerDecisionDiagnosisSchema` | runtime/owner-decision/owner-decision-view.ts:55 | const | 1 条 |
| `OwnerDecisionPhilosopherSchema` | runtime/owner-decision/owner-decision-view.ts:74 | const | 1 条 |
| `OwnerDecisionScribeSchema` | runtime/owner-decision/owner-decision-view.ts:64 | const | 1 条 |
| `OwnerRetryOptions` | runtime/internalization/owner-retry.ts:48 | interface | 1 条 |
| `PAIN_ANCHOR_TYPES` | runtime/context-payload.ts:171 | const | 1 条 |
| `ParseAdmissionDocumentResult` | runtime/store/candidate/admission-document.ts:79 | type | 1 条 |
| `parseCorrelation` | runtime/pain-ingress-payload.ts:187 | function | 1 条 |
| `parseDeviationAnchor` | runtime/pain-ingress-payload.ts:281 | function | 1 条 |
| `parseEvidence` | runtime/pain-ingress-payload.ts:246 | function | 1 条 |
| `parseScore` | runtime/pain-ingress-payload.ts:268 | function | 1 条 |
| `PhilosopherPrincipleCandidateSchema` | runtime/internalization/philosopher-output.ts:33 | const | 1 条 |
| `PhilosopherPromptBuilderInput` | runtime/internalization/philosopher-prompt-builder.ts:30 | interface | 1 条 |
| `PhilosopherPromptBuildResult` | runtime/internalization/philosopher-prompt-builder.ts:48 | interface | 1 条 |
| `PI_AI_DEFAULT_PROFILE` | runtime/config/pd-config-defaults.ts:44 | const | 1 条 |
| `PI_AI_DEFAULT_PROFILE_ID` | runtime/config/pd-config-defaults.ts:42 | const | 1 条 |
| `PIPELINE_TOPOLOGY_MODES` | runtime/internalization/peer-runner-contracts.ts:309 | const | 1 条 |
| `PrincipleQualityChecklist` | runtime/internalization/owner-decision-review.ts:109 | interface | 1 条 |
| `PrincipleQualityChecklistItem` | runtime/internalization/owner-decision-review.ts:114 | interface | 1 条 |
| `PriorRequirement` | runtime/internalization/evaluator-prompt-builder.ts:82 | interface | 1 条 |
| `PriorRequirementStatus` | runtime/internalization/evaluator-output.ts:110 | type | 1 条 |
| `PriorRequirementStatusEntry` | runtime/internalization/evaluator-output.ts:112 | interface | 1 条 |
| `PriorRequirementStatusEntrySchema` | runtime/internalization/evaluator-output.ts:207 | const | 1 条 |
| `ProductionGateDepsOptions` | runtime/activation/production-gate-deps.ts:226 | interface | 1 条 |
| `PROFILE_DEFAULT_ADAPTIVE_PAIN` | runtime/config/pd-profile-constants.ts:35 | const | 1 条 |
| `PROFILE_DEFAULT_EDIT_VERIFICATION` | runtime/config/pd-profile-constants.ts:56 | const | 1 条 |
| `PROFILE_DEFAULT_LIFECYCLE` | runtime/config/pd-profile-constants.ts:51 | const | 1 条 |
| `PROFILE_DEFAULT_PAIN` | runtime/config/pd-profile-constants.ts:46 | const | 1 条 |
| `PROFILE_DEFAULT_TESTS` | runtime/config/pd-profile-constants.ts:29 | const | 1 条 |
| `ProfileValidationResult` | runtime/config/pd-validate-profile.ts:27 | type | 1 条 |
| `ProfileValidationWarning` | runtime/config/pd-validate-profile.ts:22 | interface | 1 条 |
| `projectRepeatedGoldenHistoriesForEvaluator` | runtime/internalization/evaluator-prompt-builder.ts:217 | function | 1 条 |
| `PromptBuilderLimits` | runtime/diagnostician-prompt-builder.ts:99 | interface | 1 条 |
| `ReconstructedExposure` | runtime/internalization/router-context-reconstruction.ts:43 | type | 1 条 |
| `ReconstructedRouterContextEvidence` | runtime/internalization/router-context-reconstruction.ts:47 | interface | 1 条 |
| `ReconstructRouterContextEvidenceInput` | runtime/internalization/router-context-reconstruction.ts:59 | interface | 1 条 |
| `RenderDirectivesOptions` | runtime/activation/prompt-activation-reader-contract.ts:269 | interface | 1 条 |
| `RepairReplayResolution` | runtime/internalization/repair-replay-resolver.ts:107 | type | 1 条 |
| `RepairReplayResolutionFailureReason` | runtime/internalization/repair-replay-resolver.ts:100 | type | 1 条 |
| `RepairReplayResolverDeps` | runtime/internalization/repair-replay-resolver.ts:115 | interface | 1 条 |
| `RequirementLedgerEntry` | runtime/internalization/evaluator-prompt-builder.ts:108 | interface | 1 条 |
| `RequirementLedgerEntrySchema` | runtime/internalization/evaluator-output.ts:216 | const | 1 条 |
| `ResolveRuntimeConfigForAgentOptions` | runtime/pain-signal-runtime-factory.ts:306 | interface | 1 条 |
| `ResolveSourceDeclaredRelationsInput` | runtime/diagnostician-association-shadow.ts:169 | interface | 1 条 |
| `REUSABLE_PRINCIPLE_STATUSES` | runtime/principle-reuse/reuse-retrieval.ts:35 | const | 1 条 |
| `ReuseCheckOutcome` | runtime/candidate-intake-service.ts:186 | type | 1 条 |
| `ReuseDecisionValidation` | runtime/principle-reuse/reuse-proposal.ts:92 | type | 1 条 |
| `ReuseEvidenceActorSchema` | runtime/types/principle-schema.ts:95 | const | 1 条 |
| `ReuseEvidenceEntrySchema` | runtime/types/principle-schema.ts:100 | const | 1 条 |
| `ReuseProposalStatus` | runtime/principle-reuse/reuse-proposal.ts:24 | type | 1 条 |
| `RevokeDesignGateDeclarationInput` | runtime/store/design-gate/sqlite-design-gate-store.ts:32 | interface | 1 条 |
| `ROLLOUT_REVIEWER_PRINCIPLE_SEMANTIC_CONTRACT_VERSION` | runtime/internalization/rollout-reviewer-prompt-builder.ts:145 | const | 1 条 |
| `RolloutReviewerValidatorOptions` | runtime/internalization/rollout-reviewer-output.ts:105 | interface | 1 条 |
| `RootCauseCategorySchema` | runtime/diagnostician/diag-rootcause-output.ts:27 | const | 1 条 |
| `RootCausePromptBuilderOptions` | runtime/diagnostician/rootcause-prompt-builder.ts:133 | interface | 1 条 |
| `RouteMissingField` | runtime/internalization/internalization-route.ts:29 | type | 1 条 |
| `RouterPromptBuilderOptions` | runtime/diagnostician/router-prompt-builder.ts:48 | interface | 1 条 |
| `RouterPromptBuildResult` | runtime/diagnostician/router-prompt-builder.ts:131 | interface | 1 条 |
| `RouterPromptInput` | runtime/diagnostician/router-prompt-builder.ts:111 | interface | 1 条 |
| `RuleActivationContentCheck` | runtime/internalization/rule-activation-contract.ts:31 | type | 1 条 |
| `RuleActivationContentGap` | runtime/internalization/rule-activation-contract.ts:25 | type | 1 条 |
| `scoreReuseCandidate` | runtime/principle-reuse/reuse-shortlist.ts:125 | function | 1 条 |
| `ScribeAnchoringOptions` | runtime/internalization/scribe-output.ts:139 | interface | 1 条 |
| `ScribeIntentMaterial` | runtime/internalization/textual-basis-anchor.ts:44 | interface | 1 条 |
| `ScribePrincipleDraftSchema` | runtime/internalization/scribe-output.ts:71 | const | 1 条 |
| `ScribePromptBuilderInput` | runtime/internalization/scribe-prompt-builder.ts:7 | interface | 1 条 |
| `ScribePromptBuildResult` | runtime/internalization/scribe-prompt-builder.ts:43 | interface | 1 条 |
| `ScribeSourceTraceSchema` | runtime/internalization/scribe-output.ts:80 | const | 1 条 |
| `SemanticSelection` | runtime/owner-decision/semantic-selector.ts:33 | interface | 1 条 |
| `SemanticUnknown` | runtime/owner-decision/semantic-selector.ts:42 | interface | 1 条 |
| `ShapeBridgeResultInput` | runtime/bridge-result-shaper.ts:69 | type | 1 条 |
| `SnapshotValidationErr` | runtime/product-telemetry/snapshot-contract.ts:121 | interface | 1 条 |
| `SnapshotValidationOk` | runtime/product-telemetry/snapshot-contract.ts:116 | interface | 1 条 |
| `SourceDeclaredRelationResolution` | runtime/diagnostician-association-shadow.ts:145 | type | 1 条 |
| `SourceReadStatusSchema` | runtime/owner-decision/owner-decision-view-contract.ts:333 | const | 1 条 |
| `SplitDiagnosticianRunnerDeps` | runtime/internalization/split-diagnostician-runner.ts:44 | interface | 1 条 |
| `SqliteConnectionOptions` | runtime/store/sqlite-connection.ts:32 | interface | 1 条 |
| `SummaryFreshness` | runtime/internalization/artifact-summary.ts:428 | type | 1 条 |
| `TechnicalDetailsSchema` | runtime/owner-decision/owner-decision-view-contract.ts:358 | const | 1 条 |
| `TextBudgetFit` | runtime/adapter/context-budget.ts:92 | interface | 1 条 |
| `UnboundEvidenceRef` | runtime/diagnostician/evidence-ref-binding.ts:81 | interface | 1 条 |
| `UndeclaredApprovalDependencyFinding` | runtime/internalization/textual-basis-anchor.ts:107 | interface | 1 条 |
| `V2_CONTEXT_ONLY_TEMPLATE_EXPECTED_ALLOW` | runtime/internalization/rule-reliability-validation.ts:131 | const | 1 条 |

### 5.2 L 类（46 符号，连声明删除）

| 符号 | 声明位置 | 类型 | 条目 |
|---|---|---|---|
| `AdaptiveSelectionOutputV1` | runtime/activation/adaptive-selection-output.ts:40 | type | 1 条 |
| `ArtificerRuleOutputTB` | runtime/internalization/artificer-output.ts:108 | type | 1 条 |
| `CandidateCreatedDataTB` | runtime/evolution/evolution-types.ts:352 | type | 1 条 |
| `CircuitBreakerOpenedDataTB` | runtime/evolution/evolution-types.ts:393 | type | 1 条 |
| `CONVERSATION_ACCESS_CONFIG_KEY` | runtime/config/pd-config-types.ts:542 | const | 1 条 |
| `CorrectionKeywordStoreTB` | runtime/correction/correction-types.ts:104 | type | 1 条 |
| `CorrectionKeywordTB` | runtime/correction/correction-types.ts:97 | type | 1 条 |
| `DiagDistillerScope` | runtime/diagnostician/diag-distiller-output.ts:24 | type | 1 条 |
| `DiagRootCauseEvidence` | runtime/diagnostician/diag-rootcause-output.ts:60 | type | 1 条 |
| `DiscriminatedEventLogEntryStatic` | runtime/types/event-payload.ts:174 | type | 1 条 |
| `EvaluabilityTB` | runtime/evolution/evolution-types.ts:216 | type | 1 条 |
| `EvaluatorOutputV1TB` | runtime/internalization/evaluator-output.ts:258 | type | 1 条 |
| `EvolutionLoopEventTB` | runtime/evolution/evolution-types.ts:444 | type | 1 条 |
| `EvolutionLoopEventTypeTB` | runtime/evolution/evolution-types.ts:308 | type | 1 条 |
| `EvolutionPainDetectedDataTB` | runtime/evolution/evolution-types.ts:333 | type | 1 条 |
| `EvolutionPrincipleStatusTB` | runtime/evolution/evolution-types.ts:206 | type | 1 条 |
| `EvolutionPrincipleSuggestedRuleTB` | runtime/evolution/evolution-types.ts:249 | type | 1 条 |
| `EvolutionPrincipleTB` | runtime/evolution/evolution-types.ts:297 | type | 1 条 |
| `EvolutionPrincipleValueMetricsSnapshotTB` | runtime/evolution/evolution-types.ts:256 | type | 1 条 |
| `FORMATION_EVIDENCE_ADDENDUM_VERSION` | runtime/internalization/scribe-prompt-builder.ts:73 | const | 1 条 |
| `GovernanceHeadlineCode` | runtime/governance-projection-contract.ts:158 | type | 1 条 |
| `GovernanceNextActionCode` | runtime/governance-projection-contract.ts:160 | type | 1 条 |
| `GovernanceReasonCode` | runtime/governance-projection-contract.ts:159 | type | 1 条 |
| `HumanReviewReasonCode` | runtime/internalization/owner-review.ts:74 | type | 1 条 |
| `HygieneStatsStatic` | runtime/types/hygiene-types.ts:42 | type | 1 条 |
| `ImplementationStatic` | runtime/types/principle-schema.ts:215 | type | 1 条 |
| `LegacyImportDataTB` | runtime/evolution/evolution-types.ts:400 | type | 1 条 |
| `MaterialGateItem` | runtime/owner-decision/owner-decision-view-contract.ts:247 | type | 1 条 |
| `PersistenceActionStatic` | runtime/types/hygiene-types.ts:21 | type | 1 条 |
| `PhilosopherOutputV1TB` | runtime/internalization/philosopher-output.ts:49 | type | 1 条 |
| `PrincipleDependencyStatic` | runtime/types/principle-dependency.ts:16 | type | 1 条 |
| `PrincipleDeprecatedDataTB` | runtime/evolution/evolution-types.ts:371 | type | 1 条 |
| `PrincipleDetectorSpecTB` | runtime/evolution/evolution-types.ts:229 | type | 1 条 |
| `PrincipleEvaluatorLevelTB` | runtime/evolution/evolution-types.ts:213 | type | 1 条 |
| `PrincipleLifecycleEventStatic` | runtime/types/principle-lifecycle-event.ts:50 | type | 1 条 |
| `PrinciplePromotedDataTB` | runtime/evolution/evolution-types.ts:361 | type | 1 条 |
| `PrincipleRolledBackDataTB` | runtime/evolution/evolution-types.ts:383 | type | 1 条 |
| `PrincipleStatic` | runtime/types/principle-schema.ts:137 | type | 1 条 |
| `PrincipleTreeStoreStatic` | runtime/types/principle-tree-store.ts:22 | type | 1 条 |
| `PrincipleValueMetricsStatic` | runtime/types/principle-value-metrics.ts:28 | type | 1 条 |
| `PROFILE_DEFAULT_CUSTOM_GUARDS` | runtime/config/pd-profile-constants.ts:64 | const | 1 条 |
| `RolloutReviewerOutputV1TB` | runtime/internalization/rollout-reviewer-output.ts:97 | type | 1 条 |
| `RuleStatic` | runtime/types/principle-schema.ts:178 | type | 1 条 |
| `ScribeOutputV1TB` | runtime/internalization/scribe-output.ts:124 | type | 1 条 |
| `WORKSPACE_STATE_DB_RELATIVE_PATH` | runtime/store/storage-paths.ts:31 | const | 1 条 |
| `WORKSPACE_TRAJECTORY_DB_RELATIVE_PATH` | runtime/store/storage-paths.ts:34 | const | 1 条 |

### 5.3 A 类（9 符号，别名条目）

| 符号 | 声明位置 | 类型 | 条目 |
|---|---|---|---|
| `EvidenceCandidateInfo` | (barrel only) | — | 1 条 |
| `EvidenceChainIntentTension` | (barrel only) | — | 1 条 |
| `EvidenceDreamerTaskInfo` | (barrel only) | — | 1 条 |
| `EvidenceLedgerPrinciple` | (barrel only) | — | 1 条 |
| `EvidenceTaskMapEntry` | (barrel only) | — | 1 条 |
| `OwnerNonEmptyStringSchema` | (barrel only) | — | 1 条 |
| `OwnerTimestampSchema` | (barrel only) | — | 1 条 |
| `SubmitOutputSchema` | (barrel only) | — | 1 条 |
| `SubmitRulecodeSchema` | (barrel only) | — | 1 条 |

### 5.4 R 类（44 符号，仅桶转发条目）

| 符号 | 声明位置 | 类型 | 条目 |
|---|---|---|---|
| `AdversarialConversionResult` | (barrel only) | — | 1 条 |
| `ArtifactWithCandidates` | (barrel only) | — | 2 条 |
| `ArtificerCodeBearingAssessment` | (barrel only) | — | 1 条 |
| `attributionFromLayer` | (barrel only) | — | 1 条 |
| `CandidateIdentityReceipt` | (barrel only) | — | 1 条 |
| `ChainStateParams` | (barrel only) | — | 1 条 |
| `CommitRecord` | (barrel only) | — | 2 条 |
| `CoreAxiomBlockOptions` | (barrel only) | — | 1 条 |
| `DEFAULT_REPAIR_CONFIG` | (barrel only) | — | 1 条 |
| `DispatcherConfig` | (barrel only) | — | 1 条 |
| `FailureAttribution` | (barrel only) | — | 1 条 |
| `isV2ContextCase` | (barrel only) | — | 1 条 |
| `OwnerRevisionArtifactDraft` | (barrel only) | — | 1 条 |
| `OwnerRevisionBuildResult` | (barrel only) | — | 1 条 |
| `PainDeviationAnchor` | (barrel only) | — | 1 条 |
| `PartialContextInjectionConfig` | (barrel only) | — | 1 条 |
| `PrinciplesConfig` | (barrel only) | — | 1 条 |
| `PROFILE_AUDIT_LEVELS` | (barrel only) | — | 1 条 |
| `PROFILE_EVOLUTION_MODES` | (barrel only) | — | 1 条 |
| `PROFILE_TEST_LEVELS` | (barrel only) | — | 1 条 |
| `ProfileAuditLevel` | (barrel only) | — | 1 条 |
| `ProfileConfig` | (barrel only) | — | 1 条 |
| `ProfileEvolutionMode` | (barrel only) | — | 1 条 |
| `ProfileTestLevel` | (barrel only) | — | 1 条 |
| `PromotionCriteriaProjectionInput` | (barrel only) | — | 1 条 |
| `PromptReplacementCommit` | (barrel only) | — | 1 条 |
| `PromptReplacementDetection` | (barrel only) | — | 1 条 |
| `PromptReplacementOutcome` | (barrel only) | — | 1 条 |
| `PromptReplacementTarget` | (barrel only) | — | 1 条 |
| `QuietFlagLifecycleDecision` | (barrel only) | — | 1 条 |
| `QuietFlagLifecycleEntry` | (barrel only) | — | 1 条 |
| `RedactedProfileSummary` | (barrel only) | — | 1 条 |
| `RepairCallbacks` | (barrel only) | — | 1 条 |
| `RepairConfig` | (barrel only) | — | 1 条 |
| `RepairLLMCaller` | (barrel only) | — | 1 条 |
| `RepairResult` | (barrel only) | — | 1 条 |
| `resolveRequiresContextVersionFromArtifact` | (barrel only) | — | 1 条 |
| `RuleHostWriterConfig` | (barrel only) | — | 2 条 |
| `RuleReplacementDetection` | (barrel only) | — | 1 条 |
| `RuleReplacementTarget` | (barrel only) | — | 1 条 |
| `SchemaValidationError` | (barrel only) | — | 1 条 |
| `SqliteArtifactStore` | (barrel only) | — | 1 条 |
| `SqliteCommitStore` | (barrel only) | — | 1 条 |
| `VALID_PROJECT_FOCUS_MODES` | (barrel only) | — | 1 条 |

## 6. 验证与回退

- 每批：`CI=true node scripts/check-core-export-surface.mjs` → 期望 `+0 / -0`、exit 0（公开面未动）。
- 每批：`npm run build`、`npm test --workspace=@principles/core`。
- 每批一个 changeset，标题逐条列出被删符号（S/L/A/R 分组），不写「清理导出」。
- 每批一个独立提交；回退 = `git revert` 单批提交，不需要跨批协调。

## 7. 已知不确定性

1. 外部 npm 消费者不可观测：零引用只代表本仓为零；S 类只改「是否对外可见」中的内部可见性，不改公开面，但 L/A/R 仍建议随下一次 patch 发布并在发布说明中列出。
2. 文档提及已作为剔除条件（`docMentions > 0` 不删）；若某符号只在设计文档里作为示例出现，本报告不会误删。
3. 名称去重按「导出名」而非「声明标识」；同名不同模块的符号会合并成一行（当前候选集内未出现同名异义）。
