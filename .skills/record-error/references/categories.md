# Error Categories

| Category | Description | Examples |
|----------|-------------|----------|
| 1. Architecture Boundary | Violated core/plugin boundary or architectural constraints | Put I/O logic in core, put pure logic in plugin |
| 2. Missing Tests & Verification | Skipped required testing or verification steps | Didn't run tests, didn't add regression test |
| 3. Schema & Type Mistakes | Incorrect schemas, missed type safety, broke type contracts | Used `any`, wrong interface shape |
| 4. Documentation & Spec Drift | Code contradicts architecture docs or ADRs | Ignored ADR-0005, wrote code against documented decision |
| 5. Security & Safety | Introduced security risks or bypassed safety checks | Hardcoded secrets, skipped auth check |
| 6. Process & Workflow | Didn't read context, didn't follow workflow | Skipped handbook, didn't check graphify first |
