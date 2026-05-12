# Principles Disciple (PD) - System Rules for AI Assistants

**🚨 CRITICAL INSTRUCTION FOR ALL AI CODING AGENTS (Cursor, Trae, Copilot, Cline, Windsurf, etc.) 🚨**

You are working in the **Principles Disciple (PD)** monorepo. This system has STRICT architectural boundaries and an explicitly defined Domain Ontology. 

Before proposing or making any code changes, you MUST comply with the following rules. Failure to do so will result in architecture degradation.

## 1. The Core Ontology (LOCKED)
Do NOT invent synonymous terms (like Policy, Law, Guideline).
- **Principle**: A soft, highly abstract guideline (Why/What).
- **Rule**: A hard, testable contract (When/Where/How).
- **Implementation**: The physical code/hook that carries out the Rule.
*Reference: `docs/architecture/DOMAIN_MODEL.md`*

## 2. Strict Physical Boundaries (THE RED LINE)
- **Core Layer (`@principles/core` in `packages/principles-core/`)**: Pure domain logic, state machines.
  - ❌ **Incorrect**: `import { something } from 'openclaw-plugin'`
  - ✅ **Correct**: `import { something } from '../contracts/...'`
  - **Rule**: ABSOLUTELY NO imports from `openclaw-plugin`, `pd-cli`, or host layers. 

- **Host Layer (`openclaw-plugin` in `packages/openclaw-plugin/`)**: Stateless hooks and event formatting.
  - ❌ **Incorrect**: Writing complex if/else business logic or diagnosis algorithms inside a hook.
  - ✅ **Correct**: Extracting event payload and delegating to `@principles/core` Adapters/Runners.

## 3. Contract Centralization & Single Source of Truth
All core entities (Tasks, DiagnosticianOutputs, RuleHostResults) MUST have schemas defined centrally.
- ❌ **Incorrect**: Defining an ad-hoc `interface TemporaryTask` inside a runner file.
- ✅ **Correct**: Importing the TypeBox schema and interface from the centralized contracts/types directory.

## 4. State Machine Rigidity
- ❌ **Incorrect**: `task.status = 'succeeded'` (Direct assignment is forbidden).
- ✅ **Correct**: `taskStateMachine.transition(task, 'succeed')` (Use transition methods).

## 5. Pruning and Metabolism
- `Pruning Review` is a **read-only audit log**. Do NOT write code that performs physical deletion based on a Pruning Review.
- Real deletion/demotion is called `Pruning Action` (Future Scope) and requires dry-run & human confirmation.

## 📚 Required Reading for Major Changes
If asked to make architectural changes, you MUST refer to:
1. `docs/architecture/DOMAIN_MODEL.md`
2. `docs/architecture-governance/AI_DEVELOPMENT_GUARDRAILS.md`
3. `docs/architecture/PD_SYSTEM_ARCHITECTURE.md`
