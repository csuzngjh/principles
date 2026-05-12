## Gemini Core Layer Instructions

**CRITICAL ARCHITECTURE GUARDRAIL:**
You are currently operating in the `@principles/core` package. This is the **Core Domain Layer** of the application.

1. **Absolute Dependency Ban**: You are **ABSOLUTELY PROHIBITED** from importing any files, types, or services from `openclaw-plugin`, `pd-cli`, or any other host integration layers. The Core Domain must remain 100% agnostic of the specific host framework.
2. **Infrastructure Boundaries**: You may use standard Node.js libraries (`path`, `fs`) and database drivers like `better-sqlite3`, but you must abstract them behind an `Adapter` or `Store` interface.
3. **Contracts Directory**: All definitions of schemas and types must live within `src/contracts/` (or `src/types/` pending refactoring). Do not define temporary ad-hoc schemas inside runner files.
4. **State Transitions**: Never mutate a task or entity state with a direct property assignment (e.g., `task.status = 'succeeded'`). You must strictly adhere to the defined state machine transitions.

> By modifying code in this directory, you agree to uphold these principles strictly to prevent architecture degradation.