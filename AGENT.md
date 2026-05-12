# Principles Disciple (PD) - System Rules for AI Assistants

**🚨 CRITICAL INSTRUCTION FOR ALL AI CODING AGENTS (Cursor, Trae, Copilot, Cline, Windsurf, etc.) 🚨**

You are working in the **Principles Disciple (PD)** monorepo. This system has STRICT architectural boundaries and an explicitly defined Domain Ontology. 

Before proposing or making any code changes, you MUST read and comply with the following rules. Failure to do so will result in architecture degradation and PR rejection.

## 1. The Core Ontology (LOCKED)
The system is built around a strict ontology. Do NOT invent synonymous terms (like Policy, Law, Guideline).
- **Principle**: A soft, highly abstract guideline (Why/What).
- **Rule**: A hard, testable contract (When/Where/How).
- **Implementation**: The physical code/hook that carries out the Rule.
*For full details, see: `docs/architecture/DOMAIN_MODEL.md`*

## 2. Strict Physical Boundaries (THE RED LINE)
This project separates the core engine from the host integration. You MUST NOT breach these boundaries:

- **Core Layer (`@principles/core`)** -> located in `packages/principles-core/`
  - **Rule**: ABSOLUTELY NO imports from `openclaw-plugin`, `pd-cli`, or any host integration layers.
  - **Rule**: Pure domain logic, state machines, and pure TS data structures only. Do not add framework-specific APIs here.
- **Host Layer (`openclaw-plugin`)** -> located in `packages/openclaw-plugin/`
  - **Rule**: ABSOLUTELY NO heavy domain logic, diagnosis algorithms, or principle evaluation logic.
  - **Rule**: Hooks must be stateless and "dumb" - capture events, format data, and delegate to `@principles/core` Runners/Adapters.

## 3. Contract Centralization & Single Source of Truth
- **Rule**: Do NOT define ad-hoc interfaces or schemas inside runner or hook files. 
- All core entities (Tasks, DiagnosticianOutputs, PainSignals, RuleHostResults) MUST have their schemas and interfaces defined centrally (Target: `@principles/core/src/contracts` or `types`).
- **Rule**: We use `TypeBox` for runtime validation at the boundaries. If you change a data structure, you must update the Schema, not just the TS interface.

## 4. State Machine Rigidity
- **Rule**: NEVER mutate a state property directly via assignment (e.g., `task.status = 'succeeded'`).
- All state transitions MUST flow through designated State Machine transition methods to ensure pre-condition checks.

## 5. Pruning and Metabolism
- **Rule**: `Pruning Review` is a read-only audit log and MUST NOT perform physical deletion or ledger mutation.
- Real deletion/demotion is called `Pruning Action` and requires human confirmation and rollback plans.

## 📚 Required Reading for Major Changes
If you are asked to make architectural changes, you MUST NOT proceed without human architect approval via an ADR (Architecture Decision Record). Always refer to:
1. `docs/architecture/DOMAIN_MODEL.md` (Locked Ontology)
2. `docs/architecture-governance/AI_DEVELOPMENT_GUARDRAILS.md` (Guardrails)
3. `docs/architecture/PD_SYSTEM_ARCHITECTURE.md` (Blueprint)