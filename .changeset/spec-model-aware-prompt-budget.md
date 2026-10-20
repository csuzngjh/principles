---
'@principles/core': minor
'@principles/host-runtime': minor
---

SPEC-PD-MODEL-AWARE-PROMPT-BUDGET-001: model-context-aware prompt injection budget.

- Adds the single budget resolver `resolvePromptBudget` (pure policy, injectable Pi AI catalog): trusted host effective window (OpenClaw `contextTokenBudget` with model/modelsConfig/agentContextTokens provenance) → exact provider+modelId catalog match → provider-less catalog lookup only when every match agrees on the context window → legacy fixed 2000-char fallback with an observable reason. Budget formula `min(4000, max(500, floor(2000 × W / 128000)))` in UTF-16 chars (NOT tokens).
- Wires the resolution once per request through the real injection paths: OpenClaw plugin-local route, shared host-runtime route (`HostEventContext.modelContext`), Codex (validated `model` id), WorkBuddy (observed-optional `model`, soft-consumed — dynamic only via unambiguous catalog match, honest fallback otherwise).
- Approval-time deliverability is now tier-honest: `model_dependent` for entries fitting the supported 500..4000 range only on larger-context models (never a refusal, never a promise); `undeliverable` only beyond the 4000 max tier; Console/CLI surfaces and injection events carry budget provenance (`budgetCapacitySource`/`budgetCapacityStatus`/`budgetContextWindowTokens`).
- Rollback: with no trusted capacity facts every path resolves to the historical fixed 2000-char budget (byte-identical legacy behavior); no schema migration, no new network calls, no per-turn catalog refresh.
