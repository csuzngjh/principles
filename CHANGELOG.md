# [1.75.1](https://github.com/csuzngjh/principles/compare/v1.74.1...main) (2026-07-03)

### Bug Fixes

* **runtime:** guard mock-leak workspace paths from polluting filesystem root ([#1175](https://github.com/csuzngjh/principles/pull/1175))
* **pri-442:** close 3 internal-acceptance bugs — FINDING-002/003/004 ([#1174](https://github.com/csuzngjh/principles/pull/1174))
* **onboarding:** comprehensive first-run experience review — 30 fixes across P0-P3 ([#1166](https://github.com/csuzngjh/principles/pull/1166))
* **pri-503:** close admission gate bypass in pain-retry and diagnose ([#1168](https://github.com/csuzngjh/principles/pull/1168))
* **pri-504:** key SystemLogger cache by workspaceDir to prevent cross-workspace leakage ([#1171](https://github.com/csuzngjh/principles/pull/1171))
* **pri-505:** require dist/bundle.js in PLUGIN_REQUIRED to catch tsc-only builds ([#1172](https://github.com/csuzngjh/principles/pull/1172))
* **pri-496-500:** RuleHost seed-MVP audit findings ([#1160](https://github.com/csuzngjh/principles/pull/1160))
* **signal-collector:** preserve empathy GFI accumulation when LLM unavailable ([#1140](https://github.com/csuzngjh/principles/pull/1140))
* **acceptance:** resolve all P0/P1/P2 bugs from PRI-442 round 2 acceptance ([#1134](https://github.com/csuzngjh/principles/pull/1134))
* **rulehost:** PRI-489 shadow-first activation + CLI approve flag wiring ([#1130](https://github.com/csuzngjh/principles/pull/1130))
* **cascade:** 4-bug batch (Bug-O/Q/M/P) — restore principle cascade, re-dispatch, retry history, exports ([#1124](https://github.com/csuzngjh/principles/pull/1124))
* **f13:** rc-2 compliance cleanup — candidate-intake + evolution-queue + minor items ([#1152](https://github.com/csuzngjh/principles/pull/1152))
* **website:** pull Git LFS assets in Cloudflare Pages deploy CI ([#1158](https://github.com/csuzngjh/principles/pull/1158))
* **core:** RuleHostWriter rejects illegal expectedDecision before sandbox with clear reason ([#1079](https://github.com/csuzngjh/principles/pull/1079))
* **pd-console:** observability for silent catches + Playwright E2E smoke tests ([#1068](https://github.com/csuzngjh/principles/pull/1068))
* **schema:** align PD DB schema inconsistencies (PRI-473) ([#1066](https://github.com/csuzngjh/principles/pull/1066))
* **pri-453:** remove gate-block-helper legacy recordPainEvent to eliminate double-write ([#1038](https://github.com/csuzngjh/principles/pull/1038))
* **pri-452:** retire legacy .pain_flag readers and compatibility code ([#1035](https://github.com/csuzngjh/principles/pull/1035))
* **hooks:** add hook timeouts, async fallback, remove dead jsonl writer ([#1025](https://github.com/csuzngjh/principles/pull/1025))
* **installer:** remove shell redirect that creates real files on Windows Git Bash ([#1031](https://github.com/csuzngjh/principles/pull/1031))
* **installer:** permanent fix for @principles/core injection — order + safe overwrite ([#1030](https://github.com/csuzngjh/principles/pull/1030))
* **runtime:** use per-runner schema in tool_call path instead of hardcoded diagnostician (PRI-284) ([#1003](https://github.com/csuzngjh/principles/pull/1003))
* **runtime:** preserve diagnostician lineage into dreamer seeds (PRI-395) ([#928](https://github.com/csuzngjh/principles/pull/928))
* **runtime:** make integrity repair schema-valid (PRI-396) ([#927](https://github.com/csuzngjh/principles/pull/927))
* **runtime:** unify config resolver for mainline execution (PRI-393) ([#925](https://github.com/csuzngjh/principles/pull/925))
* **runtime:** tolerate malformed historical runs during runner recovery ([#923](https://github.com/csuzngjh/principles/pull/923))
* **runtime:** recover failed internalization tasks and normalize config runtime (PRI-392) ([#922](https://github.com/csuzngjh/principles/pull/922))
* **console:** dedupe trajectory pain rows with Runtime V2 canonical pain records ([#921](https://github.com/csuzngjh/principles/pull/921))
* **internalization:** recover stale leased tasks from auto-consumer failures ([#920](https://github.com/csuzngjh/principles/pull/920))
* **console:** make principle detail approval actions honest ([#919](https://github.com/csuzngjh/principles/pull/919))
* **internalization:** persist failures with reason in auto-consumer and base-peer-runner ([#917](https://github.com/csuzngjh/principles/pull/917))
* **console:** aggregate unmatched pain warnings at response level (PRI-382) ([#916](https://github.com/csuzngjh/principles/pull/916))
* **console:** normalize sub-run task IDs in evidence chain (PRI-383) ([#915](https://github.com/csuzngjh/principles/pull/915))
* **internalization:** prevent ready dreamer tasks from staying pending forever (PRI-381) ([#914](https://github.com/csuzngjh/principles/pull/914))
* **PRI-375:** disable async CLI by default to prevent stuck pending tasks ([#908](https://github.com/csuzngjh/principles/pull/908))
* **core:** PRI-345 short-circuit must check idempotency first ([#881](https://github.com/csuzngjh/principles/pull/881))
* **core:** artifact missing graceful skip + candidateId recursive concatenation prevention (PRI-355) ([#878](https://github.com/csuzngjh/principles/pull/878))
* **evidence:** PRI-340/341/342/343/344 — evidence chain readability + pain record fix + diagnostician guard ([#868](https://github.com/csuzngjh/principles/pull/868))
* **cli:** guard UAT commands from production workspace writes (PRI-334) ([#851](https://github.com/csuzngjh/principles/pull/851))
* **cli:** add pain retry command and clear stale diagnosis errors ([#843](https://github.com/csuzngjh/principles/pull/843))
* **openclaw-plugin:** report retried pain diagnosis accurately ([#842](https://github.com/csuzngjh/principles/pull/842))
* **runtime:** harden diagnostician structured output across runtimes ([#839](https://github.com/csuzngjh/principles/pull/839))
* **console:** approval atomicity — rollback on activation failure (PRI-322) ([#832](https://github.com/csuzngjh/principles/pull/832))

### Features

* **security:** establish PD security baseline — SEC-BASE-1~5 ([#1170](https://github.com/csuzngjh/principles/pull/1170))
* **website:** redesign homepage with video hero, breathing motto, lighter density ([#1159](https://github.com/csuzngjh/principles/pull/1159))
* **pd-console:** pi-ai default runtime + Profile CRUD + i18n fixes (PRI-501, PRI-502) ([#1162](https://github.com/csuzngjh/principles/pull/1162))
* **onboarding:** PD new user onboarding — website+installer+console /welcome ([#1146](https://github.com/csuzngjh/principles/pull/1146))
* **core:** add contextInjection config with validation and effective config ([#1151](https://github.com/csuzngjh/principles/pull/1151))
* **pd-console:** signal keywords management page with AgentCard navigation ([#1143](https://github.com/csuzngjh/principles/pull/1143))
* **rulehost:** PRI-491 owner observability for activation state, evidence, and skip reasons ([#1137](https://github.com/csuzngjh/principles/pull/1137))
* **signal:** SignalCollector unified signal collection layer — correction + empathy upstream merge ([#1132](https://github.com/csuzngjh/principles/pull/1132))
* **rulehost:** PRI-490 constrain v2 seed rules to allow/block + preserve evidenceRefs ([#1135](https://github.com/csuzngjh/principles/pull/1135))
* **bdd:** introduce BDD specification layer for MVP-Core journeys ([#1131](https://github.com/csuzngjh/principles/pull/1131))
* **artificer:** behavior example pack assembly + RuleHost evidence boundary ([#1122](https://github.com/csuzngjh/principles/pull/1122))
* **rulehost:** PR1 — singleton reuse, path convergence, shadow/live dual mode, promote ([#1121](https://github.com/csuzngjh/principles/pull/1121))
* **intent:** 5-step wizard editor + section-level version diff ([#1104](https://github.com/csuzngjh/principles/pull/1104))
* **intent:** bilingual INTENT.md (zh-CN/en) + version history ([#1100](https://github.com/csuzngjh/principles/pull/1100))
* **runtime-v2:** PRI-485 RuleContext v2 Phase 6 — Evaluator v2 adversarial cases ([#1102](https://github.com/csuzngjh/principles/pull/1102))
* **runtime-v2:** PRI-484 RuleContext v2 Phase 5 — Artificer + BehaviorExamplePack ([#1101](https://github.com/csuzngjh/principles/pull/1101))
* **plugin:** PRI-483 RuleContext v2 Phase 4 — production gate integration ([#1098](https://github.com/csuzngjh/principles/pull/1098))
* **plugin:** PRI-482 RuleContext v2 Phase 3 production data source ([#1096](https://github.com/csuzngjh/principles/pull/1096))
* **runtime-v2:** PRI-481 RuleContext v2 Phase 2 Golden Trace ABI ([#1093](https://github.com/csuzngjh/principles/pull/1093))
* **runtime-v2:** PRI-480 RuleContext v2 Phase 1 core ABI (pure logic) ([#1089](https://github.com/csuzngjh/principles/pull/1089))
* **pd-console:** redesign control center agent switches with dependency grouping and progressive disclosure ([#1086](https://github.com/csuzngjh/principles/pull/1086))
* **pd-console:** intent engineering onboarding — inline editor, create flow (PRI-477) ([#1083](https://github.com/csuzngjh/principles/pull/1083))
* **runtime:** consolidate DB initialization and add "pd runtime init" command ([#1080](https://github.com/csuzngjh/principles/pull/1080))
* **console:** implement Principle Debt management page and backend routes ([#1077](https://github.com/csuzngjh/principles/pull/1077))
* **empathy:** Empathy Channel Pipeline — keyword first, observer on miss, feedback loop ([#1073](https://github.com/csuzngjh/principles/pull/1073))
* **intent-engineering:** PRI-471 governed follow-up actions after Owner decision ([#1072](https://github.com/csuzngjh/principles/pull/1072))
* **PRI-470:** persist Owner decisions as IntentDecisionRecord ([#1067](https://github.com/csuzngjh/principles/pull/1067))
* **PRI-469:** EvidenceChain + Pain Card intentTension surfacing ([#1065](https://github.com/csuzngjh/principles/pull/1065))
* **PRI-468:** Stage A optional intentTension + Stage C additive passthrough ([#1063](https://github.com/csuzngjh/principles/pull/1063))
* **PRI-467:** inject escaped INTENT block in prompt hook behind flag ([#1059](https://github.com/csuzngjh/principles/pull/1059))
* **PRI-466:** Intent Engineering MVP — INTENT.md read path + Intent Page + CLI ([#1056](https://github.com/csuzngjh/principles/pull/1056))
* **pri-461:** add RuleHost readiness resolver with three explicit statuses ([#1047](https://github.com/csuzngjh/principles/pull/1047))
* **PRI-454:** unify admission gates — migrate 5 MVP paths to Gate B ([#1043](https://github.com/csuzngjh/principles/pull/1043))
* **quality:** system hardening — noUncheckedIndexedAccess, PR template, CI infra ([#1026](https://github.com/csuzngjh/principles/pull/1026))
* **core:** three-layer defense system for core I/O boundary (PRI-450) ([#1022](https://github.com/csuzngjh/principles/pull/1022))
* **trajectory:** extract enhanced fields from hook payload (v2 source enhancement) ([#1018](https://github.com/csuzngjh/principles/pull/1018))
* **pd-console:** expose owner edit-then-approve in Web UI (PRI-447) ([#1005](https://github.com/csuzngjh/principles/pull/1005))
* **activation:** wire Story A production closed loop (PRI-408) ([#972](https://github.com/csuzngjh/principles/pull/972))
* **pd-console:** add notification sound and badge reminders ([#971](https://github.com/csuzngjh/principles/pull/971))
* **pd-cli:** wire code_tool_hook channel to production — run-rulehost command (PRI-429) ([#966](https://github.com/csuzngjh/principles/pull/966))
* **pd-console:** skeleton loading + crossfade animations across all pages ([#965](https://github.com/csuzngjh/principles/pull/965))
* **rulehost:** RuleHost MVP Activation — code->test->assemble->retry slice (PRI-421..428) ([#963](https://github.com/csuzngjh/principles/pull/963))
* **pd-console:** console optimization Wave 1-7 — terminology cleanup, inline review, /update path fix ([#960](https://github.com/csuzngjh/principles/pull/960))
* **core:** L2 empty-response auto-retry + L2→L1 fallback (PRI-420) ([#955](https://github.com/csuzngjh/principles/pull/955))
* **dreamer:** L2 agent loop (PRI-419, dreamer-only scope) ([#953](https://github.com/csuzngjh/principles/pull/953))
* **core:** CORE_PRINCIPLES injection + PRI-415 architecture audit cleanup ([#952](https://github.com/csuzngjh/principles/pull/952))
* **cli:** operator CLI consistency + pd mvp smoke (PRI-397) ([#932](https://github.com/csuzngjh/principles/pull/932))
* **runtime:** add shared mainline snapshot assembler (PRI-394) ([#926](https://github.com/csuzngjh/principles/pull/926))
* **core:** add Mainline Contract validator for Runtime Convergence (PRI-A) ([#924](https://github.com/csuzngjh/principles/pull/924))
* **PRI-385:** Pain Evidence Chain contract and golden dogfood fixtures ([#918](https://github.com/csuzngjh/principles/pull/918))
* **eval:** add 3-arm comparison harness, fixtures, and report for PRI-374 ([#905](https://github.com/csuzngjh/principles/pull/905))
* **pd-console:** PRI-380 Console evidence chain ([#913](https://github.com/csuzngjh/principles/pull/913))
* **PRI-361:** Quality scorecard with dual-model gate ([#912](https://github.com/csuzngjh/principles/pull/912))
* **PRI-377+376:** surface stalled diagnostician tasks + product-path regression tests ([#911](https://github.com/csuzngjh/principles/pull/911))
* **PRI-379:** add repository hygiene gate for temp and runtime artifacts ([#909](https://github.com/csuzngjh/principles/pull/909))
* **config:** unify feature flag defaults into single source of truth (PRI-378) ([#910](https://github.com/csuzngjh/principles/pull/910))
* **workspace:** centralize workspace path management in config.yaml ([#864](https://github.com/csuzngjh/principles/pull/864))
* **diagnostician:** 3 split runners + post-diagnosis trigger (PRI-372) ([#903](https://github.com/csuzngjh/principles/pull/903))
* **diagnostician:** core grounding on single agent (PRI-371) ([#902](https://github.com/csuzngjh/principles/pull/902))
* **async-cli:** async pain-record CLI with feature flag gate (PRI-369) ([#897](https://github.com/csuzngjh/principles/pull/897))
* **core:** Core Principle Registry + drift test (PRI-367) ([#896](https://github.com/csuzngjh/principles/pull/896))
* **runtime:** connect pain admission to trigger decisions (PRI-337) ([#852](https://github.com/csuzngjh/principles/pull/852))
* **runtime:** wire principles.outputLanguage into diagnostician prompts (PRI-336) ([#850](https://github.com/csuzngjh/principles/pull/850))
* **pd-console:** PRI-332 output language preference + seed-user clarity ([#848](https://github.com/csuzngjh/principles/pull/848))
* **console:** PRI-330 owner-actionable filter for Principle Review page ([#846](https://github.com/csuzngjh/principles/pull/846))
* **pd-cli:** run-once default successor enqueue + integrity recommendedAction ([#844](https://github.com/csuzngjh/principles/pull/844))
* **evidence-triage:** PEAT-B1 minimal source-kind triage ([#838](https://github.com/csuzngjh/principles/pull/838))
* **core:** extract failed tool_calls as evidence + increase MAX_EVIDENCE_ENTRIES ([#880](https://github.com/csuzngjh/principles/pull/880))

### Known Limitations

* `principles-disciple` npm package excludes `dist/` due to `.gitignore` — use `create-principles-disciple` installer as the recommended install path
* `create-principles-disciple` env.test.ts has 5 Windows path separator failures (pass on CI/Linux)
* Error Handbook size approaching 200KB limit (76 entries, 181.2KB)

### Rollback Path

* All MVP-Core features have `enabled: false` emergency disable via `.pd/config.yaml`
* MVP-Gone flags (nocturnal, idle_trigger, model_training, trainer) cannot be re-enabled
* Per-rule rollback via `pd runtime activation deactivate --activation-id <id>`
* Version rollback: `git revert` + republish patch version via `npm run release`

# [1.74.1](https://github.com/csuzngjh/principles/compare/v1.74.0...main) (2026-06-21)

### Bug Fixes

* **rulehost:** align prompt template with unified ArtificerRuleOutput ([#993](https://github.com/csuzngjh/principles/pull/993))
* **pd-console:** use short-lived SqliteConnection per request in console models ([#989](https://github.com/csuzngjh/principles/pull/989))
* **rulehost:** normalizePath handles POSIX absolute paths on Windows (PRI-438) ([#988](https://github.com/csuzngjh/principles/pull/988))
* **core:** harden LLM output contract — artificer return shape + generatedAt unification + stripFabricatedIds ([#987](https://github.com/csuzngjh/principles/pull/987))
* **core:** add missing typebox dependency for L2 agent loop adapter ([#956](https://github.com/csuzngjh/principles/pull/956))
* **cli:** findDiagnosticianArtifact fallback for split pipeline (PRI-411) ([#951](https://github.com/csuzngjh/principles/pull/951))
* **runtime:** PR review P0/P1 fixes — retried terminal state + shouldRetry check + failParent reason
* **runtime:** repair retry chain — orchestrator now handles retried status (ERR-067)
* **cli:** pd runtime probe reads .pd/config.yaml for pi-ai config (PRI-402)
* **runtime:** split-stage taskId re-injection + test-double split schema (PRI-401)
* **runtime:** handle reasoning-model output in pi-ai adapter (PRI-400)
* **console:** legacy DB column fallback + deduplicate unlinked banner logic
* **config:** expose provider/model in config doctor output for pi-ai profiles (PRI-399)
* **runtime:** make integrity repair schema-valid (PRI-396)
* **runtime:** unify config resolver for mainline execution (PRI-393)
* **runtime:** tolerate malformed historical runs during runner recovery
* **console:** dedupe trajectory pain rows with Runtime V2 canonical pain records
* **internalization:** recover stale leased tasks from auto-consumer failures
* **internalization:** prevent ready dreamer tasks from staying pending forever (PRI-381)
* **console:** aggregate unmatched pain warnings at response level (PRI-382)
* **console:** normalize sub-run task IDs in evidence chain (PRI-383)

### Features

* **rulehost:** make Artificer a tool-using L2 agent (PRI-439) ([#992](https://github.com/csuzngjh/principles/pull/992))
* **rulehost:** harden execution validation, isolation and activation health (PRI-437) ([#986](https://github.com/csuzngjh/principles/pull/986))
* **rulehost:** make SQLite the sole RuleHost source and delete filesystem compatibility (PRI-436) ([#985](https://github.com/csuzngjh/principles/pull/985))
* **pd-console:** implement principle trajectory display with real data ([#984](https://github.com/csuzngjh/principles/pull/984))
* **rulehost:** promote code_rule_capability to MVP-Core and repair pain-to-dreamer lineage (PRI-435) ([#982](https://github.com/csuzngjh/principles/pull/982))
* **console:** add update resilience and enhance UX ([#977](https://github.com/csuzngjh/principles/pull/977))
* **activation:** wire Story A production closed loop (PRI-408) ([#972](https://github.com/csuzngjh/principles/pull/972))
* **pd-console:** add notification sound and badge reminders ([#971](https://github.com/csuzngjh/principles/pull/971))
* **pd-cli:** wire code_tool_hook channel to production — run-rulehost command (PRI-429) ([#966](https://github.com/csuzngjh/principles/pull/966))
* **pd-console:** skeleton loading + crossfade animations across all pages ([#965](https://github.com/csuzngjh/principles/pull/965))
* **rulehost:** RuleHost MVP Activation — code->test->assemble->retry slice (PRI-421..428) ([#963](https://github.com/csuzngjh/principles/pull/963))
* **pd-console:** console optimization Wave 1-7 — terminology cleanup, inline review, /update path fix ([#960](https://github.com/csuzngjh/principles/pull/960))
* **core:** L2 empty-response auto-retry + L2→L1 fallback (PRI-420) ([#955](https://github.com/csuzngjh/principles/pull/955))
* **core:** Dreamer L2 agent loop (PRI-419, dreamer-only scope) ([#953](https://github.com/csuzngjh/principles/pull/953))
* **core:** CORE_PRINCIPLES injection + PRI-415 architecture audit cleanup ([#952](https://github.com/csuzngjh/principles/pull/952))
* **console:** canonical pain identity linkage in evidence chain (PRI-406)
* **cli:** operator CLI consistency + pd mvp smoke (PRI-397) ([#932](https://github.com/csuzngjh/principles/pull/932))
* **runtime:** add shared mainline snapshot assembler (PRI-394) ([#926](https://github.com/csuzngjh/principles/pull/926))
* **core:** add Mainline Contract validator for Runtime Convergence (PRI-A) ([#924](https://github.com/csuzngjh/principles/pull/924))

### Known Limitations

* `principles-disciple` npm package excludes `dist/` due to `.gitignore` — use `create-principles-disciple` installer as the recommended install path
* `create-principles-disciple` env.test.ts has 5 Windows path separator failures (pass on CI/Linux)
* Error Handbook size approaching 200KB limit (76 entries, 181.2KB)

### Rollback Path

* All MVP-Core features have `enabled: false` emergency disable via `.pd/config.yaml`
* MVP-Gone flags (nocturnal, idle_trigger, model_training, trainer) cannot be re-enabled
* Per-rule rollback via `pd runtime activation deactivate --activation-id <id>`
* Version rollback: `git revert` + republish patch version via `npm run release`

# [1.73.0](https://github.com/csuzngjh/principles/compare/v1.7.6...v1.73.0) (2026-05-31)

> **MVP Seed Customer Release** — This is the first production-ready release for seed customers.
> It delivers the complete Story A' pipeline: pain capture → diagnosis → candidate → activation,
> with three proven MVP-Core channels (prompt, code_tool_hook, defer_archive).

### Features — Core Pipeline

* **runtime:** add structured output repair loop (PRI-200) — automatic LLM output schema validation and repair
* **runtime:** add synthetic PD workload baseline (PRI-206)
* **diagnostician:** 3 split runners + post-diagnosis trigger (PRI-372) — rootcause, distiller, router
* **diagnostician:** core grounding on single agent (PRI-371) — CORE_PRINCIPLES injection prevents fabrication
* **diagnostician:** RunnerKind seam for split pipeline (PRI-370)
* **async-cli:** async pain-record CLI with feature flag gate (PRI-369) — fire-and-forget pain recording
* **core-principles:** Core Principle Registry + drift test (PRI-367)
* **runtime:** connect pain admission to trigger decisions (PRI-337)
* **runtime:** wire principles.outputLanguage into diagnostician and scribe generation prompts (PRI-336)
* **evidence-triage:** PEAT-B1 minimal source-kind triage on Runtime V2 pain path
* **core:** extract failed tool_calls as evidence + increase MAX_EVIDENCE_ENTRIES to 8 (PRI-358/359)
* **core:** runtime cutover — internal agent bindings drive diagnosis and peer runners (PRI-306)
* **core:** SchemaPromptAdapter — schema-driven prompt generation (Layer C, PRI-283)
* **core:** full trace context assembly for diagnostician runners (PRI-171)
* **core:** formalize source trace locator contract (PRI-189)
* **core:** harden fullTrace quality contract (PRI-190)
* **core:** add deterministic TraceRefiner read model (PRI-191)
* **core:** add TraceRefinerAgent shadow contract (PRI-192)
* **core:** build GoldenTrace candidates from refined traces (PRI-193)
* **core:** gate refined RuleHost code through sandbox (PRI-173)
* **core:** add refiner sandbox wrapper (PRI-172)
* **core:** add RuleHostWriter shadow activation (PRI-146)
* **core:** populate RuleHost approval context fields (PRI-185)
* **core:** implement PRI-174 auto_correct live mode in RuleHost gate
* **core:** PRI-139 L1 Hard Cap & LRU Eviction
* **core:** PRI-141 Task Three Strikes Out Mechanism
* **core:** migrate empathy and correction observers to unified SDK runtime v2
* **hooks:** GFI-triggered pain emission + e2e harness fixes
* **diagnostician:** weak-model robustness — multi-attempt repair + provider-level structured output (PRI-271)

### Features — Activation & Approval

* **runtime:** add low-risk activation dispatcher (PRI-144)
* **runtime:** add intake-to-internalization bridge (PRI-142)
* **runtime:** add ApprovalQueue & auto-promotion by confidence (PRI-145)
* **pd-console:** implement Approvals UI (PRI-147)
* **activation:** wire Story A production closed loop (PRI-408)
* **pd-cli:** wire code_tool_hook channel to production — run-rulehost command (PRI-429)
* **rulehost:** RuleHost MVP Activation — code->test->assemble->retry slice (PRI-421..428)
* **rulehost:** make SQLite the sole RuleHost source and delete filesystem compatibility (PRI-436)
* **rulehost:** make Artificer a tool-using L2 agent (PRI-439)

### Features — Console & UI

* **pd-console:** Console Rebuild CR1/CR2/CR8 — Design System, Navigation, Backend Data Contract
* **pd-console:** build pain evidence page (PRI-316)
* **pd-console:** build principle review page (PRI-315)
* **pd-console:** build governance focus page (PRI-319)
* **pd-console:** build activation control page (CR6)
* **pd-console:** owner-actionable filter for Principle Review page (PRI-330)
* **pd-console:** principles output language preference and seed-user clarity (PRI-332)
* **pd-console:** PRI-380 Console evidence chain
* **pd-console:** canonical pain identity linkage in evidence chain (PRI-406)
* **pd-console:** implement principle trajectory display with real data
* **pd-console:** skeleton loading + crossfade animations across all pages
* **pd-console:** add notification sound and badge reminders
* **pd-console:** console optimization Wave 1-7 — terminology cleanup, inline review, /update path fix
* **console:** Control Center UI for PD config and agent model selection (PRI-303)
* **console:** add config API endpoints for Control Center (PRI-309)
* **console:** add seed-friendly console launcher (PRI-300)
* **console:** reduce operator journey to MVP three-page flow (PRI-245)
* **console:** restrict approvals to proven MVP channels (PRI-244)
* **console:** add update resilience and enhance UX

### Features — CLI & Config

* **cli:** add PD config doctor for seed user diagnostics (PRI-299)
* **cli:** operator CLI consistency + pd mvp smoke (PRI-397)
* **cli,plugin:** cutover config doctor and runtime features to .pd/config.yaml (PRI-305, PRI-307)
* **installer:** generate .pd/config.yaml instead of feature-flags.yaml (PRI-308)
* **core:** add PD-owned config contract
* **config:** unify feature flag defaults into single source of truth (PRI-378)
* **workspace:** centralize workspace path management in config.yaml
* **hook:** migrate live hook workspace binding to PD-owned canonical config (PRI-259)
* **pd-cli:** add internalization enqueue-successors command (PRI-218)
* **pd-cli:** run-once default successor enqueue + integrity recommendedAction

### Features — Installer & E2E

* **installer:** provide MVP-first one-click install path (PRI-247)
* **e2e:** real-environment Story A' harness with trap tasks (PRI-273)
* **mvp:** Story A' proven-channel demo workspace (PRI-246)

### Features — Feature Flags & MVP

* **mvp:** add loadable feature flag registry for MVP-Quiet paths (PRI-239)
* **legacy:** add entrypoint census and nocturnal caller guard (PRI-227)
* **plugin:** cut over Nocturnal callers to Runtime V2 (PRI-119)
* **config:** register pain_evidence_admission flag + legacy config cleanup (PRI-404)
* **rulehost:** promote code_rule_capability to MVP-Core (PRI-435)

### Features — Quality & Observability

* **runtime:** add shared mainline snapshot assembler (PRI-394)
* **core:** add Mainline Contract validator for Runtime Convergence (PRI-A)
* **runtime:** add quality scorecard with dual-model gate (PRI-361)
* **runtime:** surface stalled diagnostician tasks + product-path regression tests (PRI-377+376)
* **runtime:** add repository hygiene gate for temp and runtime artifacts (PRI-379)
* **eval:** add 3-arm comparison harness, fixtures, and report for PRI-374
* **feedback:** add privacy-preserving feedback report drafts (PRI-285)
* **update:** add PD update feature with Web UI
* **core:** CORE_PRINCIPLES injection + PRI-415 architecture audit cleanup
* **core:** Dreamer L2 agent loop (PRI-419, dreamer-only scope)
* **core:** L2 empty-response auto-retry + L2→L1 fallback (PRI-420)

### Bug Fixes (selected, v1.7.6..v1.73.0)

* **runtime:** repair retry chain — orchestrator now handles retried status (ERR-067)
* **runtime:** preserve diagnostician lineage into dreamer seeds (PRI-395)
* **runtime:** make integrity repair schema-valid (PRI-396)
* **runtime:** unify config resolver for mainline execution (PRI-393)
* **runtime:** recover failed internalization tasks and normalize config runtime (PRI-392)
* **runtime:** tolerate malformed historical runs during runner recovery
* **internalization:** recover stale leased tasks from auto-consumer failures
* **internalization:** prevent ready dreamer tasks from staying pending forever (PRI-381)
* **internalization:** persist failures with reason in auto-consumer and base-peer-runner
* **console:** dedupe trajectory pain rows with Runtime V2 canonical pain records
* **console:** aggregate unmatched pain warnings at response level (PRI-382)
* **console:** normalize sub-run task IDs in evidence chain (PRI-383)
* **console:** make principle detail approval actions honest
* **console:** legacy DB column fallback + deduplicate unlinked banner logic
* **cli:** pd runtime probe reads .pd/config.yaml for pi-ai config (PRI-402)
* **cli:** structured JSON on failure paths + real registration tests (PRI-397)
* **cli:** findDiagnosticianArtifact fallback for split pipeline (PRI-411)
* **config:** add missing diagnostician flags to pd-config-defaults
* **plugin:** correct test regressions from PRI-363 single-gate migration
* **pi-ai:** provider timeout classification and transient retry policy

# [1.7.6](https://github.com/csuzngjh/principles/compare/v1.7.5...v1.7.6) (2026-03-26)

### Features

* **phase-3:** control plane cleanup — gate.ts modular split into 6 sub-modules (thinking-checkpoint, bash-risk, progressive-trust-gate, edit-verification, gfi-gate, gate-block-helper) ([52e476e](https://github.com/csuzngjh/principles/commit/52e476e))
* **phase-3:** legacy queue status filtering (resolved/blocked/failed/cancelled/paused) + Trust input validation + timeout-only outcome filtering ([52e476e](https://github.com/csuzngjh/principles/commit/52e476e))

### Bug Fixes

* **gate:** fix bash-risk.ts command substitution handling ([52e476e](https://github.com/csuzngjh/principles/commit/52e476e))
* docs: fix chapter numbering in sleep-mode-reflection-system.md ([52e476e](https://github.com/csuzngjh/principles/commit/52e476e))
* fix: LockUnavailableError message dynamic resource naming ([52e476e](https://github.com/csuzngjh/principles/commit/52e476e))

# [1.7.5](https://github.com/csuzngjh/principles/compare/v1.7.4...v1.7.5) (2026-03-25)


### Bug Fixes

* address CodeRabbit review comments - use isSubagentAvailable() for runtime detection ([1870928](https://github.com/csuzngjh/principles/commit/1870928))
* fix central-db to handle missing thinking_model_events table in older workspaces ([adec0a8](https://github.com/csuzngjh/principles/commit/adec0a8))
* improve UI KPI cards and accessibility ([968400e](https://github.com/csuzngjh/principles/commit/968400e))
* restore subagent-probe.ts for empathy observer module ([ff6f384](https://github.com/csuzngjh/principles/commit/ff6f384))


### Features

* **ui:** redesign Principles Console with warm natural design system ([b290de6](https://github.com/csuzngjh/principles/commit/b290de6))
* **ui:** add central database aggregating all workspaces ([e9d3e64](https://github.com/csuzngjh/principles/commit/e9d3e64))
* **ui:** add workspace configuration panel ([9a467e3](https://github.com/csuzngjh/principles/commit/9a467e3))
* **ui:** add custom workspace form to WorkspaceConfig ([15dbad6](https://github.com/csuzngjh/principles/commit/15dbad6))
* **focus:** add auto-compression with milestone archiving ([06992f2](https://github.com/csuzngjh/principles/commit/06992f2))
* **focus:** add format validation and template recovery ([31f5325](https://github.com/csuzngjh/principles/commit/31f5325))


### Code Refactoring

* migrate from pd_run_worker to sessions_spawn for subagent spawning ([d1ea4f6](https://github.com/csuzngjh/principles/commit/d1ea4f6))
* remove compiled artifacts from git tracking ([6076388](https://github.com/csuzngjh/principles/commit/6076388))
* simplify focus validation to only check critical issues ([ef7e53a](https://github.com/csuzngjh/principles/commit/ef7e53a))
* improve auto-compression with config and rate limiting ([eed54e6](https://github.com/csuzngjh/principles/commit/eed54e6))



# [1.7.0](https://github.com/csuzngjh/principles/compare/v1.6.0...v1.7.0) (2026-03-19)


### Bug Fixes

* 修复插件安装器的依赖问题 ([f7e1eb4](https://github.com/csuzngjh/principles/commit/f7e1eb43cb7ec9c80679807ab81fd3b62022f254))
* correct OpenClaw Gateway default port from 3000 to 18789 ([#80](https://github.com/csuzngjh/principles/issues/80)) ([3585670](https://github.com/csuzngjh/principles/commit/3585670358a60aa7190b66991877000ecddc8dad))
* resolve 7 security vulnerabilities ([#79](https://github.com/csuzngjh/principles/issues/79)) ([739d761](https://github.com/csuzngjh/principles/commit/739d7619306fbe93858d3f853094ffeb63090f79)), closes [#69](https://github.com/csuzngjh/principles/issues/69) [#69](https://github.com/csuzngjh/principles/issues/69) [#69](https://github.com/csuzngjh/principles/issues/69)


### Features

* 添加智能体安装指引和更新摘要机制 ([063d5e1](https://github.com/csuzngjh/principles/commit/063d5e121f3a4b4bdac6f733f3b72978a5b4b8e7))
* add Principles Console P2 and clarify internal worker routing ([#78](https://github.com/csuzngjh/principles/issues/78)) ([e9b3bf4](https://github.com/csuzngjh/principles/commit/e9b3bf4041fbeb52c89f56ca28cb6b1bdf5ab24c))
* add trajectory data platform ([#76](https://github.com/csuzngjh/principles/issues/76)) ([4bba1ce](https://github.com/csuzngjh/principles/commit/4bba1ce9b8ceb12e88663fb92ac50e56946f26f5))
* **installer:** 自动检测首次安装 vs 更新 ([40f3edf](https://github.com/csuzngjh/principles/commit/40f3edf256b35247082943fa2eca5ca25d27396b))
