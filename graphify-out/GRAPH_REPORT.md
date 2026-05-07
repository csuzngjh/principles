# Graph Report - principles  (2026-05-06)

## Corpus Check
- 728 files · ~1,964,988 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 4124 nodes · 9933 edges · 82 communities detected
- Extraction: 68% EXTRACTED · 32% INFERRED · 0% AMBIGUOUS · INFERRED: 3190 edges (avg confidence: 0.77)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Community 0|Community 0]]
- [[_COMMUNITY_Community 1|Community 1]]
- [[_COMMUNITY_Community 2|Community 2]]
- [[_COMMUNITY_Community 3|Community 3]]
- [[_COMMUNITY_Community 4|Community 4]]
- [[_COMMUNITY_Community 5|Community 5]]
- [[_COMMUNITY_Community 6|Community 6]]
- [[_COMMUNITY_Community 7|Community 7]]
- [[_COMMUNITY_Community 8|Community 8]]
- [[_COMMUNITY_Community 9|Community 9]]
- [[_COMMUNITY_Community 10|Community 10]]
- [[_COMMUNITY_Community 11|Community 11]]
- [[_COMMUNITY_Community 12|Community 12]]
- [[_COMMUNITY_Community 13|Community 13]]
- [[_COMMUNITY_Community 14|Community 14]]
- [[_COMMUNITY_Community 15|Community 15]]
- [[_COMMUNITY_Community 16|Community 16]]
- [[_COMMUNITY_Community 17|Community 17]]
- [[_COMMUNITY_Community 18|Community 18]]
- [[_COMMUNITY_Community 19|Community 19]]
- [[_COMMUNITY_Community 20|Community 20]]
- [[_COMMUNITY_Community 21|Community 21]]
- [[_COMMUNITY_Community 22|Community 22]]
- [[_COMMUNITY_Community 23|Community 23]]
- [[_COMMUNITY_Community 24|Community 24]]
- [[_COMMUNITY_Community 25|Community 25]]
- [[_COMMUNITY_Community 26|Community 26]]
- [[_COMMUNITY_Community 27|Community 27]]
- [[_COMMUNITY_Community 28|Community 28]]
- [[_COMMUNITY_Community 29|Community 29]]
- [[_COMMUNITY_Community 30|Community 30]]
- [[_COMMUNITY_Community 31|Community 31]]
- [[_COMMUNITY_Community 32|Community 32]]
- [[_COMMUNITY_Community 33|Community 33]]
- [[_COMMUNITY_Community 34|Community 34]]
- [[_COMMUNITY_Community 35|Community 35]]
- [[_COMMUNITY_Community 36|Community 36]]
- [[_COMMUNITY_Community 37|Community 37]]
- [[_COMMUNITY_Community 39|Community 39]]
- [[_COMMUNITY_Community 40|Community 40]]
- [[_COMMUNITY_Community 41|Community 41]]
- [[_COMMUNITY_Community 43|Community 43]]
- [[_COMMUNITY_Community 44|Community 44]]
- [[_COMMUNITY_Community 45|Community 45]]
- [[_COMMUNITY_Community 46|Community 46]]
- [[_COMMUNITY_Community 47|Community 47]]
- [[_COMMUNITY_Community 48|Community 48]]
- [[_COMMUNITY_Community 49|Community 49]]
- [[_COMMUNITY_Community 54|Community 54]]
- [[_COMMUNITY_Community 56|Community 56]]
- [[_COMMUNITY_Community 57|Community 57]]
- [[_COMMUNITY_Community 58|Community 58]]
- [[_COMMUNITY_Community 59|Community 59]]
- [[_COMMUNITY_Community 65|Community 65]]
- [[_COMMUNITY_Community 66|Community 66]]
- [[_COMMUNITY_Community 67|Community 67]]
- [[_COMMUNITY_Community 68|Community 68]]
- [[_COMMUNITY_Community 69|Community 69]]
- [[_COMMUNITY_Community 70|Community 70]]
- [[_COMMUNITY_Community 72|Community 72]]
- [[_COMMUNITY_Community 87|Community 87]]
- [[_COMMUNITY_Community 88|Community 88]]
- [[_COMMUNITY_Community 89|Community 89]]
- [[_COMMUNITY_Community 117|Community 117]]
- [[_COMMUNITY_Community 118|Community 118]]
- [[_COMMUNITY_Community 238|Community 238]]
- [[_COMMUNITY_Community 239|Community 239]]
- [[_COMMUNITY_Community 240|Community 240]]
- [[_COMMUNITY_Community 243|Community 243]]
- [[_COMMUNITY_Community 244|Community 244]]
- [[_COMMUNITY_Community 246|Community 246]]
- [[_COMMUNITY_Community 247|Community 247]]
- [[_COMMUNITY_Community 248|Community 248]]
- [[_COMMUNITY_Community 249|Community 249]]
- [[_COMMUNITY_Community 250|Community 250]]
- [[_COMMUNITY_Community 251|Community 251]]
- [[_COMMUNITY_Community 252|Community 252]]
- [[_COMMUNITY_Community 253|Community 253]]
- [[_COMMUNITY_Community 254|Community 254]]
- [[_COMMUNITY_Community 255|Community 255]]
- [[_COMMUNITY_Community 256|Community 256]]
- [[_COMMUNITY_Community 257|Community 257]]

## God Nodes (most connected - your core abstractions)
1. `now()` - 181 edges
2. `log()` - 130 edges
3. `error()` - 130 edges
4. `warn()` - 117 edges
5. `info()` - 78 edges
6. `processEvolutionQueue()` - 57 edges
7. `TrainingExperimentResult` - 52 edges
8. `TrajectoryDatabase` - 50 edges
9. `EventLog` - 49 edges
10. `handleBeforePromptBuild()` - 48 edges

## Surprising Connections (you probably didn't know these)
- `normalizeSeverity()` --calls--> `extractEmpathySignal()`  [INFERRED]
  packages\openclaw-plugin\src\core\empathy-types.ts → packages\openclaw-plugin\src\hooks\llm.ts
- `readPainFlagContract()` --calls--> `readRecentPainContext()`  [INFERRED]
  packages\openclaw-plugin\src\core\pain.ts → packages\openclaw-plugin\src\service\evolution-pain-context.ts
- `initTaskMeta()` --calls--> `now()`  [INFERRED]
  packages\openclaw-plugin\src\core\pd-task-store.ts → scripts\uat\runtime-v2-chain-uat.mjs
- `updateSyncMeta()` --calls--> `now()`  [INFERRED]
  packages\openclaw-plugin\src\core\pd-task-store.ts → scripts\uat\runtime-v2-chain-uat.mjs
- `saveLedger()` --calls--> `seedStore()`  [INFERRED]
  packages\principles-core\src\principle-tree-ledger.ts → packages\openclaw-plugin\tests\core\observability.test.ts

## Hyperedges (group relationships)
- **Agent Protocol Stack** — ai-agent, rag-retrieval-augmented-generation, mcp-model-context-protocol, a2a-agent-to-agent-protocol [EXTRACTED 1.00]
- **AI Agent Core Components** — ai-agent, context-engineering, guardrails, agentic-cycle [EXTRACTED 1.00]

## Communities

### Community 0 - "Community 0"
Cohesion: 0.01
Nodes (88): CandidateIntakeError, CandidateIntakeService, resolveCommandForWindows(), runCliProcess(), buildResult(), buildValidResult(), DefaultDiagnosticianValidator, DiagnosticianPromptBuilder (+80 more)

### Community 1 - "Community 1"
Cohesion: 0.01
Nodes (150): createTempStateDir(), execute_training(), Main entry point. Validates spec, executes training, returns result., validate_spec(), insertPendingCandidate(), makeWorkspaceName(), seedCorrections(), seedPainEvents() (+142 more)

### Community 2 - "Community 2"
Cohesion: 0.02
Nodes (165): assert(), main(), parseArgs(), runSql(), warn(), handleArtifactShow(), ensureConsumedAt(), handleCandidateAudit() (+157 more)

### Community 3 - "Community 3"
Cohesion: 0.02
Nodes (121): canArchive(), getAllImplementations(), _handleArchiveImpl(), handleArchiveImplCommand(), _handleListArchivable(), handleBootstrapTools(), handleResearchTools(), getAllCommandDescriptions() (+113 more)

### Community 4 - "Community 4"
Cohesion: 0.02
Nodes (53): artifactShow(), candidateList(), check(), main(), parseArgs(), printReport(), status(), SqliteDiagnosticianCommitter (+45 more)

### Community 5 - "Community 5"
Cohesion: 0.02
Nodes (73): CentralDatabase, clampPageSize(), ControlUiQueryService, parseJson(), roundRate(), compute_next_wake_seconds(), _infer_priority(), _is_retry_due() (+65 more)

### Community 6 - "Community 6"
Cohesion: 0.03
Nodes (104): createImplementationAssetDir(), deleteImplementationAssetDir(), getImplementationAssetRoot(), loadEntrySource(), loadManifest(), validateImplId(), writeEntrySource(), writeManifest() (+96 more)

### Community 7 - "Community 7"
Cohesion: 0.03
Nodes (98): bootstrapRules(), run(), selectPrinciplesForBootstrap(), setupLedger(), validateBootstrap(), auditCandidateLedgerConsistency(), escapeRegex(), extractPathRegex() (+90 more)

### Community 8 - "Community 8"
Cohesion: 0.05
Nodes (113): ABC, EvaluationMetrics, EvaluationRequest, EvaluationResult, EvaluationSample, EvaluatorBackend, ExpectedArtifact, from_dict() (+105 more)

### Community 9 - "Community 9"
Cohesion: 0.02
Nodes (30): DetectionFunnel, SimpleLRU, PainDictionary, shouldIgnorePainProtocolText(), EventLog, EventLogService, createEmptyDailyStats(), disposeAllEvolutionEngines() (+22 more)

### Community 10 - "Community 10"
Cohesion: 0.04
Nodes (104): scanEnvironment(), PainConfig, applyPreset(), formatProjectFocus(), getWorkspaceDir(), handleContextCommand(), saveConfig(), setProjectFocus() (+96 more)

### Community 11 - "Community 11"
Cohesion: 0.04
Nodes (107): computeCodeHash(), computeConfigFingerprint(), generateExperimentId(), getDefaultHardwareTier(), isValidModelFamilyForProfile(), validateHardwareTier(), validateTrainerResult(), buildBlockers() (+99 more)

### Community 12 - "Community 12"
Cohesion: 0.03
Nodes (88): adjustThresholdsFromSignals(), createDefaultState(), getDetailedThresholdState(), getEffectiveThresholds(), getStore(), hasStateFile(), hasVersionField(), isFileValid() (+80 more)

### Community 13 - "Community 13"
Cohesion: 0.03
Nodes (30): makeMockRunDir(), tempDir(), makeTempDir(), makeTempDir(), makeTempDir(), makeTempDir(), makeTempDir(), createTmpDir() (+22 more)

### Community 14 - "Community 14"
Cohesion: 0.08
Nodes (95): archiveRun(), archiveRunById(), captureGitInfo(), copyDirRecursive(), extractSection(), findLatestStageGitStatus(), generateSummary(), nowIso() (+87 more)

### Community 15 - "Community 15"
Cohesion: 0.05
Nodes (61): ensureDir(), CorrectionCueLearner, createDefaultStore(), loadCorrectionKeywordStore(), saveCorrectionKeywordStore(), checkEnvironment(), detectWorkspace(), getOpenClawConfigDir() (+53 more)

### Community 16 - "Community 16"
Cohesion: 0.04
Nodes (20): getCentralDatabase(), resetCentralDatabase(), CentralHealthService, CentralOverviewService, StoreEventEmitter, calculateDuration(), EvolutionQueryService, getEvolutionQueryService() (+12 more)

### Community 17 - "Community 17"
Cohesion: 0.03
Nodes (28): read(), 测试 emit_signal 能否写入 WORKBOARD.json (包含第三方 Agent), 测试 WORKBOARD 是否会自动截断旧消息, TestEventBus, 测试 PROFILE JSON 非法时门禁应阻断, 测试 AskUserQuestion 门禁：专家用户下微观决策应自动化执行，不应频繁打扰, 测试 AskUserQuestion 门禁：高影响决策可向用户请示, 测试 AskUserQuestion 门禁：中等影响在低熟练度领域可升级为请示 (+20 more)

### Community 18 - "Community 18"
Cohesion: 0.04
Nodes (35): goToNext(), goToPrevious(), makeCurrent(), toggleClass(), checkEvolutionGate(), disposeEvolutionEngine(), EvolutionEngine, getEvolutionEngine() (+27 more)

### Community 19 - "Community 19"
Cohesion: 0.06
Nodes (24): seedTrajectorySession(), makeIdleResult(), makePrinciple(), makeRule(), seedLedger(), seedSession(), seedAssistantTurn(), seedGateBlock() (+16 more)

### Community 20 - "Community 20"
Cohesion: 0.08
Nodes (59): determineNextRunRecommendation(), determineOutputQuality(), extractSectionContent(), hasSectionStrict(), validateChecks(), validateGlobalReviewerReport(), validateProducerReport(), validateReviewerReport() (+51 more)

### Community 21 - "Community 21"
Cohesion: 0.06
Nodes (10): CodeReviewPainAdapter, OpenClawPainAdapter, recordPainSignal(), deriveSeverity(), validatePainSignal(), formatPrinciple(), formattedLength(), selectPrinciplesForInjection() (+2 more)

### Community 22 - "Community 22"
Cohesion: 0.08
Nodes (36): makeTmpDir(), computeHoldoutFingerprint(), excludeTrainingSet(), selectHoldout(), verifyHoldoutConsistency(), checkComparability(), computeDelta(), ensureEvalsDir() (+28 more)

### Community 23 - "Community 23"
Cohesion: 0.07
Nodes (21): assessDeprecatedReadiness(), clampScore(), clampRate(), computeImplementationStabilityScore(), computePrincipleAdherence(), computeRuleMetrics(), ratio(), countByLifecycle() (+13 more)

### Community 24 - "Community 24"
Cohesion: 0.05
Nodes (41): A2A (Agent-to-Agent) Protocol, ADLC (Agent Development Life Cycle), Agent Card, Agent Memory Design, AgentOps, Agent Taxonomy (Level 0-4), Agentic Cycle, AI Agent (+33 more)

### Community 25 - "Community 25"
Cohesion: 0.1
Nodes (10): dedupe(), evaluatePhase3Inputs(), isLegacyStatus(), isTimeoutOnlyOutcome(), normalizeStatus(), normalizeTaskId(), normalizeTimestamp(), pushWarning() (+2 more)

### Community 26 - "Community 26"
Cohesion: 0.1
Nodes (8): OperatorHealthReadModel, buildMaskedPrincipleSet(), getCachedMaskedPrincipleSet(), appendPruningReview(), ensureStateDir(), getLogPath(), listPruningReviews(), validateDecision()

### Community 27 - "Community 27"
Cohesion: 0.07
Nodes (28): DDO (Direct Discriminative Optimization), DDT (Decoupled Diffusion Transformer), DINOv2, DiT (Diffusion Transformers), Dispersive Loss, InfoNCE, Jensen's Inequality, MMDiT (Multimodal Diffusion Transformer) (+20 more)

### Community 28 - "Community 28"
Cohesion: 0.14
Nodes (25): buildExplanation(), computeAllCompliance(), computeCompliance(), computeViolationTrend(), detectOpportunity(), detectT01Opportunity(), detectT01Violation(), detectT02Opportunity() (+17 more)

### Community 29 - "Community 29"
Cohesion: 0.21
Nodes (8): getDbPath(), rollbackMigration(), run(), runMigrations(), showStatus(), ensureDatabaseSchema(), MigrationRunner, getCatalog()

### Community 30 - "Community 30"
Cohesion: 0.11
Nodes (9): ConfigurationError, DependencyError, EvolutionProcessingError, LockUnavailableError, PathResolutionError, PdError, SampleNotFoundError, TrajectoryError (+1 more)

### Community 31 - "Community 31"
Cohesion: 0.36
Nodes (13): addSearchBox(), addSortIndicators(), enableUI(), getNthColumn(), getTable(), getTableBody(), getTableHeader(), loadColumns() (+5 more)

### Community 32 - "Community 32"
Cohesion: 0.44
Nodes (10): a(), B(), c(), D(), g(), i(), k(), o() (+2 more)

### Community 33 - "Community 33"
Cohesion: 0.3
Nodes (9): AsyncWriteQueue, computeTrajectoryStats(), ensureTrajectoryDirAsync(), getTodayFilename(), handleAfterToolCall(), handleBeforeMessageWrite(), handleLlmOutput(), scrubSensitive() (+1 more)

### Community 34 - "Community 34"
Cohesion: 0.17
Nodes (1): StubRuntimeAdapter

### Community 35 - "Community 35"
Cohesion: 0.35
Nodes (11): check_dependencies(), check_gpu(), check_package(), check_python(), get_args(), install_dependencies(), main(), print_dependencies_status() (+3 more)

### Community 36 - "Community 36"
Cohesion: 0.17
Nodes (12): Creative Thinking, Constructive Dissatisfaction, Generalization, Intelligence or Talent, Inversion of Problems, Motivation, Nim Game, Restating Problems in Multiple Forms (+4 more)

### Community 37 - "Community 37"
Cohesion: 0.18
Nodes (1): TestDoubleRuntimeAdapter

### Community 39 - "Community 39"
Cohesion: 0.22
Nodes (1): TestStatusLine

### Community 40 - "Community 40"
Cohesion: 0.43
Nodes (5): handleSubmit(), getLanguage(), normalizeLanguage(), t(), useI18n()

### Community 41 - "Community 41"
Cohesion: 0.48
Nodes (5): auditEventLogs(), countAllHooks(), findEventLogs(), findKnownEventLogPaths(), readRecentEntries()

### Community 43 - "Community 43"
Cohesion: 0.43
Nodes (4): getGatewayToken(), getOpenClawToken(), initGatewayToken(), requestJson()

### Community 44 - "Community 44"
Cohesion: 0.29
Nodes (2): MockErrorReadModel, MockHealthyReadModel

### Community 45 - "Community 45"
Cohesion: 0.33
Nodes (7): Bell Labs, Information Theory, Claude Elwood Shannon, Shannon Award, Theseus Mouse, Alan Turing, Uranium Analogy for Brain

### Community 46 - "Community 46"
Cohesion: 0.33
Nodes (7): Agentic Workflows, AI-Enabled, AI-Native, Fine-tuning, 构建创成式 AI 产品, ICONIQ 2025 AI 建造者手册, Retrieval-Augmented Generation (RAG)

### Community 47 - "Community 47"
Cohesion: 0.29
Nodes (7): Chain of Thought, Creative Thinking (Shannon), Creative Thinking Techniques (Simplification, Analogy, Restatement, Generalization, Structural Analysis, Inversion), 去技能化 (De-skilling), Human-in-the-loop, 自动化的讽刺与AI时代的技能危机, 监控疲劳 (Vigilance Decrement)

### Community 48 - "Community 48"
Cohesion: 0.53
Nodes (4): gateBlockSession(), makeSession(), safeSession(), t01()

### Community 49 - "Community 49"
Cohesion: 0.33
Nodes (6): Bounded Sub-Agent Delegation, Coding Agent Harness Design (Sebastian Raschka), Context Compression, Prompt Caching, Session Memory, Workspace Context

### Community 54 - "Community 54"
Cohesion: 0.4
Nodes (2): useAuth(), ProtectedRoute()

### Community 56 - "Community 56"
Cohesion: 0.4
Nodes (5): FLUX.1 Kontext, KontextBench, Adversarial Diffusion Distillation, Double Stream and Single Stream Modules, Generative Flow Matching

### Community 57 - "Community 57"
Cohesion: 0.4
Nodes (5): Gyroscope Protocol, Governance Traceability, Inference Accountability, Information Variety, Intelligence Integrity

### Community 58 - "Community 58"
Cohesion: 0.4
Nodes (5): Context Reset, Generator-Evaluator Pattern, Harness design for long-running application development, Sprint Contract, Three-Agent Architecture (Planner, Generator, Evaluator)

### Community 59 - "Community 59"
Cohesion: 0.4
Nodes (5): Inductive Reasoning for Skill Consolidation, Parallel Multi-Agent Patch Proposal, Skill Creation from Scratch, Skill Deepening, Trace2Skill

### Community 65 - "Community 65"
Cohesion: 0.5
Nodes (4): FluxControlNetModel, Flux ControlNet, Control Residual, Zero Initialization

### Community 66 - "Community 66"
Cohesion: 0.5
Nodes (4): Better Harness: A Recipe for Harness Hill-Climbing with Evals, Eval-Driven Development, Harness Engineering, Production Traces

### Community 67 - "Community 67"
Cohesion: 0.5
Nodes (4): AutoHarness, Code as Harness, Harness-as-Action-Verifier, Harness-as-Policy

### Community 68 - "Community 68"
Cohesion: 0.5
Nodes (4): Continual Personalization, Hindsight Policy, SDPO: Self-Distillation Policy Optimization from User Interactions, Self-Distillation

### Community 69 - "Community 69"
Cohesion: 0.5
Nodes (4): Agentic Proposer, Filesystem as Feedback Channel, Meta-Harness, Meta-Harness Optimization

### Community 70 - "Community 70"
Cohesion: 0.5
Nodes (4): 4C Framework (Concision, Coding, Content, Customer), 生成式AI的经济潜力和实践指南, 技能转型 (Skill Transformation), SMART策略模型

### Community 72 - "Community 72"
Cohesion: 1.0
Nodes (2): detectLifecycleIntent(), routeLifecycleIntent()

### Community 87 - "Community 87"
Cohesion: 1.0
Nodes (2): Copy-IfExists(), Ensure-Directory()

### Community 88 - "Community 88"
Cohesion: 0.67
Nodes (3): LLM 高效提示词实践指南, PTCF Framework, Metaprompting

### Community 89 - "Community 89"
Cohesion: 0.67
Nodes (3): AI as Amplifier, AI 提升工程效率实践指南, High-Quality Prompts

### Community 117 - "Community 117"
Cohesion: 1.0
Nodes (2): Cognitive State Machine, SEIA-v2 (Self-Evolving Agent)

### Community 118 - "Community 118"
Cohesion: 1.0
Nodes (2): LLM Wiki Pattern, Persistent Wiki Pattern

### Community 238 - "Community 238"
Cohesion: 1.0
Nodes (1): Validate the evaluation request.         Returns True if valid, False otherwise

### Community 239 - "Community 239"
Cohesion: 1.0
Nodes (1): Load the model and adapter for evaluation.         Returns True if successful,

### Community 240 - "Community 240"
Cohesion: 1.0
Nodes (1): Score a single sample using the loaded model.         Must be implemented by su

### Community 243 - "Community 243"
Cohesion: 1.0
Nodes (1): Validate the experiment spec.         Returns True if valid, False otherwise.

### Community 244 - "Community 244"
Cohesion: 1.0
Nodes (1): Execute training and return the result.

### Community 246 - "Community 246"
Cohesion: 1.0
Nodes (1): Isaac Newton

### Community 247 - "Community 247"
Cohesion: 1.0
Nodes (1): 测试 Death Spiral 检测的词边界匹配

### Community 248 - "Community 248"
Cohesion: 1.0
Nodes (1): 测试场景：包含 fix 子串但不是真正 fix 的词汇（如 prefix/suffix）         使用简单 count() 会误判，但使用词边界正则不

### Community 249 - "Community 249"
Cohesion: 1.0
Nodes (1): 测试场景：真正的重复 fix 应该触发 Death Spiral

### Community 250 - "Community 250"
Cohesion: 1.0
Nodes (1): 测试 post_write_checks 中 task_type 变量定义问题

### Community 251 - "Community 251"
Cohesion: 1.0
Nodes (1): 测试场景：soft signal 被捕获时，task_type 应该在         _compute_task_priority 调用之前就已经定义

### Community 252 - "Community 252"
Cohesion: 1.0
Nodes (1): 测试场景：仅有 soft signal（无测试失败）时，         task_type 应该是 quality_signal

### Community 253 - "Community 253"
Cohesion: 1.0
Nodes (1): 测试 profile.py 模块的 PROFILE 解析功能

### Community 254 - "Community 254"
Cohesion: 1.0
Nodes (1): 测试 load_profile 能正确归一化缺失字段

### Community 255 - "Community 255"
Cohesion: 1.0
Nodes (1): 测试 load_profile 能纠正非法 audit_level

### Community 256 - "Community 256"
Cohesion: 1.0
Nodes (1): 测试 load_decision_policy 默认值

### Community 257 - "Community 257"
Cohesion: 1.0
Nodes (1): 测试 _normalize_decision_policy 能合并用户配置

## Knowledge Gaps
- **185 isolated node(s):** `调用 Headless Claude 模式`, `Re-detect files in packages/`, `Extract AST from code files`, `Dispatch semantic extraction subagents for uncached files`, `Merge all chunk files into semantic JSON` (+180 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **Thin community `Community 34`** (12 nodes): `StubRuntimeAdapter`, `.cancelRun()`, `.constructor()`, `.fetchArtifacts()`, `.fetchOutput()`, `.getCapabilities()`, `.healthCheck()`, `.kind()`, `.pollRun()`, `.setOutput()`, `.setRunStatus()`, `.startRun()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 37`** (11 nodes): `TestDoubleRuntimeAdapter`, `.appendContext()`, `.cancelRun()`, `.constructor()`, `.fetchArtifacts()`, `.fetchOutput()`, `.getCapabilities()`, `.healthCheck()`, `.kind()`, `.pollRun()`, `.startRun()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 39`** (9 nodes): `TestStatusLine`, `.setUp()`, `.tearDown()`, `.test_statusline_happy_path()`, `.test_statusline_missing_files()`, `.test_statusline_pain_flag()`, `.test_statusline_queue_metrics()`, `.test_statusline_queue_metrics_absent_when_no_open_tasks()`, `test_statusline.py`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 44`** (7 nodes): `runtime-pruning.test.ts`, `MockErrorReadModel`, `.getHealthSummary()`, `.getPrincipleSignals()`, `MockHealthyReadModel`, `.getHealthSummary()`, `.getPrincipleSignals()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 54`** (5 nodes): `AuthProvider()`, `useAuth()`, `ProtectedRoute.tsx`, `auth.tsx`, `ProtectedRoute()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 72`** (3 nodes): `detectLifecycleIntent()`, `routeLifecycleIntent()`, `lifecycle-routing.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 87`** (3 nodes): `Copy-IfExists()`, `Ensure-Directory()`, `collect-control-plane-snapshot.ps1`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 117`** (2 nodes): `Cognitive State Machine`, `SEIA-v2 (Self-Evolving Agent)`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 118`** (2 nodes): `LLM Wiki Pattern`, `Persistent Wiki Pattern`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 238`** (1 nodes): `Validate the evaluation request.         Returns True if valid, False otherwise`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 239`** (1 nodes): `Load the model and adapter for evaluation.         Returns True if successful,`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 240`** (1 nodes): `Score a single sample using the loaded model.         Must be implemented by su`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 243`** (1 nodes): `Validate the experiment spec.         Returns True if valid, False otherwise.`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 244`** (1 nodes): `Execute training and return the result.`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 246`** (1 nodes): `Isaac Newton`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 247`** (1 nodes): `测试 Death Spiral 检测的词边界匹配`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 248`** (1 nodes): `测试场景：包含 fix 子串但不是真正 fix 的词汇（如 prefix/suffix）         使用简单 count() 会误判，但使用词边界正则不`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 249`** (1 nodes): `测试场景：真正的重复 fix 应该触发 Death Spiral`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 250`** (1 nodes): `测试 post_write_checks 中 task_type 变量定义问题`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 251`** (1 nodes): `测试场景：soft signal 被捕获时，task_type 应该在         _compute_task_priority 调用之前就已经定义`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 252`** (1 nodes): `测试场景：仅有 soft signal（无测试失败）时，         task_type 应该是 quality_signal`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 253`** (1 nodes): `测试 profile.py 模块的 PROFILE 解析功能`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 254`** (1 nodes): `测试 load_profile 能正确归一化缺失字段`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 255`** (1 nodes): `测试 load_profile 能纠正非法 audit_level`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 256`** (1 nodes): `测试 load_decision_policy 默认值`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 257`** (1 nodes): `测试 _normalize_decision_policy 能合并用户配置`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `now()` connect `Community 1` to `Community 0`, `Community 2`, `Community 3`, `Community 4`, `Community 5`, `Community 9`, `Community 10`, `Community 11`, `Community 12`, `Community 13`, `Community 14`, `Community 15`, `Community 16`, `Community 18`, `Community 19`, `Community 20`, `Community 26`?**
  _High betweenness centrality (0.193) - this node is a cross-community bridge._
- **Why does `warn()` connect `Community 2` to `Community 32`, `Community 1`, `Community 3`, `Community 5`, `Community 6`, `Community 7`, `Community 9`, `Community 10`, `Community 11`, `Community 12`, `Community 13`, `Community 15`, `Community 16`, `Community 17`, `Community 18`, `Community 19`, `Community 28`?**
  _High betweenness centrality (0.113) - this node is a cross-community bridge._
- **Why does `error()` connect `Community 2` to `Community 0`, `Community 1`, `Community 3`, `Community 5`, `Community 6`, `Community 7`, `Community 9`, `Community 10`, `Community 12`, `Community 14`, `Community 15`, `Community 18`, `Community 20`, `Community 22`, `Community 29`?**
  _High betweenness centrality (0.056) - this node is a cross-community bridge._
- **Are the 176 inferred relationships involving `now()` (e.g. with `writeFileAtomic()` and `restartGatewayWindows()`) actually correct?**
  _`now()` has 176 INFERRED edges - model-reasoned connections that need verification._
- **Are the 127 inferred relationships involving `log()` (e.g. with `runInstall()` and `runUninstall()`) actually correct?**
  _`log()` has 127 INFERRED edges - model-reasoned connections that need verification._
- **Are the 127 inferred relationships involving `error()` (e.g. with `runInstall()` and `runUninstall()`) actually correct?**
  _`error()` has 127 INFERRED edges - model-reasoned connections that need verification._
- **Are the 114 inferred relationships involving `warn()` (e.g. with `runInstall()` and `showStatus()`) actually correct?**
  _`warn()` has 114 INFERRED edges - model-reasoned connections that need verification._