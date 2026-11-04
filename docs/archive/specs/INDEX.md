# 已归档 SPEC 台账（docs/archive/specs）

归档日期：2026-11-04。

**判定方法**：以 main 上「生产代码是否真的接线并被生产路径消费」+「已并入的工单/PR」为证据，
不采信 SPEC 自己的状态行（AGENTS.md §2 P1「Evidence Over Assumption」：SPEC 表达意图，不证明实现现实）。
事实证明状态行普遍陈旧——例如 test-temp SPEC 自称「草案（未实施）」而 `scripts/test/temp-lifecycle.mjs`
已被 11 处 vitest 配置接线；OWNER_DECISION_EXPERIENCE_V1 自称「未实施」而 PR#1856 早已并入。

**归档范围**：①已实现并交付完成；②已被同族新版取代的旧稿。
未实现、部分实现、仍是现行权威契约、被硬引用钉住的 SPEC 全部留在 `docs/specs/`。

---

## A. 已实现并交付（35 篇）

| SPEC | 实现证据（生产代码 / 并入记录） |
|---|---|
| SPEC-PD-IAER-001-v1.0.md | FR-01 `assessEvidenceReadiness` 被 `rulehost-pipeline-runner.ts:458`、`consumer-evidence-preflight.ts:274` 消费；FR-08 `buildArtificerRunCorrelation` 5 处调用；merge `eaf52c4a3` (#2041, PRI-980–985) |
| SPEC-PD-IAER-001-execution-instructions.md | 同上；要求的代码 + SQLite E2E + 报告均已入库 |
| OWNER_DECISION_EXPERIENCE_V1.md | `runtime-v2/owner-decision/*` + `pd-console/src/server/models/OwnerDecisionViewModel.ts` + `routes/owner-decision.ts`，生产接线 `server/index.ts:40,475`；`42f0f4a7a` (#1856) |
| SPEC-PD-UIUX-001-website-console-upgrade-v1.0.md | R1–R9 全部落地：`PrincipleDetailPage.tsx:122`、`FocusPage.tsx:815`、`app-sidebar.tsx:72`、`website/.vitepress/theme/components/*`；`c11113581` (#1985) |
| SPEC-PD-PAIN-RECALL-CLI-001.md | `pd-cli/src/index.ts:179-193`（`pd pain recall` + 五 flag）、`commands/pain-recall.ts:84`、`principles-core/src/runtime-v2/pain-recall-read-model.ts:68`；`659a5ace5`+`bf7191f85` |
| pain-admission-flag-contract-fix.md | 选项 A 已实施：`feature-flag-contract.ts:248`、`feature-flag-lifecycle.ts:95`「RETIRED 2026-09-12 (PRI-763)」；`pain-diagnostic-gate.ts` 模块本体已删 |
| SPEC-CODEX-PAIN-CLOSURE-001-v0.2.md | `admission-document.ts`、`codex-adapter/src/ingestion/explicit-owner-statement.ts`、`workspace-worker.ts:307`；merge `6e60d8410` (#2019, PRI-958/959/960) |
| SPEC-CODEX-PAIN-CLOSURE-001-v0.2-review.md | 评审项 R01–R07 全部落入 v0.2 必修并随 #2019 落地 |
| SPEC-CODEX-PAIN-CLOSURE-001-zcode-execution.md | 执行指令，交付物即 #2019 的实施结果 |
| workbuddy-host-adapter-spec.md | `workbuddy-adapter/src/codec/input-decoder.ts:48`、`host-adapter.ts`、`installers/workbuddy-host-installer.ts:348,883`；`5e794be8e` (#2020, PRI-952) |
| SPEC-WORKBUDDY-PAIN-CLOSURE-001-v0.1.md | `plugin/skills/{pd-pain-signal,pd-control,pd-review,pd-cli-operator}`、`explicit-owner-statement-prefix.ts`（`PD记录痛苦：`） |
| PD-MCP-GATE3-PROPOSAL-001-OPTIMIZED.md | 提案经 v0.5 采信，Gate 3 实施合并 `f15a5a6a6` (#2270) |
| SPEC-PD-MCP-GATE4-001.md | `pd-mcp-server/src/server.ts:26` `pd_recall_principle_pains`、Gate4-F installer 组件、三宿主 `.mcp.json`；merge `ab4b0f2f5` (#2304, PRI-1071) |
| SPEC-PD-RUNTIME-HANDOVER-001-v0.1.md | `pd-companion/src/lib/version-handover.ts`、`worker-drain.ts` drain IPC、`scripts/release/sync-codex-runtime-pins.mjs`；`5a17a6658`/`e060c56d1` (#2131, PRI-1040) |
| SPEC-PD-OPERATOR-DECLARED-PROMPT-BUDGET-001.md | `prompt-budget-policy.ts:345` tier-0 `operator_declared`、`budget-observation.ts:242`、`pd-config-effective.ts:294`（PRI-1020） |
| SPEC-PD-MODEL-AWARE-PROMPT-BUDGET-001.md | `prompt-budget-policy.ts:49` `model_aware_v1` + `:338 resolvePromptBudget`（1250/16000 公式），Console 观测链已消费 |
| SPEC-RULECODE-QUALITY-001-REVIEW-VERIFICATION.md | RF-01→`production-rulehost-gate.ts:460`；RF-03→`bash-risk.ts classifyCommandRisk`；RF-05→`internalization-consumer-cycle.ts:553` |
| SPEC-RULECODE-GOVERNANCE-CLOSURE-003-v0.1.md | `rule-binding-revision.ts` revise-once、`candidate-identity.ts`、`revision_epoch` 唯一键 `sqlite-pi-artifact-store.ts:132`；PRI-1042 (#2137) |
| SPEC-RULECODE-VERIFICATION-CLOSURE-002-v0.1.md | `rulecode-verification-obligations.ts`（direct_replay / system_counterfactual / derive…）；PRI-1041 (#2132) |
| SPEC-RULECODE-CODEX-LOCAL-CLOSURE-001-v0.1.md | `design-gate-facts.ts`、`sqlite-design-gate-store.ts` gate 声明、`codex-artificer-trusted-facts.ts`；PRI-1019 (#2117) |
| SPEC-RULECODE-CODEX-V2-001-v0.1.md | `hostKinds` 输入契约、`approvals.artifact_digest`(`sqlite-approval-store.ts`)、`trajectory-schema.ts:158` `project_dir`、provider 接 `pd-hook.ts:411`；PRI-1015 (#2077) |
| SPEC-RULECODE-HOST-PROMOTION-001-v0.1.md | `host-liveness-contract.ts:284` 五路 liveness、`workbuddy-rule-context-provider.ts`；#2218 |
| SPEC-RULECODE-APPROVED-REVISION-001-v0.1.md | `approved-rule-revision.ts`、`replaceRuleActivation`/`replaceActivationAtomically`；PRI-739 (#2275) |
| SPEC-PRI-1047-RULECODE-SOURCE-VERIFICATION-v0.1.md | `textual-basis-anchor.ts`、`rule-source-correction.ts` reviseRuleSourceOnce、source-correct-once 路由；#2169 |
| SPEC-PD-CODEMODE-001-zcode-execution-instructions.md | 交付=只读报告，已入库 `docs/implementation-reports/SPEC-PD-CODEMODE-001-{execution-report,source-audit}-20261020.md`；`a57cc3e07` (#2092) |
| SPEC-PD-PI12-COMPAT-001-pi-compat-audit-20261017.md | Phase 0 审计交付副本 `docs/implementation-reports/pi12-compat-phase0-spike-2026-10-17.md` |
| PD_PIPELINE_SAFETY_NET_V1_2_FINAL_CANDIDATE.md | `scripts/check-pipeline-contract.mjs:1`（按 I1–I6/J1/J2/J4 选真实 vitest），`package.json:35,62` verify:merge 末端，`ci.yml:165` |
| PD_PIPELINE_SAFETY_NET_V1_2_BACKEND_EXECUTION_INSTRUCTIONS.md | 同上（该文件是上一篇的单 Session 执行指令，步骤已全部交付） |
| test-temp-lifecycle-management.md | `scripts/test/temp-lifecycle.mjs` 作为 globalSetup 被 11 个 vitest 配置接线；CI 日志实证 |
| trajectory-data-plane-single-truth.md | `principles-core/src/runtime-v2/trajectory-schema.ts:2`（PRI-774），`applyTrajectorySchemaBase` 被 `openclaw-plugin/src/core/trajectory.ts:175`、`pain-signal-observability.ts:103`、`host-runtime/src/production-pain-evidence.ts:467` 消费 |
| SPEC-PD-PRR-001-Gate-A-Zcode-verified-20261017.md | 一次性审计指令，PRI-997/998/999 产物已落 `principles-core/tests/fixtures/gate-a-reproducibility/` + 报告 |
| SPEC-PD-PRR-001-v1.2-reality-audit-corrections-20261017.md | F-01–F-16 已由 v1.3 §10.1 逐项定案消化 |
| PRI-917-reuse-before-create-v0.1.md | `runtime-v2/principle-reuse/{reuse-retrieval,reuse-shortlist,reuse-proposal}.ts`、`principle-tree-ledger.ts:39,532`；`0939eac01` (#1900) |
| EXM-MVP-001-v4-offline-contract.md | `challenge-studies/EXM-MVP-001-v4/`、`verify-exm-human-review.mjs`、`rebind-exm-v4-freeze.mjs`、`lib/challenge-freeze.mjs:145` Ed25519 |
| CEB-002-DELIVERY-PACK.md | `lib/ceb002-stats.mjs:57 mcnemarExactPower`/`:79 reduceCaseLevel`、`build-ceb002-suite.mjs`、`runs/CEB-002-B1-12…B5-16` |

## B. 已被同族新版取代的旧稿（18 篇）

| 旧稿 | 取代者（仍在 docs/specs/） | 备注 |
|---|---|---|
| SPEC-PD-EXAMINER-001-v0.4.md | v0.10.1 | v0.3 虽也被取代但**不得移动**，见下方 C 段 |
| SPEC-PD-EXAMINER-001-v0.5-draft.md | v0.7 | 自标 `PROPOSED_NOT_APPROVED`，未批准稿 |
| SPEC-PD-EXAMINER-001-v0.7.md | v0.10.1 | 其在 `HISTORICAL_FROZEN_ASSET_BASELINE.sha256` 里的条目路径已同步改写，摘要不变 |
| SPEC-PD-EXAMINER-001-v0.9.md | v0.10.1 | 离线验收已做，真实宿主执行为零 |
| SPEC-PD-PRR-001-principle-pain-recall-v1.1.md | v1.3 | |
| SPEC-PD-PRR-001-principle-pain-recall-v1.2.md | v1.3 | |
| SPEC-PD-PAIN-SEMANTICS-AND-DETECTION-ARCHITECTURE-001-v0.1.md | v0.3 | §3.2 三前提已被 v0.2 §0 证伪 |
| SPEC-PD-PAIN-SEMANTICS-AND-DETECTION-ARCHITECTURE-001-v0.2.md | v0.3 | v0.3 §13 逐条定点修订 |
| SPEC-PD-CONSOLE-READABILITY-002-v1.0.md | v1.2 | v1.2 切片 2/3 未完，故 v1.2 留在原位 |
| SPEC-PD-CONSOLE-READABILITY-002-v1.1.md | v1.2 | 同上 |
| SPEC-OGQ-001-decision-trust-principle-necessity-v1.1.md | v1.2 | v1.2 至今未实现（PR 未合并），留在原位 |
| SPEC-PD-PL-001-principle-learning-dataset-v0.2.md | v0.3 | v0.3 被 `fixtures/dataset-manifest.json` 的 `specRef` 引用，不得移动 |
| SPEC-PD-AGENT-CAPABILITY-API-001.md | v0.5 | 正文标 v0.4-draft |
| SPEC-PD-AGENT-CAPABILITY-API-001-v0.2.md | v0.5 | |
| SPEC-RULECODE-QUALITY-001-v0.1.md | v0.2 | v0.2 的 B 段实际由 CODEX-LOCAL/CODEX-V2 交付 |
| SPEC-PD-PI12-COMPAT-001-v0.1.md | v0.2 | |
| SPEC-PD-CROSS-HOST-KEYWORD-PAIN-001-v0.1.md | v0.2 | §3.1 四词白名单被 v0.2 §1 显式替换 |
| PRI-788-correction-signal-optimization-spec.md | PAIN-SEMANTICS v0.3 Phase B | G3「TP≥3 且零 FP 直通」已被 `4257de8d7` 显式逆转（`governance-signal-admission.ts:175-186`） |

## C. 留在 docs/specs/ 的硬约束（不得移动）

| 文档 | 为什么不能动 |
|---|---|
| SPEC-PD-EXAMINER-001-v0.3.md | 被 `scripts/dev/principle-learning-lab/challenge-studies/{CEB-001,CEB-002,CEB-003-P}/input-manifest.json` 的 `specRef.path` + `specRef.specFileSha256`（`def15985…68b8`）钉住，属冻结研究契约 |
| BEHAVIORAL_LEARNING_MVP_ACCEPTANCE_v3.md | 被 `docs/adr/0027…:9`、`docs/experiments/README.md:6`、`docs/experiments/pri-836/behavior-signature.json:6`、`docs/audit/PRI-836_IMPLEMENTATION_REALITY_MAP.md:6` 按路径引用 |
| principle-purification.md | `principles-core/src/runtime-v2/store/candidate/recommendation-kind-resolver.ts:19` 按字面路径引用（RC-4） |
| SPEC-PD-PL-001-principle-learning-dataset-v0.3.md | `fixtures{,-v2}/dataset-manifest.json` 的 `specRef` 字段引用，且被 `lib/sidecar.mjs:69` 读出写入产出 |

## C2. 其余 28 篇为什么也留下

**仍是现行权威契约、但仍有未完项或未获执行授权（13 篇）**

- `SPEC-PD-EXAMINER-001-v0.10.1.md`：Console `/lab` 已随包出厂，真实模型执行仍 `403 real_execution_not_authorized`。
- `SPEC-PD-PAIN-SEMANTICS-AND-DETECTION-ARCHITECTURE-001-v0.3.md` / `-v0.3.1.md`：Phase 0+B 已落，**Phase A、Phase C 未做**（`gate-block-helper.ts:234` 仍自动造 rulehost_block Pain；GFI 仍喂 Pain 写点）。
- `SPEC-PD-PRR-001-principle-pain-recall-v1.3.md` + `Gate-A-to-B-admission-matrix` + `Gate-B-experiment-plan` + `Gate-B-owner-decision-card` + `Gate-B0-AC-preregistration`：Gate B 真实执行 NOT_RUN，决策卡 D-01–D-05 全 PENDING。
- `SPEC-PD-AGENT-CAPABILITY-API-001-v0.5.md`：Gate 3 现行契约。
- `PRI-917-semantic-reuse-adjudication-v0.3.3.md`：Reuse Review Gate 现行权威（`reuse-gated-intake.ts` 已接生产自动路径）。
- `SPEC-PD-CROSS-HOST-KEYWORD-PAIN-001-v0.2.md`：机制已实现但生产开关未开，仍是该机制的权威规格。
- `SPEC-RULECODE-QUALITY-001-v0.2.md` + `v0.2-ZCODE-EXECUTION.md`：A/B1 已落，B2/B3/B4 待前提成立。

**未实现或仅部分实现，剩余范围明确未开工（15 篇）**

- 未实现：`SPEC-OGQ-001-…-v1.2.md`（PR 至今未并入 main）、`PRI-932-*` 4 篇（激活生命周期权威重建，生产零命中）、`diagnostician-artifact-store-convergence.md`（双写拓扑原样在）、`SPEC-PD-CODEMODE-001-v0.2.md`（裁决为 NO-GO）。
- 部分实现：`PD-Console-SPEC-v0.5.md`、`SPEC-PD-CONSOLE-READABILITY-002-v1.2.md`（切片 2/3 未做，且 R5 有反向证据）、`SPEC-PD-CONSOLE-READABILITY-002-Reality-Audit-指令.md`（其交付物报告在库中不存在）、`SPEC-PD-PI12-COMPAT-001-v0.2.md`（缺 AC-6 闭环）、`PRI-769-feature-flag-lifecycle-governance-spec.md`、`PRI_815_TRINITY_…v0.3.md`（Phase B 未落）、`PD_CORE_VALUE_PIPELINE_GOVERNANCE_SPEC.md`、`SPEC-PD-RULE-ASSOCIATION-005-shadow-implementation.md`（按设计未接生产）。

## D. 归档后的引用约定

- 全仓 `docs/specs/<已归档文件名>` 形式的指针已同步改写为 `docs/archive/specs/...`，共 **95 处 / 56 文件**（12 处在源码注释与 lab 脚本，83 处在 docs 内部）。
- 裸文件名散文提及（不带路径）未改写：它们不是链接，且同名文件不会歧义。
- Markdown 相对链接（`../specs/…`、同目录裸文件名、`../plans/…`）按**搬移前的位置**重算目标后改写，共 14 处 = 10 处留守文档指向被搬文件 + 4 处被搬文档指向留守文档（含反向的 `../../plans/…`）。复验口径：搬移前既有断链 32 处保持不变，因本次归档新增的断链归零；修复器幂等（二次运行 0 改动）。
- 仓库内另有 32 处断链在本次搬移前就已断开（regex 误写、`...` 占位、已删除的历史报告目录、website 目录式链接等），与本次无关，未一并处理。
- `docs/implementation-reports/examiner-v09/HISTORICAL_FROZEN_ASSET_BASELINE.sha256` 属于**逐行复验清单**（`run-examiner-v09-acceptance.mjs verifyHistoricalBaseline()` 与 v09 回归测试都要求每条路径存在且 sha256 相符），故该条目路径必须随移动更新，摘要保持不变。
- **冻结字节例外**：`SPEC-PD-EXAMINER-001-v0.7.md` 已归档，但它的字节被同一份 baseline 钉住，因此本次只改清单里的路径行，正文一字未动（`git show HEAD:docs/specs/… > docs/archive/specs/…` 复原后实测 sha256 = `f7d8dbbd…1d9af` 相符）。代价是该文 §「本版本基于以下仓库材料」里的 4 处 `docs/specs/…v0.4 / v0.5-draft` 指针（含 2 条 GitHub blob 链接）在合并后会指向旧位置，属已知的、有意保留的失真——冻结契约优先于导航洁癖。全仓除此之外不存在指向已归档文件的 `docs/specs/` 残留指针（`git grep -F -f` 实测：docs/archive 外 0 处）。
- `docs/implementation-reports/SPEC-PD-CODEMODE-001-execution-report-20261020.md:182-188` 是一段**当时的链接核验记录**（内联代码而非链接，逐条写"存在"）。其中 2 条 `../specs/…` 现在已失效。未改写：改它等于篡改历史证据，而它本身不是导航入口。
- `scripts/ci/impact.mjs` 只 glob `docs/specs/features/**`，本次未触碰 27 个可执行 `.feature` 规约，CI 影响面映射不受影响。
