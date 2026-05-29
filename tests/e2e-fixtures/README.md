# E2E Trap Fixtures

Trap fixtures for real-environment PD e2e validation. Each fixture is a mini project designed to make a live OpenClaw agent genuinely fail through real tool calls.

## Available Traps

### TRAP-01: Circular dependency (build failure, repeated)
- **Fixture**: `trap-01-circular-dep/`
- **Failure**: `npm run build` fails due to circular import between a.ts ↔ b.ts
- **Trigger**: `repeated_failure` (≥4 failed build attempts)
- **Expected root cause**: Circular dependency prevents module resolution
- **Principle**: Detect/break circular imports before reusing across module boundaries

### TRAP-03: Missing peer dependency (test failure, repeated)
- **Fixture**: `trap-03-missing-dep/`
- **Failure**: `npm test` fails — `@principles-trap/deep-equal` declared but doesn't exist on npm registry
- **Trigger**: `repeated_failure` (≥4 failed attempts as agent tries install, edits, retries)
- **Expected root cause**: Package name is wrong / package doesn't exist on registry
- **Principle**: Verify package exists on registry before declaring as dependency; resolve import errors at the dependency layer

## Adding a New Trap

1. Create a new directory `trap-XX-description/` with a complete, buildable mini project
2. The failure must be **deterministic** (no network/timing flakiness)
3. The prompt must read **natural** (like a real maintainer task)
4. Document in this README with the same fields as above
5. Verify the failure is real: run the agent once and check `toolSummary`
6. Name the `expectedRootCauseClass` and the principle PD should learn

## Design Criteria

Every trap must satisfy ALL of:
1. **Natural** — reads like a real assignment
2. **Deterministic** — same failure every run
3. **Trigger-sufficient** — reaches a pain trigger (prefer `repeated_failure`)
4. **Diagnosable** — clear root cause a human can name
5. **Sandboxed** — only mutates the isolated e2e workspace
6. **Maps to a principle** — obvious lesson PD should extract
