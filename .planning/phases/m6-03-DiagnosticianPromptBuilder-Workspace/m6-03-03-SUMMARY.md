---
phase: m6-03
plan: "03"
status: complete
completed_at: "2026-04-24T22:39:56.000Z"
commit: 2f19a82a
---

## m6-03-03 Summary: OpenClawCliRuntimeAdapter runtimeMode + Workspace Boundary

**Goal:** Extend OpenClawCliRuntimeAdapter with runtimeMode ('local'|'gateway') and workspaceDir (OCRA-06, OCRA-07).

**What was shipped:**

### Changes to
- `packages/principles-core/src/runtime-v2/adapter/openclaw-cli-runtime-adapter.ts`

### Key changes

**New constructor options** (DPB-09 — LOCKED, HG-03 — HARD GATE):
```typescript
export interface OpenClawCliRuntimeAdapterOptions {
  runtimeMode: 'local' | 'gateway'; // No silent fallback — must be explicit
  workspaceDir?: string; // Passed as cwd to CliProcessRunner
}
```

**--local flag is conditional** (DPB-09, HG-03):
```typescript
// HG-03 (HARD GATE): No silent fallback — must be explicit
if (this.runtimeMode === 'local') {
  args.push('--local');
}
```

**workspaceDir passed as cwd** (DPB-08, HG-02):
```typescript
// DPB-08 (LOCKED): Pass workspaceDir as cwd for workspace boundary control
// HG-02 (HARD GATE): Two distinct boundaries — cwd controls PD workspace
const cliOutput = await runCliProcess({
  command: 'openclaw',
  args,
  cwd: this.workspaceDir, // undefined means process.cwd()
  timeoutMs: input.timeoutMs,
});
```

### Hard gates satisfied
- **HG-02:** OpenClaw CLI has NO `--workspace` flag. PD workspace (.pd/) vs OpenClaw workspace are distinct boundaries.
- **HG-03:** `--local`/`--gateway` must be explicit; no silent fallback.

### Success criteria verified
- [x] runtimeMode: 'local' | 'gateway' in constructor options (OCRA-07, HG-03)
- [x] --local only passed when runtimeMode === 'local' — no silent fallback (DPB-09, HG-03)
- [x] workspaceDir passed as cwd to runCliProcess (OCRA-06, DPB-08, HG-02)
- [x] Constructor requires options object — no implicit defaults (HG-03)
- [x] Existing error mapping (D-04) unchanged
- [x] TypeScript compiles without errors

### Requirements covered
- OCRA-06: workspaceDir passed as cwd
- OCRA-07: runtimeMode explicit, no silent fallback
- DPB-08: Three-layer control includes cwd
- DPB-09: No silent fallback
- HG-02, HG-03: HARD GATEs satisfied
