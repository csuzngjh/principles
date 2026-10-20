---
'@principles/core': minor
'@principles/host-runtime': minor
'@principles/codex-adapter': patch
'principles-disciple': patch
'@principles/pd-cli': patch
'@principles/workbuddy-adapter': patch
'create-principles-disciple': patch
---

SPEC-PD-MODEL-AWARE-PROMPT-BUDGET-001: model-context-aware prompt injection budget.

- Core adds the single budget resolver `resolvePromptBudget` (pure policy, injectable Pi AI catalog): trusted host effective window (OpenClaw `contextTokenBudget` with model/modelsConfig/agentContextTokens provenance) → exact provider+modelId catalog match → provider-less catalog lookup only when every match agrees on the context window → legacy fixed 2000-char fallback with an observable reason. Budget formula `min(4000, max(500, floor(2000 × W / 128000)))` in UTF-16 chars (NOT tokens).
- Host-runtime resolves once per request through the real injection path (`HostEventContext.modelContext`) and the projection/precheck/status surfaces; approval-time deliverability is tier-honest (`model_dependent` for entries fitting the supported 500..4000 range only on larger-context models — proceeds with a notice, never a refusal or a promise; `undeliverable` only beyond the 4000 max tier); injection events carry budget provenance.
- Adapters forward host model facts: OpenClaw hook context fields (type synced to the upstream enum), Codex validated `model` id, WorkBuddy observed-optional `model` (soft-consumed — dynamic only via unambiguous catalog match, honest fallback otherwise). CLI shows the model-dependent notice; Console surfaces tier fit and budget provenance.
- Rollback: with no trusted capacity facts every path resolves to the historical fixed 2000-char budget (byte-identical legacy behavior); no schema migration, no new network calls, no per-turn catalog refresh.
