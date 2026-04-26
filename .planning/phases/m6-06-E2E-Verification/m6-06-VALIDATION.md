---
name: m6-06-E2E-Verification
description: E2E integration verification for openclaw-cli runtime adapter
type: phase
phase_number: m6-06
phase_slug: E2E-Verification
date: 2026-04-25
---

# m6-06 E2E Verification — Validation Strategy

## Phase Overview

**Goal:** Full pipeline integration verification of `pd diagnose run --runtime openclaw-cli` with FakeCliProcessRunner (E2EV-01~03), real CLI path (E2EV-04~07), and legacy import regression (E2EV-08). Hard gates HG-1, HG-3, HG-5 verified.

**Plans:** 3 (m6-06-01, m6-06-02, m6-06-03)

## Validation Dimensions

### Dimension 1: Fake Runner Path (E2EV-01, E2EV-02, E2EV-03)
- Approach: Unit test with vi.mock intercepting cli-process-runner.ts
- Pass: m6-06-e2e.test.ts 3 scenarios green; runCliProcess mock called with command=openclaw; local args include --local, gateway args omit --local

### Dimension 2: Real CLI Path (E2EV-04~07, HG-1, HG-5)
- Approach: CLI subprocess spawning node packages/pd-cli/dist/index.js
- Pass: Each subprocess exits 0 OR blocked evidence JSON if openclaw unavailable

### Dimension 3: Legacy Import Regression (E2EV-08)
- Approach: Integration test with pre-existing openclaw-history lease
- Pass: m6-06-legacy.test.ts passes; contextHash non-empty, output.valid === true

### Dimension 4: TypeScript Compilation
- Approach: npx tsc --noEmit on principles-core
- Pass: No errors

### Dimension 5: TELE-01~04 Events
- Approach: StoreEventEmitter capture in tests
- Pass: All 4 event types observed in test run

### Dimension 6: No Regression in TestDouble Path
- Approach: Scenario 3 in m6-06-01 re-runs dual-track-e2e happy path
- Pass: Scenario passes

## Blocked Evidence Format
If real OpenClaw unavailable:
{ blocked: true, reason: string, evidence: string[], attemptedAt: ISO8601, command: string }

## Success Criteria
- [ ] E2EV-01: FakeCliProcessRunner proves adapter path
- [ ] E2EV-02: Full chain with mock runner
- [ ] E2EV-03: TestDoubleRuntimeAdapter regression
- [ ] E2EV-04: pd runtime probe succeeds (HG-1)
- [ ] E2EV-05: pd context build valid payload
- [ ] E2EV-06: Real full flow
- [ ] E2EV-07: pd candidate list / pd artifact show retrieve rows
- [ ] E2EV-08: Legacy import path
- [ ] HG-3: Both runtimeModes produce correct args
- [ ] HG-5: D:\.openclaw\workspace verified
- [ ] TELE-01~04: All events verified
- [ ] TypeScript compiles clean

_Validated: 2026-04-25_
