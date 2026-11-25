# @principles/workbuddy-adapter

## 0.9.0

### Minor Changes

- 2b8ac42: PRI-1275 (B2): WorkBuddy normal-entry host identity prebind and structured-receipt fallback
  
  - **Main path (probe-verified real-engine `_meta`)**: the WorkBuddy branch of `resolveHostSubmissionContext` (Core) now binds the session from the installed engine's own request metadata — `_meta.baggage` carrying `codebuddy.session_id=<uuid>` (captured 2026-11-24 from the real installed WorkBuddy Desktop 5.9.2 / CodeBuddy Code 2.165.0; the value equals the hook payload's `session_id`). The namespaced producer contract `_meta["pd.host-context.v1"]` (PRI-1275 pi-mono producers) stays accepted; when BOTH identity sources are present they must agree — a disagreement fails closed (`workbuddy_context_conflict`), and a present-but-malformed baggage session fails closed (`workbuddy_baggage_session_invalid`) instead of silently degrading. `codebuddy.conversation_request_id` is never mapped (turn equivalence unproven, SPEC field rules); `toolCallId` stays optional and absent — its absence never negates the session binding.
  - **MCP tool_response envelope decoded from the real host**: the WorkBuddy decoder previously failed loud on MCP tool completions because the engine delivers `tool_response` as the CallToolResult CONTENT BLOCK ARRAY (`[{type:'text',text:…}, …]`), not a string or object envelope. The decoder now accepts the array (every block must be a record, rc-4; empty array fails loud) and passes it through unchanged, so MCP tool calls stop losing their PostToolUse evidence path.
  - **Receipt fallback (same territory as Codex B1)**: new `workbuddy-adapter` `ingestion/pain-receipt-fallback.ts` — when the request carried NO trusted `_meta` (task legally unbound with `host_session_claim_empty`), the PostToolUse completion event's structured receipt (`pd.pain-submit-receipt.v1`) plus the event's own host identity (`session_id`/`call_id`; `generation_id` is never mapped) restores the SAME original task through the shared Core CAS recovery. Gate is an exact `mcp__<server>__<tool>` parse (server id `pd-recall` — the real engine keeps the hyphen, so the sanitized `pd_recall` spelling is a DIFFERENT third-party server and is rejected — plus `pd_submit_pain`, equality on both segments, never a substring); more than one text content block is ambiguous and rejected; `submit_unconfirmed` still requires the exact-ID read-back; a `submitted` receipt that is already `verified` is not a fallback case at all (short-circuited, so the hook emits no routine `status=degraded` line on the prebound happy path). `recoverTaskIdentityFromReceipt` (Core) admits `hostKind: 'workbuddy'` through the SAME rules: the P1-2 recoverable whitelist gains `host_session_claim_empty` (the designated missing-metadata cause) while every cause that records a REFUSAL of something the caller supplied stays refused — `host_session_not_in_workspace_trajectory` (failed trajectory check) and `host_session_claim_unusable` (claim carried only empty/sentinel spellings) — and the original task's own hostKind must equal the recovering host's.
  - **Authorization and privacy unchanged from B1**: the Workspace-level `host_identity_minimal_metadata` quiet flag gates identity persistence; full `workbuddy_conversation_ingestion` can stay OFF (real-engine E2E ran with it off) — the fallback reads no transcript and persists ids/receipt metadata only.
  - Real-engine E2E (isolated lab, installed engine, real hook + real dist MCP server + SQLite read-back): prebind at the initial write with `sessionIdHint == engine session_id`, receipt association `verified` from engine baggage, PostToolUse fallback folds idempotently (`pain_receipt_idempotent`), exactly one Pain/Task. pi-mono client E2E: the modified real pi MCP client drives the built server — `options._meta["pd.host-context.v1"]` prebinds, missing `_meta` stays unbound with the WorkBuddy cause, receipt recovery restores the same task.
  
  Review round: pd-mcp-server submit-assembly resolves the minimal identity-metadata authorization PER REQUEST (revocation stops binding on the next submission without a server restart); core baggage parsing validates EVERY `codebuddy.session_id` entry and fails closed on disagreeing multi-entry values (`workbuddy_baggage_session_conflict`); the WorkBuddy fallback no longer maps `generation_id` into any turn id; the worker queue uses the shared candidate picker with SQL-level waiting-task exclusions. Second review round: the prebound happy path short-circuits (no `already_bound` on an already-`verified` `submitted` receipt → no routine `status=degraded` line per successful submission), and the sentinel/blank model-claim case got its own refused cause (`host_session_claim_unusable`) instead of being folded into the recoverable `host_session_claim_empty`.

### Patch Changes

- b99dc3d: Pipeline Spine Phase 1 (PRI-1291): fix the three verified pipeline breaks. D1 — `PainToPrincipleServiceOptions` is now a discriminated union on `asyncMode` (sync mode requires `sourceMaterialAuthorization` + `trajectoryTurnReader`), the sync bridge call forwards the authorization, and the three sync entry points (pd pain record --wait, OpenClaw hook, OpenClaw /pd-pain command) wire the workspace consent-ledger authorization and trajectory reader. D2 — `deviationAnchorToPainAnchor` single-tracks the anchor: the ingress/bridge write side derives the canonical `anchor`, the assembler recovers historical `deviationAnchor` rows and surfaces malformed ones in ambiguityNotes. D4 — `pd candidate internalize` gains the authority gate (dedup-first ordering, raw-kind validation, admission-document fail-closed, seed suppression, rule seeding window preserved) and both automatic seed entries (`diagnose`, PainSignalBridge) refuse invalid RAW kinds with zero seeding; `validateRecommendationKind` is exported from the runtime barrel with admission records.
  
  Owner recovery and bridge lifecycle: preserve persisted Owner parks during failed automatic retries, and give each production bridge acquisition an explicit release scope. Workspace retirement drains active borrowers and pending constructors before closing SQLite resources.
- Updated dependencies [d738de4]
- Updated dependencies [2b8ac42]
- Updated dependencies [49a7713]
- Updated dependencies [b99dc3d]
- Updated dependencies [db6fb22]
- Updated dependencies [c895c64]
  - @principles/core@8.2.0
  - @principles/host-runtime@4.7.0
  - @principles/install-layout@0.11.0

## 0.8.0

### Minor Changes

- 9eaa8a3: PD Service Host Phase 2 (PRI-1280, SPEC-PD-SERVICE-HOST-001 §11 Phase 2 +
  Gate 0 准入边界 / ADR-0020 §11.6): `pd service run-once --shadow --workspace
  <dir> [--host codex|workbuddy] [--timeout-ms <n>] [--json]` — an explicit,
  manual, bounded REAL Worker Cycle per explicitly-selected legacy-owned
  workspace, default-off and never scheduled. The unified Worker Adapter
  contract (TD §2.3: `pd.worker-adapter.v1` — hostKind / adapterVersion /
  supports(binding evidence only: validated claim or host-tool declaration,
  never feature flags / cwd / env) / executeOnce / cycleOutcome / reason /
  nextAction / lastProgressAt / health) wraps the EXISTING
  `pd codex|workbuddy worker --once --json --workspace` entries of the
  active-release install as bounded subprocesses (SIGTERM→grace→SIGKILL
  ladder, per-workspace isolation, AbortSignal cancellation; task recovery
  stays with the existing Lease TTL / Recovery Sweep). Worker child env is
  BUILT from an allowlist (TD §5.2): identity/host-root pointers
  (PD_EXPERIMENT_ROOT, PD_WORKSPACE_DIR, OPENCLAW_*, PD_COMPANION_WORKER_IPC,
  HOME/USERPROFILE, CODEX_HOME/WORKBUDDY_CONFIG_DIR) are dropped or pinned
  from the trusted install identity, `PD_INVOCATION_SOURCE=service_host` is
  set, credentials ride the existing getEnvVar chain via a name-pattern
  allowlist (values never logged). `lastProgressAt` reflects real persisted
  progress only (task status transitions diffed read-only pre/post cycle;
  empty cycles keep the previous value — never a completion timestamp);
  unreadable evidence degrades (rc-9). Status stays
  `pd.service-run-status.v1`, extended additively with a `shadow` section
  (per-workspace admission + execution records; `dryRun:false`). Shadow
  refuses non-legacy `backgroundExecutions` owners, never modifies the owner
  marker, registers no OS scheduler, and keeps Companion supervision /
  OpenClaw AutoConsumer untouched. Phase 1 `--dry-run` is unchanged; the two
  modes are mutually exclusive (default-off refused without either).
  
  codex-adapter (minor): `lastCycleDriver` gains the `service_host` identity
  (three-way companion/service_host/manual, TD §5.2) so `pd codex worker
  --status` stall attribution names the shadow driver instead of misreporting
  `manual`.
  
  workbuddy-adapter (minor): NEW cycle-level liveness record
  (`.state/workbuddy-worker-liveness.json`, same shape and atomic-write
  discipline as Codex): cycle start/stage deadlines/completion/duration/mode/
  degradation reason plus the same three-way `lastCycleDriver` — FR-10 health
  was previously undecidable for WorkBuddy. Known parity gap recorded (NOT
  fixed here): the local pending-first candidate pick can starve retry_wait
  under sustained pressure; Codex/WorkBuddy parity stays partial until the
  core fair-share selector is adopted (follow-up on PRI-1280).
  
  Package extraction decision (task §11): the Service Host stays INSIDE
  pd-cli (`src/services/service-host/`) — extraction into a separate
  workspace package would re-enter the ERR-196 release-asset risk class
  (bundle staging, staged manifest rewrite, REQUIRED_COMPONENTS, packaged
  smoke, release-locks regeneration) that cannot be fully exercised outside
  the release pipeline, and Phase 2 adds no consumer that needs the split.
  
  Review round (2026-11-21, 13 findings, all verified real and fixed):
  shadow host roots resolve from the trusted home ONLY
  (`canonicalHostRootsOnly` — forged OPENCLAW_*/CODEX_HOME/
  WORKBUDDY_CONFIG_DIR overrides can no longer steer discovery nor the
  child env pins; ignored inputs recorded rc-9); host-tool declarations
  are VALIDATED via the existing `loadHostToolDeclarations` authority
  before they count as binding evidence; worker stderr/reason strings are
  sanitized (path redaction → `<path>`, control chars stripped) before
  persistence; credential NAMES from the workspace's effective `apiKeyEnv`
  join the child env allowlist so custom-named env credentials keep
  working; Codex catch-up progress counts only ACTUAL persisted rows
  (`inserted>0`, not re-checked sessions) and downstream evidence requires
  `runStatus==='succeeded'`; a cross-run progress projection
  (`service/shadow-progress.json`) keeps `lastProgressAt` across A→B→A and
  dry-run interleaving; degraded cycles with confirmed task-state changes
  now record the evidenced progress timestamp; `--timeout-ms` is validated
  as a full integer BEFORE any real cycle (no more `5m`→1s clamps or
  `five`→silent default); both workers settle the liveness record on early
  returns (no stale mid-stage `runningStage` after a pause/degradation);
  the coordinator passes its invocation id to the Worker
  (`PD_INVOCATION_ID`, TD §5.2) and both workers record it in liveness for
  correlation; the concurrency acceptance proves executability first and
  asserts at-most-once claims exactly.

### Patch Changes

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
- f1bb2fe: WorkBuddy installs are usable out of the box (Owner-requested, 2026-11-22).
  
  `@principles/workbuddy-adapter`: the shipped plugin manifest now declares
  `defaultEnabled: true` instead of `false`. The installer's existing rule is
  unchanged — an explicit boolean already in `settings.json` always wins — so an
  Owner who disabled PD stays disabled, while a fresh install no longer needs a
  manual trip to the plugin manager. Enabling the plugin also loads its bundled
  `.mcp.json`, which is the only path that makes the pd-recall MCP server
  available without a separate trust decision (verified against the engine: the
  `mcp-approvals.json` trust store is consulted only for USER-level
  `~/.workbuddy/mcp.json` entries, never for plugin-declared servers).
  
  `create-principles-disciple`: after a successful install/update commit, a
  LEGACY user-level `pd-recall` entry in `<config>/mcp.json` is removed when —
  and only when — the read-only classifier proves PD ownership from the launcher
  bytes AND the plugin-side replacement is usable (the plugin ended enabled,
  its installed payload declares `pd-recall`, and the launcher binding was
  written). Such an entry is a different MCP origin: it would demand a manual
  trust gesture AND duplicate the plugin's own server in the MCP list, so an
  upgraded machine would still look broken. The cleanup runs post-commit so a
  rolled-back install leaves `mcp.json` byte-identical; a permission-preserving
  byte backup (`mcp.json.pd-legacy-<ts>.bak`) is written first, and the
  replacement is guarded by the snapshot bytes so a concurrent host save is
  refused rather than overwritten. Every other key and server entry is kept —
  the file is rewritten in canonical JSON form. When the substitute is not
  proven (e.g. the Owner's explicit disable was preserved), the legacy entry
  stays and the install reports why instead of enabling the plugin behind the
  Owner's back. A cleanup failure is a warning, never an install failure, and an
  unprovable or foreign same-name entry is still left untouched (Gate 4
  conflict semantics unchanged).
- Updated dependencies [00ec958]
- Updated dependencies [d2799f4]
- Updated dependencies [652409b]
- Updated dependencies [3a3b142]
  - @principles/core@8.1.0
  - @principles/host-runtime@4.6.0
  - @principles/install-layout@0.10.0

## 0.7.1

### Patch Changes

- 2e91fdf: P0: enforce `automatic_pain_submission` authorization BEFORE the Pain
  submission chain — `PainSignalBridge.onPainDetected` refuses
  `automatic_hook` right after provenance resolution (ahead of
  capabilityDisabled ensure and every existing-task path), and
  `PainToPrincipleService.recordPain` / `admitGovernanceSignals` apply the
  same lazy probe so unauthorized signals never create, reset, re-execute
  or mutate a diagnosis task (observation-only stays the only record).
  The `authorizedEvidence` evidence-emptiness mechanism is removed.
  
  P1: fix the Companion restart-timer race — entering
  `handover_preparing`/`rollback_pending`/`service_host_owned` now retires
  entries without a live child (stopped + drain/restart handles cleared),
  and `spawnFor` re-verifies stopped state, the ownershipBlocked set, and
  registry entry identity at the final launch point so a stale crash
  restart can never resurrect a legacy worker mid-transition.
- 2e91fdf: Workspace 归属发现补齐 OpenClaw 自身持久化绑定：`collectHostWorkspaceClaims` 现在同样读取 `<openclawHome>/extensions/principles-disciple/mcp-binding.json`，且只有经 `validateMcpBinding` 全量校验（host/schemaVersion/workspaceDir/runtimeDir/canonical serverEntry）的 binding 才能形成 workspace claim；launcher.cjs 同步同一严格规则与新增 OpenClaw 绑定源。install manifest 新增可选 `backgroundExecution` 所有权记录（state/effectiveOwner/generation/operationId/previousOwner/targetOwner/updatedAt），解析 fail-closed，为 SPEC-PD-SERVICE-HOST-001 §8.4 CAS 所有权契约的 schema 支撑。
- Updated dependencies [2e91fdf]
- Updated dependencies [2e91fdf]
- Updated dependencies [2e91fdf]
- Updated dependencies [2e91fdf]
- Updated dependencies [5e30d93]
  - @principles/core@8.0.1
  - @principles/host-runtime@4.5.1
  - @principles/install-layout@0.9.1

## 0.7.0

### Minor Changes

- 9b63a24: PD Home 单一路径权威收敛（Workspace Layout Redesign）：三宿主配置根与治理工作区彻底隔离，备份根迁至 `<PD_HOME>/.pd/backups`。
  
  - **install-layout**: `PdHomePaths` 增加 `runtimeDir`/`pdRuntimeBackupsDir`/`openclawExtensionDir`/`codexWorkspaceDir`/`workbuddyConfigDir`/`workbuddyWorkspaceDir`；生产模式解析 `CODEX_HOME`/`WORKBUDDY_CONFIG_DIR` 覆盖，实验模式对其绝对性与边界 fail-closed（新增 `codex_home_not_absolute`/`codex_home_outside_experiment`/`workbuddy_config_dir_not_absolute`/`workbuddy_config_dir_outside_experiment`）；新增 `getInstallLayoutPathsFromPdHome()` 与 `getWorkbuddyHostConfigPathsFromPdHome()` 供已解析 PD Home 复用，消除同一操作内的双重解析。
  - **install-layout / mcp-binding**: `getHostDefaultWorkspaceDirs` 支持 `openclawHome`/`workbuddyConfigDir` 覆盖；launcher-only 拒绝理由新增 `experiment_host_config_invalid`/`openclaw_state_dir_not_absolute`；三份 launcher.cjs 与 `findForeignWorkspaceHost` 保持字节级同源判定。
  - **create-principles-disciple**: 备份 canonical 根从 `<openclawHome>/pd-backups` 迁至 `<PD_HOME>/.pd/backups`；`migrateLegacyPdBackups()` 由安装器显式搬迁两处遗留位置（旧 OpenClaw 备份根整体 + extensions/ 兄弟目录），返回可审计结果（保留原名、冲突加确定性后缀、失败保留原件、旧根仅在清空后移除）；卸载器 PD-owned 路径与 release-manager overlay 标记改经 PD Home 权威。
  - **pd-console**: 只使用 canonical 备份根；启动期隐式迁移逻辑移除（迁移职责归安装器，Console 不再在启动时搬迁 Owner 文件）。
  - **codex-adapter / workbuddy-adapter / host-runtime / pd-cli / pd-mcp-server**: 全部宿主 hook、ingestion、health、setup、worker、telemetry 与 MCP log 路径改经 `resolvePdHome()` 单一权威；实验环境读/写全部落在 lab 根内，非法配置 fail-closed（结构化 reason + nextAction，rc-9），无 os.homedir() 静默回退。
  - **core**: `runtime/storage-paths` 扩展为全量工作区相对路径契约（`PD_DIRS`/`PD_FILES`/`resolvePdPath`），openclaw-plugin 的私有副本改为 re-export 该单一权威；物理布局不变（ADR-0023 §2.6）。

### Patch Changes

- 09cba00: workspace 归属判定纳入宿主正式声明与 payload 绑定（PRI-1247 复验重开）：默认目录之外，`~/.openclaw/principles-disciple.json` 声明的非默认工作区、Codex PLUGIN_DATA 与 WorkBuddy marketplace 的 mcp-binding.json 绑定同样构成归属；launcher/pd-setup/安装器健康检查/`pd health`/Codex 工作区解析复用同一判定（按最终目录身份比较 junction/大小写），错绑在工具可用前被拒，修复 Codex 安装时不再选中他宿主声明的工作区（launcher 三副本随发）。同批：`pd candidate internalize` 写入口复用准入写门并在领取（wakeOnce）拦截未准入旧任务（PRI-1267）；入队写失败返回单一结构化 JSON 回执（PRI-1268）；链路追踪区分候选被拒/待审/已准入/真实存储失败，拒绝场景不再建议注定被拒的 internalize 命令（PRI-1263）。
  
  评审轮整改（2026-11-18）：跨宿主显式安装重定向到 Codex 自有默认工作区时先创建该目录（原先仅 `--host all` 非显式路径创建，重定向写出指向缺失目录的绑定后被自身健康检查判失败）；internalize 准入门自身写失败同样返回结构化 write_failed；`--dry-run` 预览以同一评估语义计算结论但不落盘（预览零写入，cli-4）；复用待审（admitted+awaiting_owner）在链路追踪中优先呈现为待 Owner 审查而非误报账目写失败。
  
  评审二轮整改（2026-11-18）：工作区声明改从宿主实际配置根读取——共享收集器、安装器 fallback 与 pd-setup 归属检查统一改用 `openclawHome`（即 launcher 依 `OPENCLAW_STATE_DIR`/`OPENCLAW_HOME` 解析的同一根），默认根声明在实际根被覆盖时不再被误用，消除"安装器放行、launcher 拒绝"的两侧分歧；Codex 工作区物化限定在本次安装目标或刷新目标含 Codex 的运行，物化失败归入 Codex 自身的安装/刷新结果而不再越过宿主错误隔离中止整体安装（仅安装 OpenClaw 且 Codex 目录不可写的形态已回归覆盖）。
- 85ec815: 宿主反馈证据链四项修复：`pd_submit_pain` 接受宿主会话声明并按本工作区授权轨迹校验（PRI-1260，verified 才写 sessionIdHint 与回执关联，未验明保留 unbound 合同并回报具体原因）；Codex live/catch-up 采集复用正式 v3 授权判定，缺失/撤回/失败记录在读转录前拒绝（PRI-1262）；超限完整 JSONL 记录由 pipeline 扫描跳过并留可追踪处置，检查点前进、与未完成尾部区分（PRI-1261，Codex+WorkBuddy 生产边界）；授权轨迹读取器接入 pd diagnose/pain retry 与 Codex/WorkBuddy worker/auto-run（PRI-1265，会话两种拼写匹配、过期档不可见）。
  
  评审轮整改（2026-11-18）：live 采集路径同样先过正式授权判定（撤回/缺失不再落 prompt）；超限跳过路径对 `compacted` 控制记录有界提取并应用 compaction（无法安全解析则不越过该记录）；轨迹读取只服务 `retention_class IN (operational, promoted)`、返回最新 N 条、精确 rollout_identity 优先（子代理原文不再混入父会话）、可选 host 隔离；会话校验排除 sentinel 值；过期行重放不再复活正文。
- 5f2378d: Principle Context Batch 1（PRI-1269，Owner 2026-11-17 授权）：CURRENT_FOCUS 由 Agent 工作记忆文件转型为 Owner 手动维护的 Principle Context 来源文件（只读）。退役 prompt 路径的自动恢复/自动压缩/历史版本注入/工作记忆注入与 compaction 工作记忆写入；`/pd-focus compress` 退役，`status` 改为文件事实（存在性/大小/行数/更新时间），`rollback` 改为原始字节恢复（先备份当前原始字节，不改写换行/BOM、不追加版本或状态文本）；`/pd-init` 改为访谈并输出三节草案（不写文件）；普通 OpenClaw Prompt 启动不再创建 CURRENT_FOCUS.md（模板移除）；`projectFocus` 旧配置保留加载兼容但不再产生任何读取或注入行为（标记 deprecated）。
  
  **Breaking（@principles/core）**：`@principles/core` 根导出与 `@principles/core/prompt-builder` 子路径移除已退役的工作记忆/压缩符号（`compressFocusContent`、`parseWorkingMemorySection`、`workingMemoryToInjection`、`mergeWorkingMemory`、`extractSummary`、`extractMilestones`、`validateCurrentFocus`、`cleanupStaleInfoPure`、`DEFAULT_FOCUS_COMPRESSION_OPTIONS`、`extractDescription`、`extractProblems`、`extractNextActions`、`deduplicateArtifacts` 及类型 `FileArtifact` / `WorkingMemorySnapshot` / `FocusCompressionOptions` / `FocusCompressionResult`）；仅保留 `extractVersion` / `extractDate` 两个展示辅助函数。这些符号随其唯一生产消费者（openclaw-plugin focus 链路）一并退役，无内部调用者残留。
- Updated dependencies [bf0aa6c]
- Updated dependencies [9b63a24]
- Updated dependencies [09cba00]
- Updated dependencies [85ec815]
- Updated dependencies [8afad8f]
- Updated dependencies [5f2378d]
- Updated dependencies [9b63a24]
- Updated dependencies [0d9a7e1]
  - @principles/core@8.0.0
  - @principles/install-layout@0.9.0
  - @principles/host-runtime@4.5.0

## 0.6.7

### Patch Changes

- 9259474: Fix two Codex MCP binding defects:
  
  - PRI-1247: Codex install/update/repair now defaults to Codex's own workspace instead of the OpenClaw-oriented detection result (an explicit `--workspace` still wins). A binding that points at another PD host's owned default workspace is treated as a cross-host misbinding by the launcher, the installer health check and `pd health`; `pd mcp probe` now reports the workspace the binding actually serves and refuses an explicit target the binding does not serve.
  - PRI-1248: the launcher binding is also written to the host-persistent PLUGIN_DATA location, which the launcher and health checks read first. A same-version cache rebuild, a version upgrade through the supported update chain, or a cold start no longer loses the binding; the payload-local copy remains as the legacy fallback (PRI-1183 repair path preserved).
- 8389a54: Intent 生产入口 Reader 接入 + Intent Console 产品体验（SPEC-PD-INTENT-UNIFICATION-001 v2.0 B/C 阶段，PRI-1229~1239）。
  
  - **B1 中立 Host IntentDocReader（PRI-1229）**：`@principles/host-runtime` 新增 `createHostIntentDocReader` / `resolveHostIntentLang` —— 实现 Core `IntentDocReader` Port 的最薄宿主读取适配（flag-first、32KB 上限按实际读取字节在单一 fd 上判定无 TOCTOU、TTL+mtime 缓存、结构化 not_found/oversized/read_error 降级、绝不抛出）。全部业务语义（flag 谓词、章节分类、模板识别、Hash）复用 Core 纯函数，未复制任何判定逻辑；Core 新导出 `isIntentAnchoringEnabled` 与意图分类函数。不共享 openclaw-plugin 实现的原因：插件是宿主专属交付单元，CLI/宿主运行时反向依赖会颠倒依赖方向（SPEC §9.3 规则 4）。
  - **B2-B4 CLI 三个生产入口接入（PRI-1230~1232）**：`pd pain record` / `pd diagnose` / `pd pain retry` 构造 Service/Runner 时传入中立 Reader（绑定入口 effectiveConfig，语言惰性解析）。重试一致性由 Stage A 既有快照语义保证（同一任务复用已持久化快照，绝不重读最新 INTENT.md；损坏快照 fail-loud；flag-off 零文件访问且历史快照保留）。
  - **B5 宿主侧接入（PRI-1233）**：governance admission 的 `ensureGovernanceDiagnosticianTask`、L3 自动诊断 `runPendingDiagnosticianOnce`、codex/workbuddy workspace worker 的诊断执行全部传入 Reader —— 准入链路上 Stage A 真正执行的所有位置现在都能捕获快照。
  - **缓存键修复**：`createPainSignalBridge` 的缓存键纳入 intent 锚定开关状态（与 persistence/pipeline/reuse 同一纪律）——长寿命宿主在 Owner 关闭开关后不再复用按旧开关构建的 bridge/reader（否则开关形同虚设）。
  - **C1 Summary 内容状态（PRI-1234）**：`GET /api/intent` 返回 `contentReadiness`（template_only/incomplete/configured）、`usableSectionCount`、`totalSectionCount=5` 与逐章节 `sectionStates`（authored/placeholder/missing），全部由 Core 共享确定性分类投影；UI 校验器同步收紧（非法枚举、计数与状态不一致、不可读内容声称可用章节一律拒绝）。不新增任何存储。
  - **C2/C3 Intent 页面（PRI-1235/1236）**：首屏六状态（Disabled/Error/Missing/Template Only/Incomplete/Configured，严格优先级，Missing/Error 绝不显示成 Template Only）+ 章节状态徽标 + `N / 5` 计数 + 使用说明（明确 INTENT.md 不是 RuleCode、不是宿主执行权限）；功能开关支持双向切换——关闭前八项影响逐条确认（停止读取/注入/快照/张力；不删除文档/版本/历史快照/历史决策、不取消已有 Approval Gate），取消零变更，成功后按持久化配置刷新；保留既有编辑、Decision Summary、Version History、双语隔离与 32KB 限制。
  - **C4 Onboarding 逐章跳过（PRI-1237）**：每章可跳过、可部分完成、可返回再编辑；完成页汇总五章填写状态并明确未填写章节不会作为战略依据；全空完成产生诚实的 Template Only，不伪造作者内容。
  - **C6 审批冲突目标准确化（PRI-1238）**：审批卡对不可豁免冲突（不可妥协项/止损升级 → `owner_boundary_conflict`；核心原则 → `core_principle_conflict`）逐条展示具体冲突对象（意图章节名或已注册原则 id）并明示 confirm_drift 不能解除；UI 校验器补齐这两个服务端真实存在的阻断码（此前会被静默丢弃，卡片显示可批准而服务端必拒）。
  
  无新 Feature Flag、无新数据库表、无新 Service；`pd intent show` flag-off 不触盘、`pd intent init` flag-off 可用、run-once 消费既有上游产物等既有语义全部保留。
- Updated dependencies [9259474]
- Updated dependencies [8389a54]
  - @principles/install-layout@0.8.3
  - @principles/core@7.10.1
  - @principles/host-runtime@4.4.0

## 0.6.6

### Patch Changes

- 9e53829: PRI-1127 WorkBuddy 产品入口：把已有的「自适应原则注入（只追加）」设置卡扩展到 WorkBuddy 宿主，补齐「选到工作区 → 配置决策服务 → 开启 → 查看结果 → 关闭」这段用户可见路径。
  
  - 设置卡新增宿主选择（Codex / WorkBuddy），明确标注当前工作区、宿主与其已有开关 `host.<host>.adaptive_activation`。启停只写所选宿主的开关；决策服务配置仍是工作区级共享项，沿用原有写入保护（其它启用宿主存在时拒绝改写；已有 `replaceableActivationIds` 替换配置时拒绝通过只追加入口开启，但仍可关闭）。
  - 结果按工作区 + 宿主 + 同轮身份匹配：复用真实 `generation_id`（WorkBuddy）/ `turn_id`（Codex）与已有 `runtime_v2_prompt_activations_injected` 注入事件。WorkBuddy hook 现在把与 Codex 同构的 `adaptive` 事实写入同一事件（`resultCode`、`scored`，以及仅当最终装配确实包含该 id 时才出现的 `appendedActivationId`），不新增事件类型或子系统。页面补显示同轮身份、实际装配得出的「已追加」、最终顺序与独立请求证据；送达由独立的模型请求证据确认，页面不推断。
  - 默认关闭不变：Codex / WorkBuddy 两条开关互不影响，省略 `host` 时保持原 Codex 契约（与并行的 Codex 侧工作兼容）。关闭、缺少可信当前轮身份或没有可追加空间时继续走 Native；不用 Session ID、轮次序数或历史文本替代身份。
  - 可用范围：仅 WorkBuddy 宿主在 `host.workbuddy` 已启用且该工作区配置了决策服务时可开启；不改变 Codex 现有行为，不扩展到跨模型 / 跨任务矩阵。OpenClaw 普通 embedded 仍依赖上游同轮身份字段，本单不改动、继续按现有上游依赖跟进。
  - 关闭方式：在控制台该工作区的 WorkBuddy 卡关掉开关，或在工作区 `.pd/config.yaml` 的 `features` 中把 `host.workbuddy.adaptive_activation.enabled` 设为 `false`。关闭后零评分请求，原则装配正文与 Native 逐字节一致。
- Updated dependencies [94591ce]
- Updated dependencies [2225759]
  - @principles/core@7.9.0
  - @principles/host-runtime@4.3.0

## 0.6.5

### Patch Changes

- f671c65: 让「哪些 pd 命令真的在被使用」第一次可以被回答，并堵住技能文档与真实命令树的漂移。
  
  - 记录：`pd` 进程入口新增一次调用记录（`cli_invocation`），写入 `<workspace>/.pd/telemetry/critical-events.jsonl` —— 该 sink 不轮转；`.pd/logs/events_*.jsonl` 7 天即删，无法承载趋势。记录失败被完全吞掉，绝不改变命令退出码；退出码无法确定时写 `UNKNOWN` 而不是 `0`。
  - 只读不破约：记录器只追加到 `pd runtime init` 已引导的 sink，绝不创建目录或文件 —— **未初始化**的工作区里，`pd pain recall` 这类只读命令仍让工作区逐字节不变。sink 已存在时会追加一行 `cli_invocation`（这是记录功能本身；命令 stdout 与退出码不受影响）。pain-recall golden 契约比较的是其 fixture 内既有文件的哈希与该 fixture 不新增文件/目录，而 fixture **不含 sink**，所以该契约不覆盖「已有 sink」的情形；另在 `cli-invocation-recording.production.test.ts` 增加了该情形的独立 characterization 测试，未放宽 golden 断言。
  - 来源：`PD_INVOCATION_SOURCE` 只在真实 spawn 点设置（console / companion / installer / plugin-script），缺省为 `human`。技能侧目前没有包装器会 spawn `pd`，因此没有 `agent-skill` 采集点 —— 不为打点改造调用协议。
  - 读取：新增只读命令 `pd runtime usage report --days N`，按命令 × 来源输出计数与退出码分布，并把无法解析的行、窗口外记录、缺失字段分别计入 coverage 与 `UNKNOWN` 桶（不静默丢弃、不当成 0）。
  - 漂移：用 `buildPdProgram()` 解析真实命令树，递归扫描全部语言模板 / pd-skills 单一源 / codex / workbuddy 技能树中的 `pd ...` 引用。首次全量扫描（24 个文档、114 处引用）发现 6 个投递文件与 core 三处 `nextAction` 引导了一个从未注册的命令 `pd principle list`。修法为改文档与引导（改为从工作区账本 `.state/principle_training_state.json` 的 `_tree.principles` 读取），不新增对外命令面。
  - CI：技能投递文件变更此前只触发 installer scope，契约测试不会运行；现在同时激活 `cli` scope，模板改动即触发该守卫。
- Updated dependencies [fac2efd]
- Updated dependencies [5bd8613]
- Updated dependencies [f671c65]
- Updated dependencies [7163c3b]
- Updated dependencies [b0c5aad]
- Updated dependencies [3e31f77]
- Updated dependencies [cda7c2f]
  - @principles/core@7.7.0
  - @principles/host-runtime@4.2.0

## 0.6.4

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

## 0.6.3

### Patch Changes

- 758dd2f: Experiment isolation hardening for the real OpenClaw host E2E:
  
  - the MCP launcher refuses an experiment (`PD_EXPERIMENT_ROOT`) whose `PD_MCP_LOG_DIR` is missing or outside the root, and refuses a binding whose workspace is outside the root;
  - the experiment launcher pins `PD_MCP_LOG_DIR`, validates the OpenClaw profile's per-agent workspaces, and materializes a canonical `.pd/install.json` runtime layout under the experiment root (removing the `pd_cli_entry_missing` root cause);
  - the launcher's path canonicalization now handles not-yet-created directories (8.3 vs long path forms) instead of misclassifying them as outside the root;
  - prompt activation identity now requires the formal ledger UUID: the `principleDraft.title` fallback is gone, activation/artifact UUID mismatches refuse injection, and legacy title activations keep working as an explicitly marked `legacy_title` identity without creating new title-keyed receipts;
  - prompt/implementation/defer candidates are reported as `candidate_kind_not_ledger_eligible` (a type boundary), not `candidate_kind_invalid`, and Owner correction phrases from the real-host regression are ambiguous candidate discovery terms.
- Updated dependencies [758dd2f]
  - @principles/core@7.6.1
  - @principles/host-runtime@4.1.1
  - @principles/install-layout@0.8.1

## 0.6.2

### Patch Changes

- a35c3a3: Score a replaceable Adaptive Activation with two independent judgments in the same single Decisions request: whether the incoming principle directly helps the user's next required step, and whether this turn can drop the Owner-listed outgoing principle while keeping the constraints the task still needs. PD selects only candidates that clear the existing `0.70` line on both, keeps the append question unchanged, and reports `replacement_unsafe` separately from "candidate not applicable". Protocol version moves to `v3-20261112` so old and new evidence cannot be mixed.
- Updated dependencies [a35c3a3]
- Updated dependencies [738f41b]
- Updated dependencies [6f1b469]
- Updated dependencies [3433a54]
- Updated dependencies [5126555]
- Updated dependencies [531d336]
- Updated dependencies [baea50e]
  - @principles/host-runtime@4.1.0
  - @principles/core@7.6.0

## 0.6.1

### Patch Changes

- 2ceca52: PRI-1171 P2 工单⑦：采集健康可观察。`pd health` 主报告内嵌三宿主对话摄取段（每宿主 hostFlag/ingestionFlag/consent 元数据/检查点水位 lastSuccessAt·checkpointOffset·lagBytes·lastDegradation/显式 live_only 会话列表——live 路径从不写 checkpoint，缺检查点是状态不是滞后异常；openclaw 为显式 not_wired 行，P3 工单⑨接线；全部降级带 reason+nextAction，cli-1/6 合规）。host-runtime 新增 `listGovernanceUncheckpointedSessions`（live_only 数据面，有界+截断标记）。workbuddy-adapter 导出 `locateWorkbuddyTranscriptBySessionIdentity`（采集写入者与健康读取者共用同一定位器）。宿主适配器在 pd-cli 内惰性加载（PRI-1061 宿主无关启动：`pd health --help` 在适配器缺失时仍可启动，缺失降级为结构化 host_adapter_unavailable）。Console 新增只读采集健康状态页（`/api/health/ingestion` 逐字透传 CLI 权威报告 + `/ingestion-status` 页面 + 工具导航项；G6 红线：状态视图，非轨迹浏览；pd-console 为私有包，其发布意图按 guard 指引落在 installer patch）。
- Updated dependencies [9bb9127]
- Updated dependencies [3e1c29d]
- Updated dependencies [422f4e2]
- Updated dependencies [759be56]
- Updated dependencies [f504a7c]
- Updated dependencies [a3b6155]
- Updated dependencies [40a8181]
- Updated dependencies [4881436]
- Updated dependencies [c61f388]
- Updated dependencies [2ceca52]
- Updated dependencies [2a49e33]
- Updated dependencies [35fc780]
  - @principles/host-runtime@4.0.0
  - @principles/core@7.5.0

## 0.6.0

### Minor Changes

- 8a5c1e8: WorkBuddy 对话采集端到端接通（PRI-1171 P2 工单④–⑥，本 PR 同时包含编码/解码、Owner 原话投影与运行时接线）。新增 `ingestion/` 模块：`encodeWorkbuddyCwd`（按盘上取证样本锁定的目录编码契约）、确定性转录定位/校验（hint 优先 + `<projects>/<encodeCwd(cwd)>/<sessionId>.jsonl` 推导，含穿越/包含/主会话形状/会话身份一致性校验）、六记录类型宽容解码（message/function_call/function_call_result/reasoning/file-history-snapshot/ai-title，另容忍 session-meta/fork/未知类型——跳过全部计数告警，不静默）、callId 工具配对（配对缺失侧 partial）、reasoning parentId 链归属（失败=partial+unattributed，不猜）、压缩标记只告警不传墓碑、checkpoint 种子合成序数、50MB 单会话告警。host-runtime：`GovernanceObservationKind` 联合增 `reasoning`；工具调用与结果共用 `call:<callId>` logical key，跨窗口完成时可合并工具事实（不再产生两条永不修复的 partial）；写入事务改用 `BEGIN IMMEDIATE`，并容忍并发 hook 争抢 journal_mode 切换。变体基线固化 fixtures + 契约/集成/E2E 测试。
  
  真实载荷保护（PR #2534 评审批次 A P0 修复）：WorkBuddy 的 `message/user` 记录在真实盘上是约 15KB 宿主 `<system-reminder>` 上下文 + 尾部 `<user_query>` 中的 Owner 原话。解码器改为 **fail-closed**：只从 `<user_query>` 结构化边界投影 Owner 原话，并过滤落在 `<system-reminder>` 区间内的伪造标签；无法确认边界时落 `partial` + `wb_user_context_unconfirmed` 告警且不写 `visibleText`——绝不把 AGENTS/身份文件/工具说明当 Owner 证据入库，也不存在"换个标签就整段放行"的 fail-open 通道。新增标签变体、上下文内伪造 `<user_query>`、纯上下文、未闭合等回归；裸明文被显式测试钉为 partial（契约变更，见测试内注释）。
  
  工单⑤⑥接线：新增 `workbuddy_conversation_ingestion`（quiet，默认关）与 lifecycle census 条目；`pd workbuddy setup` 是该开关 + v3 同意记录的**受支持入口**（约定，非强制边界：consent API 公开导出、ledger/config 均为普通文件）。`--accept` 在执行前展示披露（`--json` 时写 stderr 以保持 cli-1 严格 JSON）；先开 flag、成功后写 granted，失败时用**写入前捕获的原始字节**经 tmp+rename **原子回滚**（undo 路径同样原子）。运行时**真实读取** v3 consent ledger（Codex 路径仍硬编码 granted），撤销即时生效。WorkBuddy 插件注册 `Stop`（30s）→ decoder 映射 `turn_complete`（Stop 无 cwd，不伪造）→ `ingestWorkbuddyConversation` 把 snake_case `transcript_path` / `agent_transcript_path` 桥接到 `HookHints`；Stop 解码接受二者至少其一（官方 hooks reference 只列 `transcript_path`，仓库 capability matrix 写 `agent_transcript_path`，两者冲突且**尚无真实 Stop payload 取证（NOT_RUN）**，因此在拿到真实载荷前接受并集）。worker 增加按 durable checkpoint 精确 sessionId 定位的有界 catch-up，并打印 catch-up 行；reconcile 的 promotion recovery 参数按宿主绑定为 `codexConversationIngestionEnabled`，WorkBuddy worker 固定传 `false`——WorkBuddy 的同意绝不释放 Codex 证据。三层门（host.workbuddy + ingestion flag + consent=granted）任一关闭均零转录读取。
  
  真实回滚面：本 PR 不是"单 PR revert 即恢复原状"。仓库代码回退后，已安装插件清单里的 `Stop` 注册仍会存在，直到用户更新/卸载插件；workspace 中已写入的 `workbuddy_conversation_ingestion` flag 与 consent ledger 也是持久事实（回退后无读取方，属安全残留）。运行期关闭应按顺序使用 `pd workbuddy setup --decline`（撤销同意 + 关 flag）；恢复默认态需同时更新已安装插件。

### Patch Changes

- e872dbf: Score only authorized principles missing from the current Native prompt. Codex and WorkBuddy use the shared scorer. OpenClaw can use it when its host supplies the current admitted message and ID. Each host has an independent opt-in; legacy OpenClaw mappings keep precedence.
- b7b1efd: 宿主工具语义声明升级到 v2，并补上写入载荷格式的单一真源（ADR-0030）。
  
  - `@principles/core`（minor）：新增对外能力——`WritePayloadFormat` 类型、`WRITE_PAYLOAD_FORMAT_VALUES`、`isWritePayloadFormat()`，`ToolSemanticMappingV1` 增加可选 `writePayloadFormat`，`ToolSemanticRegistry` 增加 `resolveWritePayloadFormat()`。只新增公开成员，既有 `lookup` / `resolve` / `hasHostTool` 与 `canonicalKind` 判定不变，属向后兼容的能力扩展。
  - `@principles/host-runtime`（minor）：声明契约版本 1 → 2，新增持久化字段 `writePayloadFormat`；工作区多宿主声明合并对该字段严格比对——相同则合并，一方缺省视为「声明为普通 content」并与 `file-header-patch` 冲突（fail loud，不静默择一）；v1 声明降级读取为缺省语义并返回 `warnings`，不再拒绝加载。`HostToolDeclaration.version` 扩为 `1 | 2`，解析/解析器结果类型新增 `warnings`；v1 读取路径保持可用。
  - `@principles/codex-adapter` / `@principles/workbuddy-adapter`（patch）：适配既有 v2 契约——`apply_patch` 继续声明 `file-header-patch`，声明写入改用 `HOST_TOOL_DECLARATION_VERSION`，并把降级 warning 透出到 stderr；无新增宿主可见能力。
  - `principles-disciple`（patch）：修复「Codex 与 OpenClaw 同工作区时声明合并失败」——OpenClaw 的 `apply_patch` 也声明 `file-header-patch`；写入风险家族按载荷编码拆分为普通 content 与 patch 两组，`LOW_RISK_WRITE_TOOL_NAMES` 集合内容不变，本包内暂无该字段的消费方，故按行为修复记 patch。
  - `@principles/pd-cli`（patch）：调试种子脚本跟随 v2 声明接口（版本常量替换），无 CLI 输出契约变化。
  - `create-principles-disciple`（patch）：安装器打包 OpenClaw 插件载荷（C4 装配边）；安装器侧无逻辑改动，仅随载荷刷新版本。
  
  级别判定理由：`@principles/core` 与 `@principles/host-runtime` 增加了对外公开的类型、方法与持久化 schema 字段（向后兼容），属于 semver 的 minor 能力扩展；其余包只是跟随该契约或修复既有合并失败，无新增宿主可见能力，按 patch 记录。
- Updated dependencies [6000713]
- Updated dependencies [e872dbf]
- Updated dependencies [9c425d8]
- Updated dependencies [cb987f8]
- Updated dependencies [b7b1efd]
- Updated dependencies [d46ab03]
- Updated dependencies [028c0c5]
- Updated dependencies [8a5c1e8]
- Updated dependencies [27ba1b9]
- Updated dependencies [054aca8]
- Updated dependencies [b0e601f]
- Updated dependencies [3c430fc]
  - @principles/host-runtime@3.5.0
  - @principles/core@7.4.0
  - @principles/install-layout@0.8.0

## 0.5.11

### Patch Changes

- 2efe4a0: Pain Ingress v0.8 收尾（T22 / T03 / T17）：
  
  - 锚点结构化补齐：`diagnostic_json.anchor = {type, ref}` 现在对 `owner_expectation` / `established_principle` / `agent_instruction` 三类锚点都会写入；写侧与读侧共用同一份 `PainAnchorSchema` / `parsePainAnchor`，避免两份手写结构漂移。`deviationAnchor` 语义未变。
  - 诊断器消费：`DiagnosisTargetSchema` 与 `DiagnosticianTaskRecord` 均带 `anchor`；`SqliteContextAssembler` 把 `diagnostic_json.anchor` 当不可信输入解析（非法则丢弃并在 `ambiguityNotes` 说明，不猜测）；根因提示词在锚点存在时输出 ANCHOR 块，指明"行为是相对哪个要求被衡量"，并修复了包装层转发遗漏（与 PRI-844 同型）。
  - 两份 `pd-pain-signal` Skill（Codex/OpenClaw 共用插件与 WorkBuddy 插件）按实际实现改写：MCP `pd_submit_pain` 参数与三种锚点格式、`painType` 可省略但 `principle_deviation` 只适用于原则锚点、严重度不可自提、仅本次授权、后台禁止、失败回执（`refused` / `failed` / `submit_unconfirmed`）的阅读方式；原生入口（`PD记录痛苦：` 前缀、`/pd-pain`、Codex 实时回合的 `pd pain explicit`）与锚点式提交明确区分。
  - SPEC / TD 中"只落文档、代码未改"的过期状态描述已更正为已实现，并保留真实环境验收项为待执行。
- 746e55d: B3：hook 与 replay 共用同一个工具语义解析入口。`resolveHostToolSemanticsForHook()` 以“workspace 持久化声明 → 宿主静态声明 → baseline”为优先级解析 `canonicalKind`：声明中出现的原始工具名以声明为准（与 replay/证据/Console 读取的是同一份 `.pd/host-tool-semantics/*.json`），声明未覆盖的静态名继续补齐，避免陈旧声明截断宿主当前工具面。声明损坏或跨宿主冲突时返回带 reason/nextAction 的类型化失败，绝不静默回退成空 registry；消费方（OpenClaw gate、Codex/WorkBuddy pd-hook）保留可用性——退回宿主静态声明并在 stderr / logger 留下可观察诊断（rc-9）。
  
  修复前：同一 workspace 中若持久化声明把 `exec` 记为 `write`（或声明了静态表没有的工具名），OpenClaw gate 仍按静态表判为 `execute`，生产侧提取出 `out.txt`，而 replay 得到 `<tool:exec>`，同一条路径规则在回放命中、在生产不命中。现在两端一致。
  
  OpenClaw 的接入模块刻意放在 `hooks/hook-tool-semantics.ts` 而非 `constants/tool-semantics.ts`：后者位于 `rulehost-evidence` 卫星包路径上，引入 host-runtime barrel 会把整条 LLM 依赖图拉进卫星包（satellite-purity / OPT-002）。
- Updated dependencies [c8b984f]
- Updated dependencies [030e0cf]
- Updated dependencies [2efe4a0]
- Updated dependencies [030d003]
- Updated dependencies [389477a]
- Updated dependencies [746e55d]
  - @principles/core@7.3.1
  - @principles/host-runtime@3.3.1

## 0.5.10

### Patch Changes

- Updated dependencies [3f6ab0d]
- Updated dependencies [1042164]
  - @principles/core@7.2.0
  - @principles/install-layout@0.7.0
  - @principles/host-runtime@3.2.2

## 0.5.9

### Patch Changes

- Updated dependencies [93288c7]
  - @principles/install-layout@0.6.0
  - @principles/host-runtime@3.2.1

## 0.5.8

### Patch Changes

- Updated dependencies [ddbd1cf]
  - @principles/core@7.0.0
  - @principles/host-runtime@3.2.0

## 0.5.7

### Patch Changes

- Updated dependencies [8da2cdc]
- Updated dependencies [30ccf33]
  - @principles/core@6.0.0
  - @principles/host-runtime@3.1.0

## 0.5.6

### Patch Changes

- Updated dependencies [20719c6]
- Updated dependencies [bbdcb50]
  - @principles/core@5.2.0
  - @principles/install-layout@0.5.0
  - @principles/host-runtime@3.0.4

## 0.5.5

### Patch Changes

- Updated dependencies [6278ec3]
  - @principles/core@5.1.0
  - @principles/host-runtime@3.0.0

## 0.5.4

### Patch Changes

- 8f83392: Align the WorkBuddy plugin manifest description and the website install guide with the real install/enable behaviour: the installer preserves an existing `enabledPlugins` choice and otherwise applies the manifest default (`defaultEnabled=false`), so a fresh install is installed but not enabled. Copy and copy-guard assertions only; no install, enablement or default behaviour changes.

## 0.5.3

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
  - @principles/host-runtime@2.2.3

## 0.5.2

### Patch Changes

- a710e8a: PD MCP now writes durable, sanitized JSONL evidence by default to `~/.pd/logs/mcp`
  (one file per process, 2 MiB/file, 64 MiB/directory, 14 days). Set `PD_MCP_LOG=0`
  to disable it with zero writes.
  
  Events: `launcher_start`, `startup`, `initialize`, `tools_list`, `tool_call`,
  `shutdown` and `startup_failure` (a pre-handshake exit now leaves PD-side
  evidence). Logging failures are swallowed: tool results, stdout protocol purity,
  the 32 KiB budget and the 10 s deadline are unchanged.
  
  New export command: `pd mcp logs export [--days 7] [--out <zip|dir>]` bundles the
  recent logs plus a README/manifest into one zip ≤20 MiB for offline analysis.
- 2a7aec5: PRI-1093 / SPEC P-5: WorkBuddy keyword detection no longer applies a sentence-initial `startsWith` pre-filter before the shared keyword-stage guards. Mid-sentence corrections now reach the same quote / third-person / negation guards Codex uses, so they are no longer silently discarded at the detection layer and land in the same `ambiguity` disposition. This does not add Pain: WorkBuddy still has no persisted behavior-trace evidence, so admitted candidates stop at the evidence gate (`abandoned` / `evidence_invalid`). Cost impact: at most one extra Stage-1 evaluation per prompt; Stage-2 pending candidates stay zero-LLM in the hook.
  
  `@principles/core` also gains one deterministic guard in the shared keyword stage: a clause that opens with a hypothetical/conditional marker (`如果` / `假如` / `要是` / `假设` / `万一`) downgrades a high-precision correction hit from STRONG to `ambiguity`, because such a clause states a hypothesis rather than an Owner assertion. The guard is clause-scoped, so a real correction in a later clause still reaches STRONG.
  
  `@principles/workbuddy-adapter` is a comment-only correction: the hook note now describes the post-P-5 shared-guard behavior instead of a `startsWith` pre-filter that no longer exists. No runtime behavior changed.
- 1c1b91f: WorkBuddy: automatic Pain detection/correction is unsupported (the ingress evidence gate has no persisted observation writer, so automatic candidates never become Pain rows). The installer no longer enables `workbuddy_live_keyword_pain`, and install/status/docs copy now points to the explicit `PD记录痛苦：` prefix only.
- Updated dependencies [2a7aec5]
- Updated dependencies [efae469]
- Updated dependencies [c1e7e1f]
- Updated dependencies [1c1b91f]
  - @principles/host-runtime@2.0.1
  - @principles/core@4.0.1

## 0.5.1

### Patch Changes

- Updated dependencies [46cbdab]
  - @principles/core@4.0.0
  - @principles/host-runtime@2.0.0

## 0.5.0

### Minor Changes

- dc1addd: **BREAKING CHANGE** — Pain Phase A: Legacy Retirement (SPEC-PD-PAIN-SEMANTICS-AND-DETECTION-ARCHITECTURE-001 v0.3, Phase A).
  
  A technical tool failure is now trajectory and health evidence only. It can no longer become an Owner behavioral-deviation Pain on its own; the only automatic admission left is Phase B shared correction detection, and explicit Owner manual Pain is unchanged.
  
  Retired automatic Pain entry points:
  
  - OpenClaw legacy `after_tool_call` admission/emit (`handleAfterToolCall` Stage 5/6, `evaluatePainAdmissionForToolCall`, `emitPainIfAdmitted`) and the shared-host `onAfterToolResult` / `handleSharedPainEvidenceResult` path.
  - Shared Production Pain Evidence tool-failure Pain writing and diagnosis admission; the writer now records verified `tool_calls` (outcome, exit code, raw trajectory) only.
  - Codex live/transcript tool-call admission (`buildLiveToolCandidate` and the `tool_call` branch of `buildTranscriptCandidates`).
  - Repeated-failure escalation (`REPEATED_FAILURE_THRESHOLD` / `consecutiveErrors >= 4` upgrade rules). No replacement error-count escalation was introduced; host error counters stay untouched.
  - RuleHost block automatic Pain (`gate-block-helper.ts` Step 5). The block itself, `gate_blocks`, EventLog, blocked-attempt health counting and the Owner correction entry are unchanged.
  - WorkBuddy `admitBareHostPains` sweep, its worker call, its `admission` report field and the bare-pain `painEnrichmentProvider` sourceRef synthesis. WorkBuddy automatic correction stays fail-closed/observation_only; no `pain_event:<canonicalPainId>` synthetic evidence, no PainIngress bypass, no restored compensation.
  
  Removed public exports:
  
  - `@principles/core/runtime-v2`: `RISKY_HIGH_SCORE_THRESHOLD`, `REPEATED_FAILURE_THRESHOLD` (the upgrade rules they gated are gone; descriptor evaluation is terminal).
  - `@principles/host-runtime`: `admitBareHostPains`, `AdmitBareHostPainsInput`, `AdmitBareHostPainsResult`, `GovernanceToolFailureCandidate` (and the tool-failure variant of `GovernanceSignalCandidate`), `PRODUCTION_WRITE_TOOLS`, `PainEvidenceEntry`, `ProductionToolEventFields`, `DerivedToolPainIdentity`, `deriveProductionToolPainIdentity`, `resetProductionPainCooldownForTest`, `productionPainCooldownEntryCountForTest`.
  
  Retained on purpose: Owner manual `/pd-pain` and the explicit Pain tool (`buildManualPainObservation` → `evaluateEvidenceTriage` → `evaluateTriggerController`), `TriggerController`, `admission-gate.ts`, canonical Pain identity, idempotency/cooldown semantics, `correctionEvidence`/lineage, Diagnostician task creation, and the whole Phase C GFI surface (`hooks/llm.ts` health branch, `/pd-pain` GFI line, Console GFI health, `pd runtime gfi`, `tool_calls.gfi_before/gfi_after`, Session Tracker and receipt chain). No new tables, migrations, feature flags, workers or queues; historical `pain_events` rows remain readable.

### Patch Changes

- Updated dependencies [dc1addd]
  - @principles/core@3.0.0
  - @principles/host-runtime@1.0.0

## 0.4.1

### Patch Changes

- f02aa73: PRI-1066 recalibrates the model-aware prompt injection budget (`model_aware_v1` → `model_aware_v2`): the baseline doubles from 2000 to 4000 chars at the 128K reference window (hard ceiling 16000 → 32000, fallback 2000 → 4000, total ceiling derived per model), so an Owner-approved principle set stops filling the injection slot after a handful of principles. It also adds the `pi_catalog_model_id` tier (a provider-less model id that the installed catalog answers unanimously derives a real window instead of silently using the fixed fallback), records policy-version-skewed events as `foreignPolicyEventsSkipped` instead of dropping them silently, and removes the standing Focus-page "budget full" nag: `truncated` is the normal rotation state, so the notice now appears only when a host cannot fit even one principle and carries an actionable next step.
- Updated dependencies [f02aa73]
  - @principles/core@2.1.1
  - @principles/host-runtime@0.15.1

## 0.4.0

### Minor Changes

- b37c67f: Gate 4-E/F (PRI-1071): the WorkBuddy plugin payload ships `.mcp.json` (stdio, `${CODEBUDDY_PLUGIN_ROOT}` placeholders — the proven built-in-plugin pattern) exposing the read-only `pd-recall` MCP server; payload version 0.2.1→0.2.2 with `defaultEnabled:false` preserved (install ≠ enable). The installer now writes the launcher binding into the materialized marketplace payload from the frozen governance workspace, skipping with a structured note when the installed PD runtime predates the MCP component.

### Patch Changes

- Updated dependencies [fb70a87]
  - @principles/install-layout@0.4.1

## 0.3.0

### Minor Changes

- 4257de8: Phase B — Shared Correction Detection (SPEC-PD-PAIN-SEMANTICS-AND-DETECTION-ARCHITECTURE-001 v0.3 / v0.3.1).
  
  Behavior contract changes (intentional, per the v0.3 spec):
  
  - Stage 1 (P-1): matched keywords inside paired quotes no longer constitute STRONG; third-person reported and negated contexts — and the downgraded colloquial terms `我说的是` / `都说了` — are Stage-2 candidates only. `他说这是错的` can no longer reach STRONG through the Codex bare-substring path.
  - P-2 (D5 reversal): LLM-learned keywords never earn `high` precision from TP/FP history; they only enter Stage 2. Owner-promoted and seed terms keep the weight-based rule.
  - P-3: a shared confidence gate (`evaluateStage2ConfidenceGate`) distinguishes CORRECTION / NONE / pending; low confidence and LLM errors are never a terminal NONE. Constants: 0.7 / 0.7, MAX_ATTEMPTS=5, TTL=72h.
  - Pending candidates: ambiguous Codex/WorkBuddy Stage-1 candidates are now persisted as `pending_llm_review` rows in the existing `governance_signal_admissions` table (zero DDL) instead of being silently dropped. New terminal decisions `resolved_none` / `abandoned`; `admitOne` returns the pending/terminal semantic instead of an empty `already_admitted` id. CAS claim/complete/settle, idempotent transitions, crash recovery, aggregate 60s / ≤2 candidates per worker cycle.
  - PainIngress: `ensureGovernanceDiagnosticianTask` derives provenance from `evaluatePainIngress` instead of hardcoding `host_context_bound`; `PainIngressCorrelationV1` gains a `workbuddy` variant; the diagnostician context assembler no longer drops `hostKind='workbuddy'`.
  
  Stage-2 classification is now constructed by one shared host-runtime factory (`createSignalClassifierForWorkspace` / `createSignalLlmClassifier`), used by both workers and the OpenClaw plugin; no second model runtime was added. `EARNED_PRECISION_MIN_TP` remains exported as a deprecated compatibility constant (no admission code consults it — D5 removed earned precision without breaking the public root export).

### Patch Changes

- Updated dependencies [4257de8]
  - @principles/core@2.1.0
  - @principles/host-runtime@0.15.0

## 0.2.17

### Patch Changes

- Updated dependencies [5fa6fc9]
  - @principles/core@2.0.0
  - @principles/host-runtime@0.14.5

## 0.2.16

### Patch Changes

- b8ec104: Replace dot-path flag instructions ("Set features.host.workbuddy.enabled=true")
  with a single-line flow mapping the Owner adds to the EXISTING `features:`
  block (`host.workbuddy: {enabled: true}`), plus an explicit statement that the
  dotted id is ONE flat key — a nested host:→workbuddy: write is silently a
  different key.
  
  Two constraints shaped the copy (both verified against the real code, not
  assumed): hook diagnostics collapse every whitespace run, so a multi-line YAML
  block reached users flattened into one unparseable line; and every real
  config.yaml already has a top-level `features:` key, so pasting a second one
  fails with "duplicated mapping key" — which the loader turns into a
  `malformed` config and a full fallback to defaults.
  
  Fixed across ALL hosts: workbuddy hook/worker/installer copy, codex hook
  (host gate + conversation ingestion), catch-up nextAction, worker paused
  status, and the openclaw observer-config loader (which also contrasts the
  genuinely-nested internalAgents path). (PRI-1063)
- Updated dependencies [b8ec104]
  - @principles/host-runtime@0.14.3

## 0.2.15

### Patch Changes

- 5349930: RuleCode host promotion loop (SPEC-RULECODE-HOST-PROMOTION-001 v0.1, A→B→C):
  
  - Host resolution: replace the "anything not Codex is OpenClaw" fork with an
    explicit openclaw/codex/workbuddy/unknown/multi-host routing. The OpenClaw
    historical default now applies ONLY to workspaces with no non-OpenClaw
    declaration or evidence — a WorkBuddy-only workspace can no longer inherit
    the OpenClaw capability claim (H02), and durable non-OpenClaw evidence
    whose declaration is missing fails closed for every known host, not just
    Codex.
  - Per-host capability contracts: Codex (`codex-v2@1`) and WorkBuddy
    (`workbuddy-v1@1`) contracts join the existing OpenClaw authority, with
    tool aliases taken from each host's real, evidence-locked vocabulary. The
    promotion shape validator binds to the resolver's contract version — a
    wrong-host contract fails `runtime_compatibility` instead of passing.
  - Shadow attribution (B3): `rulehost_evaluated` events carry `hostKind`;
    promotion shadow summaries count only the resolved promotion host's
    samples. Another host's samples and pre-attribution legacy rows count
    toward no host's threshold (H05). OpenClaw plugin rows are stamped too.
  - WorkBuddy V2 rule context: a provider over WorkBuddy's OWN trajectory
    (same-session tool_calls rows) replaces the blanket "no provider"
    boundary. WorkBuddy supplies no designGate fact (no attestation entry
    point exists there) and unavailable history degrades through the shared
    suspension contract with precise reasons. The V2 qualification gate now
    applies symmetrically: a Codex-stamped artifact never auto-executes on
    WorkBuddy and vice versa (SPEC §11.3/H13). pd-console rides inside the
    create-principles-disciple artifact.
  
    Review fixes (round 2, findings 1-3):
    - R1: `emergency_controls` no longer passes on contract shape + flag
      alone. A core-owned recovery-control registry (verified against the
      real pd CLI registrations and the Console emergency-pause route by
      cross-package contract tests) gates every probe; the fabricated
      `pd status` / `pd activation emergency-pause` commands were removed
      (they never existed), the global pause is honestly declared through
      its real Console surface, OpenClaw probes use the real `exec` tool,
      and a rule combination that blocks the recovery probes fails the
      check.
    - R2: tool_calls rows now carry producer host attribution
      (`host_kind`, stamped by every writer; legacy rows stay NULL and are
      never backfilled). The WorkBuddy provider consumes ONLY rows proven
      to be WorkBuddy's — a colliding Codex session can no longer lend its
      reads to a WorkBuddy read-before-write rule (precise
      unavailable reasons instead). The WorkBuddy PostToolUse channel
      contract classifies string responses as completed successes (the
      failure channel is a separate registration).
    - R3: `rulehost_unhealthy` events pass the same host-attribution
      filter as every other shadow event — a foreign host's anomaly can no
      longer fail (or gate) the target host's readiness.
  
    Review fixes (round 3, findings 1-2):
    - R3/P1: readiness now separates four evidence layers. Composition
      verification executes through the production boundary (every rule of
      candidate+live compiled by the production hardened evaluator, merged by
      the gate's mergeDecisions — a requireApproval escalation fails too);
      console-channel controls carry NO rule probe (their path never passes
      the gate; isolated tests prove the real pause route changes gate
      behavior); emergency_controls additionally requires per-evaluation
      TARGET-ENVIRONMENT reachability evidence — the CLI readiness spawns the
      real `pd activation list --json` subprocess against the target
      workspace (the expected activation must appear in its listing), the
      console proves the pause substrate readable. Absent/failed/mismatched
      evidence fails with `recovery_reachability_unverified`; nothing is
      cached, so no install inherits another's "verified" state.
    - R3/P2: host attribution now runs through DEDUP and FACT UPGRADE. All
      tool_calls dedup/upgrade queries (recordVerifiedToolOutcomes, the live
      PostToolUse path, governance admission) are host-scoped for known
      hosts: a colliding row from another host is a different record (no
      swallowing), a legacy NULL row is never implicitly claimed (a new
      attributed row lands beside it), same-host re-delivery stays
      idempotent, and unknown→final upgrades only same-host rows.
  
    Review fixes (round 4, findings 1-2):
    - R4/P1: recovery reachability is PER-CAPABILITY. The evidence type gains
      a capabilities matrix; emergency_controls requires every registry
      capability (pd_status, rulecode_deactivate, rulecode_global_pause,
      owner_review_access) to carry its own current, channel-matched,
      workspace-matched entry — missing, duplicate, unknown, channel-mismatched
      or failed entries fail closed with stable reason codes. The shared
      host-runtime probe module executes the REAL pd CLI subprocesses: the
      status listing (pd_status) and a new non-destructive
      `pd activation deactivate --dry-run` validation path (rulecode_deactivate
      — real parsing, workspace binding, and target resolution, returning
      BEFORE any governance audit write or store mutation). Console readiness
      assembles its own evidence: the same CLI subprocess probes, a
      transaction-rollback write probe for the pause substrate (table asserted
      unchanged after rollback), and a route-served signal for owner_review
      (real authenticated Console HTTP entry observed in the same evaluation).
      CLI-process promotion honestly reports console-channel entries as NOT
      verified and refuses (fail closed); commit-failure semantics stay
      covered at the service level.
    - R4/P2: real-SQLite dedup coverage extended beyond one helper: the
      production pain-evidence handler (both dedup routes), the governance
      admission entry (both dedup queries), and the Codex ingestion chain each
      get cross-host collision, legacy-NULL, same-host idempotency, and
      terminal-protection regressions against real production entries.
  
  Round 5: verify recovery controls under actionable V2 facts and history,
  normalize probe paths in linear time, and compile RuleCode separately from
  its fixed VM JSON bridge without weakening sandbox limits.
- Updated dependencies [5349930]
  - @principles/core@1.297.5
  - @principles/host-runtime@0.14.2

## 0.2.14

### Patch Changes

- eaaa2e9: WorkBuddy plugin hook wrapper now arms a self-deadline strictly below the hooks.json host timeout and kills a hung adapter child itself, degrading non-blocking (exit 1 + bounded stderr, P02) instead of leaving the outcome to the host's undefined hook-timeout semantics. Rationale (2026-10-28 incident follow-up): the adapter entry's own fail-open exits can never run when the host kills the wrapper mid-flight, so the "UserPromptSubmit failure never blocks" guarantee was unenforceable on the timeout path. Budgets: UserPromptSubmit 12s under a narrowed 15s host timeout (prompt loss is the costliest channel), every other event 25s under the unchanged 30s; a guard test locks every wrapper budget below its hooks.json timeout, and a real-process test proves the kill/degrade path end-to-end (EP-04). Bumps the WorkBuddy plugin manifest 0.2.0 → 0.2.1 (bump-on-content-change convention, #2108) and records the timeout-path semantics in SPEC §4.4.
- Updated dependencies [07242b7]
- Updated dependencies [53a285f]
  - @principles/core@1.297.4
  - @principles/host-runtime@0.14.1

## 0.2.13

### Patch Changes

- cd773b5: Codex explicit pain statement: fix evidence-promotion ordering.
  
  - Run the live observation ingestion BEFORE the explicit registration in
    pd-hook, so the FIRST `PD记录痛苦：` submission of a rollout promotes its
    evidence window instead of degrading with rollout_not_found /
    trigger_not_found (the trigger observation used to be written only by the
    ingestion pass that ran after the registration).
  - Promote evidence BEFORE enqueuing the Diagnostician task, closing the
    window where a fast worker could start the first diagnosis before the
    available evidence window was promoted.
  - With codex_conversation_ingestion disabled, skip promotion and disclose
    `conversation_ingestion_disabled` in the receipt (no transcript read, no
    session observation, no misleading missing-substrate reason).
  - Reconciliation now requires the current ingestion consent explicitly:
    flag-off recovers tasks and links without reading or promoting old session
    observations; enabled reconciliation promotes before making tasks runnable.
  - ensureGovernanceDiagnosticianTask: a concurrent ensure racing on the same
    deterministic task id now converges on the existing task instead of
    reporting task_submit_failed:UNIQUE while the task actually exists.
- Updated dependencies [44a9d3d]
- Updated dependencies [cd773b5]
  - @principles/core@1.297.3
  - @principles/host-runtime@0.14.0

## 0.2.12

### Patch Changes

- 4fefb36: Codex explicit pain statement: fix evidence-promotion ordering.
  
  - Run the live observation ingestion BEFORE the explicit registration in
    pd-hook, so the FIRST `PD记录痛苦：` submission of a rollout promotes its
    evidence window instead of degrading with rollout_not_found /
    trigger_not_found (the trigger observation used to be written only by the
    ingestion pass that ran after the registration).
  - Promote evidence BEFORE enqueuing the Diagnostician task, closing the
    window where a fast worker could start the first diagnosis before the
    available evidence window was promoted.
  - With codex_conversation_ingestion disabled, skip promotion and disclose
    `conversation_ingestion_disabled` in the receipt (no transcript read, no
    session observation, no misleading missing-substrate reason).
  - Reconciliation now requires the current ingestion consent explicitly:
    flag-off recovers tasks and links without reading or promoting old session
    observations; enabled reconciliation promotes before making tasks runnable.
  - ensureGovernanceDiagnosticianTask: a concurrent ensure racing on the same
    deterministic task id now converges on the existing task instead of
    reporting task_submit_failed:UNIQUE while the task actually exists.
- Updated dependencies [4fefb36]
  - @principles/host-runtime@0.13.5

## 0.2.11

### Patch Changes

- 1b13597: SPEC-PD-PAIN-RECALL-CLI-001: new read-only `pd pain recall` command — recalls the historical pains a principle verifiably derives from, so a host Agent can check a principle's origin, trigger boundary, or current-situation fit on demand. Only two authoritative association edges are honored (`reuseEvidence[].painId`; `derivedFromPainIds` resolved through its production contract as candidate ids via `tasks.input_ref`), results dedup by real pain id while keeping every evidence ref, `--context` re-ranks deterministically without any model/network call, and per-source availability separates `not_recorded` from `unreadable` (`source_missing`/`source_unreadable` never masquerade as `no_matches`). All three hosts' `pd-cli-operator` skills (Codex plugin, OpenClaw en/zh templates, WorkBuddy adapter) now document when to call it, how to read the JSON contract, and the diagnosis-is-not-owner-statement rule.

## 0.2.10

### Patch Changes

- Updated dependencies [0f2d1fb]
  - @principles/core@1.296.0
  - @principles/host-runtime@0.13.0

## 0.2.9

### Patch Changes

- 6881b6c: Bump the Codex plugin manifest 0.1.1 → 0.2.0 and the WorkBuddy plugin manifest 0.1.0 → 0.2.0. The unified four-skill set (#2106) changed both plugins' shipped content without moving their manifest versions; Codex cache updates key on that version, so users re-running `codex plugin add` could be served the already-installed 0.1.1 payload and never receive the new skills. The WorkBuddy same-version refresh path is content-safe, but a versioned cache dir makes the upgrade observable. Includes a cross-version WorkBuddy upgrade regression (new cache dir + registration repoint + governance data preserved) and parameterizes the delivery tests off the shipped manifest version.

## 0.2.8

### Patch Changes

- 5c383e5: Unify PD host skills around four consistent capabilities, clarify Owner governance and evidence boundaries, and align the published skill bundles and Codex recovery guidance.
  
  Review-round additions: `pd run list/show` gain an optional `--workspace` (governance-workspace reads independent of cwd); Codex skills route every shipped script through `pd-locate.cjs --exec` — one authoritative locator that resolves the plugin root once, fails loud on marketplace ambiguity or a missing script instead of silently falling back to an older version; WorkBuddy near-miss explicit-statement prefixes get an actionable format notice; `pd-review` startup text no longer presents CLI approval as an agent fallback.

## 0.2.7

### Patch Changes

- 222d9e0: Connect WorkBuddy live keyword Pain detection to the shared learned correction vocabulary (AUDIT-P3-01, 2026-10-21 remediation; SPEC-PD-CROSS-HOST-KEYWORD-PAIN-001 v0.2): assessWorkbuddyLiveKeyword accepts an optional UnifiedKeywordStore and admitTrustedWorkbuddyLiveCorrection plus the adapter pre-filter now resolve the same shared live store (seed + learned, mtime-cached, seed-only degradation) instead of the four-term P0 projection, so earned-high terms accumulated on other hosts take effect in WorkBuddy. Only high-precision correction terms can trigger automatic Pain (existing gates unchanged: startsWith prefilter, native UserPromptSubmit validation, explicit Owner-statement prefix reservation, both default-OFF flags, no LLM, no transcript reads). Adds direct host-runtime unit tests for the admission boundary (previously adapter-indirect only, AUDIT-P3-04).
- Updated dependencies [765d5c4]
- Updated dependencies [222d9e0]
  - @principles/core@1.295.2
  - @principles/host-runtime@0.12.1

## 0.2.6

### Patch Changes

- Updated dependencies [48df168]
  - @principles/host-runtime@0.12.0

## 0.2.5

### Patch Changes

- d3796e4: SPEC-PD-MODEL-AWARE-PROMPT-BUDGET-001: model-context-aware prompt injection budget.
  
  - Core adds the single budget resolver `resolvePromptBudget` (pure policy, injectable Pi AI catalog): trusted host effective window (OpenClaw `contextTokenBudget` with model/modelsConfig/agentContextTokens provenance) → exact provider+modelId catalog match (host-declared provider) → legacy fixed 2000-char fallback with a bounded machine-readable reason code — provider-less name-only matches NEVER confirm (v0.2 trust amendment: a unanimous name cannot prove the deployment is not a custom endpoint). Budget formula `min(16000, max(1250, floor(2000 × W / 128000)))` in UTF-16 chars (NOT tokens). The 1250 floor is MEASURED (shared route full render of one minimum viable principle = 849/1204 chars with self-report off/on — lower floors re-create the audited 32K zero-injection defect); the 16000 cap is the Owner target upper bound (1M windows map to 15625).
  - Host-runtime resolves once per request through the real injection path (`HostEventContext.modelContext`) and the projection/precheck/status surfaces; approval-time deliverability is tier-honest (`model_dependent` for entries fitting the supported 1250..16000 range only on larger-context models — proceeds with a notice, never a refusal or a promise; `undeliverable` only beyond the 16000 max tier; cross-host aggregation is monotone — only ALL-hosts overflow brands an entry oversized everywhere); injection events carry budget provenance INCLUDING the bounded `budgetFallbackReason` code.
  - Adapters forward host model facts: OpenClaw hook context fields (type synced to the upstream enum), Codex validated `model` id, WorkBuddy observed-optional `model` (soft-consumed — dynamic only via unambiguous catalog match, honest fallback otherwise). CLI shows the model-dependent notice; Console surfaces tier fit and budget provenance.
  - Rollback: with no trusted capacity facts every path resolves to the historical fixed 2000-char budget (byte-identical legacy behavior); no schema migration, no new network calls, no per-turn catalog refresh.
- Updated dependencies [d3796e4]
  - @principles/core@1.295.0
  - @principles/host-runtime@0.11.0

## 0.2.4

### Patch Changes

- bf5aed3: Introduce an opt-in WorkBuddy native current-user keyword Pain path using the shared high-precision detector, canonical Pain admission and Diagnostician task continuation. Expose effective keyword detection status; leave the feature off by default and preserve Codex ingestion consent boundaries.
- Updated dependencies [bf5aed3]
  - @principles/core@1.294.1
  - @principles/host-runtime@0.10.4

## 0.2.3

### Patch Changes

- b02ebb5: Deliver WorkBuddy pain recording, status, Owner review and disable skills through the plugin package, marketplace and versioned cache. Reject incomplete payloads and unsafe manifest versions before registration, refresh old hook-only caches even at the same manifest version while preserving native registry scopes and older cache versions, confine cache replacement to the PD plugin version directory, and delegate disable to the existing official installer API.
- b02ebb5: Connect WorkBuddy current-user explicit Owner pain submissions to existing governance admission and diagnostic task creation. Preserve native session/turn identity, unverified Owner evidence, bounded input rejection and model-visible receipts; retain Codex prefix behavior through the shared parser.
- Updated dependencies [b02ebb5]
  - @principles/core@1.293.4
  - @principles/host-runtime@0.10.2

## 0.2.2

### Patch Changes

- Updated dependencies [fec1306]
- Updated dependencies [574954a]
- Updated dependencies [06152af]
  - @principles/install-layout@0.4.0
  - @principles/core@1.293.0
  - @principles/host-runtime@0.10.0

## 0.2.1

### Patch Changes

- ccc04eb: Switch distributed PD packages to Apache License 2.0, ship matching LICENSE/NOTICE files, and preserve the historical MIT notice. This is a licensing and packaging release without runtime feature changes.
- Updated dependencies [ccc04eb]
  - @principles/core@1.292.1
  - @principles/host-runtime@0.9.1
  - @principles/install-layout@0.3.1

## 0.2.0

### Minor Changes

- 5e794be: New package: the WorkBuddy host adapter (third ADR-0020 host) — decoder/encoder, hook entry with the probed fail-closed contract, tool semantics, evidence recorder, plugin skeleton, governance worker cycle.

### Patch Changes

- Updated dependencies [6e60d84]
- Updated dependencies [0f94f8c]
- Updated dependencies [4ba83b7]
- Updated dependencies [5e794be]
- Updated dependencies [5e794be]
- Updated dependencies [5e794be]
  - @principles/core@1.292.0
  - @principles/host-runtime@0.9.0
  - @principles/install-layout@0.3.0
