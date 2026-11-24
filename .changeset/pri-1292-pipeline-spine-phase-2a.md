---
"@principles/core": patch
"@principles/host-runtime": patch
"@principles/codex-adapter": patch
"@principles/workbuddy-adapter": patch
"@principles/pd-cli": patch
"principles-disciple": patch
"create-principles-disciple": patch
---

Pipeline Spine Phase 2A (PRI-1292): ONE assembly point for the workspace pipeline host collaborators and ONE cache-free diagnostician runner assembly. `resolveWorkspacePipelineHostDeps` (@principles/host-runtime, new export) returns the five required collaborators (intentDocReader / trajectoryTurnReader / sourceMaterialAuthorization / telemetrySink / isAutoPainSubmissionAuthorized) with the default trajectory reader bound to the SAME consent-ledger authorization instance the gate consumers receive — removing the double-authorization-instance defect where diagnostician-auto-run, both codex worker sites and the workbuddy worker built two independent consent ports per call. All eight production assembly points migrate: pd pain record, the OpenClaw hook and /pd pain command (via the new shared plugin factory `createPluginPainToPrincipleService`, which passes the Gateway's in-process trajectory as the reader override and the entry's effectiveConfig as the intent flag authority per SPEC §13.1), diagnostician-auto-run, both codex worker sites, the workbuddy worker, and `pd diagnose run` + `pd pain retry`. `createDiagnosticianRunnerBundle` (@principles/core/runtime, new export, admitted) extracts in place the Diag*Runner + SplitDiagnosticianRunner assembly from the cached-bridge factory so the factory, diagnose and pain-retry share one construction sequence; it never touches bridgeCache, derives the same timing contract both CLIs relied on (stage = input, parent = 3×, lease 120s / heartbeat 40s), and with an externally provided stateManager reuses its connection and never closes it — dispose() is idempotent and closes only a factory-created manager. CLI contracts unchanged: --no-intake, --runtime test-double, ERR-067 retry loop, dead-letter replay and task-rerun semantics, JSON output shapes and exit codes are pinned by the existing suites plus new ownership/isolation tests.
