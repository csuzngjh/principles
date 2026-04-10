---
phase: 16
slug: nocturnal-snapshot-and-runtime-hardening
status: local_complete_live_pending
nyquist_compliant: true
wave_0_complete: true
created: 2026-04-10
---

# Phase 16 - Validation Strategy

## Test Infrastructure

| Property | Value |
|----------|-------|
| Framework | vitest |
| Quick run | `npm test -- tests/service/evolution-worker.nocturnal.test.ts tests/service/nocturnal-runtime-hardening.test.ts` |
| Typecheck | `npx tsc --noEmit` |
| Production evidence | SSH inspection of `.state/evolution_queue.json`, `.state/subagent_workflows.db`, and `.state/nocturnal-runtime.json` |

## Required Automated Validation

- `npm test -- tests/service/evolution-worker.nocturnal.test.ts`
- `npm test -- tests/service/nocturnal-runtime-hardening.test.ts`
- `npx tsc --noEmit`

## Required Production Evidence Validation

After implementation and deployment, verify on the live workspace:

1. recent nocturnal workflows no longer start with all-zero `pain_context_fallback` snapshots
2. queue failures stop clustering around generic timeout-only explanations when ingress/runtime root cause is already known
3. workflow terminal states reflect the real cause before watchdog sweep

Suggested inspection points:
- `~/.openclaw/workspace-main/.state/evolution_queue.json`
- `~/.openclaw/workspace-main/.state/subagent_workflows.db`
- `~/.openclaw/workspace-main/.state/nocturnal-runtime.json`
- `~/.openclaw/workspace-main/memory/logs/SYSTEM.log`

## Sign-off Conditions

- [x] ingress tests pass
- [x] runtime-state tests pass
- [x] typecheck passes
- [ ] live evidence shows fewer empty fallback runs
- [ ] live evidence shows truthful terminal reasons

**Approval:** local pass, deploy for live verification
