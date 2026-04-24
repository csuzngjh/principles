---
phase: m6-02
plan: "03"
subsystem: runtime-v2/adapter
tags: [runtime-v2, adapter, export, OCRA-05]
requires: [OCRA-05]
provides: [OpenClawCliRuntimeAdapter export]
affects: [m6-04]
tech_stack:
  added: []
  patterns: [barrel re-export]
key_files:
  created: []
  modified:
    - packages/principles-core/src/runtime-v2/adapter/index.ts
key_decisions:
  - "OpenClawCliRuntimeAdapter re-exported alongside TestDoubleRuntimeAdapter"
requirements_completed: [OCRA-05]
duration: ~
completed: "2026-04-24"
---

# Phase m6-02 Plan 03: Export OpenClawCliRuntimeAdapter

**Substantive:** Added `OpenClawCliRuntimeAdapter` re-export to `adapter/index.ts` barrel.

## What Was Built

Updated `packages/principles-core/src/runtime-v2/adapter/index.ts`:
```typescript
export { OpenClawCliRuntimeAdapter } from './openclaw-cli-runtime-adapter.js';
```

## Verification

- `grep "OpenClawCliRuntimeAdapter" adapter/index.ts` — export present ✓
- `grep "TestDoubleRuntimeAdapter" adapter/index.ts` — existing export unchanged ✓
- `npx tsc --noEmit` — clean ✓

## OCRA-05

Adapter can now be registered via `RuntimeSelector`. m6-04 will import:
```typescript
import { OpenClawCliRuntimeAdapter } from '../runtime-v2/adapter/index.js';
// ...
RuntimeSelector.register(new OpenClawCliRuntimeAdapter());
```

## Phase Complete

m6-02 complete — all 5 OCRA requirements verified. Ready for m6-03.
