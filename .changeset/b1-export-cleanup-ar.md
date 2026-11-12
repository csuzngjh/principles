---
"@principles/core": patch
---

核心库导出清理（B1 第 3 批 / A + R 类）：删除 51 个**不在公开面**、全仓零引用的导出条目——9 个别名条目（`X as Y`）与 42 个内部桶转发 specifier。声明与实现全部保留，运行时行为不变；公开导出面（27 个入口、2,351 个符号）不变，门禁 `+0 / -0`。

删除的符号（按字母序，51 个）：

`EvidenceCandidateInfo`、`EvidenceChainIntentTension`、`EvidenceDreamerTaskInfo`、`EvidenceLedgerPrinciple`、`EvidenceTaskMapEntry`、`OwnerNonEmptyStringSchema`、`OwnerTimestampSchema`、`SubmitOutputSchema`、`SubmitRulecodeSchema`、`AdversarialConversionResult`、`ArtifactWithCandidates`、`ArtificerCodeBearingAssessment`、`attributionFromLayer`、`CandidateIdentityReceipt`、`ChainStateParams`、`CommitRecord`、`CoreAxiomBlockOptions`、`DEFAULT_REPAIR_CONFIG`、`DispatcherConfig`、`FailureAttribution`、`isV2ContextCase`、`OwnerRevisionArtifactDraft`、`OwnerRevisionBuildResult`、`PainDeviationAnchor`、`PartialContextInjectionConfig`、`PrinciplesConfig`、`PROFILE_AUDIT_LEVELS`、`PROFILE_EVOLUTION_MODES`、`PROFILE_TEST_LEVELS`、`ProfileAuditLevel`、`ProfileConfig`、`ProfileEvolutionMode`、`ProfileTestLevel`、`PromotionCriteriaProjectionInput`、`PromptReplacementCommit`、`PromptReplacementDetection`、`PromptReplacementOutcome`、`PromptReplacementTarget`、`QuietFlagLifecycleDecision`、`QuietFlagLifecycleEntry`、`RedactedProfileSummary`、`RepairCallbacks`、`RepairConfig`、`RepairLLMCaller`、`RepairResult`、`resolveRequiresContextVersionFromArtifact`、`RuleHostWriterConfig`、`RuleReplacementDetection`、`RuleReplacementTarget`、`SchemaValidationError`、`VALID_PROJECT_FOCUS_MODES`

本批**跳过** 2 个符号（不在本 changeset 的删除范围）：

- `SqliteArtifactStore`：`src/runtime/store/artifact/index.ts` 的架构契约测试（`architecture-regression.test.ts:929`）显式断言该桶必须导出它，删除会使该测试变红；按"不为了通过而改守卫"处理，保留；
- `SqliteCommitStore`：同上，`architecture-regression.test.ts:940` 断言 `store/commit/index.ts` 必须导出它。
