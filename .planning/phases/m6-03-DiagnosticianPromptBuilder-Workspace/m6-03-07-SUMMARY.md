---
phase: m6-03
plan: "07"
status: complete
completed_at: "2026-04-24T22:39:56.000Z"
commit: 2f19a82a
---

## m6-03-07 Summary: Integration Tests — DiagnosticianPromptBuilder → OpenClawCliRuntimeAdapter Pipeline

**Goal:** End-to-end integration test verifying the m6-03 pipeline: payload → buildPrompt() → message JSON → startRun().

**What was shipped:**

### Artifacts
- `packages/principles-core/src/runtime-v2/diagnostician/__tests__/diagnostician-prompt-builder.integration.test.ts` (NEW)

### Test cases (10 total)
1. buildPrompt() message can be passed directly to startRun() as inputPayload
2. taskId appears at top level of the JSON message (DPB-04)
3. contextHash appears at top level of the JSON message (DPB-04)
4. diagnosisTarget appears at top level of the JSON message (DPB-04)
5. sourceRefs appears at top level of the JSON message (DPB-04)
6. conversationWindow appears at top level of the JSON message (DPB-04)
7. workspaceDir accessible via promptInput.context.workspaceDir (OCRA-06)
8. workspaceDir NOT at top level (OCRA-06 — reduces exposure)
9. runtimeMode='local' passes --local flag to openclaw agent (OCRA-07)
10. runtimeMode='gateway' omits --local flag (OCRA-07, HG-03)
11. message is ONLY JSON — no markdown, no tool calls (DPB-02)

### Pipeline tested
```
DiagnosticianContextPayload
  → DiagnosticianPromptBuilder.buildPrompt()
  → { message: string, promptInput: PromptInput }
  → OpenClawCliRuntimeAdapter.startRun({ inputPayload: message })
  → CLI args: openclaw agent --agent <id> --message <json> [--local] --timeout <ms>
```

### Success criteria verified
- [x] All vitest integration tests pass (10 test cases)
- [x] DPB-01 covered: buildPrompt() output → startRun() inputPayload
- [x] DPB-04 covered: all 5 fields at top level (taskId, contextHash, diagnosisTarget, conversationWindow, sourceRefs)
- [x] OCRA-06 covered: workspaceDir in nested context, not at top level
- [x] OCRA-07 covered: runtimeMode='local' passes --local, 'gateway' omits it
- [x] DPB-02 covered: message is only JSON (no markdown)
- [x] HG-03 covered: no silent fallback verified
- [x] runCliProcess mocked — no real openclaw binary required

### Requirements covered
- DPB-01, DPB-02, DPB-03, DPB-04, DPB-05
- OCRA-06, OCRA-07
- HG-02, HG-03
