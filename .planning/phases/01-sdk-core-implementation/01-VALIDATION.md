---
phase: "1"
slug: sdk-core-implementation
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-17
---

# Phase 1 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 4.1.0 |
| **Config file** | `packages/principles-core/vitest.config.ts` (Wave 0 — new) |
| **Quick run command** | `npx vitest run packages/principles-core/tests/adapters/ -x` |
| **Full suite command** | `npx vitest run packages/principles-core/tests/ -x` |
| **Estimated runtime** | ~10 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run packages/principles-core/tests/ -x`
- **After every plan wave:** Run `npx vitest run packages/principles-core/tests/ -x` + `npx vitest run packages/openclaw-plugin/tests/core/ -x`
- **Before `/gsd-verify-work`:** Full monorepo suite must be green (`npx vitest run -x`)
- **Max feedback latency:** 10 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 01-01-01 | 01 | 1 | SDK-MGMT-01 | — | Package resolves as @principles/core | smoke | `node -e "import('@principles/core').then(m => console.log(Object.keys(m)))"` | ❌ W0 | ⬜ pending |
| 01-02-01 | 02 | 1 | SDK-CORE-03 | — | validatePainSignal + deriveSeverity work in new package | unit | `npx vitest run packages/principles-core/tests/pain-signal.test.ts -x` | ❌ W0 | ⬜ pending |
| 01-02-02 | 02 | 1 | SDK-CORE-03 | — | All 6 interface files exported from new package | smoke | `npx vitest run packages/principles-core/tests/exports.test.ts -x` | ❌ W0 | ⬜ pending |
| 01-03-01 | 03 | 1 | SDK-ADP-07 | T-01 | Coding adapter captures tool failures, returns null on success | unit | `npx vitest run packages/principles-core/tests/adapters/coding/ -x` | ❌ W0 | ⬜ pending |
| 01-04-01 | 04 | 1 | SDK-ADP-08 | — | Writing adapter captures text quality issues, returns null on clean text | unit | `npx vitest run packages/principles-core/tests/adapters/writing/ -x` | ❌ W0 | ⬜ pending |
| 01-05-01 | 05 | 2 | SDK-TEST-02 | — | Conformance factories validate both adapters | conformance | `npx vitest run packages/principles-core/tests/conformance/ -x` | ❌ W0 | ⬜ pending |
| 01-06-01 | 06 | 2 | SDK-TEST-03 | — | Benchmarks run and p99 < 50ms (pain), < 100ms (injection) | benchmark | `npx vitest bench packages/principles-core/tests/bench/` | ❌ W0 | ⬜ pending |
| 01-07-01 | 07 | 2 | SDK-MGMT-02 | — | Package version is valid Semver, CHANGELOG exists | manual | `cat packages/principles-core/package.json \| jq .version` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `packages/principles-core/vitest.config.ts` — test + bench configuration
- [ ] `packages/principles-core/tsconfig.json` — TypeScript config
- [ ] `packages/principles-core/package.json` — package definition with exports map
- [ ] `packages/principles-core/src/index.ts` — barrel export
- [ ] `packages/principles-core/src/types.ts` — duplicated type shapes (InjectablePrinciple, HybridLedgerStore)
- [ ] `packages/principles-core/tests/adapters/coding/openclaw-pain-adapter.test.ts` — SDK-ADP-07
- [ ] `packages/principles-core/tests/adapters/writing/writing-pain-adapter.test.ts` — SDK-ADP-08
- [ ] `packages/principles-core/tests/conformance/pain-adapter-conformance.ts` — SDK-TEST-02
- [ ] `packages/principles-core/tests/conformance/injector-conformance.ts` — SDK-TEST-02
- [ ] `packages/principles-core/tests/bench/adapter-performance.bench.ts` — SDK-TEST-03

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Package version is valid Semver | SDK-MGMT-02 | Version string check is trivial | `cat packages/principles-core/package.json | jq .version` |
| CHANGELOG.md exists with initial entry | SDK-MGMT-02 | File existence check | `test -f packages/principles-core/CHANGELOG.md` |

*All phase behaviors have automated verification (manual checks are trivial file-existence).*

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 10s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
