---
phase: m6-03
plan: "01"
status: complete
completed_at: "2026-04-24T22:39:56.000Z"
commit: 2f19a82a
---

## m6-03-01 Summary: PromptInput Type + DiagnosticianPromptBuilder Skeleton

**Goal:** Create `DiagnosticianPromptBuilder` class skeleton and `PromptInput` type.

**What was shipped:**

### Artifacts
- `packages/principles-core/src/runtime-v2/diagnostician-prompt-builder.ts` (NEW)

### Key decisions

**PromptInput type** (DPB-06 — LOCKED):
```typescript
export interface PromptInput {
  taskId: string;
  contextHash: string;
  diagnosisTarget: DiagnosisTarget;
  conversationWindow: HistoryQueryEntry[];
  sourceRefs: string[];
  context: DiagnosticianContextPayload; // nested for backward compat
}
```

**PromptBuildResult type** (DPB-02 — LOCKED):
```typescript
export interface PromptBuildResult {
  readonly message: string; // JSON string for --message flag
  readonly promptInput: PromptInput;
}
```

**DiagnosticianPromptBuilder.buildPrompt():** Pure transform — accepts `DiagnosticianContextPayload`, returns `PromptBuildResult`. No DB calls (DPB-05). No `extraSystemPrompt` field (DPB-07 LOCKED).

### Success criteria verified
- [x] PromptInput type defined with DPB-06 structure (taskId, contextHash, diagnosisTarget, conversationWindow, sourceRefs, context)
- [x] PromptBuildResult has message (string) + promptInput (PromptInput) fields
- [x] buildPrompt() accepts DiagnosticianContextPayload and returns PromptBuildResult
- [x] Output is JSON via JSON.stringify() (DPB-02)
- [x] NO extraSystemPrompt field (DPB-07)
- [x] buildPrompt() is pure — no database calls (DPB-05)
- [x] TypeScript compiles without errors

### Requirements covered
- DPB-01: buildPrompt signature
- DPB-02: JSON-only output
- DPB-03: JSON conforms to expected structure
- DPB-04: Explicit fields (partial — full mapping in m6-03-04)
- DPB-05: Pure function, no DB calls
- DPB-06: PromptInput structure
- DPB-07: No extraSystemPrompt field
