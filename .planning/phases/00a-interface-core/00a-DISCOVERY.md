# Discovery: Phase 0a Interface Contracts & Hardening

## 1. PainSignal Schema (SDK-CORE-01)

The existing `PainFlagData` in `src/core/pain.ts` is the current source of truth. We will formalize it as `PainSignal` and add strict validation.

**Proposed Schema (Zod-like or TypeBox):**
- `source`: string (e.g., 'tool_failure', 'human_intervention')
- `score`: number (0-100)
- `timestamp`: string (ISO 8601)
- `reason`: string
- `sessionId`: string
- `agentId`: string
- `traceId`: string
- `triggerTextPreview`: string
- `domain`: string (New: for multi-domain support)
- `severity`: 'low' | 'medium' | 'high' | 'critical' (New: derived from score)
- `context`: Record<string, unknown> (New: for additional payload)

## 2. StorageAdapter Interface (SDK-CORE-02)

The existing `principle-tree-ledger.ts` handles JSON file storage. We need to abstract this to support future adapters (e.g., SQLite, Remote API).

**Interface:**
```typescript
export interface StorageAdapter {
  loadLedger(): Promise<HybridLedgerStore>;
  saveLedger(store: HybridLedgerStore): Promise<void>;
  // High-level operations to encapsulate locking and atomic writes
  mutateLedger<T>(mutate: (store: HybridLedgerStore) => T | Promise<T>): Promise<T>;
}
```

## 3. Storage Failure Handling (SDK-QUAL-03)

- **Retry Strategy**: Exponential backoff for file lock acquisition.
- **Fallback**: If the primary storage (e.g., `PRINCIPLE_TRAINING_FILE`) is unavailable/corrupted, attempt to use a `.bak` file or log a CRITICAL error with a memory buffer fallback (though persistence is key).
- **Atomic Writes**: Continue using `atomicWriteFileSync` but wrap it in a retry loop.

## 4. LLM Hallucination Detection (SDK-QUAL-02)

In `nocturnal-trinity.ts`, the extraction happens in stages (Dreamer -> Philosopher -> Scribe).
Hallucination detection can be implemented as a post-Scribe validation step:
1. **Source Veracity**: Check if the `badDecision` actually exists in the `NocturnalSessionSnapshot` (e.g., keyword search in assistant turns).
2. **Contextual Grounding**: Verify the proposed `betterDecision` uses tools/files mentioned in the snapshot.

## 5. Principle Text Overflow Protection (SDK-QUAL-04)

Context window management for principle injection.
- **Budgeting**: Define a max token/character limit for "active principles" in a prompt.
- **Selection**: If the limit is exceeded, use a ranking (e.g., by `score` or `relevance`) to select the top N principles.
- **Summarization**: (Optional) Summarize older or lower-priority principles if they must be included.

## 6. Baseline Metrics (SDK-OBS-01..04)

Metrics to be calculated at the end of each evolution cycle or via a standalone CLI:
- **Principle Stock**: `total_principles = active + candidate + probation`
- **Association Rate**: `count(principles_created_from_pain) / count(total_pain_signals)`
- **Internalization Rate**: `count(internalized_principles) / total_principles`
- **Association Latency**: (Optional) Average time from pain signal to principle creation.
