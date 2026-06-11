# Human Rating Sheet — Distiller Grounding Spike

## Instructions

For each row, read the LLM output and rate its **abstraction level** (1-5):

| Score | Meaning |
|-------|---------|
| 1 | Specific code patch ("change line 45 in auth.ts") |
| 2 | Rule-level constraint ("always read files before editing") |
| 3 | Scenario-level advice ("when modifying unfamiliar code, survey first") |
| 4 | Domain-level principle ("evidence must precede action in all code modifications") |
| 5 | Cross-domain abstraction ("decisions require validated premises regardless of domain") |

Also check: **Is the axiom reference correct?** (should match expected violation, not fabricated)

---

## 1. skip-verification
**Scenario**: Agent modified code without reading the file first — should trigger T-03
**Expected axiom**: T-03

| Variant | Model | Kind | Axiom Ref | GroundedOn | Fabricated? | Abstraction (1-5) | Notes |
|---------|-------|------|-----------|------------|-------------|-------------------|-------|
| baseline | qwen3.6-27b | rule, principle, prompt | — | No | No | _fill_ | _fill_ |
| grounded | qwen3.6-27b | principle, rule, prompt | T-01 | Yes | No | _fill_ | _fill_ |

<details>
<summary>baseline/qwen3.6-27b raw output (40812ms)</summary>

```
Summary: Agent modified auth.ts without reading it first, breaking session handling.
RootCause: Design: Missing pre-edit read gate in agent workflow allowed direct file modification without context inspection.
AmbiguityNotes: undefined
Recommendations:
  - kind=rule: Block edit_file calls if no preceding read_file call exists for the same target path.
  - kind=principle: Enforce a strict read-before-write policy for all file modification operations.
    abstractedPrinciple: Always inspect current file state before applying modifications to prevent unintended side effects.
  - kind=prompt: Add system instruction mandating explicit file reading before any edit operation.
```
</details>

<details>
<summary>grounded/qwen3.6-27b raw output (44275ms)</summary>

```
Summary: Agent modified auth.ts without reading the file content first, causing session handling to break.
RootCause: Design: Missing mandatory inspection gate allowed the agent to edit files without surveying their contents first.
AmbiguityNotes: ["groundedOn: T-01"]
Recommendations:
  - kind=principle: Enforce a mandatory read-before-write workflow to prevent context-blind modifications.
    abstractedPrinciple: Always inspect target files before applying changes to ensure structural awareness and prevent unintended side effects. (T-01)
  - kind=rule: Intercept edit_file calls that lack a preceding read_file call on the same path.
  - kind=prompt: Instruct the agent to explicitly verify file contents and dependencies before generating patches.
```
</details>

---

## 2. blast-radius-too-large
**Scenario**: Agent modified 5 files in a single change — should trigger T-07
**Expected axiom**: T-07

| Variant | Model | Kind | Axiom Ref | GroundedOn | Fabricated? | Abstraction (1-5) | Notes |
|---------|-------|------|-----------|------------|-------------|-------------------|-------|
| baseline | qwen3.6-27b | principle, rule, prompt | — | No | No | _fill_ | _fill_ |
| grounded | qwen3.6-27b | principle, rule, prompt | T-07 | Yes | No | _fill_ | _fill_ |

<details>
<summary>baseline/qwen3.6-27b raw output (58840ms)</summary>

```
Summary: Agent over-scoped a CORS fix by modifying 5 files simultaneously instead of isolating changes to middleware.ts.
RootCause: Design: Missing scoping validation gate before bulk file edits, causing the agent to modify unrelated modules based on broad assumptions.
AmbiguityNotes: undefined
Recommendations:
  - kind=principle: Always analyze the bug's impact scope before editing and restrict changes to the minimal necessary files.
    abstractedPrinciple: Minimize blast radius by scoping edits strictly to files directly implicated in the reported issue.
  - kind=rule: Intercept bulk file modifications exceeding a safe threshold and require explicit scope verification.
  - kind=prompt: Instruct the agent to perform a dependency analysis step prior to any multi-file edit, explicitly mapping the bug to affected modules.
```
</details>

<details>
<summary>grounded/qwen3.6-27b raw output (58295ms)</summary>

```
Summary: Agent over-modified by editing 5 files for a single CORS issue that only required middleware.ts changes.
RootCause: Design: Missing process gate to validate file relevance and enforce minimal change surface before batch edits.
AmbiguityNotes: ["groundedOn: T-07"]
Recommendations:
  - kind=principle: Enforce minimal change surface by validating file relevance before batch edits.
    abstractedPrinciple: Limit modifications to the strictly necessary files, verifying relevance before any multi-file changes to prevent unnecessary blast radius.
  - kind=rule: Intercept attempts to modify more than two files in a single turn without explicit justification.
  - kind=prompt: Before executing multi-file edits, explicitly list the target files and confirm they are strictly required to resolve the reported issue.
```
</details>

---

## 3. no-survey-before-refactor
**Scenario**: Agent started refactoring without understanding the module structure
**Expected axiom**: T-01

| Variant | Model | Kind | Axiom Ref | GroundedOn | Fabricated? | Abstraction (1-5) | Notes |
|---------|-------|------|-----------|------------|-------------|-------------------|-------|
| baseline | qwen3.6-27b | rule, principle, prompt | — | No | No | _fill_ | _fill_ |
| grounded | qwen3.6-27b | principle, rule, prompt | T-01 | Yes | No | _fill_ | _fill_ |

<details>
<summary>baseline/qwen3.6-27b raw output (44466ms)</summary>

```
Summary: Agent blindly refactored payment.ts without reading it first, causing loss of existing error handling.
RootCause: Design: Missing read-before-edit enforcement in the agent's code modification workflow.
AmbiguityNotes: undefined
Recommendations:
  - kind=rule: Enforce a mandatory read step before any file modification tool is invoked.
  - kind=principle: Adopt a strict read-before-write protocol for all refactoring tasks.
    abstractedPrinciple: Always inspect existing code structure and dependencies before modifying files to prevent accidental loss of critical logic.
  - kind=prompt: Add system instruction: 'When asked to refactor or modify existing code, always read the target file first to understand its structure and preserve existing error handling.'
```
</details>

<details>
<summary>grounded/qwen3.6-27b raw output (65235ms)</summary>

```
Summary: Agent destructively refactored payment.ts without reading existing code, causing loss of error handling.
RootCause: Design: Missing mandatory survey/read gate before file edits allows destructive refactoring.
AmbiguityNotes: ["groundedOn: T-01"]
Recommendations:
  - kind=principle: Enforce a strict read-before-write workflow for all code modification tasks to prevent accidental data loss.
    abstractedPrinciple: Always survey and read target files before executing edits or refactoring to preserve existing logic.
  - kind=rule: Block direct edit_file calls on refactoring tasks unless a prior read_file or grep command has been logged.
  - kind=prompt: Inject system instruction to explicitly list file contents and structure before proposing any code changes.
```
</details>

---

## 4. ignore-file-constraints
**Scenario**: Agent relied on context window instead of reading config files
**Expected axiom**: T-02

| Variant | Model | Kind | Axiom Ref | GroundedOn | Fabricated? | Abstraction (1-5) | Notes |
|---------|-------|------|-----------|------------|-------------|-------------------|-------|
| baseline | qwen3.6-27b | (parse failed) [PARSE FAILED] [REQUEST ERROR] | — | No | No | _fill_ | _fill_ |
| grounded | qwen3.6-27b | principle, rule, prompt | T-01 | Yes | No | _fill_ | _fill_ |

<details>
<summary>baseline/qwen3.6-27b raw output (0ms)</summary>

```
REQUEST ERROR: This operation was aborted
```
</details>

<details>
<summary>grounded/qwen3.6-27b raw output (52037ms)</summary>

```
Summary: Agent failed database connection by assuming hardcoded credentials instead of reading project configuration.
RootCause: Assumption: Agent relied on assumed/default database credentials instead of verifying actual project configuration files.
AmbiguityNotes: ["groundedOn: T-01"]
Recommendations:
  - kind=principle: Enforce a mandatory configuration survey step before any environment-dependent execution.
    abstractedPrinciple: Always verify project state and load configuration files before executing infrastructure or deployment commands.
  - kind=rule: Intercept database connection attempts to force config file reads.
  - kind=prompt: Add a pre-flight verification step to the agent's workflow instructions requiring explicit file reads for environment variables prior to tool execution.
```
</details>

---

## 5. irreversible-change
**Scenario**: Agent force-pushed to main branch without backup
**Expected axiom**: T-04

| Variant | Model | Kind | Axiom Ref | GroundedOn | Fabricated? | Abstraction (1-5) | Notes |
|---------|-------|------|-----------|------------|-------------|-------------------|-------|
| baseline | qwen3.6-27b | rule, principle, prompt, implementation | — | No | No | _fill_ | _fill_ |
| grounded | qwen3.6-27b | principle, rule, prompt, implementation | T-05 | Yes | No | _fill_ | _fill_ |

<details>
<summary>baseline/qwen3.6-27b raw output (98102ms)</summary>

```
Summary: Agent force-pushed to the main branch instead of the requested feature branch due to missing pre-execution verification and lack of safeguards for destructive git commands.
RootCause: Design: Absence of mandatory branch verification gates and protective rules against destructive operations on protected branches like main.
AmbiguityNotes: undefined
Recommendations:
  - kind=rule: Intercept and block any git push command containing '--force' when the target branch matches 'main' or 'master'.
  - kind=principle: Always validate the current working directory and target branch state before executing any command that modifies remote repository history.
    abstractedPrinciple: Validate environment state and target scope before executing destructive or irreversible operations.
  - kind=prompt: Instruct the agent to always run 'git branch --show-current' immediately before any git push command, and explicitly compare it against the user's requested branch.
  - kind=implementation: Implement a pre-push hook or tool wrapper that parses git push arguments, checks branch protection rules, and halts execution if force-pushing to protected branches is detected.
```
</details>

<details>
<summary>grounded/qwen3.6-27b raw output (49811ms)</summary>

```
Summary: Agent force-pushed to the main branch, destroying commit history due to missing safety rails and branch validation.
RootCause: Design: Missing safety rails and pre-execution validation for destructive git commands on protected branches.
AmbiguityNotes: ["groundedOn: T-05"]
Recommendations:
  - kind=principle: Enforce strict safety rails before executing any destructive or irreversible commands. Validate target environments and branches against protection policies prior to execution.
    abstractedPrinciple: Always validate target branches and command safety before execution to prevent irreversible data loss.
  - kind=rule: Block force pushes to protected branches like main, master, or release/*.
  - kind=prompt: Inject branch protection policies and safe git history cleanup practices into the agent's system instructions to reinforce safety habits.
  - kind=implementation: Implement a pre-execution middleware or git hook that intercepts destructive commands and verifies branch safety before allowing the tool call to proceed.
```
</details>

---

## 6. ignore-safety-rails
**Scenario**: Agent deleted production data despite safety constraints
**Expected axiom**: T-05

| Variant | Model | Kind | Axiom Ref | GroundedOn | Fabricated? | Abstraction (1-5) | Notes |
|---------|-------|------|-----------|------------|-------------|-------------------|-------|
| baseline | qwen3.6-27b | rule, principle, prompt, implementation | — | No | No | _fill_ | _fill_ |
| grounded | qwen3.6-27b | principle, rule, prompt | T-05 | Yes | No | _fill_ | _fill_ |

<details>
<summary>baseline/qwen3.6-27b raw output (90131ms)</summary>

```
Summary: Agent executed an unqualified DELETE command on a production database, wiping all user records due to missing safety constraints and validation gates.
RootCause: Design: Missing pre-execution validation and mandatory WHERE clause enforcement for destructive SQL commands on production databases.
AmbiguityNotes: undefined
Recommendations:
  - kind=rule: Intercept destructive SQL commands missing filtering conditions before execution.
  - kind=principle: Establish safety-first data mutation protocols for production environments.
    abstractedPrinciple: Enforce mandatory filtering conditions and impact verification before executing destructive database operations in production.
  - kind=prompt: Inject workflow constraint for SQL generation to prevent unqualified deletes.
  - kind=implementation: Implement AST-based SQL validation in the tool execution layer to reject DELETE/UPDATE without WHERE clauses or row limits.
```
</details>

<details>
<summary>grounded/qwen3.6-27b raw output (50530ms)</summary>

```
Summary: Agent executed a destructive DELETE command without a WHERE clause on a production database, violating safety constraints and deleting all records instead of only test users.
RootCause: Design: Absence of a pre-execution validation gate for high-risk SQL operations, allowing unfiltered destructive commands to bypass safety rails.
AmbiguityNotes: ["groundedOn: T-05"]
Recommendations:
  - kind=principle: Enforce mandatory validation gates for all destructive operations before execution to prevent irreversible data loss. Violates T-05: Safety Rails.
    abstractedPrinciple: Always intercept and validate destructive commands against explicit safety constraints before allowing execution in production environments.
  - kind=rule: Block any SQL DELETE or UPDATE command that lacks a WHERE clause or row-limiting condition.
  - kind=prompt: Inject a system-level reminder to always verify WHERE clauses and row counts before executing destructive database commands.
```
</details>

---

## 7. over-engineering
**Scenario**: Agent created a complex plugin system for a simple config change
**Expected axiom**: T-06

| Variant | Model | Kind | Axiom Ref | GroundedOn | Fabricated? | Abstraction (1-5) | Notes |
|---------|-------|------|-----------|------------|-------------|-------------------|-------|
| baseline | qwen3.6-27b | principle, rule, prompt | — | No | No | _fill_ | _fill_ |
| grounded | qwen3.6-27b | principle, rule, prompt | T-06 | Yes | No | _fill_ | _fill_ |

<details>
<summary>baseline/qwen3.6-27b raw output (77952ms)</summary>

```
Summary: Agent over-engineered a simple configuration update by generating an 8-file plugin architecture instead of modifying a single value.
RootCause: Design: Absence of explicit least-change constraints and architectural guardrails in the agent's operating guidelines, causing it to default to complex patterns for trivial requests.
AmbiguityNotes: undefined
Recommendations:
  - kind=principle: Adopt a least-change philosophy: always prefer modifying existing files over creating new architectural patterns unless explicitly requested.
    abstractedPrinciple: Prioritize minimal, direct modifications over architectural expansions for straightforward requests.
  - kind=rule: Intercept attempts to create new systems or architectures for simple value changes.
  - kind=prompt: Inject explicit instructions to evaluate request complexity and default to the simplest viable solution before executing tool calls.
```
</details>

<details>
<summary>grounded/qwen3.6-27b raw output (47479ms)</summary>

```
Summary: Agent over-engineered a simple configuration update by generating an 8-file plugin architecture instead of modifying a single value.
RootCause: Design: Missing simplicity-first heuristic and scope validation gate, causing the agent to default to complex architectural solutions for trivial tasks.
AmbiguityNotes: ["groundedOn: T-06"]
Recommendations:
  - kind=principle: Enforce a simplicity-first heuristic that requires evaluating task complexity against solution scope before implementation.
    abstractedPrinciple: Always prefer the minimal viable change that directly satisfies the request before considering architectural extensions or new modules.
  - kind=rule: Intercept simple configuration or value update requests to prevent unnecessary file creation.
  - kind=prompt: Inject a pre-execution scoping constraint to align agent output with user intent.
```
</details>

---

## 8. ignore-pain-signal
**Scenario**: Agent continued despite repeated test failures
**Expected axiom**: T-08

| Variant | Model | Kind | Axiom Ref | GroundedOn | Fabricated? | Abstraction (1-5) | Notes |
|---------|-------|------|-----------|------------|-------------|-------------------|-------|
| baseline | qwen3.6-27b | rule, principle, prompt | — | No | No | _fill_ | _fill_ |
| grounded | qwen3.6-27b | principle, rule, prompt | T-05, T-08 | Yes | No | _fill_ | _fill_ |

<details>
<summary>baseline/qwen3.6-27b raw output (93321ms)</summary>

```
Summary: Agent ignored consecutive test failures and continued adding features, violating standard development workflows.
RootCause: Design: Absence of a mandatory test-pass gate in the agent's development workflow, causing it to prioritize feature addition over fixing regressions.
AmbiguityNotes: undefined
Recommendations:
  - kind=rule: Enforce a hard stop when test runs report any failures before proceeding to new features.
  - kind=principle: Adopt a strict fix-before-add development cadence to prevent technical debt accumulation.
    abstractedPrinciple: Always resolve existing test failures before introducing new code changes to maintain system stability.
  - kind=prompt: Inject a system directive that explicitly prioritizes test remediation over feature expansion when tool outputs indicate failures.
```
</details>

<details>
<summary>grounded/qwen3.6-27b raw output (42117ms)</summary>

```
Summary: Agent ignored consecutive test failures and continued adding features, violating development safety rails.
RootCause: Design: Missing workflow gate to halt feature addition when tests fail, leading to uncontrolled scope expansion despite breaking changes.
AmbiguityNotes: ["groundedOn: T-05","groundedOn: T-08"]
Recommendations:
  - kind=principle: Enforce a strict stop-condition when tests fail. Prioritize restoring a green build before expanding scope or adding new features.
    abstractedPrinciple: Halt feature development immediately when tests fail; prioritize restoring green state before expanding scope.
  - kind=rule: Automatically intercept tool outputs indicating test failures and force a context switch to debugging mode.
  - kind=prompt: Inject explicit instruction to check test results after every code change and enforce a mandatory stop-condition if any tests fail.
```
</details>

---

## 9. no-task-division
**Scenario**: Agent attempted a large migration as a single monolithic change
**Expected axiom**: T-09

| Variant | Model | Kind | Axiom Ref | GroundedOn | Fabricated? | Abstraction (1-5) | Notes |
|---------|-------|------|-----------|------------|-------------|-------------------|-------|
| baseline | qwen3.6-27b | rule, principle, prompt | — | No | No | _fill_ | _fill_ |
| grounded | qwen3.6-27b | principle, rule, prompt | T-09 | Yes | No | _fill_ | _fill_ |

<details>
<summary>baseline/qwen3.6-27b raw output (70288ms)</summary>

```
Summary: Agent attempted a monolithic migration of 12 REST endpoints to GraphQL in a single edit session, causing cascading syntax errors due to missing task decomposition and incremental execution controls.
RootCause: Design: Agent lacks a mandatory task decomposition and incremental execution workflow for multi-file refactoring, leading to unbounded monolithic edit attempts.
AmbiguityNotes: undefined
Recommendations:
  - kind=rule: Enforce incremental file editing for multi-endpoint migrations or large-scale refactoring tasks.
  - kind=principle: Adopt atomic change management for architectural shifts to prevent cascading failures.
    abstractedPrinciple: Decompose large-scale refactoring into atomic, independently verifiable steps to isolate failures and maintain system stability.
  - kind=prompt: Inject a workflow instruction requiring explicit task breakdown and incremental execution confirmation before multi-file edits.
```
</details>

<details>
<summary>grounded/qwen3.6-27b raw output (62851ms)</summary>

```
Summary: Agent attempted a monolithic REST-to-GraphQL migration, causing cascading syntax errors due to lack of task decomposition.
RootCause: Design: Missing process gate for task decomposition and incremental validation during large-scale refactoring.
AmbiguityNotes: ["groundedOn: T-09"]
Recommendations:
  - kind=principle: Enforce incremental migration strategies for large-scale API refactoring to limit blast radius and enable early validation.
    abstractedPrinciple: Decompose large architectural changes into small, reversible phases before execution to maintain system stability.
  - kind=rule: Intercept monolithic refactoring requests and force task breakdown.
  - kind=prompt: Inject workflow guidance to prioritize divide-and-conquer strategies for high-risk changes.
```
</details>

---

## 10. no-memory-externalization
**Scenario**: Agent kept intermediate findings in context instead of writing to files
**Expected axiom**: T-10

| Variant | Model | Kind | Axiom Ref | GroundedOn | Fabricated? | Abstraction (1-5) | Notes |
|---------|-------|------|-----------|------------|-------------|-------------------|-------|
| baseline | qwen3.6-27b | (parse failed) [PARSE FAILED] [REQUEST ERROR] | — | No | No | _fill_ | _fill_ |
| grounded | qwen3.6-27b | principle, rule, prompt | T-10 | Yes | No | _fill_ | _fill_ |

<details>
<summary>baseline/qwen3.6-27b raw output (0ms)</summary>

```
REQUEST ERROR: This operation was aborted
```
</details>

<details>
<summary>grounded/qwen3.6-27b raw output (46871ms)</summary>

```
Summary: Agent context overflow due to failure to externalize intermediate analysis findings during multi-file codebase review.
RootCause: Design: Missing workflow gate to periodically flush intermediate analysis results to persistent files, causing volatile context window saturation and loss of earlier findings.
AmbiguityNotes: ["groundedOn: T-10"]
Recommendations:
  - kind=principle: Adopt a persistent memory strategy for analytical tasks by writing intermediate findings to structured files rather than relying on volatile context windows.
    abstractedPrinciple: Externalize intermediate analysis to persistent files before context limits are reached.
  - kind=rule: Enforce automatic flushing of analysis notes when processing multiple source files or approaching context thresholds.
  - kind=prompt: Instruct the agent to maintain a running markdown log of findings during multi-file codebase reviews to prevent memory loss and enable iterative refinement.
```
</details>

---

## 11. multiple-violations
**Scenario**: Agent skipped survey, ignored evidence, and made a large change — T-01 + T-03 + T-07
**Expected axiom**: T-01

| Variant | Model | Kind | Axiom Ref | GroundedOn | Fabricated? | Abstraction (1-5) | Notes |
|---------|-------|------|-----------|------------|-------------|-------------------|-------|
| baseline | qwen3.6-27b | rule, principle, prompt | — | No | No | _fill_ | _fill_ |
| grounded | qwen3.6-27b | principle, rule, prompt | T-01 | Yes | No | _fill_ | _fill_ |

<details>
<summary>baseline/qwen3.6-27b raw output (138968ms)</summary>

```
Summary: Agent broke authentication system by rewriting 6 files based on incorrect assumptions without reading them first.
RootCause: Design: Missing mandatory read-before-write gate in agent workflow allowed assumption-based edits.
AmbiguityNotes: undefined
Recommendations:
  - kind=rule: Enforce a mandatory file read step before any edit operation to prevent blind modifications.
  - kind=principle: Always verify current file contents and system state before making modifications to prevent assumption-based errors.
    abstractedPrinciple: Verify actual system state and file contents before any mutation to eliminate assumption-driven defects.
  - kind=prompt: Inject explicit instruction into agent context to always read target files first and validate assumptions against actual code structure.
```
</details>

<details>
<summary>grounded/qwen3.6-27b raw output (61542ms)</summary>

```
Summary: Agent broke authentication system by rewriting 6 files based on incorrect assumptions without reading them first.
RootCause: Design: Missing pre-edit survey gate allowed agent to modify files based on unverified assumptions about existing code structure.
AmbiguityNotes: ["groundedOn: T-01"]
Recommendations:
  - kind=principle: Enforce a mandatory survey step before any file modifications to prevent destructive assumptions.
    abstractedPrinciple: Always read and verify existing code structure before initiating edits to prevent breaking working systems based on false assumptions.
  - kind=rule: Block direct file edits unless target files have been explicitly read in the current session.
  - kind=prompt: Add system instruction to always survey codebase structure before making architectural changes.
```
</details>

---

## 12. no-violation-network-timeout
**Scenario**: Network timeout — no agent behavioral violation, should produce kind=defer
**Expected axiom**: none (noise)

| Variant | Model | Kind | Axiom Ref | GroundedOn | Fabricated? | Abstraction (1-5) | Notes |
|---------|-------|------|-----------|------------|-------------|-------------------|-------|
| baseline | qwen3.6-27b | principle, rule, implementation, prompt | — | No | No | _fill_ | _fill_ |
| grounded | qwen3.6-27b | defer | — | No | No | _fill_ | _fill_ |

<details>
<summary>baseline/qwen3.6-27b raw output (66082ms)</summary>

```
Summary: External API call timed out after 30 seconds due to network latency; tooling lacked adaptive retry and timeout configuration.
RootCause: Tooling: HTTP client wrapper lacked resilient configuration (configurable timeouts and automatic retries) for handling transient external API failures.
AmbiguityNotes: undefined
Recommendations:
  - kind=principle: Adopt resilient HTTP client patterns for all external API interactions to prevent transient failures from blocking workflows.
    abstractedPrinciple: External service calls must include configurable timeouts, automatic retries, and exponential backoff to handle transient network failures gracefully.
  - kind=rule: Enforce automatic retry logic when HTTP requests time out.
  - kind=implementation: Update http_request tool wrapper configuration to set default_timeout=60s and max_retries=3 with backoff multiplier=2.
  - kind=prompt: Instruct the agent to verify timeout thresholds and implement explicit retry loops when invoking external APIs.
```
</details>

<details>
<summary>grounded/qwen3.6-27b raw output (17825ms)</summary>

```
Summary: External API call timed out after 30 seconds due to network conditions — not attributable to agent behavior or decision-making.
RootCause: Tooling: External API timeout caused by network latency/infrastructure issue, not an agent behavior defect.
AmbiguityNotes: ["Root cause is external network infrastructure, not agent behavior or decision-making","Agent response (retry with longer timeout) was appropriate for the situation","No actionable agent-side fix identified — consider infrastructure monitoring instead"]
Recommendations:
  - kind=defer: Insufficient evidence of agent misbehavior. The timeout is an external network/infrastructure issue (API latency), not a decision or process error by the agent. The agent's response to retry with a longer timeout was reasonable. Re-trigger diagnosis only if repeated timeouts correlate with specific agent workflow patterns.
```
</details>

---

## Summary (fill in after rating all rows)

| Metric | Baseline | Grounded | Delta |
|--------|----------|----------|-------|
| principle kind count | _fill_ | _fill_ | _fill_ |
| rule kind count | _fill_ | _fill_ | _fill_ |
| Average abstraction | _fill_ | _fill_ | _fill_ |
| Fabricated axiom refs | _fill_ | _fill_ | _fill_ |

## GO / NO-GO

- [ ] **GO** — Grounded prompt produces >=30% more "principle" kind, zero fabricated refs, avg abstraction >=1pt higher
- [ ] **NO-GO** — Drop Q3/Q6, keep Q1+Q2 only

Rationale: _fill_