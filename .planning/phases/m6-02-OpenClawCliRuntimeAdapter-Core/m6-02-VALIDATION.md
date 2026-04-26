---
phase: m6-02
slug: OpenClawCliRuntimeAdapter-Core
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-24
---

# Phase m6-02 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest (existing test infrastructure in `packages/principles-core`) |
| **Config file** | `packages/principles-core/vitest.config.ts` (existing) |
| **Quick run command** | `cd packages/principles-core && npx vitest run src/runtime-v2/adapter/openclaw-cli-runtime-adapter.test.ts --reporter=basic` |
| **Full suite command** | `cd packages/principles-core && npx vitest run` |
| **Estimated runtime** | ~20 seconds |

---

## Sampling Rate

- **After m6-02-01 (adapter impl):** `cd packages/principles-core && npx tsc --noEmit src/runtime-v2/adapter/openclaw-cli-runtime-adapter.ts`
- **After m6-02-02 (tests):** `cd packages/principles-core && npx vitest run src/runtime-v2/adapter/openclaw-cli-runtime-adapter.test.ts --reporter=basic`
- **After m6-02-03 (index export):** `cd packages/principles-core && npx tsc --noEmit src/runtime-v2/adapter/index.ts`
- **After every plan wave:** `npx vitest run` (full suite)
- **Before `/gsd-verify-work`:** Full suite must be green

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------------|-----------|-------------------|-------------|--------|
| m6-02-01-01 | 01 | 1 | OCRA-01~04 | command='openclaw' hardcoded; args array form | unit | `tsc --noEmit openclaw-cli-runtime-adapter.ts` | CREATED | ⬜ pending |
| m6-02-02-01 | 02 | 2 | OCRA-01~04 | runCliProcess mocked (no real binary) | unit | `vitest run openclaw-cli-runtime-adapter.test.ts` | CREATED | ⬜ pending |
| m6-02-03-01 | 03 | 2 | OCRA-05 | N/A (re-export) | unit | `tsc --noEmit index.ts` | MODIFIED | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `packages/principles-core/src/runtime-v2/adapter/openclaw-cli-runtime-adapter.ts` — main implementation (OCRA-01~04)
- [ ] `packages/principles-core/src/runtime-v2/adapter/openclaw-cli-runtime-adapter.test.ts` — unit tests (OCRA-01~04)
- [ ] `packages/principles-core/src/runtime-v2/adapter/index.ts` — updated with OpenClawCliRuntimeAdapter export (OCRA-05)

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Real openclaw binary invocation (no mock) | OCRA-02 | Requires openclaw binary installed | Run `openclaw agent --agent diagnostician --message '{}' --json --local --timeout 5` and verify it produces JSON DiagnosticianOutputV1 |

*If none: "All phase behaviors have automated verification via unit tests."*

---

## Validation Sign-Off

- [ ] All tasks have `<verify>` commands in their `<acceptance_criteria>`
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all requirement IDs (OCRA-01~05)
- [ ] No watch-mode flags
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
