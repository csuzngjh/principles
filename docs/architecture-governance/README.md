# Architecture Governance

This directory contains the project-level governance documents for reducing hidden workflow breakage, duplicate implementations, implicit protocol drift, and multi-source state conflicts.

These documents are intentionally incremental. They are not a mandate for a single large refactor. They exist to let the project move from:

- hidden workflow ownership
- duplicated write paths
- string-based implicit contracts
- weak runtime observability

to:

- explicit ownership
- workflow registries
- machine-checkable invariants
- gradual retirement of duplicate paths

## Documents

- `ARCHITECTURE_GUARDRAILS.md`
  The top-level architectural rules for workflow-heavy code.
- `GRADUAL_ROADMAP.md`
  The incremental adoption plan. This is the main operational document for periodic follow-up.
- `DOMAIN_OWNERSHIP_BOOTSTRAP.md`
  A first-pass ownership map for the current codebase, focused on high-risk concepts.
- `WORKFLOW_REGISTRY_BOOTSTRAP.md`
  A first-pass registry of workflow clusters that currently exist in the project.
- `PR_ARCHITECTURE_CHECKLIST.md`
  Review checklist for architecture-sensitive pull requests.

## How To Use This Directory

1. Start with `GRADUAL_ROADMAP.md`.
2. Use `DOMAIN_OWNERSHIP_BOOTSTRAP.md` to identify duplicated writers.
3. Use `WORKFLOW_REGISTRY_BOOTSTRAP.md` to identify unclear workflow ownership.
4. Use `PR_ARCHITECTURE_CHECKLIST.md` for every PR that touches hooks, runtime workflows, state writes, routing, or cleanup.
5. Update these docs gradually as workflows are clarified and old paths are retired.

## Non-Goals

These documents do not require:

- a full-project rewrite
- immediate replacement of all legacy paths
- instant adoption of new facades or state machines

The first goal is visibility and control. Consolidation comes later, one workflow at a time.
