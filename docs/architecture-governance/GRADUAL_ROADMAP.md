# Gradual Roadmap

## Why This Must Be Gradual

This project already contains many active workflows. A broad refactor that tries to centralize all ownership at once is more likely to create outages than remove risk.

The correct strategy is:

1. make hidden structure visible
2. stop adding new uncontrolled complexity
3. validate governance in shadow mode
4. retire duplicate paths one workflow at a time

---

## Stage 0: Stop Complexity From Growing

### Goal

Prevent new hidden workflow duplication from entering the codebase.

### Allowed Changes

- governance documents
- review checklists
- ownership notes
- workflow mapping

### Forbidden Changes

- broad ownership rewrites
- forced facade adoption across the whole codebase
- changing multiple runtime workflows at once

### Exit Criteria

- architecture governance docs exist
- PR checklist exists
- new workflow work can be reviewed against explicit criteria

---

## Stage 1: Audit-Only Visibility

### Goal

Detect hidden structural risk without changing behavior.

### Work

- add duplicate writer scanner
- add workflow orphan scanner
- add invariant violation scanner
- run scanners manually first

### Operating Mode

- report only
- no automatic fixes
- no CI blocking
- warning-only if connected to CI

### Exit Criteria

- we can produce a repeatable architecture audit report
- we can name the highest-risk duplicate writers
- we can name the highest-risk orphan workflows

---

## Stage 2: Shadow Governance

### Goal

Introduce governance mechanisms without taking control away from existing runtime behavior.

### Work

- define workflow owners
- define truth sources
- define invariants
- add provenance tags where missing
- add shadow state tracking for selected workflows

### Operating Mode

- audit-only or shadow-only
- no authoritative rerouting yet
- no legacy path removal yet

### Exit Criteria

- one workflow can be observed end-to-end using shadow state
- invariants are machine-checkable for that workflow
- cleanup gaps become visible before they become outages

---

## Stage 3: Pilot Workflow Consolidation

### Goal

Use one workflow cluster as the proving ground for the governance model.

### Candidate Order

1. subagent session lifecycle
2. pain/event writes
3. routing shadow observation
4. rollback workflow
5. nocturnal session cleanup

### Selection Criteria

- clear boundary
- high operational risk
- small enough scope to revert quickly
- visible success criteria

### Required Safety Controls

- kill switch
- old path retained in shadow temporarily
- boundary test
- invariant test
- rollback plan

### Exit Criteria

- selected workflow has one owner
- duplicate write paths are retired or explicitly shadowed
- cleanup is guaranteed
- runtime behavior is verified

---

## Stage 4: Incremental Retirement

### Goal

Replace hidden overlap with explicit ownership across the project, one cluster at a time.

### Rules

- never retire two unrelated high-risk workflows in one PR
- never remove legacy path before shadow validation completes
- every retired path must be documented
- every new owner path must have tests and invariants

### Exit Criteria

- major workflow clusters have explicit owners
- duplicate writers are reduced to known, temporary exceptions only
- architecture audit can fail CI for proven high-confidence violations

---

## First 90-Day Focus

### Wave 1

- publish governance docs
- add architecture audit scripts
- produce first audit report

### Wave 2

- map domain ownership for pain, workflow lifecycle, routing, and nocturnal cleanup
- choose pilot workflow

### Wave 3

- implement shadow governance for pilot workflow
- validate against real runtime behavior

### Wave 4

- retire first duplicate path
- update docs and checklist with lessons learned

---

## What We Must Not Do

- do not attempt a repo-wide facade rewrite
- do not convert all hooks into one framework in one step
- do not let audit scripts auto-fix state
- do not make CI blocking before false-positive rate is understood
- do not keep old and new paths permanently active

---

## Review Rhythm

We should revisit this directory on a regular cadence.

Recommended cadence:

- weekly: read latest audit output
- biweekly: choose one workflow or concept to clarify
- monthly: retire or downgrade one duplicate path

This keeps the project moving without destabilizing production behavior.
