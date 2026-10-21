# @principles/workbuddy-adapter

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
