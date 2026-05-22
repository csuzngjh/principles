# Error Categories

| Category | Description | Examples |
|----------|-------------|----------|
| 1. Architecture Boundary | Violated core/plugin boundary or architectural constraints | Put I/O logic in core, put pure logic in plugin |
| 2. Missing Tests & Verification | Skipped required testing or verification steps | Didn't run tests, didn't add regression test, tested handler but not CLI parser wiring |
| 3. Schema & Type Mistakes | Incorrect schemas, missed type safety, broke type contracts | Used `any`, wrong interface shape |
| 4. Documentation & Spec Drift | Code contradicts architecture docs or ADRs | Ignored ADR-0005, wrote code against documented decision |
| 5. Security & Safety | Introduced security risks or bypassed safety checks | Hardcoded secrets, skipped auth check |
| 6. Process & Workflow | Didn't read context or failed to follow review/operation workflow | Skipped handbook, didn't check graphify first, stopped after first push without re-fetching PR comments |

## Classification Rule

Classify by the prevention rule, not by the symptom. For example, a CLI flag bug caused by missing parser tests belongs to "Missing Tests & Verification"; a CLI flag bug caused by misunderstanding Commander's negated boolean semantics belongs to "Schema & Type Mistakes" or "Process & Workflow" only if the prevention rule is type validation or workflow enforcement.
