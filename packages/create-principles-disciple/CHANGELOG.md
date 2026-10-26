# create-principles-disciple

## 1.145.22

### Patch Changes

- 52d2c6a: Connect Owner-decided principle reuse to shared identity resolution, and add authenticated rule-candidate binding with one bounded revision. Preserve prior PI artifacts across revision epochs and reject stale or revoked binding receipts before generation and publication. The bundled Console exposes binding separately from rule approval and activation.

## 1.145.21

### Patch Changes

- 4922dda: PRI-1041：按上游声明确定 RuleCode 必需验证，区分历史证据与可回放事实，独立系统契约测试贯通 L2 自测/提交、Runner、Evaluator 与工件装配；缺少能力或必需覆盖时不再错误标记为验证通过。
- e060c56: PRI-1040：为 Companion 托管的 Codex/WorkBuddy worker 接通合作式发布交接，当前周期完成后才替换，无法安全交接时明确显示原因。Codex 插件发布后维护已发布包固定版本、递增插件缓存版本，并由真实 npm 能力探针保护交付。

## 1.145.20

### Patch Changes

- 1b13597: SPEC-PD-PAIN-RECALL-CLI-001: new read-only `pd pain recall` command — recalls the historical pains a principle verifiably derives from, so a host Agent can check a principle's origin, trigger boundary, or current-situation fit on demand. Only two authoritative association edges are honored (`reuseEvidence[].painId`; `derivedFromPainIds` resolved through its production contract as candidate ids via `tasks.input_ref`), results dedup by real pain id while keeping every evidence ref, `--context` re-ranks deterministically without any model/network call, and per-source availability separates `not_recorded` from `unreadable` (`source_missing`/`source_unreadable` never masquerade as `no_matches`). All three hosts' `pd-cli-operator` skills (Codex plugin, OpenClaw en/zh templates, WorkBuddy adapter) now document when to call it, how to read the JSON contract, and the diagnosis-is-not-owner-statement rule.

## 1.145.19

### Patch Changes

- eba9e22: PRI-1021：安装器不再写 OpenClaw 宿主的 `~/.openclaw/plugins/installs.json`。该文件自 OpenClaw 2026.10.5 起会被 doctor 状态迁移硬拒，导致网关以 exit 78 循环重启；插件注册只由 `openclaw.json` 与宿主自身的安装流程负责。
- e0f9fc8: PRI-1022：让新用户知道「PD 的内置智能体需要自己配 LLM」。安装指引（README 双语、USER_GUIDE 双语、官网 getting-started 双语、安装器 README）新增前置条件与「开始之前：先给 PD 一个 LLM」一节，讲清 provider / model / apiKeyEnv 三个字段和跳过后的真实后果（证据照收，但不诊断、不提原则）。`--yes` 安装摘要不再只说「配置了 runtime profile」，未配置时点名三个字段并给出两条补齐路径。Console 控制中心把原本写好却从未渲染的五句 readiness 文案接到实际状态上，并删掉「runtime profile 是 OpenClaw profile」这句与当前默认架构相反的描述。

## 1.145.18

### Patch Changes

- 0f2d1fb: PRI-1020: Owner-declared context windows (SPEC-PD-OPERATOR-DECLARED-PROMPT-BUDGET-001). A new optional `promptBudget` section in `.pd/config.yaml` lets the Owner declare a model's real context window (`declaredContextWindowTokens` + optional per-host `hosts` overrides). It is tier 0 of the injection budget chain — outranking host-reported windows and the model catalog — and scales the budget with the same formula as #2093 (262144 tokens → 4096 chars, cap 16000). This unblocks Codex/WorkBuddy hosts whose adapters carry no window facts and whose custom model ids can never match the installed catalog (previously locked at the 2000-char fallback forever). Console surfaces forecast under the declared basis when no fresh runtime observation exists; a fresh observation still wins. Delete the section to roll back to the previous behavior. Config validation fails loud on malformed values (policy plausibility bounds, closed host set, unknown keys).

## 1.145.17

### Patch Changes

- 4256244: PRI-1019：为 Codex RuleCode 接通经 Owner 认证的设计事实声明、生成能力检查和逐次运行时事实；缺失或失效事实会暂停依赖规则并显示原因。Console 提供范围登记与撤回入口；保留真实原则审批与逐工件激活流程。

## 1.145.16

### Patch Changes

- 6881b6c: Bump the Codex plugin manifest 0.1.1 → 0.2.0 and the WorkBuddy plugin manifest 0.1.0 → 0.2.0. The unified four-skill set (#2106) changed both plugins' shipped content without moving their manifest versions; Codex cache updates key on that version, so users re-running `codex plugin add` could be served the already-installed 0.1.1 payload and never receive the new skills. The WorkBuddy same-version refresh path is content-safe, but a versioned cache dir makes the upgrade observable. Includes a cross-version WorkBuddy upgrade regression (new cache dir + registration repoint + governance data preserved) and parameterizes the delivery tests off the shipped manifest version.

## 1.145.15

### Patch Changes

- 5c383e5: Unify PD host skills around four consistent capabilities, clarify Owner governance and evidence boundaries, and align the published skill bundles and Codex recovery guidance.
  
  Review-round additions: `pd run list/show` gain an optional `--workspace` (governance-workspace reads independent of cwd); Codex skills route every shipped script through `pd-locate.cjs --exec` — one authoritative locator that resolves the plugin root once, fails loud on marketplace ambiguity or a missing script instead of silently falling back to an older version; WorkBuddy near-miss explicit-statement prefixes get an actionable format notice; `pd-review` startup text no longer presents CLI approval as an agent fallback.

## 1.145.14

### Patch Changes

- 765d5c4: Decouple the signal_confirmations batch consumer from the correction_observer flag (AUDIT-P2-04, 2026-10-21 remediation): the periodic cycle now starts when signal_collector is enabled (default on) even with correction_observer off (default), so persisted pending confirmations are consumed instead of remaining invisible permanent-pending records. Keyword optimization remains exclusively gated by correction_observer and is never silently enabled. Batch skips due to an unavailable classifier are now counted (stage2BatchSkipped) and pd config doctor classifies backlog-plus-skip as degraded with an actionable next action.
- d00ea5c: Signal detection sync-path and observability hardening (AUDIT-P2-01/P2-02, 2026-10-21 remediation): defer all health-counter file writes off the before_prompt_build synchronous call stack (degraded/zero-hit paths previously did a synchronous read-modify-write per message); add stage2Invocations and stage2BatchSkipped counters with backward-compatible signal-health parsing and pd config doctor display; add sync-path regression tests and a repeatable detectSync performance baseline. SQLite queue records stay synchronous by design.

## 1.145.13

### Patch Changes

- 48df168: PRI-1017: Console budget forecasts now run under the workspace's most recent runtime budget OBSERVATION, closing the SPEC-PD-MODEL-AWARE-PROMPT-BUDGET-001 §6.1 data-chain gap where the runtime injected under a model-aware budget (e.g. 256K window → 4000 chars) while the console still forecast under its own parameterless fixed 2000-char fallback (`1953/2000`).
  
  - Host-runtime adds a read-only observation model over the EXISTING injection events (`runtime_v2_prompt_activations_injected` JSONL): latest budget fact per host, untrusted-input discipline (closed-set validation, loud skip counts), workspace + host binding, 24h freshness bound, policy-version binding, and pre-policy events skipped rather than reinterpreted. No new database, no second budget state source, no event schema change.
  - The reader is bounded: at most the 7 most recent daily files in each candidate log directory (`.pd/logs` and `.state/logs` — a per-directory cap so a later directory can never be starved of the newest observation), and only the last 4 MiB of each file, so a large log can never stall the console; a cut line is dropped rather than half-parsed, and `truncatedFiles` reports the skip loudly. An observation that only exists in a skipped prefix is reported as absent (honest fallback), never reconstructed.
  - Console surfaces (approvals/grouped badge, activations status rows, post-approval warning) pass the observation-rebuilt `PromptBudgetResolution` into the same production projection; payloads carry `budgetObservedAt` so the UI labels the budget as the most recent runtime observation — never as a live confirmation. Per-host forecasts under an unconfirmed route each carry their own budget basis.
  - Honest degradation: no observation / stale observation (`runtime_budget_observation_stale` reason code) / host mismatch / untrusted event fields all fall back to the fixed budget with traceable reason codes; governance flows are untouched.
  - Also completes a PR #2093 review leftover: the focus-page budget fallback localization keys (10 reason codes + notes) now exist in both en and zh-CN, and the grouped API accepts `?host=workbuddy` like the focus page's host picker.

## 1.145.12

### Patch Changes

- d3796e4: SPEC-PD-MODEL-AWARE-PROMPT-BUDGET-001: model-context-aware prompt injection budget.
  
  - Core adds the single budget resolver `resolvePromptBudget` (pure policy, injectable Pi AI catalog): trusted host effective window (OpenClaw `contextTokenBudget` with model/modelsConfig/agentContextTokens provenance) → exact provider+modelId catalog match (host-declared provider) → legacy fixed 2000-char fallback with a bounded machine-readable reason code — provider-less name-only matches NEVER confirm (v0.2 trust amendment: a unanimous name cannot prove the deployment is not a custom endpoint). Budget formula `min(16000, max(1250, floor(2000 × W / 128000)))` in UTF-16 chars (NOT tokens). The 1250 floor is MEASURED (shared route full render of one minimum viable principle = 849/1204 chars with self-report off/on — lower floors re-create the audited 32K zero-injection defect); the 16000 cap is the Owner target upper bound (1M windows map to 15625).
  - Host-runtime resolves once per request through the real injection path (`HostEventContext.modelContext`) and the projection/precheck/status surfaces; approval-time deliverability is tier-honest (`model_dependent` for entries fitting the supported 1250..16000 range only on larger-context models — proceeds with a notice, never a refusal or a promise; `undeliverable` only beyond the 16000 max tier; cross-host aggregation is monotone — only ALL-hosts overflow brands an entry oversized everywhere); injection events carry budget provenance INCLUDING the bounded `budgetFallbackReason` code.
  - Adapters forward host model facts: OpenClaw hook context fields (type synced to the upstream enum), Codex validated `model` id, WorkBuddy observed-optional `model` (soft-consumed — dynamic only via unambiguous catalog match, honest fallback otherwise). CLI shows the model-dependent notice; Console surfaces tier fit and budget provenance.
  - Rollback: with no trusted capacity facts every path resolves to the historical fixed 2000-char budget (byte-identical legacy behavior); no schema migration, no new network calls, no per-turn catalog refresh.

## 1.145.11

### Patch Changes

- 0dc0431: chore(deps): bump @sinclair/typebox 0.34.49 -> 0.34.52（#2087）。typebox 是 core / plugin / console 的运行时 dependency，console 随 installer 分发，故 core、plugin 与 installer 各声明 patch。
- 96bff72: chore(deps): bump @principles/install-layout 0.2.7 -> 0.4.0（#2088）。install-layout 是 installer 的运行时 dependency，随 create-principles-disciple 工件分发，installer 声明 patch。
- 9c4f766: chore(deps): bump i18next 26.4.2 -> 26.4.7（#2089）。i18next 是 pd-console 运行时 dependency，console 随 installer 分发，installer 声明 patch。

## 1.145.10

### Patch Changes

- bf5aed3: Introduce an opt-in WorkBuddy native current-user keyword Pain path using the shared high-precision detector, canonical Pain admission and Diagnostician task continuation. Expose effective keyword detection status; leave the feature off by default and preserve Codex ingestion consent boundaries.

## 1.145.9

### Patch Changes

- 1a127e2: 修复 RuleCode 新生成契约与路径事实，统一原则范围内的语义验收，并为经过逐规则复验的 Codex V2 规则接通运行上下文。

## 1.145.8

### Patch Changes

- b02ebb5: Deliver WorkBuddy pain recording, status, Owner review and disable skills through the plugin package, marketplace and versioned cache. Reject incomplete payloads and unsafe manifest versions before registration, refresh old hook-only caches even at the same manifest version while preserving native registry scopes and older cache versions, confine cache replacement to the PD plugin version directory, and delegate disable to the existing official installer API.

## 1.145.7

### Patch Changes

- 1eb5293: Upgrade the Pi runtime dependency from @earendil-works/pi-ai / pi-agent-core 0.85.1 to 1.2.0 (SPEC-PD-PI12-COMPAT-001). Migrates the three runtime adapters to the Pi 1.2 agent-loop contract: the system prompt now rides the transcript as a leading system message (also fixing the duplicated user message in every L2 request under 0.85.x), shouldStopAfterTurn is replaced by finishTurn with the upstream canonical error/aborted guard, convertToLlm passes the system role through, and the ToolCall extraction predicate adopts the SDK type (arguments narrowed to JsonObject). Regenerates all installer release locks on the Node 22 / npm 10 toolchain; pi-agent-core's runtime dependency tree shrinks to pi-ai + typebox. No governance, activation, or approval behavior changes; Artificer keeps fail-closed semantics (no L1 fallback) and the Owner-Evidence gate is untouched.
- d91b9e0: PRI-1011: an LLM run whose output budget the provider rejects now recovers instead of burning all retries on the same rejected value.
  
  - core: `completeWithRetry` recognises the "requested max_tokens exceeds the maximum output tokens" signature (resolved error responses and thrown errors alike) and halves the budget for the next attempt of that same run — a profile that was never rejected keeps sending exactly what it sends today. A profile that relies on pi-ai native defaulting gets an explicit number for the retry, because resending `undefined` would resend the value the provider just rejected.
  - The ladder stops at a 4096 floor: below that a structured answer is routinely cut off, so further halving would trade a provider rejection for a silent truncation. At the floor the run still fails loud as `execution_failed` with the provider evidence intact.
  - Each step emits an observable `llm_max_tokens_downshift` event (from/to, provider, model, attempt, provider evidence), so the Owner can see what was tried rather than only that something failed.
  - Rate limits, timeouts and unrelated 4xx keep their existing classification and trigger no downshift.
  
  This release train patches `@principles/core`; the correction observer and the other internal agents call it through the bundled `principles-disciple` plugin, and the installer bundles the plugin, so both must be declared in the same plan (release-intent rule N-5/C4). No plugin or installer code changes.
- a241ca2: 修复装机上「Codex 治理健康」永久降级：console 改用安装布局权威去找 pd-cli 入口。
  
  此前 `CodexGovernanceHealthModel` 用包名解析（`require.resolve('@principles/pd-cli/package.json')`）定位要执行的 CLI，而 console 从未声明这个依赖——装机上它必然抛 `MODULE_NOT_FOUND`，被 `catch { return null }` 压成一个常量 reason `pd_cli_unavailable`，与「运行时真的坏了」无法区分；nextAction 还引导 Owner 去 `npm i -g @principles/pd-cli`，这台机器上既无效也不该做（安装面由 installer/更新链独占）。
  
  现在解析顺序为：安装布局权威 `resolveUpdateLayout()` 给出 `pdCliDir` → 拼 `<pdCliDir>/dist/index.js` → 按实际盘上状态给出可区分原因（入口缺失 / 不可读 / 不是常规文件），nextAction 指向控制台的更新页与 `npx create-principles-disciple`。布局解析不到时才退回工作区依赖图（源码树场景），且该通道不做存在性预检，未构建时由子进程自己报结构化失败。既有 dev 行为与 CLI 调用命令行（`health --host codex --workspace <dir> --json`）均未变。
  
  同一症状的第二处断链：CLI 在报告本身判定「治理未就绪」时按设计以退出码 1 结束（cli-2：未就绪就是可执行信号），而 console 把非零退出直接当作采集失败丢掉。于是在 host 未启用的装机上——退出码恒为 1、stdout 却是一份完整报告——面板显示的仍是采集失败常量，真正的阻断原因（如 `host.codex: disabled`）被淹没。现在非零退出只表示「需要用 stdout 判定」：解析并校验到报告字段就原样返回（未就绪仍如实呈现 ready=false + 阻断原因），拿不到可用报告才降级，并区分 `health_collection_failed`（子进程没能给出输出）与 `report_unusable`（输出了但不符合 --json 契约）。

## 1.145.6

### Patch Changes

- ef04263: Retire the local manifest-host union twin: install-layout 0.4.0 is published,
  so the installer imports the shared `installManifestHostsForPersist()` again
  and the temporary local copy (added when the registry only served 0.3.x) is
  deleted. The registry-parity dual-mode test now runs its POSITIVE mode
  against the published dependency: an unknown future host survives codex
  install, workbuddy install and known-host uninstall end-to-end.

## 1.145.5

### Patch Changes

- 807fcab: 修正纠正词库到顶后学习通道冻结的根因：满 200 词时按证据淘汰最没用的学习词（seed/user 永不被淘汰），不再抛错；UPDATE/REMOVE 与 ADD 共用同一条词身份规则，未命中只记一次可读跳过；拒绝把动作词当 term 入库；学习不再删除 Owner 播种词；每次词库变更进 SYSTEM 日志。Stage2 回写不再用判词覆盖命中词，观察员据此拿到真实的 REMOVE 证据。

## 1.145.4

### Patch Changes

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
- 06152af: Connect Codex Owner-labelled behavior evidence to the shared internalization preflight. Reuse one validated assembler across OpenClaw, Codex and evidence attach/resume; read trajectory data without creating or migrating it and preserve host-specific semantics. Missing labels reach Owner review without model calls or attempts; missing/corrupt sources remain observable source faults.
- 33b399e: Ship the runtime profile maxTokens preservation fix in the bundled console.
- Updated dependencies [fec1306]
  - @principles/install-layout@0.4.0

## 1.145.3

### Patch Changes

- eaf52c4: PRI-980 (SPEC-PD-IAER-001): bundle refresh — this release train patches `principles-disciple` (evidence-readiness preflight, channel-aware Artificer routing, owner evidence attach/resume, run-correlation telemetry) and `@principles/host-runtime`; the installer bundles the plugin, so it must be declared in the same release plan (release-intent rule N-5/C4). No installer code changes.
- 364e37d: Console readability slice 1 (SPEC-PD-CONSOLE-READABILITY-002): fix static mojibake separators in candidate descriptions, split long rule text into short-title preview + verbatim body (newlines preserved, no bold h1 body), relabel approval record counts (no longer called behavioral evidence), rename the misleading "Edit" action to "Replace pending version", fold raw deterministic-check codes into a disclosure, and stop pasting the candidate description into the principles list "Formation Basis" block.

## 1.145.2

### Patch Changes

- 2010689: WorkBuddy installer: probe every fixed drive's standard Program Files directories when resolving the WorkBuddy engine CLI (G1, 2026-10-15). A Desktop install outside the SystemDrive's Program Files (e.g. `D:\Program Files\WorkBuddy`) previously resolved to "engine not found" — `install` skipped its engine verification and `detect` reported an absent engine on a real installation, and the real-engine isolation test silently skipped on such machines. Env overrides (`PD_WORKBUDDY_ENGINE` / `WB_ENGINE`) keep priority; Linux/CI behavior is unchanged (drive scan is win32-only).

## 1.145.1

### Patch Changes

- ccc04eb: Switch distributed PD packages to Apache License 2.0, ship matching LICENSE/NOTICE files, and preserve the historical MIT notice. This is a licensing and packaging release without runtime feature changes.
- Updated dependencies [ccc04eb]
  - @principles/install-layout@0.3.1

## 1.145.0

### Minor Changes

- 5e794be: WorkBuddy host installer (desktop marketplace registration, governance workspace init, enable/uninstall) + workbuddy-adapter payload distribution and release locks.

### Patch Changes

- 6e677f8: fix(release): 把 openclaw-plugin 的 `@principles/core` 依赖范围对齐到一个**已发布**版本。
  
  ## 问题
  
  `packages/openclaw-plugin/package.json` 声明 `"@principles/core": "^1.291.6"`，
  但 **1.291.6 从未发布到 npm**（registry 上 `@principles/core` 的 latest 仍是 1.291.5）。
  
  该范围由上一个 Version PR（#2015）的 changesets「Updated dependencies」机制自动写入，
  而那次发布从未执行，范围就此悬空。一旦某个 Version PR 把 core 继续 bump（例如 1.291.7），
  `^1.291.6` 的下界就不再等于 workspace 版本，`decidePending()` 判为 `broken`，
  `packages/openclaw-plugin/tests/package/published-host-runtime-bundle.test.ts`
  （以及 `test:host-runtime-parity`）随即抛错：
  
  ```
  @principles/core@^1.291.6 resolves to nothing on the registry and is not a
  changesets-materialized version of this workspace (1.291.7) — a genuinely
  unresolvable publish range.
  ```
  
  ## 修法
  
  把范围改为 `^1.291.5`——registry 上真实存在的版本，于是 `decidePending()` 走
  `published` 分支：套件**真实运行**（而非因 pending 窗口被跳过），实际完成
  `npm pack` → 隔离安装 → import bundle 的完整发布契约验证。
  
  这不是降低需求：`^1.291.6` 本就是 changeset 自动生成的，不代表 plugin 的真实最低
  core 版本。合并后 changesets 会在下一个 Version PR 中把该范围自动对齐到 core 的新版本。
  
  ## 附带影响
  
  `package-lock.json` 同步更新。
  
  > 注：1.291.6 / 2.1.2 这两个已 materialize 但未发布的版本仍悬在发布流程上，
  > 需要单独补发布或由 release train 处理——不在本 changeset 范围内。
- 4ba83b7: PRI-955 (R1 F11): the Console no longer equates "no failed tasks" with "the pipeline is healthy".
  
  - `GET /api/v1/failed-tasks` now returns a derived `pipeline` health block computed on read from the same state.db facts the list already uses — no new persistence, no second truth. Counts come from an exact read-only COUNT(*)/MIN/MAX aggregate scoped to learning-pipeline runner kinds (pendingCount is never a LIMIT-truncated list length; the progress timestamp ignores succeeded tasks outside the learning pipeline). Status semantics: `stalled` (work waiting, no progress inside the window), `backlogged` (work waiting, still progressing — with its own nextAction), `healthy` (nothing waiting plus fresh runner-kind progress evidence), `disabled` (internalization_auto_consumer off — learning cannot advance), `unknown` (unreadable counters or a fresh workspace with no evidence) — every non-healthy state carries a nextAction, and unknown is never reported as healthy. Status semantics: `stalled` (work waiting, no progress inside the window), `backlogged` (work waiting, still progressing), `healthy` (nothing waiting plus fresh progress evidence), `unknown` (unreadable counters or a fresh workspace with no evidence) — every non-healthy state carries a nextAction, and unknown is never reported as healthy.
  - Failed-tasks page: the empty copy no longer claims "PD 管道运行正常"; it states the fact ("当前查询范围内没有失败任务") and renders the learning-queue health card (both zh-CN and en). The card also renders above the list when tasks exist.
  
  Dogfood evidence (2026-10-13, F11): a 13-deep philosopher backlog starving for 35+ minutes was reported by this page as "没有失败任务。PD 管道运行正常。"
- 8f9e870: PRI-956 (R1 F15): the principles review page discloses runtime revocation instead of implying "in effect" from the ledger's asset status.
  
  - Background (Owner-adjudicated): the ledger `status` is an ASSET lifecycle with no deactivated value — a deactivated principle stays `active` there forever, while the runtime authority is the activations table (verified: after Owner deactivation, new sessions inject zero activations). The review page classified ledger-`active` as "approved & in effect" and its cross-check queried approvals rather than activations, so the two governance pages could disagree.
  - Change: `GET /api/v1/principles` items now carry `runtimeDeactivated: true` when the activations table reports a deactivated activation targeting the principle (read-only query; degrades with a reason). The review page renders a "运行时已停用 / Runtime Revoked" badge next to the governance decision. No second write authority is introduced; the ledger status semantics are unchanged (no deactivate→ledger sync), and the classification bucket is unchanged.
  - Regression: `pd health --host codex`-style cross-new-session revocation checks remain covered by the structured injection events (runtime_v2_prompt_activations_injected injectedCount); a full browser approve→activate→inject→deactivate→no-inject regression runs in the R1 acceptance report.
- Updated dependencies [5e794be]
  - @principles/install-layout@0.3.0

## 1.144.28

### Patch Changes

- 9fb95ff: chore(deps): bump tailwind-merge 3.6.0 -> 3.7.0（#2007；@principles/pd-console 运行时 dependency，打进 console bundle 随 installer 工件分发）。
- 06b46b0: chore(deps): bump sonner 2.0.7 -> 2.0.8（#2009；@principles/pd-console 运行时 dependency，打进 console bundle 随 installer 工件分发）。
- a6b824d: chore(deps): bump js-yaml 5.4.2 -> 5.4.3（#2010，installer 自身 lockfile）。js-yaml 是 create-principles-disciple 的运行时 dependency，随发布工件分发，故声明 patch。
- 69fa3f3: chore(deps): bump js-yaml 5.4.1 -> 5.4.3（#2011）。js-yaml 是 core / host-runtime / plugin / pd-cli / console 的运行时 dependency，console 随 installer 分发，故这 4 个可发布包与 installer 各声明 patch。

## 1.144.27

### Patch Changes

- 6317a63: Keep unresolved content references unresolved across evidence replays (Phase 1 closeout review P2-2). The evidence producers treated the STORED contentRef as an opaque truthy object when rebuilding an observation for a replayed source event: an already-stored `revision_reference_unresolved` reference (no payloadDigest — e.g. an activation whose artifact is missing) was re-emitted as `resolution: 'resolved'` without a digest. The normalizer rejects `resolved`-without-digest before the store's idempotent dedup branch runs, so replaying the SAME source event failed with `observation_contentRef_resolved_requires_payloadDigest` instead of landing as an idempotent duplicate — "record count unchanged" was the result of rejection, not idempotency (the real 2026-10-11 replay probe hit exactly this). Resolution is now upgraded to `resolved` only when a payloadDigest is actually present; digest-carrying (resolved) replays keep their digest and dedup as before. Fixed at all four producer sites (Codex prompt delivery + Codex deny chain, OpenClaw prompt delivery + gate enforcement chain); validator, oracle, and store semantics unchanged. `create-principles-disciple` rides along because the installer bundles the plugin. Regression tests drive the real recorder → ingress → store boundary on both hosts: unresolved first-record + replay lands as `duplicateCount: 1` with the original resolution preserved, and a new ingress boundary test pins digest-less-batch replay as an idempotent duplicate plus same-key-different-content as a reported conflict.

## 1.144.26

### Patch Changes

- c111135: Console UI upgrade (SPEC-PD-UIUX-001): honest receipt semantics (0/0 no longer claims "already in context"), Focus reading order with conclusion-first layout and deduped decision inbox, narrow-screen drawer navigation replacing the fixed 256px sidebar, keyboard skip-link that keeps the HashRouter route, danger/contrast token fixes including the dark-mode Welcome button, and full EN/ZH localization with document language sync.

## 1.144.25

### Patch Changes

- 4e38342: Phase 1 acceptance: empty release declaration — this PR is test/documentation only (new intervention-evidence BDD feature + step definitions for pd-console; no production source changes).

## 1.144.24

### Patch Changes

- 3bc01f3: PRI-948: the Owner can finally leave a reason when approving a Principle. The approve action's optional `note` requirement was declared by the owner-decision contract and accepted by the approvals route (`approvals.decision_note`), but the Console confirmation panel never rendered the field and the call site dropped it — so `decision_note` stayed empty forever and approval rationale had no archive. The panel now renders a requirement-driven note textarea (visible and editable, still optional — confirm is not gated on it) and forwards the trimmed note through `approveApproval(approvalId, note)`. Ships the pd-console fix inside the installer package (pd-console is private).

## 1.144.23

### Patch Changes

- f4b7599: PRI-896, PRI-897: the update recovery surface stops alarming forever on residue that the product has already outlived, and a sealed transaction journal can no longer be overwritten by a retry. `GET /api/update/recovery` now consults the product's own verdict (`recoverUnfinishedTransaction`, PRI-853) before labelling a non-terminal journal as needing recovery: a crash orphan that the live `active.json` generation proves was superseded (`old_confirmed`) is reported separately in the new `superseded` field instead of holding the Owner's attention, while a missing/corrupt active record or an interrupted activation (`explicit_refusal`) keeps alarming — demotion is evidence-gated, never a blanket mute. `ReleaseManager.apply()` now refuses to append a second attempt onto an existing journal file (new `journal_sealed` refusal, raised before any side effect), which previously broke whole-file sequence validation and marked even an earlier `confirmed` update in that file as corrupt forever. Ships the pd-console fix inside the installer package (pd-console is private).

## 1.144.22

### Patch Changes

- 8a72441: Re-drive the npm release train so the product 2.3.0 component cohort actually ships (PRI-874).
  
  The Version Packages PR for this cohort merged and auto-dispatched its train, but every matrix leg failed inside the real-upgrade gate with `Cannot decrement patch of version 2.1.0`: the gate's local N-1 baseline helper could only step a patch number down, and ADR-0027 had just moved the plugin to a minor landing (`2.1.0`, patch tail 0). The gate fixture therefore rejected a legitimate release input, Publish and Finalize were skipped, and nothing reached the registry — `@principles/core`, `@principles/pd-cli`, `@principles/host-runtime`, `principles-disciple` and `@principles/codex-adapter` all stayed at their previous published versions even though their new versions are already committed on main.
  
  The fixture itself is fixed on main by `previousReleaseVersion()` (test-only, no shipped code). That fix cannot be retrofitted onto the already-dispatched cohort, because the release matrix runs the gate test from the cohort's own tree by design (G5, SPEC §17.1) and the cohort resolver only accepts a Version Packages PR merge commit. This changeset is the release intent that materializes a new cohort carrying both the committed versions and the corrected gate, so the pending component releases publish.

## 1.144.21

### Patch Changes

- d5732f8: PD v2 Phase 1 Evidence Foundation (ADR-0027): normalized intervention evidence ledger.
  
  - core: intervention evidence contract + deterministic normalizer (rc-1..rc-5 trust boundary, anti-forgery cross-field rules), append-only SQLite ledger tables inside the existing state.db (idempotent same-source replay, reported source conflicts, immutable records, activation occurrence snapshots), busyTimeoutMs connection option, and the four-query audit read contract.
  - host-runtime: shared intervention evidence ingress — the single validated entry every host source uses; never throws, never waits on locks (busyTimeoutMs 0), degrades with structured reason + nextAction.
  - openclaw-plugin (principles-disciple): evidence wiring on both legacy and shared routes — prompt delivery attempts (submitted/attempted, host consumption never claimed), enforcement chains on gate block/auto-correct (runtime_loaded delivery, runtime_verified application with explicit proof boundary, episode, effect), agent_claimed self-report mirroring; gated by the existing principle_receipt_ledger flag.
  - codex-adapter: evidence adapter on the shared ingress — UserPromptSubmit delivery attempts after the durable event-log line, deny chains recorded only after successful stdout encoding; honest capability matrix (self_report Unsupported, enforcement Unknown per PRI-780).
  - create-principles-disciple (ships pd-console): four read-only evidence-audit queries under /api/v1/receipts/evidence-audit plus the authenticated Owner outcome input POST /api/v1/evidence/outcomes (closed body contract, server-derived actor), and an evidence-audit section on the principle detail page.
  
  No effectiveness scoring, ranking, or automatic governance action anywhere (Phase 1 records facts only).
- 0b981bb: 提示词容量与生效反馈修复（PD_PROMPT_CAPACITY_V1，阶段 A/B1/B2/C）：
  
  - core：`listEntryLine` 列表行格式单一权威；prompt 版本替换——dispatcher `supersedeActivationId` 通道 + state store 单事务 `replacePromptActivation`（新激活+不可变 supersede 决策+旧版停用，故障回滚不留双活）；`detectPromptReplacementTarget` / `buildOwnerRevisionArtifact`（复用真实 Scribe 内容合同）；Scribe prompt v5 正文最短充分要求。
  - host-runtime：宿主事实绑定的有效注入路由解析（声明∪pain_events，Codex 恒共享、OpenClaw 按 flag、未知不猜测）；投影合同扩展（unit/计费范围/超长透传/诊断截断标记）；单一 `checkPromptArtifactDeliverability` 写入前预检；激活级注入状态读取；注入事件诚实读模型（无日志=unknown 非零）。
  - pd-cli：`pd activation approve --target-host` + prompt 写入前容量门（拒绝零写入、单一 JSON、结构化 nextAction）。
  - console（随 create-principles-disciple 发布）：审批预检门与 422 拒绝、未确认宿主横幅与请求级目标宿主、激活页注入状态与「修改为可注入版本」入口、替换事务 UX。

## 1.144.20

### Patch Changes

- 64c3111: PRI-947: the Owner approval second step now appears where the Owner is looking. Clicking 批准 on a principle detail page expanded the confirmation panel as the last node of the whole page, below the fold and with no scroll/focus/toast, so the click looked dead; the panel now renders inside the decision region that owns the action buttons, and a Playwright regression test asserts the panel lands in that region and that the first click performs no write. Ships the pd-console fix inside the installer package (pd-console is private).

## 1.144.19

### Patch Changes

- ac46818: PRI-945 — uninstall deletion gates now detect the filesystem entry itself
  (lstat), not its resolved target (existsSync). A dangling symlink/junction
  under `~/.pd` (releases/, staging/, backups/, a dangling active.json) or the
  shared runtime dir, or the plugin extension junction, was previously silently
  skipped — existsSync follows the link to a missing target and returns false —
  so uninstall reported success while stranding the broken link on disk. Each
  removal gate now reclaims the leftover entry, and the remover (fs.rm with
  recursive+force) unlinks it without ever following or deleting the target. The
  CLI `--check` status still reports a dangling link as "missing" (preserved on
  purpose), so only the actual teardown reclaims it.

## 1.144.18

### Patch Changes

- ce5cfc7: PRI-944 — an update or install no longer aborts because `openclaw gateway stop`
  was slow. The gateway stop was decided by the exit code of a 15s `cmd.exe /c`
  wrapper: when the wrapper timed out while the service manager was still closing
  the gateway, the installer concluded "refused to stop" and refused the whole
  run before touching anything — on the reported host that voided a signed-channel
  update at the `verified` stage. `stopOpenClawGateway` now decides by the EFFECT:
  after a failed stop it waits (bounded, 30s, 1s polls) until the observed gateway
  port has no listener and the observed PID has exited, and only then lets the run
  proceed. A refusal is classified so the operator instruction matches reality:
  `gateway_still_running` (verified still listening — stop it by hand),
  `stop_confirmation_timeout` (port cleared, process lingering — wait and retry),
  `verification_unavailable` (nothing observable — refused, never assumed). The
  start leg is deliberately unchanged: its failure is a notification, and a cold
  start measures in minutes.

## 1.144.17

### Patch Changes

- a5d069b: Uninstall no longer tells the user to "manually delete" the personal data it
  just promised to preserve. The post-uninstall hint (.principles/.state, MD
  files) previously read like a cleanup instruction for the same retained
  governance directories, risking accidental deletion of data meant to survive a
  reinstall. The hint now states the files are intentionally preserved and need
  no manual action (PRI-893).
- 3a26f30: PRI-894 + PRI-895 — uninstall reclaims ~/.pd update residue on full shared-runtime teardown. When the last host is uninstalled, `uninstall` now removes staging/, releases/ and backups/ (a GB-scale disk leak) and a dangling active.json that still pointed at a deleted release, after the runtime directory itself is gone and before install.json is removed. Deletion is provably bounded to those three update directories plus the pointer (never a glob of ~/.pd/), so transactions/, logs/, trust/, channels/ and bootstrap/ are left untouched. A corrupt active.json is preserved with an observable note; a partial (single-host) uninstall preserves all residue; and install.json is kept when reclaim fails so a re-run retries instead of stranding the residue.

## 1.144.16

### Patch Changes

- 34ba089: Console approval cards no longer render the internal `unlinked:<artifactId>`
  machine id as the card title on the second path that still produced it
  (PRI-941). PRI-940 closed the case where the pinned draft artifact has left the
  artifact store; an artifact row that still exists can degrade the same way — its
  content yields no extractable description and its lineage resolves to nothing,
  so the grouping key becomes `unlinked:<artifactId>` while `artifactUnavailable`
  stays unset, and that machine id was used as the Owner-visible title. The UI
  title rule now refuses any title shaped like the synthesized grouping key, and a
  card whose title actually degraded states both reasons ("lineage cannot be
  resolved to a principle, and no readable title could be extracted from its
  stored content") instead of going blank without explanation — a candidate that
  does have a readable title gets no warning. `artifactUnavailable` keeps its
  original meaning: the PRI-940 wire contract still asserts that an existing
  artifact carries no such flag. Approve/edit/reject behavior, the `unlinked:`
  grouping key and the ledger itself are unchanged.
- c66c956: Two "view the full evidence chain" links in the console now open a page instead
  of a blank screen (PRI-942). Both pointed at `/evidence`, a route that has never
  been registered: the console's inner route table has no wildcard fallback, so the
  sidebar stayed put while `<main>` rendered nothing — the link looked like a
  failure of the evidence chain rather than a dead address. They now point at
  `/pain`, the only page in the product that actually fetches and renders the
  evidence chain, and it needs no id, so it cannot 404 and never puts a machine
  identifier in the URL. A new static guard in the navigation test walks every
  in-app link the console UI writes with a visible path: literal `to` targets in
  all their quote forms, plus the static part of a target that only becomes dynamic
  after an interpolation marker. Each must resolve against the route table App.tsx
  already publishes, so the next dead link fails CI instead of showing up as an
  empty panel. Landing is not anchored to the individual candidate yet (it opens
  the top of the chain list); per-candidate anchoring is tracked separately.

## 1.144.15

### Patch Changes

- 7d1daef: PRI-926: update history reconciliation now tells the truth. The ReleaseManager journals `preUpdateProductVersion` on the planned transition (from the active record), reconciliation derives `fromVersion` from it (absence stays `unknown`), only journals in the ReleaseManager update domain synthesize Owner-facing rows (wrongly-projected install-domain rows are dropped), timestamps come from the journal's first line instead of the scan moment, and synthesized ids are deterministic (`reconciled-<transactionId>`) so cap-evicted rows cannot resurrect as duplicates. Ships the pd-console reconciliation fix inside the installer package (pd-console is private).

## 1.144.14

### Patch Changes

- 71c8c93: Console approval cards no longer render the internal `unlinked:<artifactId>`
  machine id as the card title when the pinned draft artifact has left the
  artifact store (PRI-940). Real case: a pending approval pinned to a scribe
  revision that a later run superseded showed `unlinked:pi-art-scribe-…` as the
  card title, and the Owner could not tell what the card was about. The grouped
  model now reports `artifactUnavailable` for such cards; the UI replaces the
  machine id with the localized untitled copy and shows a visible note
  explaining that the draft original is gone (likely superseded), that
  rejecting is a safe choice, and where the raw artifact ID remains reachable
  (the edit section's current-artifact field). Approve/edit/reject behavior
  and the `unlinked:` grouping key are unchanged.

## 1.144.13

### Patch Changes

- 5c763b2: chore(deps): bump fs-extra 11.4.0 -> 11.4.1（installer 运行时依赖，随 create-principles-disciple tarball 一起分发，故声明 cpd patch）。
- df9e555: PRI-917 v0.3.3 (OD-PRI917-05): Reuse Review Gate — automatic candidate intake now consults the semantic reuse evaluation capability before creating a Principle.
  
  A `reuse` recommendation parks the candidate (`refused/reuse_pending_owner`): no Principle is written, no evidence is appended, the candidate stays pending for the Owner, and the bridge emits an observable `reuse_gate_triggered` event plus a `reuse_review_required` outcome pointing at `pd candidate review --decide reuse|create`. `create`/`uncertain` recommendations and every evaluation failure degrade to normal creation (learning never blocks). `reuseEvaluation.enabled=false` restores the exact pre-v0.3.3 behavior.
  
  Also fixes the R5 "two-heads-block" defect: `pd candidate review --decide reuse` no longer lets the PRI-442 admission pre-check reject low-confidence candidates — a reuse verdict creates nothing, so the ledger-quality gate does not apply (the `--decide create` pre-check is unchanged).
  
  PR review fixes (4×P2, PRI-938): the bridge cache key now folds in the reuse-gate switch so a long-lived host picks up `reuseEvaluation.enabled` toggles in both directions (T11 rollback without a restart); mixed batches and replays keep parked candidates visible (`reuse_review_required` degraded outcome, Codex worker `reuseReviewRequiredCandidateIds`, OpenClaw `PAIN_SERVICE_REUSE_REVIEW_REQUIRED` log gated on the park disposition); `pd diagnose` / `pd pain-retry` render parked candidates with review guidance and exclude them from `internalize` next-action lists.
  
  Follow-up review fixes: evaluation profile and timeout changes invalidate the cached reuse hook. Replay verifies the original diagnosis admission and performs a read-only reuse check before reporting a parked candidate, preserving failed-intake and gate-disabled behavior without additional persisted state.
  
  Owner-approved configuration hardening: constructing CandidateIntakeService with both reuseRecommendation and reuseDecision now fails explicitly before either callback or any candidate mutation, instead of silently prioritizing the decision channel.

## 1.144.12

### Patch Changes

- 349b747: chore(deps): bump @fontsource/jetbrains-mono 5.2.8 -> 5.3.0 (pd-console，随 installer 分发)。
- 9fc1a31: chore(deps-dev): bump @types/node 26.6.1 -> 26.6.2 in create-principles-disciple.
- a438282: chore(deps): bump @principles/install-layout 0.2.4 -> 0.2.7 in create-principles-disciple（同步 cpd package-lock）。
- 47fad14: chore(deps-dev): bump vitest 5.0.1 -> 5.0.2 in create-principles-disciple.

## 1.144.11

### Patch Changes

- 25e8562: The Console's update page no longer reports "Request timeout" on a slow
  metadata host. `GET /api/update/check` refreshes the signed channel over the
  network — TUF metadata, the channel document and the release metadata, several
  sequential requests to the release metadata host — and it was running under the
  generic 10-second request budget. Measured against GitHub Pages from a CN
  network, the same request completes in ~1.2s most of the time and in ~12.5s
  about one run in five, so the page failed intermittently while the installation
  itself was healthy and already up to date.
  
  The check route now has its own 30-second budget, overridable with
  `PD_UPDATE_CHECK_TIMEOUT_MS` (milliseconds) exactly like the existing
  `PD_UPDATE_APPLY_FULL_TIMEOUT_MS` knob for slow disks and networks. A refused
  value falls back to the default with one observable log line. The check stays
  read-only: a timeout never leaves a partial update behind.
- 7421049: The console's prompt-injection budget forecast now mirrors the production
  selection policy instead of silently defaulting to the legacy FIFO prefix
  (PRI-935). The forecast previously called the budget selector without its
  round key, which did not make it conservative — it selected a different
  policy, one that structurally excludes the newest activation from every
  truncated selection. The console therefore told the Owner an approved
  principle "will NOT enter agent behavior until older ones are deactivated"
  while the live injection path rotates and injects it within a bounded number
  of user turns, pushing Owners to deactivate healthy principles.
  
  buildLivePromptInjectionProjection now accepts the caller's round key and
  reports the policy it actually ran, the eligible count, whether production
  rotates on this route, and the set of activations reachable under some round.
  Reachability is a property of the policy rather than of a single round, so a
  console with no session round key can still distinguish an activation that is
  merely rotated out of the current window from one that is genuinely starved.
  Approve now emits injection_budget_queued for the queued case — with a bounded
  "within at most N consecutive user turns" statement and an explicit note that
  deactivating older principles is not required — and reserves
  injection_budget_excluded for real starvation, no longer asserting a FIFO
  ordering the production route does not use. The pre-decision queue badge and
  both locales follow the same policy, and the raw English server text is
  collapsed behind a native details element so the toast no longer renders as one
  mixed Chinese/English block (still preserved verbatim).
  
  The shared host route deliberately passes no round key and continues to report
  legacy_fifo_prefix_v1, so cross-host fairness remains PRI-930 and is not
  claimed here. All new projection fields are optional; payloads without them
  validate as before and render policy-agnostic copy.

## 1.144.10

### Patch Changes

- 276efe4: A workspace pointer that does not name one fixed directory is no longer
  resolved. A value that lost its separators in transit —
  `"D:.openclawworkspace"` for `D:\.openclaw\workspace` — used to be handed to
  `path.resolve()`, which turned it into a plausible absolute path that depends
  on the process working directory; a root-relative value such as `\workspace`
  was anchored to whichever drive the caller was on. The same config could then
  send governance state (`.pd/state.db`, `.state/trajectory.db`) to a different
  directory depending on which process read it, with no warning.
  
  The plugin now skips such a candidate, continues with the next declared source
  (env > config > default is unchanged), and logs the refusal together with the
  source it fell back to. The installer refuses such a workspace before any side
  effect, rather than only when writing the config pointer. Values that carry
  their own drive, or a UNC share, are unaffected (PRI-931).

## 1.144.9

### Patch Changes

- 50ed22e: Prompt principle injection now rotates deterministically under the fixed
  2000-char budget instead of always packing the oldest prefix, so a live,
  eligible, individually-fitting principle can no longer be permanently starved
  by its position (PRI-904). The rotation round is the session-local user-turn
  ordinal already persisted in the trajectory database — an existing fact, read
  through the registered trajectory-store seam — so consecutive rounds advance
  by exactly one and N rounds cover all N eligible positions: a bounded
  opportunity window with no new persisted scheduling state, no randomness and
  no clock. Non-fitting entries no longer terminate the scan; oversized entries
  are reported separately; the injection event carries selectionPolicy,
  eligibleCount, rotationStartIndex, the round ordinal that produced the
  selection, and schema-bounded dropped/oversized activation id lists (max 16)
  so truncation is explainable and traceable. The legacy FIFO prefix behavior
  remains the rollback baseline whenever no round ordinal is available.

## 1.144.8

### Patch Changes

- e1fda67: The update chain now refuses a non-HTTPS release-asset URL outright, re-checks
  HTTPS on every redirect hop it follows (a carrier can no longer downgrade the
  delivery to plaintext with a 302), and publishes verified asset bytes to their
  canonical staging name only through a private, exclusively-created candidate
  plus an atomic rename, so a plaintext carrier can no longer poison every
  delivery and an unverified file can never be reachable under the name the
  installer deploys from (PRI-927).

## 1.144.7

### Patch Changes

- 1f4faf2: Update apply now survives a transient release-asset download failure (bounded
  retry with backoff) and recycles the transaction's staging directory when the
  journal reaches a terminal state, so failed and successful updates no longer
  leave ~1.3GB per attempt on the customer's disk (PRI-924).

## 1.144.6

### Patch Changes

- 12a5139: PRI-922: retire the previous.json ghost slot. The update-chain layout no longer
  declares a second pointer, recoverUnfinishedTransaction takes only the journal
  plus the active record, and the console recovery endpoint (bundled via this
  package) never reads previous.json. Production install/upgrade/rollback/repair
  behavior is unchanged for normal installation layouts, where the file has had
  no writer since 2026-08-26 and therefore never exists; on a machine with a
  leftover or hand-crafted previous.json, recovery decisions now deliberately
  ignore it (a fabricated record could previously sway them — closed by
  regression tests proving previous.json is not a recovery input).

## 1.144.5

### Patch Changes

- 4726620: feat(installer): PRI-912 canonical junction reconciliation for plugin @principles/core copies
  
  After all components deploy and before the journal 'staged' transition, the
  installer replaces a materialized <plugin>/node_modules/@principles/core
  copy with a junction (Windows) / relative symlink (Unix) to the runtime root
  core — only when the package identity, the plugin manifest's declared file:
  dependency resolving to the canonical core, and the full content digest all
  match. Gate failures skip with a structured reason; a failed conversion
  restores the copy; idempotent across repairs.

## 1.144.4

### Patch Changes

- 176a9a2: build: prune unused better-sqlite3 platform binaries from release assets
  
  Self-contained release assets now keep only the better-sqlite3 prebuild for
  the asset's own platform+arch (linux: musl detected from the build machine,
  which is also the target since cross-builds are refused). Foreign-platform
  `.node` files are removed from every materialized copy after staging and
  before `_release/manifest.json` is generated, so the signed manifest always
  describes the pruned tree. Measured saving on a real win32-x64 build:
  104,349,056 B (99.5 MiB) across 7 copies per platform asset; installer
  dependency resolution, package topology and runtime behavior are unchanged.

## 1.144.3

### Patch Changes

- 4ced615: OPT-002 (runtime-v2 barrel narrowing): the plugin's satellite bundles no longer pull the LLM SDK graph. Six shared plugin modules switched their VALUE imports from the `@principles/core/runtime-v2` barrel to the eight narrow leaf subpaths (type-only barrel imports unchanged; exported names unchanged), and `@principles/core` exports gained those additive subpaths (`./runtime-v2/store/workspace-leak-guard`, `./runtime-v2/feedback/redact-sensitive`, `./runtime-v2/types/event-types`, `./runtime-v2/trajectory-schema`, `./runtime-v2/internalization/{rule-host-input-builder,rule-context-v2,behavior-example-pack,tool-semantic-registry}`). governance-audit.js drops 2,783,013 → 70,786 bytes (−97.5%) and rulehost-evidence.js 2,826,401 → 60,244 bytes (−97.9%); bundle.js is byte-identical (4,151,557) — the main package keeps its LLM runtime through its own direct barrel import. `runtime-v2/index.ts` and all existing exports are untouched. A build-level satellite purity guard (`scripts/build/check-satellite-purity.mjs`, wired into `esbuild.config.js`) now fails any plugin bundle build that reintroduces pi-ai / pi-agent-core / anthropic / openai / genai / undici inputs into the satellite outputs, so the invariant no longer rests on discipline alone.

## 1.144.2

### Patch Changes

- fc1c9de: OPT-001 (artifact-size audit P1): releases now ship the production console web bundle. The pd-console `build` script (used by every official path — installer bundling, release-metadata, publish action, reproducibility, CI smokes) runs the UI step as `build:ui:production` (esbuild minify, no inline sourcemap): app.js drops from 8.6 MiB to 1.1 MiB, shrinking the installer payload by ~7.6 MiB. The bundler script additionally fails loud if a dev-mode app.js (sourceMappingURL marker) ever reaches the payload again. Local dev and console e2e keep using `build:ui` (dev) unchanged.
- c7453ea: PR #1844 follow-up: the Governance Focus prompt-injection forecast and the PRI-890 approve-time budget check now read `buildLivePromptInjectionProjection` (host-runtime), which follows the SAME injection route the agent uses — with `abstraction_layer_v1` off (the live default) the forecast replays the plugin's PromptActivationReader → trimToBudget chain instead of always rendering with the shared-path directive wrapper. Previously a saturated 2000-char budget was over-forecast (~3/11 principles "injected" vs the real 9/11), so the Focus page badge and approve warnings overstated budget pressure. Principle selection, FIFO ordering, injection behavior and the budget algorithm are unchanged; parity and boundary regression tests pin the projection to the live path.
- 38b86f6: PRI-889: Governance Focus now renders the existing PendingReviewCard (Wave 7 component with approve/reject/revise actions) for pending approval groups, giving Owners their first clickable activation-approval path in the browser. When grouped approvals data is available, activation_approval entries skip the legacy OwnerDecisionCard (its only affordance was a dead CTA); when unavailable, all entries keep rendering so decisions never silently disappear. The card honors the PRI-787 governance-readiness lock with a visible reason.
- 5fc33bd: PRI-890: approve now recomputes the production prompt injection projection (same FIFO + 2000-char budget logic the prompt hook uses) and surfaces a non-fatal warning when the freshly approved prompt-channel activation lands outside the budget — previously the approval silently never reached agent behavior when the budget was saturated (PRI-768 v6-02). Non-budget exclusions (artifact resolution failures) are reported with their own reason code, and the Governance Focus approve flow shows the warning toast so the Owner sees it at decision time.
- 84c7074: PRI-892: fixed the silent no-op of `npx create-principles-disciple` on Windows. Node resolves the main module through symlinks/junctions while `process.argv[1]` keeps the unresolved link path handed over by npm/npx `.bin` shims, so the raw `pathToFileURL(argv[1]) === import.meta.url` entry guard never matched and the CLI exited 0 with zero output (install / repair-update-chain / uninstall all dead). The guard now canonicalizes argv[1] with `realpathSync` before comparing (fail-safe: an unreadable entry is simply not the main module), keeps the cli-7 import-safety semantics (importing the module still never parses argv), and adds an rc-9 observable fallback: when the entry path unambiguously names this package's `dist/index.js` but canonicalization still misses, the CLI warns on stderr instead of saying nothing. The identical guard in the Codex `pd-hook` entry is fixed the same way (linked installs previously skipped `main()` silently). Regression tests spawn the built CLI and hook through a junction path and assert real output (red before the fix: empty stdout, exit 0).
- edaae75: Fix PRI-898: the global `pd` command is no longer gated on the npm-distributed payload mode, and the Windows shim set now reaches every shell.
  
  - Decoupling: self-contained release-asset installs (the recommended channel) now write the global `pd` shim into the PATH-managed npm global bin dir, so the host agent finds `pd` without manual PATH edits.
  - Windows coverage: in addition to `pd.cmd` (cmd) and `pd.ps1` (PowerShell), the installer writes an extensionless `pd` sh shim — Git Bash/MSYS does not apply PATHEXT, so a bare `pd` only resolves to that exact-named file. Without it a Git Bash host got command-not-found even with the `.cmd` on PATH.
  - Shim path quoting: the sh forwarding shim embeds its target path in POSIX single quotes, so an install directory containing spaces, `$`, backticks or an apostrophe resolves literally instead of being expanded or breaking out of the quote (the previous double-quote form only escaped `"`).
  
  Foreign-`pd` protection, rollback bookkeeping, the uninstaller scan (now also cleaning the extensionless `pd` on Windows), and the `PD_SKIP_GLOBAL_SHIM` smoke gate are unchanged; the pd-cli upgrade / dependency-resolution payload-mode gates stay where they belong.
- edbbcd9: RAH-3 (PRI-907): complete the release-artifact content boundary. @principles/install-layout and principles-disciple (openclaw-plugin) production builds now exclude compiled tests (tsconfig.build.json; plugin build:types declaration emit filtered too) with the same fail-loud dist hygiene assertion as RAH-1. The installer bundle script (create-principles-disciple) filters compiled test artifacts out of every payload copy AND asserts zero test artifacts across all payload components after materialization — test code can no longer reach user machines even if a future package forgets its build-boundary guard. A repo-level scan (check:workspace-artifacts, wired into verify:merge) backstops all workspace dist trees.
- 8b7b775: Security audit run-1 remediation (findings verified against eabbde6d, applied on ccc69252):
  
  - **RuleCode enforcement is now content-bound** (audit HIGH `rulecode-approval-content-unbound`): the production gate and the OpenClaw plugin RuleHost re-verify the current `pi_artifacts` row against the `activation_decisions.artifact_digest` recorded at Owner promotion time before compiling it. A workspace-local rewrite of `content_json` (or lineage fields) is now skipped with a structured `artifact_content_tampered` warning instead of silently executing unapproved code. Rows without a recorded decision (legacy activations) keep their prior behavior. Adds `mapPiArtifactRow`/`PiArtifactRow` exports (the single `pi_artifacts` row→snapshot mapping) so enforcement reproduces the promotion-time digest byte-for-byte.
  - **Replay evaluate is hard-bounded** (audit MEDIUM `rulecode.replay.in-process-evaluate-no-hard-timeout`): pre-activation replay runs each evaluate call through a precompiled vm script with a 2000ms hard timeout — a looping LLM-authored candidate now fails its replay case instead of hanging the console server, evaluator worker, or CLI process.
  - **Governance-store unavailability leaves a durable trace** (audit MEDIUM `gate-failopen-allow-on-state-corruption`): when `state.db` is missing or unreadable, the gate/plugin record a best-effort marker under `~/.pd/enforcement-health/` (outside the agent-writable workspace), and the console governance read model distinguishes "state.db deleted after initialization — enforcement degraded (fail-open)" from a never-initialized workspace.
  - **Console refuses unauthenticated non-loopback binds** (audit MEDIUM `pd-console-noauth-nonloopback-bind`): the loopback-only invariant now keys on the effective authentication state (token-less default included), not just the explicit `--no-auth` flag.
  - **Plugin honors an explicit conversation-access opt-out** (audit LOW `openclaw-plugin:conversation-access-autofix-overrides-explicit-owner-opt-out`): the auto-fix repairs only an absent `allowConversationAccess` flag; an explicit `false` (the documented turn-off) is preserved and surfaced as an honored Owner opt-out instead of being silently rewritten on every gateway start.
- Updated dependencies [edbbcd9]
  - @principles/install-layout@0.2.7

## 1.144.1

### Patch Changes

- 0d39045: chore(deps-dev): bump @types/node 26.5.1 -> 26.6.1 in create-principles-disciple.
- 6b05c87: chore(deps): bump @radix-ui/react-slot 1.3.0 -> 1.3.3 (pd-console, ships inside installer).
- 78a3564: chore(deps): bump js-yaml 5.4.1 -> 5.4.2 in create-principles-disciple (runtime dependency).
- 3587170: chore(deps): bump @radix-ui/react-dialog 1.1.15 -> 1.1.23 (pd-console, ships inside installer).
- 7f5558b: chore(deps-dev): bump vitest 5.0.0 -> 5.0.1 in create-principles-disciple.
- 76ed7d0: chore(deps): bump react/react-dom/@types to 19.3.0 (pd-console, ships inside installer). 单独 bump react-dom 会使 react<->react-dom 版本错配导致 Console 白屏（e2e useMemo of null），故本 PR 配对升级 react 与 @types/react.

## 1.144.0

### Minor Changes

- 8424d60: Baseline-cutover accounting for the unpublished source delta between the registry baseline (1.143.3, published from fb397452) and current main: the update-chain rework landed by PR #1768 (bootstrap executor, transaction journal, release-manager authority, dual-ABI payload application, embedded product identity stamp, public exports) plus the pd-console payload changes it ships (owner-decision UI and console surface updates). The version alignment to 1.143.3 is a starting point, not a claim this content shipped.

### Patch Changes

- 40de641: Owner-facing console fixes carried by PR #1789 (focus CTA deep-links), which merged after the Changesets cutover and was not yet in release accounting. The pd-console payload bundled by the installer now: deep-links owner-decision and grouped-approval CTAs to the specific Principle record instead of the generic review list (activation_approval inbox items carry a resolved `principleId`; on resolution failure they fall back to the prior un-deep-linked behavior, rc-9); re-applies the ledger-validation contract that was silently dropped when the shared artifact→principleId resolver was extracted (ERR-142); and escapes externally-supplied values interpolated into CSS deep-link selectors to close a selector-injection path (ERR-143). Installer bundle content is new, so the installer needs a release.

## 1.10.0

### Minor Changes

- 650ae5a: ## v1.9.1: WebUI Data Source Fixes

  ### Phase 16-20 Complete

  - **Phase 16**: Data Source Tracing - mapped all 4 WebUI pages to API endpoints
  - **Phase 17**: Overview Page Fix - fixed `/api/central/overview`, `/api/overview`, `/api/overview/health`
  - **Phase 18**: Loop/Samples + Feedback Fix - fixed `/api/samples`, `/api/feedback/*` data sources
  - **Phase 19**: Gate Monitor Frontend - fixed `/api/gate/stats`, `/api/gate/blocks` types
  - **Phase 20**: E2E Validation - 19 regression tests added for all API endpoints

  ### Bug Fixes

  - Fixed `evolution-worker.ts` missing `runtimeAdapter` parameter
  - Fixed `nocturnal-train.ts` mode field type annotation
  - Fixed `sync-version.sh` to include `create-principles-disciple` package

  ### Infrastructure

  - Added `@changesets/cli` for monorepo version management
  - Added `data-endpoints-regression.test.ts` with 19 tests
