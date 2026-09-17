# Error Categories

Exact values accepted by the record validator (`scripts/error-records.cjs` `VALID_CATEGORIES`) — pass them verbatim to `error:record create-pattern --category`:

| Category (exact value) | Description | Examples |
|----------|-------------|----------|
| `Architecture Boundary Violations` | Violated core/plugin boundary or architectural constraints | Put I/O logic in core, put pure logic in plugin |
| `Missing Tests & Verification` | Skipped required testing or verification steps | Didn't run tests, didn't add regression test |
| `Schema & Type Mistakes` | Incorrect schemas, missed type safety, broke type contracts | Used `any`, wrong interface shape |
| `Documentation & Spec Drift` | Code contradicts architecture docs or ADRs | Ignored ADR-0005, wrote code against documented decision |
| `Security & Safety` | Introduced security risks or bypassed safety checks | Hardcoded secrets, skipped auth check |
| `Process & Workflow` | Didn't read context, didn't follow workflow | Skipped the Pattern Index, didn't check graphify first |
