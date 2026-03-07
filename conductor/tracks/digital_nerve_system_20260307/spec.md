# Specification: Digital Nerve System (v1.2.0)

## Overview
Implement a dual-track pain perception system that decouples subjective keyword matching from objective physical friction.

## Functional Requirements
- Migrate existing regex-based pain signals to an external `pain_dictionary.json` in `stateDir`.
- Implement Generalized Friction Index (GFI) logic in `after_tool_call` hook.
- Implement System Override logic in `before_prompt_build` when GFI > 100.
- Add async flush of dictionary hits via `EvolutionWorker`.

## Acceptance Criteria
- `pain_dictionary.json` is successfully loaded on startup.
- Three consecutive shell errors trigger a GFI override.
- Dictionary hits are persisted to disk every 15 minutes.
