---
phase: m6-03
slug: DiagnosticianPromptBuilder-Workspace
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-24
---

# Phase m6-03 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest (from existing runtime-v2 test suite) |
| **Config file** | `packages/principles-core/vitest.config.ts` |
| **Quick run command** | `cd packages/principles-core && npx vitest run src/runtime-v2/diagnostician/` |
| **Full suite command** | `cd packages/principles-core && npx vitest run src/runtime-v2/` |
| **Estimated runtime** | ~30 seconds |

---

## Sampling Rate

- **After every task commit:** Run quick command
- **After every plan wave:** Run full suite command
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| m6-03-01-01 | 01 | 1 | DPB-01, DPB-06 | unit | `vitest run diagnostician-prompt-builder.test.ts -t "buildPrompt returns PromptResult with message"` | W0 | ⬜ pending |
| m6-03-02-01 | 02 | 1 | DPB-01~05 | unit | `vitest run diagnostician-prompt-builder.test.ts -t "DPB"` | W0 | ⬜ pending |
| m6-03-03-01 | 03 | 1 | OCRA-06, OCRA-07 | unit | `vitest run openclaw-cli-runtime-adapter.test.ts -t "workspace boundary"` | existing | ⬜ pending |
| m6-03-04-01 | 04 | 2 | DPB-01~05 | unit | `vitest run diagnostician-prompt-builder.test.ts -t "buildPrompt full implementation"` | W0 | ⬜ pending |
| m6-03-05-01 | 05 | 2 | OCRA-06, OCRA-07 | unit | `vitest run openclaw-cli-runtime-adapter.test.ts -t "OCRA-07"` | existing | ⬜ pending |
| m6-03-06-01 | 06 | 3 | DPB-01~05 | unit | `vitest run diagnostician-prompt-builder.test.ts -t "exports"` | W0 | ⬜ pending |
| m6-03-07-01 | 07 | 3 | DPB-01~05, OCRA-06, OCRA-07 | integration | `vitest run diagnostician-prompt-builder.integration.test.ts` | W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `packages/principles-core/src/runtime-v2/diagnostician/diagnostician-prompt-builder.ts` — DPB-01~DPB-07 coverage
- [ ] `packages/principles-core/src/runtime-v2/diagnostician/__tests__/diagnostician-prompt-builder.test.ts` — unit tests for DPB-01~DPB-07
- [ ] `packages/principles-core/src/runtime-v2/diagnostician/PromptInput.ts` — PromptInput type definition

*If none: "Existing infrastructure covers all phase requirements."*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| No markdown/tool-call content in prompt output | DPB-02 | Requires content inspection of serialized JSON string | Verify via unit test: `expect(JSON.parse(result.message)).not.toContain('markdown')` |
| Workspace boundary: PD vs OpenClaw workspace distinct | OCRA-06, HG-2 | Requires verifying cwd/env injection in CliProcessRunner call | Verify via integration test mock: check `cwd` is PD workspace dir and env vars are set |

*If none: "All phase behaviors have automated verification."*

---

## Validation Sign-Off

- [ ] All tasks have automated verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending