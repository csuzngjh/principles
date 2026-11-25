# @principles/pd-mcp-server

## 0.5.2

### Patch Changes

- e4f4337: PRI-1276 (B2) — OpenClaw 正常入口身份与回执兜底
  
  - Core：`recoverTaskIdentityFromReceipt` 的 `hostKind` 联合类型纳入 `'openclaw'`（共享 CAS 恢复权威，OpenClaw 指定回执领地 `host_session_claim_empty` 已在既有白名单）。
  - openclaw-plugin：新增 `after_tool_call` 结构化回执兜底（`hooks/pain-receipt-fallback.ts`）。真实探针确认的 OpenClaw 自有 envelope（单层编码 + `details.mcpServer` 交叉验证 + 精确工具名门 `pd-recall__pd_submit_pain`），身份取事件 ctx `sessionId` 与执行上下文 `toolCallId`；按事件重读 `host_identity_minimal_metadata` 授权；fail-open + 单行 ids-only 结构化诊断；经 Core CAS 恢复原 Task，不产生第二条 Pain/Task。
  - `PluginHookAfterToolCallEvent` 本地镜像补齐宿主真实字段（`params`/`runId`/`toolCallId`）。
  - pd-mcp-server：MCP 写入超时的 reconciled/submitted 与 `submit_unconfirmed` 回执保留原请求已判定的 `sessionAssociation`；缺失 association 的回执仍 fail-closed，`submit_unconfirmed` 仍需精确 ID 读回。
  - 真实隔离安装 E2E（OpenClaw 2026.11.5）：场景 B（缺失 `_meta` → 合法 unbound → 事件回执 → CAS 恢复原 Task，SQLite 读回证据）与场景 D（授权关闭 → 零身份持久化 + blocked_by_consent 处置）PASS。安装版 runtime materializer 尚无 `_meta` 生产者（无插件可达扩展点），宿主级主路径标注不支持；上游补丁卡见 `docs/reports/PRI1276_OPENCLAW_HOST_IDENTITY_AUDIT_20261125.md` §10。
- Updated dependencies [e4f4337]
- Updated dependencies [b7134ff]
- Updated dependencies [ce6049a]
- Updated dependencies [528d7a5]
  - @principles/core@8.3.0
  - @principles/host-runtime@4.7.1

## 0.5.1

### Patch Changes

- d738de4: PRI-1273 (A2): automatic evidence backfill when a known target turn's body arrives late
  
  - The Codex worker's waiting-task reconcile now BACKFILLS the arrived target-turn evidence in the SAME expected-value CAS that flips `waiting_for_target_evidence` → `ready_for_diagnosis`: the original task's top-level `evidence` array and its versioned `painIngress.evidenceClass` (`available`/`entryCount`) are persisted together with the disposition, so the real array and count stay consistent for the read-back validator — exactly like a submission whose target text existed up front (SPEC-PD-FEEDBACK-RESILIENCE-001 TD §3 step 6). An already non-empty evidence array is preserved untouched (only the disposition flips). The flip's CAS preconditions now also carry lease generation + attempt count (P1-4 parity with the receipt recovery).
  - A source-material consent denial is no longer mixed into the waiting set: when the consent-ledger decision denies the read (missing / revoked / not granted / unreadable), the reconcile reclassifies the task to `blocked_by_source_material_consent` with the reason code `target_turn_source_material_<reason>` — no evidence is persisted from a denied source, the diagnosis gates keep refusing it, and only a newly authorized target turn may unblock it.
  - New shared `TargetTurnEvidenceRead` vocabulary (Core export): the structured exact-turn read (`available` entries / `not_found` / `blocked_by_consent` / `read_failed`) that the submit path's opportunistic enrichment and the worker reconcile's backfill now share — one authority for the entries shape both paths persist. `pd-mcp-server` imports the shared type (its local duplicate removed).
  - New `listGovernanceConversationTextsForHostTurn` (host-runtime, devin BUG_0002): the ONE SQL selection rule for an exact target turn's readable text — host/session/turn + conversational kind + retained readable text filtered inside the query, keeping the turn's LAST N rows (reversed to capture order) so a final answer sitting behind dozens of tool/reasoning observations still surfaces. The worker backfill reader, the diagnosis-time exact-turn reader and the submit path's enrichment all consume it; the old generic early-window (`ORDER BY id LIMIT`) reads are gone from all three.
  - New `readCodexTargetTurnEvidence` (codex-adapter): the consent-gated EXACT (rollout identity, host turn id) governance-store read behind the reconcile — the source-material ledger is consulted BEFORE any store query (PRI-1283 R2 parity with the submit path), rows keep the same retention/excerpt contract as submit-time enrichment (user/assistant turns, `operational`/`promoted` retention, `governance_observation:<logicalKey>` sourceRef, bounded note, last 12), and another session's rows, another host's same-key rows and retention-expired rows never qualify. `codexTargetTurnTextAvailable` becomes its `available` projection.
  - Read failures surface as bounded per-task errors (`target_evidence_read_failed`) instead of a silent false; malformed entries from the reader are rejected element-wise (rc-4), never partially persisted.
  - E2E acceptance (real hook ingestion → real dist MCP server submit over stdio → transcript growth → real worker cycle with catch-up → backfill → real split-pipeline diagnosis with the deterministic LLM boundary → candidate admission): same painId/taskId, evidence exactly the target turn's rows, evidenceClass consistent, the model call contains the target turn and never turns 11/12, repeated cycles are no-ops, and consent revocation between submit and arrival blocks instead of diagnosing. An oversized record and an incomplete JSONL tail around the arrival converge without corrupting or duplicating the backfill.
- 2b8ac42: PRI-1275 (B2): WorkBuddy normal-entry host identity prebind and structured-receipt fallback
  
  - **Main path (probe-verified real-engine `_meta`)**: the WorkBuddy branch of `resolveHostSubmissionContext` (Core) now binds the session from the installed engine's own request metadata — `_meta.baggage` carrying `codebuddy.session_id=<uuid>` (captured 2026-11-24 from the real installed WorkBuddy Desktop 5.9.2 / CodeBuddy Code 2.165.0; the value equals the hook payload's `session_id`). The namespaced producer contract `_meta["pd.host-context.v1"]` (PRI-1275 pi-mono producers) stays accepted; when BOTH identity sources are present they must agree — a disagreement fails closed (`workbuddy_context_conflict`), and a present-but-malformed baggage session fails closed (`workbuddy_baggage_session_invalid`) instead of silently degrading. `codebuddy.conversation_request_id` is never mapped (turn equivalence unproven, SPEC field rules); `toolCallId` stays optional and absent — its absence never negates the session binding.
  - **MCP tool_response envelope decoded from the real host**: the WorkBuddy decoder previously failed loud on MCP tool completions because the engine delivers `tool_response` as the CallToolResult CONTENT BLOCK ARRAY (`[{type:'text',text:…}, …]`), not a string or object envelope. The decoder now accepts the array (every block must be a record, rc-4; empty array fails loud) and passes it through unchanged, so MCP tool calls stop losing their PostToolUse evidence path.
  - **Receipt fallback (same territory as Codex B1)**: new `workbuddy-adapter` `ingestion/pain-receipt-fallback.ts` — when the request carried NO trusted `_meta` (task legally unbound with `host_session_claim_empty`), the PostToolUse completion event's structured receipt (`pd.pain-submit-receipt.v1`) plus the event's own host identity (`session_id`/`call_id`; `generation_id` is never mapped) restores the SAME original task through the shared Core CAS recovery. Gate is an exact `mcp__<server>__<tool>` parse (server id `pd-recall` — the real engine keeps the hyphen, so the sanitized `pd_recall` spelling is a DIFFERENT third-party server and is rejected — plus `pd_submit_pain`, equality on both segments, never a substring); more than one text content block is ambiguous and rejected; `submit_unconfirmed` still requires the exact-ID read-back; a `submitted` receipt that is already `verified` is not a fallback case at all (short-circuited, so the hook emits no routine `status=degraded` line on the prebound happy path). `recoverTaskIdentityFromReceipt` (Core) admits `hostKind: 'workbuddy'` through the SAME rules: the P1-2 recoverable whitelist gains `host_session_claim_empty` (the designated missing-metadata cause) while every cause that records a REFUSAL of something the caller supplied stays refused — `host_session_not_in_workspace_trajectory` (failed trajectory check) and `host_session_claim_unusable` (claim carried only empty/sentinel spellings) — and the original task's own hostKind must equal the recovering host's.
  - **Authorization and privacy unchanged from B1**: the Workspace-level `host_identity_minimal_metadata` quiet flag gates identity persistence; full `workbuddy_conversation_ingestion` can stay OFF (real-engine E2E ran with it off) — the fallback reads no transcript and persists ids/receipt metadata only.
  - Real-engine E2E (isolated lab, installed engine, real hook + real dist MCP server + SQLite read-back): prebind at the initial write with `sessionIdHint == engine session_id`, receipt association `verified` from engine baggage, PostToolUse fallback folds idempotently (`pain_receipt_idempotent`), exactly one Pain/Task. pi-mono client E2E: the modified real pi MCP client drives the built server — `options._meta["pd.host-context.v1"]` prebinds, missing `_meta` stays unbound with the WorkBuddy cause, receipt recovery restores the same task.
  
  Review round: pd-mcp-server submit-assembly resolves the minimal identity-metadata authorization PER REQUEST (revocation stops binding on the next submission without a server restart); core baggage parsing validates EVERY `codebuddy.session_id` entry and fails closed on disagreeing multi-entry values (`workbuddy_baggage_session_conflict`); the WorkBuddy fallback no longer maps `generation_id` into any turn id; the worker queue uses the shared candidate picker with SQL-level waiting-task exclusions. Second review round: the prebound happy path short-circuits (no `already_bound` on an already-`verified` `submitted` receipt → no routine `status=degraded` line per successful submission), and the sentinel/blank model-claim case got its own refused cause (`host_session_claim_unusable`) instead of being folded into the recoverable `host_session_claim_empty`.
- Updated dependencies [d738de4]
- Updated dependencies [2b8ac42]
- Updated dependencies [49a7713]
- Updated dependencies [b99dc3d]
  - @principles/core@8.2.0
  - @principles/host-runtime@4.7.0

## 0.5.0

### Minor Changes

- d2799f4: PRI-1274 (B1): host identity prebind and structured-receipt fallback for `pd_submit_pain`
  
  - New unified `HostSubmissionContext` (Core): normalizes host-injected MCP `tools/call` `_meta` (Codex native `threadId`/`sessionId` + optional `x-codex-turn-metadata.turn_id`; namespaced `pd.host-context.v1` for other hosts) with sentinel/shape validation and a fail-closed conflict rule against model-supplied `hostSession` claims. Review round 2: a present-but-invalid `threadId` (sentinel/oversized) is its own `invalid` verdict — never a silent fallback to `sessionId` — and a claim with ANY foreign identifier conflicts even when a second identifier agrees.
  - `pd_submit_pain` main path: a trusted `_meta` context pre-binds the submission session at the ORIGINAL Pain/Task write. Session binding no longer requires the target turn text (`codex_target_evidence_unavailable` coupling removed); a missing `submissionTurnId` never negates the session. Target-evidence reads use the assembly's own validated host kind (never a fixed `codex`) and an unreadable optional store degrades to no enrichment instead of aborting the submission.
  - New quiet flag `host_identity_minimal_metadata` (default off): the one-time Workspace-level minimal identity-metadata authorization, separate from `codex_conversation_ingestion` and `automatic_pain_submission`. Flag off keeps submissions legally unbound with `blocked_by_consent` and persists ZERO identity metadata from the fallback (no `receiptRef`/`toolCallId`).
  - Codex PostToolUse fallback (B1): the gate now parses the REAL namespaced Codex tool name (`mcp__pd_recall__pd_submit_pain`; server `pd-recall` and its identifier-sanitized spelling — verified against the installed codex-cli 0.171.0 binary and the Gate 2 runtime capture) — bare names and same-named tools on other MCP servers never enter. The envelope decode rejects multi-block content as ambiguous, normalizes workspace spellings before validation, and applies the unified format/sentinel check to event identity fields. Recovery restores the SAME original task via the existing expected-value CAS — now with full status/lease preconditions closing the read→write race against a concurrent worker (P1-4), plus original-task hostKind/workspace verification (P1-2). The receipt's `sessionAssociation` is the security boundary: ONLY `codex_host_metadata_missing` is recoverable; `host_context_conflict`, `host_context_invalid:*`, `blocked_by_consent` and `codex_target_turn_invalid` refusals can never be overturned by the fallback. `submit_unconfirmed` requires an exact-ID read-back; same-call replay is idempotent; different `toolCallId` is ambiguous; terminal/leased/foreign/conflicting tasks are never mutated; no transcript reads, no free-text recovery. No automatic retry of receipt recovery exists (P1-5 option B): the hook's stderr states per-outcome truth instead of a false next-cycle promise.
  - Target turns now participate in diagnosis admission (P1-3): `submissionTurnId` and `targetTurnId` are distinct fields end-to-end. A session-bound submission that names a target turn whose text is not yet collectable is created `waiting_for_target_evidence` (same versioned `recovery` block, no new TaskStatus) unless it carries an explicit Owner statement; the candidate picker excludes waiting tasks inside the store query (SQL WHERE before ORDER BY/LIMIT, memory-store parity); a bounded worker-cycle reconcile flips them once the exact (host, session, turn) text exists; the context assembler reads EXACTLY the named turn — the session's other turns never substitute it — and never infers a target when none was named.
  - `painIngress.verifiedHostSession` now validates `submissionTurnId` and `targetTurnId` independently (historical both-or-neither rows parse unchanged).
- 652409b: PRI-1283 R2/R3 (SPEC-PD-FEEDBACK-RESILIENCE-001 TECH §2.2): sourceRef
  revocation safety gate and persisted excerpt cleanup.
  
  R2 — unified latest-consent read gate over the conversation-ingestion consent
  ledger v3 (the single authority): a new `SourceMaterialAuthorizationPort`
  (core) with the ledger-backed implementation
  `createConsentLedgerSourceMaterialAuthorization` (host-runtime), consulted
  PER CALL (no cache) at every consumption entry point — diagnosis context
  assembly (evidence entries, correction evidence, promoted evidence window,
  governance turn reader, payload sourceRefs), all three split-pipeline model
  invocation boundaries (`source_authorization_revoked` blocks the run), the
  shared admission re-verification (`evaluateAndPersistAdmissionForWrite` /
  internalization orchestrator / consumer cycle), `pd pain recall`, the Console
  evidence-chain read model, and the MCP submit assembly (target-turn evidence
  and session-verification probes refuse on blocked consent). Unwired ports
  fail CLOSED for governance-sourced material; `owner_reported:` / `candidate:`
  / openclaw inline evidence is not consent-governed and unaffected.
  `ensureGovernanceContinuation` / `reconcileGovernanceContinuation` now AND the
  caller flag with a live ledger read instead of trusting the flag alone.
  
  R3 — `runSourceRevocationSweep` (host-runtime): idempotent, visible,
  retryable purge of persisted excerpts for every host whose recorded consent
  decision is not granted — governance_observations text/tool facts NULLed and
  retention-class expired (the store's no-regain guard makes re-granting NOT
  resurrect old excerpts), admission marker payloads redacted (including the
  independent `reason` column and pending-review termination), pain_events
  text/reason NULLed for automatic pains (the Pain row and its identity
  survive), task diagnostic_json evidence entries removed with a truthful
  `painIngress.evidenceClass` (`source_revoked` added to the v1 reason enum)
  and a non-sensitive `sourceRevocation` audit block, pain_diagnoses,
  diagnostician artifacts, runs.output_payload and pi_artifacts evidence
  filtered via row CAS. Wired into `pd codex setup --decline` / `pd workbuddy
  setup --decline` (immediate sweep) and exposed as `pd consent sweep-revoked
  [--apply] [--json]` (default dry run — truly read-only connections, no schema
  init, no WAL/journal writes); audit trail at
  `.state/source-revocation-sweep.jsonl` carries metadata only. Ledger-missing
  workspaces are not swept (not a revocation) while R2 gates keep blocking; an
  unreadable ledger fails the sweep loudly.
  
  Review round 2 hardening (directives A–F): pending Stage-2 reviews of a
  revoked host are terminated `abandoned('source_revoked')` by both the sweep
  and the claim path (claim-time consent re-validation; pre-classifier claim
  verification blocks new model requests after a revocation; in-flight results
  are fenced by the decision+claimToken CAS); explicit Owner statements
  (`PD记录痛苦：` / `pd pain explicit` / WorkBuddy explicit intake) are
  classified by their own provenance and survive the revocation on every read
  path (sweep / recall / context assembler / console) and in the intake
  re-verification (a historical `admitted` verdict is re-verified against the
  latest source authorization before internalization may reuse it); dry runs
  are read-only per table with counted-from-write purges and reported audit
  failures; the core barrel surface carries only cross-package production
  consumers (9 admitted symbols).
  
  Review round 3 (owner_manual classification ruling): an explicit Owner
  statement is owner_manual only when its text is credibly Owner-authored —
  a direct Owner channel (`codex_explicit_prefix` / `workbuddy_explicit_prefix`
  / `cli_owner_statement` / `openclaw_manual_pain`), or an agent-assisted
  `codex_explicit_agent` submission carrying a bound Owner confirmation record
  (`ownerConfirmation.kind = owner_verbatim_turn_match` written by the
  registration path after verifying the statement VERBATIM against the current
  turn's host transcript, fingerprint-bound to the persisted text). A
  self-declared `owner_statement` classification or a forged/mismatched
  confirmation never exempts: unverified agent submissions persist as
  Agent-derived and are governed by the consent ledger on every entry point
  (sweep / recall / context assembler / console / admission), consistent under
  one shared `isOwnerManualCorrectionEvidence` judgment.
  
  Round 4 hardening (review threads #14/#19/#20/#21): the console evidence-chain redaction now judges STRUCTURED correction evidence via `isOwnerManualCorrectionEvidence` instead of the spoofable summary reason marker; verbatim confirmation additionally requires an authorized source-material ledger for that host; the admission validator accepts legacy unconfirmed `codex_explicit_agent` payloads (empty evidence array tolerated) as Agent-derived so task reconciliation cannot starve on them; and the sweep task probe also matches rows carrying `correctionEvidence` so statement-only governed tasks are evaluated, with the evidenceClass rewrite made rerun-idempotent.
  Diagnostician PHASE 1.5 now labels an unverified `codex_explicit_agent` correction as agent-relayed/unverified instead of claiming verbatim Owner words (review thread on the prompt builder).

### Patch Changes

- Updated dependencies [00ec958]
- Updated dependencies [d2799f4]
- Updated dependencies [652409b]
- Updated dependencies [3a3b142]
  - @principles/core@8.1.0
  - @principles/host-runtime@4.6.0

## 0.4.4

### Patch Changes

- 9b63a24: PD Home 单一路径权威收敛（Workspace Layout Redesign）：三宿主配置根与治理工作区彻底隔离，备份根迁至 `<PD_HOME>/.pd/backups`。
  
  - **install-layout**: `PdHomePaths` 增加 `runtimeDir`/`pdRuntimeBackupsDir`/`openclawExtensionDir`/`codexWorkspaceDir`/`workbuddyConfigDir`/`workbuddyWorkspaceDir`；生产模式解析 `CODEX_HOME`/`WORKBUDDY_CONFIG_DIR` 覆盖，实验模式对其绝对性与边界 fail-closed（新增 `codex_home_not_absolute`/`codex_home_outside_experiment`/`workbuddy_config_dir_not_absolute`/`workbuddy_config_dir_outside_experiment`）；新增 `getInstallLayoutPathsFromPdHome()` 与 `getWorkbuddyHostConfigPathsFromPdHome()` 供已解析 PD Home 复用，消除同一操作内的双重解析。
  - **install-layout / mcp-binding**: `getHostDefaultWorkspaceDirs` 支持 `openclawHome`/`workbuddyConfigDir` 覆盖；launcher-only 拒绝理由新增 `experiment_host_config_invalid`/`openclaw_state_dir_not_absolute`；三份 launcher.cjs 与 `findForeignWorkspaceHost` 保持字节级同源判定。
  - **create-principles-disciple**: 备份 canonical 根从 `<openclawHome>/pd-backups` 迁至 `<PD_HOME>/.pd/backups`；`migrateLegacyPdBackups()` 由安装器显式搬迁两处遗留位置（旧 OpenClaw 备份根整体 + extensions/ 兄弟目录），返回可审计结果（保留原名、冲突加确定性后缀、失败保留原件、旧根仅在清空后移除）；卸载器 PD-owned 路径与 release-manager overlay 标记改经 PD Home 权威。
  - **pd-console**: 只使用 canonical 备份根；启动期隐式迁移逻辑移除（迁移职责归安装器，Console 不再在启动时搬迁 Owner 文件）。
  - **codex-adapter / workbuddy-adapter / host-runtime / pd-cli / pd-mcp-server**: 全部宿主 hook、ingestion、health、setup、worker、telemetry 与 MCP log 路径改经 `resolvePdHome()` 单一权威；实验环境读/写全部落在 lab 根内，非法配置 fail-closed（结构化 reason + nextAction，rc-9），无 os.homedir() 静默回退。
  - **core**: `runtime/storage-paths` 扩展为全量工作区相对路径契约（`PD_DIRS`/`PD_FILES`/`resolvePdPath`），openclaw-plugin 的私有副本改为 re-export 该单一权威；物理布局不变（ADR-0023 §2.6）。
- 85ec815: 宿主反馈证据链四项修复：`pd_submit_pain` 接受宿主会话声明并按本工作区授权轨迹校验（PRI-1260，verified 才写 sessionIdHint 与回执关联，未验明保留 unbound 合同并回报具体原因）；Codex live/catch-up 采集复用正式 v3 授权判定，缺失/撤回/失败记录在读转录前拒绝（PRI-1262）；超限完整 JSONL 记录由 pipeline 扫描跳过并留可追踪处置，检查点前进、与未完成尾部区分（PRI-1261，Codex+WorkBuddy 生产边界）；授权轨迹读取器接入 pd diagnose/pain retry 与 Codex/WorkBuddy worker/auto-run（PRI-1265，会话两种拼写匹配、过期档不可见）。
  
  评审轮整改（2026-11-18）：live 采集路径同样先过正式授权判定（撤回/缺失不再落 prompt）；超限跳过路径对 `compacted` 控制记录有界提取并应用 compaction（无法安全解析则不越过该记录）；轨迹读取只服务 `retention_class IN (operational, promoted)`、返回最新 N 条、精确 rollout_identity 优先（子代理原文不再混入父会话）、可选 host 隔离；会话校验排除 sentinel 值；过期行重放不再复活正文。
- Updated dependencies [bf0aa6c]
- Updated dependencies [9b63a24]
- Updated dependencies [09cba00]
- Updated dependencies [85ec815]
- Updated dependencies [8afad8f]
- Updated dependencies [5f2378d]
- Updated dependencies [9b63a24]
- Updated dependencies [0d9a7e1]
  - @principles/core@8.0.0
  - @principles/host-runtime@4.5.0

## 0.4.3

### Patch Changes

- f62d43a: OG-4：为 **Codex / OpenClaw / WorkBuddy 三宿主全部部署**在生产 MCP 入口注册 `pd_submit_pain`（Owner 2026-11-13 授权，记录见 `docs/implementation-reports/PD-MCP-GATE3-OWNER-DECISION-CARD.md` §〇 r5 + r6；r6 把 r5 的 WorkBuddy 单宿主范围扩展为三宿主）。
  
  - **接线**：`pd-mcp-server/src/index.ts` 在装配层对任一**已知** `PD_MCP_HOST`（codex / openclaw / workbuddy）显式传入 `enableSubmitTool: true` 与 `callSubmitCapability`；host 标记**缺失**时保持 recall-only，**存在但未知**时启动失败（`host_invalid`，exit 1）。`server.ts` 的默认 gate 保持 `false`，不引入 env var / feature flag，OG-4 安全边界未降级。
  - **config 绑定**：新增 `src/submit-assembly.ts`，复用 `host-runtime/pd-config` 的 `loadPdConfigForPlugin` 把 Core `submitPainCapability` 绑定到有效 `.pd/config.yaml`，并按启动绑定传入 `hostKind` 使各宿主记录可归因；config 校验失败时该宿主降级为 recall-only，日志只记固定原因码（`errors[].reason` 可能含绝对路径或 YAML 片段，禁止入日志），**绝不回落** `.state/workflows.yaml`（PRI-393）。`host-runtime` 新增 `./pd-config` 公共子路径导出，`pd-mcp-server` 新增 `@principles/host-runtime` 依赖；`bundle-plugin.mjs` 的 MCP staged 清单同步把该依赖改写为 `file:../host-runtime`，否则自包含发布构建会回退到 registry 解析。
  - **治理**：Codex PreToolUse matcher 扩展为 `Bash|apply_patch|pd_submit_pain`（事件可被观察到）；**tool-semantics 分类有意不登记**，三宿主均解析为 `other`。理由：`CanonicalKind` 是文件变更轴，`write` 会进入 `computeBehaviorFacts.writeCount` 并关闭 `other ⇒ facts incomplete` 的保守闸门，而该工具写账本、payload 无目标路径；OpenClaw `hooks/gate.ts:363-366` 只路由 write/bash/agent 三族，登记会造出 `hasHostTool` 为真却永不触发的假声明（PRI-741）。解析为 `other` 时 rule-context provider 挂起而非断言事实。待 `CanonicalKind` 支持非文件变更或实机取证后补登记。
  - **文档**：决策卡 r5 + r6 授权记录、SPEC §7.7 / TD §5.1.1 状态同步、`pd-mcp-server/README.md`、`2026-11-11-pain-submit-limited-rollout.md` 标记 SUPERSEDED。
  - **回归**：真实 stdio 进程用例断言三宿主 `tools/list` 均为 2 工具（`readOnlyHint:false`）、host 缺失时仍 1 工具；pd-mcp-server 全套、3 份 tool-semantics 契约、Codex hook matcher 契约、G4-1～G4-7 架构守卫全绿；eslint / tsc 0 错误。
  - **发布**：改动涉及 installer 分发的 runtime，installer 必须随版本列车发版，否则已安装机器拿不到新 MCP Server。生效还需重启各宿主会话（或 `/reload-plugins`）。
  - **已知既有红灯**：`mcp-binding-contract-parity.test.ts` 在 origin/main 上因 `758dd2f51 (#2614)` 新增 5 个 `experiment_*` launcher reason code 未同步契约声明而失败；该失败在主树旧基线复跑 40/40 通过，非本变更引入。
- Updated dependencies [f62d43a]
- Updated dependencies [fb2bcb1]
- Updated dependencies [93eaa26]
  - @principles/host-runtime@4.1.2
  - @principles/core@7.6.2

## 0.4.2

### Patch Changes

- 758dd2f: Experiment isolation hardening for the real OpenClaw host E2E:
  
  - the MCP launcher refuses an experiment (`PD_EXPERIMENT_ROOT`) whose `PD_MCP_LOG_DIR` is missing or outside the root, and refuses a binding whose workspace is outside the root;
  - the experiment launcher pins `PD_MCP_LOG_DIR`, validates the OpenClaw profile's per-agent workspaces, and materializes a canonical `.pd/install.json` runtime layout under the experiment root (removing the `pd_cli_entry_missing` root cause);
  - the launcher's path canonicalization now handles not-yet-created directories (8.3 vs long path forms) instead of misclassifying them as outside the root;
  - prompt activation identity now requires the formal ledger UUID: the `principleDraft.title` fallback is gone, activation/artifact UUID mismatches refuse injection, and legacy title activations keep working as an explicitly marked `legacy_title` identity without creating new title-keyed receipts;
  - prompt/implementation/defer candidates are reported as `candidate_kind_not_ledger_eligible` (a type boundary), not `candidate_kind_invalid`, and Owner correction phrases from the real-host regression are ambiguous candidate discovery terms.
- Updated dependencies [758dd2f]
  - @principles/core@7.6.1

## 0.4.1

### Patch Changes

- 028c0c5: 收敛 `mcp-binding.json` 的校验为单一声明。`@principles/install-layout` 新增 `mcp-binding-contract`：schema 常量、三宿主 canonical 入口、`validateMcpBinding` 形状校验、reason 码枚举与表驱动夹具。Codex 安装器的自愈判断与 `pd health` 的内部判定都改为复用该函数，不再各自维护一套更宽松的判据；launcher 仍是无依赖 `.cjs`，由 `pd-mcp-server` 的平价测试实跑真实 launcher 逐条比对各宿主的 reason 字符串（新增码无样例即红）。`pd health` 对外输出码保持不变（`binding_paths_not_absolute`、`server_entry_not_canonical` 等），映射留在 pd-cli 侧并有表征测试。`pd-mcp-server` 的 manifest 变化仅是测试期 `file:` devDependency（不进入运行时依赖图，发布产物不变）。路径比较按 launcher 的规则统一：win32 大小写不敏感、其他平台严格相等，`platform` 由调用方注入（不读 `process.platform`），因此该分支可在 Linux CI 上被覆盖。枚举守卫改为扫描真实产生路径（含 `fail(declared.reason, …)` 的动态 reason），声明表既不能漏码，也不能保留 launcher 不再产生的码。
- Updated dependencies [e872dbf]
- Updated dependencies [cb987f8]
- Updated dependencies [b7b1efd]
- Updated dependencies [d46ab03]
- Updated dependencies [8a5c1e8]
- Updated dependencies [27ba1b9]
- Updated dependencies [054aca8]
- Updated dependencies [b0e601f]
- Updated dependencies [3c430fc]
  - @principles/core@7.4.0

## 0.4.0

### Minor Changes

- 0afc6b3: SPEC-PD-AGENT-PAIN-INGRESS-001 v0.8：Agent 痛点入口四阶段落地。
  
  - 阶段 1：Core Pain Submit Capability、anchor 校验、统一 Origin/Provenance；`evaluatePainIngress()` 增加 MCP 专用分支并排在通用 Unbound 分支之前。
  - 阶段 2：MCP `pd_submit_pain` 契约面；超时返回 `submit_unconfirmed`，并以 `taskId = diagnosis_<painId>` 做限时只读回查（found/not_found/read_error），不取消写入、不自动重投。
  - 阶段 3：四类写入点统一 `DEFAULT_PAIN_SCORE = 40`（`moderate`）；MCP 路径恢复 Observability，`pain_events` 可见。
  - 阶段 4：Console L2/L2b；OpenClaw tick 增加 L3 自动诊断（每轮最多 1 个，失败保留 pending，flag `openclaw_diagnostician_consumer` 可关）；安装器废弃旧 `pd-record-pain` skill（仅重命名字节命中已发布载荷的副本，用户修改副本保留并告警）。
  
  MCP 写能力仍受 OG-4 门禁约束：生产入口不开启，`tools/list` 不含 `pd_submit_pain`。

### Patch Changes

- Updated dependencies [0afc6b3]
- Updated dependencies [9ae1936]
- Updated dependencies [f1cf77b]
- Updated dependencies [09a1205]
  - @principles/core@7.3.0

## 0.3.3

### Patch Changes

- Updated dependencies [ddbd1cf]
  - @principles/core@7.0.0

## 0.3.2

### Patch Changes

- Updated dependencies [8da2cdc]
- Updated dependencies [30ccf33]
  - @principles/core@6.0.0

## 0.3.1

### Patch Changes

- d36724c: core: the `runtime-v2` generation name is gone from the code surface (PRI-1136). The directory `src/runtime-v2/` is now `src/runtime/`, the `@principles/core/runtime-v2` subpath (and its 17 sub-subpaths) is now `@principles/core/runtime`, and the TypeScript identifiers that spelled the generation were renamed (`RUNTIME_V2_PRINCIPLE_BUDGET` → `RUNTIME_PRINCIPLE_BUDGET`, `RuntimeV2SchemaVersionSchema` → `RuntimeSchemaVersionSchema`, `recordRuntimeV2ActivationsInjected` → `recordRuntimeActivationsInjected`, …).
  
  This is a **breaking** subpath change for any package that imports `@principles/core/runtime-v2`: the old specifier no longer resolves. Every in-repo consumer moves in the same commit; the OpenClaw plugin bundles core through esbuild, so installed plugin builds are unaffected.
  
  Frozen wire values did **not** change: `runtime_v2_prompt_activations_injected`, `source: 'pd-runtime-v2'`, `pd-runtime-v2-diagnosis` and the other §4 literals keep their exact bytes. The prompt header `Runtime V2 activated principles:` is also unchanged — the golden characterization tests still pass byte-for-byte.
  
  host-runtime: import paths follow the rename; no behavior change. The exported constant `RUNTIME_V2_EVENT_LOG_CANDIDATE_DIRS` was renamed to `RUNTIME_EVENT_LOG_CANDIDATE_DIRS`, but the old name stays as a `@deprecated` alias of the same frozen array so `^2.2.0` consumers do not break on a patch release.
  
  pd-cli / pd-mcp-server / codex-adapter / workbuddy-adapter: their compiled output imports the core subpath, so they must be republished in the same version pass — otherwise an installed copy keeps resolving the removed `@principles/core/runtime-v2` specifier. Package-level public API is unchanged; patch only. **Observable CLI contract:** `pd demo story-a --json` adds the generation-neutral `isRuntimeExclusive` field and retains `isRuntimeV2Exclusive` as a deprecated compatibility alias for existing consumers.
  
  principles-disciple: the two shipped payload scripts accept both core subpath generations (`@principles/core/runtime` for Core 5.x, `@principles/core/runtime-v2` for the currently pinned Core 4.1.0), so the plugin keeps working before and after the pin move. Payload changed, so the host cache version is bumped.
  
  create-principles-disciple: bundles the plugin, so it follows the same version pass.
- Updated dependencies [d36724c]
  - @principles/core@5.0.0

## 0.3.0

### Minor Changes

- a710e8a: PD MCP now writes durable, sanitized JSONL evidence by default to `~/.pd/logs/mcp`
  (one file per process, 2 MiB/file, 64 MiB/directory, 14 days). Set `PD_MCP_LOG=0`
  to disable it with zero writes.
  
  Events: `launcher_start`, `startup`, `initialize`, `tools_list`, `tool_call`,
  `shutdown` and `startup_failure` (a pre-handshake exit now leaves PD-side
  evidence). Logging failures are swallowed: tool results, stdout protocol purity,
  the 32 KiB budget and the 10 s deadline are unchanged.
  
  New export command: `pd mcp logs export [--days 7] [--out <zip|dir>]` bundles the
  recent logs plus a README/manifest into one zip ≤20 MiB for offline analysis.

### Patch Changes

- Updated dependencies [2a7aec5]
- Updated dependencies [efae469]
- Updated dependencies [c1e7e1f]
- Updated dependencies [1c1b91f]
  - @principles/core@4.0.1

## 0.2.2

### Patch Changes

- Updated dependencies [46cbdab]
  - @principles/core@4.0.0

## 0.2.1

### Patch Changes

- Updated dependencies [dc1addd]
  - @principles/core@3.0.0

## 0.2.0

### Minor Changes

- f8a2ce7: Gate 4-B: add the production PD MCP Server package (SPEC-PD-MCP-GATE4-001 v1.2, PRI-1071).
  
  - One shared MCP server implementation for the Codex / OpenClaw / WorkBuddy host plugins; each host spawns its own process around this module.
  - Single read-only tool `pd_recall_principle_pains` with an honest `readOnlyHint: true`; business data flows exclusively through the Gate 3 Capability public subpath `@principles/core/runtime-v2/pain-recall-capability` (OD-A v1 disclosure).
  - Strict input contract at the protocol layer (principleId 1..200 required, limit 1..10 default 3, every other property rejected); capability re-validates field-by-field.
  - Single text content block, no structuredContent; 32 KiB UTF-8 response budget (32768 passes, 32769 → `unavailable` + `response_budget_exceeded`, isError, never silently truncated); 10 s deadline with late-result suppression, bounded orphan tracking and verified resource release (no underlying-cancellation claim).
  - isError mapping per SPEC §4.8 (disclosure assertion failure and Adapter execution failures only); sanitized stderr-only JSON logging; stdout carries MCP protocol messages only; fail-closed startup workspace binding via `PD_MCP_WORKSPACE_DIR` (no cwd/HOME fallback), exit 1 before initialize when the binding is invalid.
  - SDK frozen to `@modelcontextprotocol/server@2.4.0` (exact pin; interop matrix with v1-family host clients 4/4); architecture guard tests pin: Core has no MCP SDK dependency, capability-subpath-only business access, no CLI subprocess queries, pd-cli independence, exact version pins.

### Patch Changes

- d825694: Gate 4 (PRI-1071) third remediation round — context isolation, real rollback acceptance, and registration-conflict safety:
  
  - OpenClaw: the host-wide `mcp-binding.json` is written only from an explicitly declared PD workspace (`PD_WORKSPACE_DIR` / `OPENCLAW_WORKSPACE` / `principles-disciple.json`). Without one, the stale binding is removed and `pd-recall` fails closed (`binding_missing`) instead of binding the `main` agent's workspace for every agent. Per-agent hooks keep their existing workspace resolution.
  - WorkBuddy installer: unchanged transaction semantics, now proven by a real fault injection — a read-only `installed_plugins.json` fails the registration commit after the cache swap, and the previous cache/binding/settings/registry are restored byte-for-byte, after which the real launcher still completes initialize / tools/list / tools/call.
  - All three hosts: a same-name MCP registration owned by another server stops the install/setup BEFORE any config, binding, or cache write; a PD-owned same-name entry is reused idempotently; different names coexist; malformed or unattributable configs fail closed. `pd health` reports `CONFIG_DRIFT` with `mcp_same_name_conflict` / `mcp_registration_unverifiable`.
  - `pd-mcp-server` startup logs a workspace fingerprint (SHA-256 prefix, never the path) so operators and acceptance runs can prove which workspace a process bound.
