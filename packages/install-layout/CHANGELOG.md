# @principles/install-layout

## 0.11.0

### Minor Changes

- db6fb22: Export `canonicalizeDeepestExisting` so test harnesses can realpath the deepest existing ancestor for symlink/junction-safe sandbox boundary checks.
- c895c64: Service Host Phase 5 — the PD-owned Service Host is the fresh-install default
  background lifecycle owner.
  
  - install-layout: new `provision_fresh_install` ownership transition
    (legacy_owned with NO record → service_host_owned in one CAS write,
    generation 1). It refuses without `freshInstall=true` and refuses any
    workspace that already carries an ownership record, so upgrades keep using
    the quiescing `begin_handover` sequence. Service-Host-only manifests
    (`hosts: []` + declared workspaces) are now valid; an empty manifest with
    neither stays structural damage.
  - create-principles-disciple: `--host` has no default (no silent OpenClaw);
    `none` installs no host adapter. Fresh installs default to registering AND
    enabling the user-level OS scheduler, then provision the ACTUAL bound host
    workspaces into Service Host ownership (active-release no-consume readiness →
    CAS → first real managed cycle → `<pdHome>/service/install-provisioning.json`
    evidence). A failed/deferred attempt records a PER-WORKSPACE pending entry
    (`<pdHome>/service/pending-provisioning.json`), so `--host all` keeps every
    deferred workspace resumable; each entry persists the REAL resolved directory
    (a re-pointed symlink cannot claim a new target later); a later explicit
    `--enable-service-host` install verifies each workspace's CURRENT host
    binding, probes that host, and refuses to flip while a legacy OpenClaw
    Gateway may still consume it.
    Historical installs never wrote a pending entry and are never resumed
    implicitly. `--yes` accepts the recommended default, `--json`/
    `--non-interactive` without consent reports `consent_required` instead of
    creating a trigger, `--no-service-host` opts out, and upgrades keep
    refresh-if-registered. Refreshing an installed host reads its real binding
    (Codex plugin-data / payload copy) and reuses that workspace instead of this
    run's target; the console update resolves a legal empty `hosts` record to
    `none`; the interactive install mode is recommended from the FINAL workspace
    directory, never from another default.
  - pd-cli: `pd service run-once --trigger installer` records the fresh-install
    first cycle; `pd service status` exposes `hostBindingState`
    (`bound` / `waiting_for_host_binding`) so a Service-Host-only workspace is
    truthful instead of implying a worker that does not exist.

## 0.10.0

### Minor Changes

- 3a3b142: PD Service Host Phase 4 (PRI-1282, SPEC-PD-SERVICE-HOST-001 §11 Phase 4 /
  §8.4 / §4): OpenClaw decoupling — the standalone OpenClaw worker, the
  Gateway ownership gate + quiesce protocol, and the §8.4 CAS transition
  primitive (phase attribution corrected: Phase 4 lands the minimal
  reusable primitive, Phase 5 reuses it for Codex/WorkBuddy).
  
  @principles/install-layout (minor) — the §8.4 state-machine WRITE half the
  schema deferred: `transitionWorkspaceBackgroundExecution` (six legal
  transitions: begin/abort/complete_handover, begin/complete/abort_rollback)
  under a cross-process directory lock (O_EXCL + owner metadata + TTL
  quarantine reclaim) with in-lock monotonic-generation fencing,
  operationId idempotency (same-op replay no-op, foreign-op
  `operation_in_progress`), atomic rename landing, unknown top-level field
  preservation, and legacy single-key migration in the same write;
  `readWorkspaceBackgroundOwnership` — the single fail-closed read
  projection shared by the Gateway gate, the openclaw worker gate and the
  handover/rollback commands; `withInstallManifestWriteLock` for whole-file
  writers (ERR-168).
  
  principles-disciple (minor) — new `./openclaw-worker` subpath export: the
  bounded OpenClaw workspace worker cycle reusing the SHARED consumer cycle
  + diagnostician with the SAME OpenClaw host facts the Gateway injects
  (catalog/semantics/hostKinds pinned by a runtime parity test; the only
  intentional difference is attribution `service-host-worker`), worker
  liveness evidence (`.state/openclaw-worker-liveness.json`, codex pattern),
  PD_INVOCATION_SOURCE/PD_INVOCATION_ID attribution, declaration
  refresh+validation, the §8.4 ownership gate (only `service_host_owned` is
  consumable; unreadable marker fails closed — manual invocation can never
  double-consume a Gateway-owned workspace) and the no-consume readiness
  self-check. Gateway InternalizationAutoConsumerService: §8.4 marker gate
  at service-start, per-tick AND post-cycle (a handover opened mid-cycle is
  observed the moment the cycle ends); quiesce protocol with the persisted
  `pd.gateway-quiesce.v1` acknowledgment (bound to operationId+generation,
  bounded in-flight wait, honest `in_flight_timeout`); the parked timer slot
  degrades into a slow ownership watch that re-arms consumption when the
  marker returns to legacy_owned — rollback needs no Gateway restart.
  
  @principles/host-runtime (minor) — `collectWorkspaceCredentialEnvNames`:
  one collector for the credential env NAMES a workspace's runtime profiles
  reference (Service Host allowlist since Phase 2; OpenClaw worker readiness
  now) — names only, values never pass through.
  
  @principles/pd-cli (minor) — `pd openclaw worker --once|--readiness
  --json --workspace <dir>` (lazy plugin-subpath import; NO continuous mode
  — the OS scheduler owns triggering); `pd service handover|rollback` §8.4
  orchestration (openclaw binding verification → atomic begin_handover with
  workspace registration → active-release readiness probe → gateway
  quiesce-ack wait bound to operationId+generation → single CAS flip →
  first real worker cycle → write-once operationId-keyed evidence; verify-
  only crash continuation; `--abort`/`--resume`); managed dispatch host set
  adds openclaw (`MANAGED_WORKER_HOST_KINDS`) while Phase 2 shadow stays
  codex|workbuddy (`--shadow --host openclaw` still refused); managed
  status record `hostKind` widens additively (still `pd.service-run-status.v1`).
  
  create-principles-disciple (minor) — install.json writers join the
  ownership CAS lock discipline (ERR-168): the installer's
  `writeInstallManifest` and the update side's `writeInstallConfig` /
  `mergeIntoInstallJson` run their read-modify-save under the same physical
  lock as the §8.4 transition primitive, failing loud instead of silently
  clobbering `backgroundExecutions` records. Against an older registry-
  resolved @principles/install-layout (the pre-cohort release window) the
  lock export is feature-detected and the pre-PR unlocked write behavior is
  kept for that window only.
  
  Adaptive timer decision: V1 fixed 120s OS period (no persisted Gateway
  counters, no timer service) — quantified comparison and disclosed
  semantic changes in
  `docs/reports/PD_SERVICE_HOST_PHASE4_SCHEDULING_COMPARISON.md` (normal and
  sparse loads comparable; burst drain ~2x slower, bounded; zero lost
  tasks; failure-backoff ladder semantics disclosed). manifest
  `workspaceBindings` is NOT implemented — host-binding authority stays
  with the existing dual sources (manifest + validated claims); handover
  registers the workspace through the existing atomic merge path.

## 0.9.1

### Patch Changes

- 2e91fdf: Workspace 归属发现补齐 OpenClaw 自身持久化绑定：`collectHostWorkspaceClaims` 现在同样读取 `<openclawHome>/extensions/principles-disciple/mcp-binding.json`，且只有经 `validateMcpBinding` 全量校验（host/schemaVersion/workspaceDir/runtimeDir/canonical serverEntry）的 binding 才能形成 workspace claim；launcher.cjs 同步同一严格规则与新增 OpenClaw 绑定源。install manifest 新增可选 `backgroundExecution` 所有权记录（state/effectiveOwner/generation/operationId/previousOwner/targetOwner/updatedAt），解析 fail-closed，为 SPEC-PD-SERVICE-HOST-001 §8.4 CAS 所有权契约的 schema 支撑。
- 2e91fdf: Workspace 所有权记录升级为逐 Workspace 独立表达：`InstallManifest.backgroundExecutions` 为以 canonical workspaceDir 为 key 的 `BackgroundExecutionRecord` 映射（替换单数 `backgroundExecution`），含 per-state 语义校验（handover_preparing/rollback_pending 必须 operationId+正确的 previous/target、generation ≥ 1；legacy_owned/service_host_owned 禁止携带交接字段）；旧单记录仅在 `workspaces.length === 1` 时迁移，多 Workspace 歧义 fail-closed；新增 `setInstallManifestBackgroundExecution` 单键写入器。Pain Ingress 收紧 `automatic_hook` 信任边界：已绑定宿主报告的来源必须落在宿主来源词汇表（codex: `codex:*`；workbuddy: `workbuddy:*`；openclaw: `after_tool_call`），不可信来源降级 `observation_only`（`untrusted_automatic_source`），不再产生 LLM/Task。
- 5e30d93: PD Service Host Phase 1 (PRI-1279, SPEC-PD-SERVICE-HOST-001 §11 Phase 1 /
  ADR-0020 §11.6): new `pd service run-once --dry-run [--json]` coordinator with
  the read-only Service Host pipeline — install identity (production-forced with
  PD_EXPERIMENT_ROOT stripping, recorded), two-source workspace discovery over
  the canonical install manifest and validated per-host claims
  (`collectHostWorkspaceClaims` / `findForeignWorkspaceOwner` reused), realpath
  identity dedupe, read-only `backgroundExecutions` owner projection, the
  install-level single-instance run lock (SQLite `BEGIN IMMEDIATE` arbitration
  over `<pdHome>/service/service-run-gate.db` — acquire, PID-verified takeover and
  ownership-checked release all decided inside one transaction; zero-wait
  immediate `already_running`; fully fail-closed on gate/busy errors; release
  reports a structured outcome — released / not_owned / failed_busy /
  failed_unwritable — where unreadable lock files (EACCES/EPERM/EIO) are real
  failures, never misread as released or not_owned),
  and the versioned operational status file under
  `<pdHome>/service/run-once-status.json`. Phase 1 starts no Worker and changes
  no consumer ownership; a run without `--dry-run` refuses
  (`dry_run_required_phase1`).
  
  Placement note (TD §2.1 deviation): the coordinator lives inside pd-cli
  (`src/services/service-host/`) instead of a separate `@principles/service-host`
  package — a new pd-cli workspace dependency would enter the self-contained
  release asset (ERR-196 class) and require payload-component staging, staged
  manifest rewrites and release-lock regeneration that cannot be fully exercised
  outside the release pipeline. Extraction into a dedicated package remains a
  Phase 2 (PRI-1280) decision with its own release-onboarding work.
  
  install-layout (patch): re-export `resolveRealUserHome` — the shared home
  precedence authority — so the coordinator reuses the single identity
  resolution instead of re-deriving it; add the authoritative Active Release
  record parser (`active-release.ts`: `ACTIVE_RELEASE_SCHEMA_VERSION`,
  `ActiveReleaseRecord`, `ActiveReleaseVerdict`, `parseActiveReleaseRecord`,
  `readActiveReleaseRecord`, `activeReleaseRecordPath`) — the single schema
  owner the service-host coordinator validates against (P1 defect fix:
  strict validation replaces lenient any-object parsing).

## 0.9.0

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

## 0.8.3

### Patch Changes

- 9259474: Fix two Codex MCP binding defects:
  
  - PRI-1247: Codex install/update/repair now defaults to Codex's own workspace instead of the OpenClaw-oriented detection result (an explicit `--workspace` still wins). A binding that points at another PD host's owned default workspace is treated as a cross-host misbinding by the launcher, the installer health check and `pd health`; `pd mcp probe` now reports the workspace the binding actually serves and refuses an explicit target the binding does not serve.
  - PRI-1248: the launcher binding is also written to the host-persistent PLUGIN_DATA location, which the launcher and health checks read first. A same-version cache rebuild, a version upgrade through the supported update chain, or a cold start no longer loses the binding; the payload-local copy remains as the legacy fallback (PRI-1183 repair path preserved).

## 0.8.2

### Patch Changes

- 5b0667c: 收回 MCP binding 形状校验的 pinned mirror，恢复 install-layout 单一实现（PRI-1191）。触发条件已满足：install-layout 0.8.1 已发布 validateMcpBinding / getCanonicalMcpServerEntry / MCP_BINDING_* 导出，且安装器依赖下限已抬到 ^0.8.1。删除 mcp-binding-shape-mirror.ts 及其 mirror parity 测试，codex-host-installer 的 isMcpBindingHealthy 改回直接 import 共享声明，并清除安装器与共享声明两侧的同源指针注释。校验行为不变：共享权威侧 launcher parity 测试（mcp-binding-contract-parity.test.ts）保留且仍全绿。

## 0.8.1

### Patch Changes

- 758dd2f: Experiment isolation hardening for the real OpenClaw host E2E:
  
  - the MCP launcher refuses an experiment (`PD_EXPERIMENT_ROOT`) whose `PD_MCP_LOG_DIR` is missing or outside the root, and refuses a binding whose workspace is outside the root;
  - the experiment launcher pins `PD_MCP_LOG_DIR`, validates the OpenClaw profile's per-agent workspaces, and materializes a canonical `.pd/install.json` runtime layout under the experiment root (removing the `pd_cli_entry_missing` root cause);
  - the launcher's path canonicalization now handles not-yet-created directories (8.3 vs long path forms) instead of misclassifying them as outside the root;
  - prompt activation identity now requires the formal ledger UUID: the `principleDraft.title` fallback is gone, activation/artifact UUID mismatches refuse injection, and legacy title activations keep working as an explicitly marked `legacy_title` identity without creating new title-keyed receipts;
  - prompt/implementation/defer candidates are reported as `candidate_kind_not_ledger_eligible` (a type boundary), not `candidate_kind_invalid`, and Owner correction phrases from the real-host regression are ambiguous candidate discovery terms.

## 0.8.0

### Minor Changes

- 028c0c5: 收敛 `mcp-binding.json` 的校验为单一声明。`@principles/install-layout` 新增 `mcp-binding-contract`：schema 常量、三宿主 canonical 入口、`validateMcpBinding` 形状校验、reason 码枚举与表驱动夹具。Codex 安装器的自愈判断与 `pd health` 的内部判定都改为复用该函数，不再各自维护一套更宽松的判据；launcher 仍是无依赖 `.cjs`，由 `pd-mcp-server` 的平价测试实跑真实 launcher 逐条比对各宿主的 reason 字符串（新增码无样例即红）。`pd health` 对外输出码保持不变（`binding_paths_not_absolute`、`server_entry_not_canonical` 等），映射留在 pd-cli 侧并有表征测试。`pd-mcp-server` 的 manifest 变化仅是测试期 `file:` devDependency（不进入运行时依赖图，发布产物不变）。路径比较按 launcher 的规则统一：win32 大小写不敏感、其他平台严格相等，`platform` 由调用方注入（不读 `process.platform`），因此该分支可在 Linux CI 上被覆盖。枚举守卫改为扫描真实产生路径（含 `fail(declared.reason, …)` 的动态 reason），声明表既不能漏码，也不能保留 launcher 不再产生的码。

## 0.7.0

### Minor Changes

- 1042164: PRI-1165: make PD's `openclawHome` follow OpenClaw's explicit state dir, and move the experiment instance's runtime cache into its root.
  
  - `resolvePdHome()` now treats `OPENCLAW_STATE_DIR` as authoritative over `OPENCLAW_HOME` in production (matching OpenClaw) and requires it to stay inside the experiment root in experiment mode. A relative `OPENCLAW_STATE_DIR` is refused fail-closed (`openclaw_state_dir_not_absolute`); in experiment mode a value outside the root is refused (`openclaw_state_dir_outside_experiment`).
  - `pd config doctor` follows an explicit `OPENCLAW_STATE_DIR` for the OpenClaw home (instead of always `<home>/.openclaw`) and honours an explicit `OPENCLAW_CONFIG_PATH`.
  - `dev:console:experiment` now sets `XDG_CACHE_HOME=<root>/.cache` — OpenClaw's private SQLite snapshot staging root and rolling logs resolve through it instead of `%LOCALAPPDATA%\openclaw` — and `OPENCLAW_PROFILE=experiment` so the rolling log filename is namespaced. `%LOCALAPPDATA%\OpenClaw\locks` stays shared but is safe: lock files are keyed by the canonical state-db path.

## 0.6.0

### Minor Changes

- 93288c7: PRI-872: add a fail-closed PD home contract so a second (experiment) instance can run on the same user account without touching the production installation.
  
  - `resolvePdHome()` / `PD_EXPERIMENT_ROOT` (install-layout): the single authority for "which PD home does this process own". Production keeps the historical `os.homedir()` derivation; an experiment root derives `.pd`, `.pd-console`, `.openclaw` and `.codex` under itself. Unusable values (empty, relative, missing, not a directory, overlapping `~/.pd`/`~/.pd-console`/`~/.openclaw`, or a derived path linked outside the root) return a structured refusal — never a silent fallback to the real user home.
  - `create-principles-disciple`: the detached bootstrap executor resolves its PD home through the same contract, so an experiment console's update transaction can never target the production runtime.
  - pd-console: every user-level path (workspace registry, update page/history, bootstrap executor lookup, backups, gateway config) now derives from that resolution instead of `os.homedir()`; an experiment instance defaults to console port 13100, refuses product updates (`experimental_instance`) and refuses machine-level `openclaw gateway stop|start` (its gateway is a foreground `openclaw gateway run` owned by the launcher). New `npm run dev:console:experiment -- --root <abs dir>` starts the isolated instance with port preflight and child-process lifecycle.

## 0.5.0

### Minor Changes

- bbdcb50: Separate the four independent WorkBuddy host facts in `pd health --host workbuddy` — plugin registration (registry), plugin enablement (settings enabledPlugins), governance flag state (ENABLED / EXPLICITLY_DISABLED / DEFAULT_OFF / UNKNOWN, an explicit Owner opt-out is never folded into a generic OFF), and an explicit runtime boundary (RUNTIME_PROBE_NOT_PERFORMED + MODEL_TOOL_CALL_NOT_VERIFIED; pd health stays read-only, never starts the host or the MCP server). The registration/enablement judgment and the host config paths move to @principles/install-layout as the single authority (getWorkbuddyHostConfigPaths / interpretWorkbuddyPluginState) — installer, `status` and `pd health` now resolve the same paths and apply the same rules; the installer delegates instead of owning a second judgment. A complete MCP payload implies nothing about registration or enablement. Verified: a WorkBuddy-only machine reports INSTALLED at the top level (negative control included).

## 0.4.1

### Patch Changes

- fb70a87: Gate 4 (PRI-1071): expose the canonical MCP server component path (`mcpServerDir` + `getMcpServerEntry`) so PD-owned binding writers derive `~/.pd/runtime/pd-mcp-server/dist/index.js` from the install-layout SSoT instead of repeating the segment list. The installer keeps a local twin until this version is on the registry (0.4.0 predates the export); the twin is removed in the follow-up release.

## 0.4.0

### Minor Changes

- fec1306: > Note: `@principles/pd-companion` is private and changesets-ignored; its
  > desktop release version bump (0.1.2 → 0.1.3) belongs to the companion
  > release-prep flow, not to this changeset.
  >
  > Note (RF-02, PUBLISH_BLOCKED until install-layout 0.4.0 publishes): the
  > npm-published installer resolves its install-layout dependency from the
  > registry, which still serves 0.3.x. While that holds, the installer's
  > unknown-host compatibility is REFUSE-ONLY: a manifest carrying a host the
  > dependency cannot parse makes install/merge fail closed
  > (install_manifest_malformed) instead of dropping the registration —
  > verified against the real registry resolution by the dual-mode parity test
  > in the packaged-install smoke suite. True forward-compat write-through
  > activates when this changeset's install-layout minor publishes (0.4.0) and
  > this package's range is raised to it; the local twin
  > (`src/manifest-host-union.ts`) must then be retired in favor of the shared
  > export, and the parity test flips to its positive mode automatically.
  
  Fix the PD Companion install-compatibility brick (2026-10-16): Companion 0.1.2
  bundled install-layout 0.1.0, whose parser rejected the production 3-host
  manifest (`workbuddy` unknown) as `install_manifest_malformed` — surfacing
  "未找到已安装的 PD / console_runtime_not_installed" on a healthy canonical
  install and mass-stopping every running workspace worker as
  `removed_from_manifest`.
  
  - install-layout: an unknown host string is now a structured
    `install_manifest_unknown_host` warning (parsed into
    `manifest.unknownHosts`), never a malformed manifest; `layoutVersion`
    mismatch, structural damage and illegal workspace paths stay fail-closed;
    new `installManifestHostsForPersist()` reunifies known+unknown hosts for
    writers; the parser re-reads its own output idempotently.
  - installer / workbuddy host installer / uninstaller: manifest write-backs
    carry unknown host registrations forward instead of silently unregistering
    a newer host; an uninstall keeps the shared runtime while any unknown host
    remains registered.
  - Companion: manifest reads return an explicit ok/unavailable outcome — an
    unreadable manifest holds worker state (structured
    `workspace_worker_sync_skipped` events, one Owner-visible escalation per
    episode) instead of syncing an empty list; install-layout failure causes
    are routed distinctly (incompatible layoutVersion → update-the-Companion
    page with a release link; missing install; corrupt runtime).
  - Packaging: verify-package now gates the parser extracted FROM the built
    app.asar through the manifest cross-version compatibility matrix
    (scripts/bundled-parser-compat.mjs) and records the app + bundled
    install-layout versions; companion-release runs the package test suite
    before packaging.

## 0.3.1

### Patch Changes

- ccc04eb: Switch distributed PD packages to Apache License 2.0, ship matching LICENSE/NOTICE files, and preserve the historical MIT notice. This is a licensing and packaging release without runtime feature changes.

## 0.3.0

### Minor Changes

- 5e794be: WorkBuddy install contract: 'workbuddy' install host, workbuddyAdapterDir, getWorkbuddyWorkspaceDir (OD-07 governance workspace).

## 0.2.7

### Patch Changes

- edbbcd9: RAH-3 (PRI-907): complete the release-artifact content boundary. @principles/install-layout and principles-disciple (openclaw-plugin) production builds now exclude compiled tests (tsconfig.build.json; plugin build:types declaration emit filtered too) with the same fail-loud dist hygiene assertion as RAH-1. The installer bundle script (create-principles-disciple) filters compiled test artifacts out of every payload copy AND asserts zero test artifacts across all payload components after materialization — test code can no longer reach user machines even if a future package forgets its build-boundary guard. A repo-level scan (check:workspace-artifacts, wired into verify:merge) backstops all workspace dist trees.
