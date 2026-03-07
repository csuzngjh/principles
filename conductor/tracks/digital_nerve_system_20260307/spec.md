# Specification: Digital Nerve System (v1.2.0)

## Overview
Implement a dual-track pain perception system that decouples subjective keyword matching (Track B) from objective physical friction (Track A). This system transforms the agent into a self-aware entity capable of recognizing its own deadlocks and learning from failures through a "Digital Nerve System."

## Functional Requirements

### Track A: Generalized Friction Index (GFI) - Empirical Pain
- **Objective Monitoring**: Track physical friction based on tool execution results.
- **GFI Formula**: `GFI_new = max(0, GFI_old + (Delta_F * M_loop)) - C_cool`.
    - **Delta_F**: Exit Code != 0 (+30), Syntax/JSON Error (+40), User Intervene (+80).
    - **M_loop**: Multiplier for identical errors detected via "Denoised Hashing" (stripping timestamps/hex addresses).
    - **C_cool**: Immediate reset to 0 upon any successful tool execution.
- **System Override**: When `GFI > 100`, intercept the prompt and force a `<reflection>` mode by injecting a high-priority system message.

### Track B: Dynamic Pain Dictionary - Semantic Pain
- **Externalized Logic**: Move hardcoded regex patterns from `llm.ts` to `stateDir/pain_dictionary.json`.
- **Memory Optimization**: Load dictionary into memory at startup; perform matches in-memory to avoid I/O bottlenecks.
- **Lifecycle Management**: Track `hits` for each rule.
- **Async Persistence**: Use `EvolutionWorker` to flush hit counters to disk every 15 minutes.

## Non-Functional Requirements
- **Performance**: Zero synchronous I/O in the main dialogue loop (except for initial load).
- **Decoupling**: No pain signals should be hardcoded in the `.ts` files.
- **Robustness**: Error handling for corrupted JSON or missing files in `stateDir`.

## Acceptance Criteria
- `pain_dictionary.json` is automatically initialized if missing.
- Three consecutive identical shell errors trigger a GFI override and force reflection.
- Valid tool execution immediately clears the GFI score.
- Hit counters in `pain_dictionary.json` are correctly updated asynchronously.
