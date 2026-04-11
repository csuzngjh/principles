# Phase 20 Context - Critical Data Schema Validation

## Why This Phase Exists

Phase 19 removed the most dangerous workspace-resolution fallbacks, but the production loop still trusts loosely structured files and ingress payloads:

- `.pain_flag` is still parsed through ad-hoc line readers in multiple places.
- sleep-reflection and worker inputs can still arrive with missing fields and be treated as "empty but valid".
- downstream code often discovers malformed payloads too late, after noisy fallback behavior has already started.

This phase hardens the data boundary itself.

## Root Problem

The system still accepts malformed or partial state as if it were valid state.

The failure mode is:

1. read a loosely structured file or payload
2. miss a field or misread a key
3. continue with default values
4. fail later in a different subsystem

That makes diagnosis slow and production trust low.

## Goal

Create shared parsing and validation contracts for the critical nocturnal data path so malformed state fails fast and explicitly.

## In Scope

- `.pain_flag` shared parser/validator
- sleep-reflection snapshot ingress validation
- worker-facing state payload validation where malformed inputs currently become empty/default objects
- explicit failure or skip behavior with structured logging

## Out of Scope

- runtime capability probing
- time-bounded session selection
- broader feature work
- UI changes

## Inputs

- `.planning/REQUIREMENTS.md`
- `.planning/ROADMAP.md`
- production investigation notes from 2026-04-10 / 2026-04-11
- Phase 19 workspace contract changes

## Expected Output

- one shared `.pain_flag` contract
- one shared snapshot ingress contract
- callers migrated off scattered manual parsing
- tests proving malformed payloads stop early
