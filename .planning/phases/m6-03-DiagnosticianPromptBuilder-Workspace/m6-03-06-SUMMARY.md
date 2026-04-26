---
phase: m6-03
plan: "06"
status: complete
completed_at: "2026-04-24T22:39:56.000Z"
commit: 2f19a82a
---

## m6-03-06 Summary: DiagnosticianPromptBuilder Exports from runtime-v2 index.ts

**Goal:** Export DiagnosticianPromptBuilder, PromptInput, PromptBuildResult, and OpenClawCliRuntimeAdapterOptions from the runtime-v2 barrel.

**What was shipped:**

### Changes to
- `packages/principles-core/src/runtime-v2/index.ts`
- `packages/principles-core/src/runtime-v2/adapter/index.ts`

### New exports in index.ts
```typescript
// Diagnostician Prompt Builder (M6)
export { DiagnosticianPromptBuilder, summarizeConversationWindow } from './diagnostician-prompt-builder.js';
export type { PromptInput, PromptBuildResult } from './diagnostician-prompt-builder.js';

// OpenClawCliRuntimeAdapter (M6)
export type { OpenClawCliRuntimeAdapterOptions } from './adapter/openclaw-cli-runtime-adapter.js';
```

### New re-export in adapter/index.ts
```typescript
export type { OpenClawCliRuntimeAdapterOptions } from './openclaw-cli-runtime-adapter.js';
```

### Downstream availability
These types/classes are now importable via:
```typescript
import { DiagnosticianPromptBuilder } from '@principles-core/runtime-v2';
import type { PromptInput, PromptBuildResult, OpenClawCliRuntimeAdapterOptions } from '@principles-core/runtime-v2';
```

### Success criteria verified
- [x] DiagnosticianPromptBuilder exported from runtime-v2 index.ts
- [x] PromptInput and PromptBuildResult type exported from runtime-v2 index.ts
- [x] OpenClawCliRuntimeAdapterOptions type exported from runtime-v2 index.ts
- [x] OpenClawCliRuntimeAdapterOptions type re-exported from adapter/index.ts
- [x] Existing exports unchanged (TestDoubleRuntimeAdapter, etc.)
- [x] TypeScript compiles without errors

### Requirements covered
- DPB-01 (via export), DPB-06 (PromptInput type exported)
