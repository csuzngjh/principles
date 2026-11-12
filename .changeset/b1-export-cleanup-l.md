---
"@principles/core": patch
---

核心库导出清理（B1 第 2 批 / L 类）：删除 43 个**不在公开面**、全仓零引用的导出声明（41 个类型别名 + 2 个常量）。它们只有声明、没有任何使用点，删除后不改变任何运行时行为；公开导出面（27 个入口、2,351 个符号）不变，门禁 `+0 / -0`。

删除的符号（按字母序，43 个）：

`AdaptiveSelectionOutputV1`、`ArtificerRuleOutputTB`、`CandidateCreatedDataTB`、`CircuitBreakerOpenedDataTB`、`CorrectionKeywordStoreTB`、`CorrectionKeywordTB`、`DiagDistillerScope`、`DiagRootCauseEvidence`、`DiscriminatedEventLogEntryStatic`、`EvaluabilityTB`、`EvaluatorOutputV1TB`、`EvolutionLoopEventTB`、`EvolutionLoopEventTypeTB`、`EvolutionPainDetectedDataTB`、`EvolutionPrincipleStatusTB`、`EvolutionPrincipleSuggestedRuleTB`、`EvolutionPrincipleTB`、`EvolutionPrincipleValueMetricsSnapshotTB`、`FORMATION_EVIDENCE_ADDENDUM_VERSION`、`GovernanceHeadlineCode`、`GovernanceNextActionCode`、`GovernanceReasonCode`、`HumanReviewReasonCode`、`HygieneStatsStatic`、`ImplementationStatic`、`LegacyImportDataTB`、`MaterialGateItem`、`PersistenceActionStatic`、`PhilosopherOutputV1TB`、`PrincipleDependencyStatic`、`PrincipleDeprecatedDataTB`、`PrincipleDetectorSpecTB`、`PrincipleEvaluatorLevelTB`、`PrincipleLifecycleEventStatic`、`PrinciplePromotedDataTB`、`PrincipleRolledBackDataTB`、`PrincipleStatic`、`PrincipleTreeStoreStatic`、`PrincipleValueMetricsStatic`、`PROFILE_DEFAULT_CUSTOM_GUARDS`、`RolloutReviewerOutputV1TB`、`RuleStatic`、`ScribeOutputV1TB`

另有两个注释随符号失效而更新（`pitask-metadata.ts`、`rule-reliability-validation.ts` 中对已删类型 `HumanReviewReasonCode` 的说明改为指向 `HUMAN_REVIEW_REASON`）。

本批**跳过** 3 个符号（不在本 changeset 的删除范围）：

- `CONVERSATION_ACCESS_CONFIG_KEY`：配置键字面量（`allowConversationAccess`），其它包以自有字面量使用，按"配置键命中即保留"处理；
- `WORKSPACE_STATE_DB_RELATIVE_PATH` / `WORKSPACE_TRAJECTORY_DB_RELATIVE_PATH`：与进行中的 `ai/storage-path-single-source` 存储路径收敛线重复，删除会造成无谓冲突，留待该线合并后统一处理。
