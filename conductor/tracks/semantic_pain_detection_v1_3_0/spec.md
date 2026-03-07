# Specification: Semantic Pain Detection (v1.3.0)

## Overview
Implement a three-layer semantic pain detection system to overcome the limitations of exact regex matching. This system will leverage OpenClaw's native memory search to identify un-programmed expressions of confusion and automatically promote high-frequency patterns into formal exact-match rules.

## Functional Requirements
- **L1/L2/L3 Detection Pipeline**: Implement a funnel that checks Exact Match (L1), LRU Cache (L2), and Async Vector Search (L3).
- **Native RAG Integration**: Utilize `api.runtime.tools.createMemorySearchTool` to perform asynchronous vector similarity searches without blocking the main event loop.
- **Rule Promotion**: Extract N-grams from the candidate pool (`pain_candidates.json`) inside the `EvolutionWorker` and promote them to `exact_match` rules in `pain_dictionary.json`.
- **Pre-emptive Warnings**: Use the `before_prompt_build` hook to warn the agent if its intent matches historical failure patterns.
- **Memory Compaction**: Hook into `before_compaction` to extract error stacks and reflections from discarded context, saving them to `workspaceDir/memory/pain/`.

## Non-Functional Requirements
- **Zero-Perceived Latency**: The L3 vector search must be strictly asynchronous.
- **Data Isolation**: All pain memory and candidates must be scoped to `workspaceDir/memory/pain/`.

## Acceptance Criteria
- Unknown expressions of confusion (e.g., "This is giving me a headache") are successfully matched against the `00_seed_samples.md` ground truth via L3.
- After 3 identical semantic hits, a new `exact_match` rule is automatically added to the active dictionary.
- The system correctly intercepts `before_compaction` events and writes structured error logs to the memory directory.