# AGENTS.md — Principles Disciple Engineering Constitution

> This file is the canonical engineering policy for AI agents working in the Principles Disciple repository.
>
> Tool-specific files such as `CLAUDE.md` and `GEMINI.md` may add tool/environment guidance, but MUST NOT redefine product boundaries, architecture policy, verification policy, stable rule IDs, or PR governance defined here.

---

# 1. Product Boundary — Read First

Principles Disciple (PD) is an **Owner-governed behavior internalization system for AI agents**.

Canonical product orientation:

* `docs/product/PRODUCT_IDENTITY.md`
* `docs/adr/0014-mvp-first-strategy-and-product-pivot.md`
* `docs/plans/post-mvp-conditional-roadmap.md`

PD owns:

* Owner-relevant behavioral evidence;
* diagnosis of repeated behavioral patterns;
* reviewable Principle proposals;
* Owner approval / rejection / archive decisions;
* reversible activation;
* later observation of behavior change.

PD does **not** own:

* general task execution;
* general agent orchestration;
* general-purpose memory;
* generic tool retry;
* generic LLM output repair;
* autonomous value decisions without an Owner.

Do not duplicate capabilities already owned by the host runtime unless repository evidence shows PD must own the responsibility.

PD remains **MVP-first** unless the Owner explicitly changes that direction.

For unsolicited adjacent opportunities:

> record them as follow-up candidates; do not automatically implement them.

---

# 2. Engineering Constitution

These principles take precedence over TDD, BDD, Clean Code rules, design patterns, preferred function size, or other implementation methodologies.

## P1 — Evidence Over Assumption

Never implement from remembered architecture, stale documentation, issue wording, previous PRs, or SPEC assumptions alone.

Verify material facts using the current repository:

* production code;
* schemas/types;
* migrations/stores;
* production wiring;
* consumers;
* tests;
* configuration;
* runtime/database evidence when available.

A SPEC expresses intended change.

It does not prove current implementation reality.

---

## P2 — Survey Before Acting

Before substantial implementation, determine:

1. Where does the current behavior live?
2. What is the authoritative source of truth?
3. Which production path consumes it?
4. Which tests currently protect it?
5. Which existing abstraction owns this responsibility?
6. Is there already another implementation of the proposed mechanism?
7. What is the smallest verified gap?

Do not begin by designing a new subsystem.

Begin by discovering what already exists.

---

## P3 — Minimal Change Surface

Solve the stated problem with the smallest coherent change.

Do not:

* perform unrelated refactors;
* redesign neighboring systems because they could be cleaner;
* add infrastructure for hypothetical future work;
* widen a PR because review discovered adjacent opportunities.

Adjacent improvements become follow-up work unless required for correctness or safety of the current task.

---

## P4 — One Source of Truth

A durable fact must have one authoritative owner.

Do not create an independent second truth for:

* Principle lifecycle;
* approvals;
* activation;
* Owner decisions;
* RuleCode state;
* internalization task state;
* governance facts;
* configuration;
* lineage.

Caches, projections, snapshots, read models, analytics and UI state must remain derived.

A read model must not quietly become a write authority.

---

## P5 — Verification First

Before implementation, determine:

> What evidence would convince us that this change is correct?

Choose the verification method based on the task:

* reproducible bug → regression test;
* pure logic / validator → unit or property test;
* Owner-visible workflow → BDD / scenario / E2E;
* SQLite / persistence → integration + round-trip;
* schema / API → contract test;
* CLI → real parser/registration test;
* host integration → production-path integration;
* cross-package contract → consumer test;
* security/safety boundary → negative/adversarial test;
* refactor → characterization + existing contract tests.

TDD and BDD are tools, not universal requirements.

Prefer tests that exercise the real public/production boundary over tests that only exercise internal helpers.

---

## P6 — Deep Modules, Stable Interfaces

Prefer modules that hide substantial complexity behind small, stable semantic interfaces.

Do not equate:

* small functions;
* many files;
* many interfaces;
* many services;
* many design patterns

with good architecture.

Ask:

> How much behavior does the caller receive for how much interface it must understand?

A useful abstraction increases that leverage.

---

## P7 — No Speculative Abstraction

Do not create interfaces, adapters, factories, registries, providers, strategies, managers, extension points, background processes, feature flags, or new subsystems for hypothetical future requirements.

A seam should represent a real variation axis.

Useful heuristic:

* zero implementation → usually speculative;
* one implementation → question whether the seam is needed;
* two materially different implementations → likely real seam.

Do not mechanically delete existing seams without checking consumers, compatibility and ownership.

---

## P8 — Optimize for Future Change

Judge design by whether the next likely change becomes:

* local;
* predictable;
* understandable;
* testable;
* reversible.

Optimize total system cognitive load, not local stylistic purity.

---

# 3. Truth and Authority Model

Always distinguish **Intent Truth** from **Implementation Truth**.

## 3.1 Intent Truth — what SHOULD happen

Use this order:

1. explicit current Owner instruction;
2. approved current issue / SPEC acceptance criteria;
3. `docs/product/PRODUCT_IDENTITY.md`;
4. applicable non-superseded ADRs and amendments;
5. active product / behavioral contracts.

An ADR may preserve historical material.

Check:

* status;
* superseding ADRs;
* amendments;
* historical notes.

A conflict with an applicable ADR is a **design-drift signal**, not automatic permission to rewrite code.

## 3.2 Implementation Truth — what DOES happen

Use this order:

1. current production code;
2. schemas / migrations / stores / types;
3. production wiring / entry points;
4. tests exercising the production path;
5. package/config manifests;
6. runtime evidence.

Narrative documentation is useful for navigation but is not automatically implementation truth.

## 3.3 Conflict

If Intent Truth and Implementation Truth differ:

do not silently choose one.

Determine whether:

* code is behind the approved design;
* documentation is stale;
* an ADR was superseded;
* the SPEC assumption is wrong;
* migration is incomplete.

Document material drift in the PR.

---

# 4. Stable MVP Contract IDs

The following IDs are repository-stable interfaces and may be referenced by PR templates, ADRs, SPECs and historical decisions.

Do not casually rename or remove them.

## `mvp-q-1-what-if-skip`

What happens if we do not do this?

For new product scope or a non-listed MVP addition, explain the actual consequence of skipping it.

If there is no concrete consequence or evidence of need, do not implement it.

## `mvp-q-2-how-observed`

How will the Owner or operator observe that it works?

Examples:

* UI behavior;
* CLI result;
* persisted fact;
* runtime event;
* testable externally visible behavior.

A feature with no meaningful observation path is incomplete.

## `mvp-q-3-how-disabled`

What is the rollback, disable or recovery strategy?

A new feature flag is **not automatically required**.

Prefer:

1. existing controlling mechanism;
2. existing feature flag;
3. reversible state/deactivation;
4. backward-compatible rollback;
5. new feature flag only when independent runtime disablement adds meaningful risk control.

Do not create feature flags merely because “we may want to turn this off later”.

## `mvp-q-4-emotional-value`

For Owner-facing product behavior, explain:

* what negative emotion is reduced;
* what positive feeling is created.

Use the emotional-value guide in the private docs:

`$PD_PRIVATE_DOCS_DIR/product/emotional-value.md`

(see §26 Private Docs Access)

For internal engineering work, state:

`N/A — no direct Owner-facing behavior.`

Do not generate ceremonial emotional-value prose.

---

# 5. MVP Scope Triage

Existing subsystems may still use:

* MVP-Core
* MVP-Quiet
* MVP-Gone

according to ADR-0014 and current feature-flag policy.

Adding a capability to MVP-Core requires explicit Owner/maintainer approval.

Important:

> Unsolicited new functionality is not automatically implemented as MVP-Quiet.

If the task does not require it, record it as a follow-up rather than adding more dormant code.

---

# 6. Anti-pattern Stable IDs

These IDs remain stable stop/review signals.

They are not lexical bans; they identify reasoning patterns requiring scrutiny.

## `antipattern-future-extensibility`

“For future extensibility.”

Require evidence of a real current variation axis.

## `antipattern-completeness`

“For completeness.”

Completeness without present product value is not sufficient justification.

## `antipattern-new-research`

“New research suggests we should add X.”

Research may inform design but does not establish current PD product need.

## `antipattern-adr-accepted`

“The ADR was Accepted.”

Accepted historical text may have been amended or superseded.

Verify current applicability.

## `antipattern-review-missing`

“During review I noticed X is missing.”

A review observation is not automatically current-task scope.

## `antipattern-prep-next-phase`

“Prepare for the next Phase.”

Do not implement future-phase infrastructure before restart criteria are met.

## `antipattern-core-io`

“Add unregistered or misowned I/O to principles-core.”

Core I/O is not absolutely forbidden, but must belong to an explicitly registered architectural seam.

See:

`packages/principles-core/io-seam-registry.json`

---

# 7. Repository Discovery

Do not rely on a hard-coded package inventory in this file.

At task start:

```bash
git status
git log -n 5 --oneline
```

Then inspect relevant:

* packages;
* entry points;
* callers;
* stores;
* schemas;
* configuration;
* public exports;
* tests.

Use normal search tools freely:

```bash
rg "SymbolName"
rg "new SomeService"
rg "interface SomePort"
rg "from '@principles/"
rg "some_schema_field"
```

Useful navigation sources:

* `docs/architecture/README.md`
* `docs/architecture/PD_ARCHITECTURE_OVERVIEW.md`
* `CONTEXT-MAP.md`
* package-level `CONTEXT.md`
* `docs/adr/`

Verify navigation documents against current repository reality.

---

# 8. Architectural Placement

## 8.1 `@principles/core`

Pure domain/runtime logic is preferred.

Current architecture also contains explicitly registered I/O seams.

The registry is:

`packages/principles-core/io-seam-registry.json`

Rule:

> No unregistered core I/O.

Before adding I/O to core:

1. identify current responsibility ownership;
2. reuse an existing registered seam where appropriate;
3. justify any genuinely new seam;
4. register it in the SSoT;
5. keep architecture/lint guards green.

Do not use the registry as a loophole for arbitrary infrastructure growth.

## 8.2 Host-specific behavior

Host-specific integration belongs to the relevant host adapter/runtime boundary.

Do not assume all host I/O belongs to OpenClaw.

OpenClaw-specific and Codex-specific behavior have different host boundaries.

Shared host-neutral behavior should remain in the existing shared owner.

## 8.3 Legacy architecture

Do not recreate retired God classes, Nocturnal execution paths, superseded scheduling systems, retired state mechanisms, or deferred post-MVP architecture merely because historical documents still describe them.

---

# 9. Runtime Contract — Stable IDs

Apply this gate when code handles untrusted runtime data such as:

* parsed JSON;
* LLM output;
* SQLite/DB rows;
* diagnostic JSON;
* artifact metadata;
* YAML/config input;
* external host input.

These IDs remain stable.

## `rc-1-treat-as-unknown`

Treat untrusted runtime values as `unknown` until validated.

Never use `any` as a trust-boundary escape hatch.

## `rc-2-no-as-bypass`

Do not use TypeScript `as` assertions to replace runtime validation of untrusted data.

Use actual guards/schema validation.

## `rc-3-fail-loud-missing`

Required fields must fail explicitly when missing or malformed.

Do not silently skip required invalid data.

## `rc-4-validate-array-elements`

Validating “is array” is insufficient.

Validate relevant element types/content.

## `rc-5-object-hasown-not-in`

For untrusted object-key membership checks, prefer:

`Object.hasOwn(...)`

instead of relying on inherited-property behavior of `in`.

## `rc-6-lineage-consistency`

Lineage/evidence identifiers describing the same event/task/run/pain must come from internally consistent authority.

Test mismatch cases.

## `rc-7-loop-state-freshness`

Retry/repair loops must distinguish:

* current state;
* next state;
* persisted/recorded state.

Do not reuse stale iteration errors or results.

## `rc-8-safe-serialization`

Unknown values used in previews/logs/telemetry must be serialized safely and with bounded output.

Do not assume raw `JSON.stringify` is safe for arbitrary unknown values.

## `rc-9-no-silent-fallback`

Graceful degradation must be observable.

Include:

* structured reason;
* notes;
* telemetry;
* logs;
* nextAction

as appropriate.

Silent fallback is a bug when the fallback changes meaningful behavior.

---

# 10. CLI / Operator Contract — Stable IDs

Apply this gate when touching CLI registration, operator workflows or `packages/pd-cli/src/commands/**`.

## `cli-1-strict-json`

`--json` stdout must contain exactly the documented machine-readable JSON result.

No banners or mixed explanatory stdout.

## `cli-2-exit-stops`

Exit paths must actually terminate control flow.

If tests stub `process.exit`, prove no later mutation occurs.

## `cli-3-negated-flags-parser-tests`

Commander `--no-*` behavior requires real parser/registration tests.

## `cli-4-dry-run-confirm-mutex`

Mutating commands must preserve established dry-run / confirmation semantics.

When both flags exist, enforce the intended mutual-exclusion contract.

## `cli-5-failure-no-mutation`

Failed validation, unsupported operations, failed diagnoses and failed upstream stages must not perform forbidden state mutations.

## `cli-6-output-next-action`

Degraded/refused/failed operator results should contain a structured reason and useful next action.

## `cli-7-test-wiring`

When behavior depends on command-line parsing or registration, test actual command wiring, not only handlers.

---

# 11. Engineering Skill Routing

Installed engineering skills are conditional expert workflows, not universal rituals.

Repository policy and verified PD requirements override generic skill advice.

## `codebase-design`

Use when:

* introducing/changing public interfaces;
* creating adapters;
* moving responsibilities between modules/packages;
* designing subsystem boundaries;
* significant architecture refactoring.

Apply:

### Interface leverage

How much capability does the caller get for how much interface it must understand?

### Deletion test

If the abstraction disappeared, would meaningful complexity disappear too?

If callers could simply import the underlying implementation with no meaningful complexity increase, the abstraction may be shallow.

### Real seam test

Is the variation real now, or hypothetical?

### Interface as test surface

Prefer testing through public module behavior rather than exposing internals only for tests.

## `diagnosing-bugs`

Prefer for non-trivial bugs.

Typical flow:

```text
reproduce
→ narrow
→ hypothesize
→ collect evidence
→ identify root cause
→ fix
→ regression verify
```

## `tdd`

Use when red-green-refactor provides a useful feedback loop.

Good candidates:

* reproducible bugs;
* validators;
* pure logic;
* state transitions;
* bounded vertical slices.

Verification First has higher priority than TDD First.

## `domain-modeling`

Use when domain language, lifecycle semantics, authority, ownership or state meaning changes.

Do not invoke for routine implementation that leaves the domain model unchanged.

## `code-review`

Use before final handoff of substantial implementation.

Review separately:

* Standards correctness
* Specification correctness

Technically elegant code solving the wrong problem is still wrong.

## `improve-codebase-architecture`

Use for explicit architecture-health work.

Do not use it as permission to widen a normal feature or bug-fix PR.

Preferred flow:

```text
scan
→ identify candidates
→ rank
→ select one bounded improvement
→ characterize
→ refactor
→ verify
```

Do not perform repository-wide cleanup automatically.

## Experimental setup skills

Do not automatically introduce repository-wide deep-module enforcement tools or reorganize the monorepo.

Audit first.

Prototype on a bounded area.

Use a separate SPEC/issue for major architecture-tooling changes.

---

# 12. Deep Module Health

When reviewing architecture, look for:

## Shallow module signals

* wrapper with almost no hidden complexity;
* re-export layer that only redirects imports;
* public barrel exposing internal helpers;
* callers coordinating many internal steps manually;
* interface with one implementation and no real variation;
* tests importing private helpers because public behavior is hard to exercise;
* public APIs mirroring implementation details;
* duplicated orchestration;
* many tiny modules that must always be understood together.

## Deep module signals

* small semantic interface;
* substantial hidden implementation;
* stable public behavior;
* callers do not need internal sequencing knowledge;
* internal refactoring does not force widespread caller changes;
* failures/invariants handled internally;
* tests can exercise behavior through the boundary.

Do not make every utility deep.

Depth is valuable when it reduces total cognitive complexity.

---

# 13. Complexity Delta Gate

Every non-trivial implementation must report:

```text
Complexity Delta

New durable source of truth: YES / NO
New persisted schema/state: YES / NO
New subsystem/service/background process: YES / NO
New public abstraction/interface: YES / NO
New runtime feature flag: YES / NO
New cross-package dependency: YES / NO
New host/platform-specific behavior: YES / NO
New external/network capability: YES / NO
```

For each `YES`, explain:

1. why the existing owner cannot satisfy the requirement;
2. what complexity the addition hides;
3. why a smaller solution is insufficient;
4. how it is verified;
5. how it can be removed or rolled back.

Several unexplained `YES` values are an architecture warning.

Prefer a negative Complexity Delta when safely possible.

---

# 14. Error Experience Handbook

Before substantial implementation, read:

`docs/process/error-management/ERROR_PATTERN_INDEX.md`

Use it as retrieval memory.

Do not load the full handbook by default.

Select only materially relevant ERR patterns.

**There is no minimum ERR count.**

Zero relevant ERR entries is valid.

Never manufacture relevance to satisfy a process quota.

Read detailed handbook entries only when selected by the index or needed for investigation.

## Recording Errors

Every real review finding must be classified.

Record/update the Error Experience Handbook when the finding has a reusable engineering root cause, especially:

* escaped production/CI defect;
* P0/P1 correctness or safety defect;
* recurring failure class;
* architectural invariant violation;
* material P2 likely to recur across tasks.

Do not create long-term institutional-memory entries for:

* trivial typos;
* immediately corrected local mistakes;
* purely cosmetic findings;
* implementation details with no reusable lesson.

When several review comments share one root cause:

> record one root-cause lesson / recurrence.

If the handbook is changed, run its current validation command.

---

# 15. BDD Contract

BDD is a behavioral specification tool, not a universal coding workflow.

Apply it when the task touches:

* MVP-Core Owner journeys;
* CLI/operator contracts;
* behavior already covered by `.feature`;
* Owner-visible behavior where `.feature` is the clearest contract.

When applicable:

1. find/read the relevant `.feature`;
2. understand its observable behavior;
3. implement;
4. run the associated scenario;
5. determine whether failures are implementation regressions or intentional contract changes.

AI may update step definitions when necessary.

AI must not:

* delete a `.feature`;
* disable a scenario;
* lower observable expectations

merely to make tests green.

Intentional behavior-contract changes must be explicit and Owner-visible.

---

# 16. Feature Flags and Rollback

Feature flags are governance assets with lifecycle cost.

New independently switchable runtime behavior needs an explicit rollback strategy.

Prefer:

1. existing owning flag/configuration;
2. existing deactivation/state mechanism;
3. backward-compatible rollback;
4. new feature flag only when independent runtime disablement adds meaningful risk control.

Do not create a flag for every bug fix, refactor, reader or helper.

When a new feature flag is legitimately required:

* use the current feature-flag SSoT;
* obey category/default rules;
* update required lifecycle metadata for quiet flags;
* verify the production loader actually consumes the flag;
* test flag-off behavior when relevant.

---

# 17. Owner-facing Emotional Value

For:

* Console/UI workflows;
* governance interactions;
* approvals;
* onboarding;
* surfaced product capabilities;
* Owner-facing information architecture;

read the emotional-value guide in the private docs:

`$PD_PRIVATE_DOCS_DIR/product/emotional-value.md`

(see §26 Private Docs Access)

Assess:

* uncertainty reduction;
* cognitive-load reduction;
* sense of control;
* clarity of cause/effect;
* interruption cost;
* trust.

For internal engineering work:

`Emotional value: N/A — no direct Owner-facing behavior.`

---

# 18. Data Cleanup / Destructive Operations

Before deletion, cleanup, destructive migration, archival or repair that can remove/rewrite governance/user data, read:

`docs/process/DATA_CLEANUP_GUIDELINES.md`

Default to preservation.

Use explicit bounded mutation.

Do not treat destructive cleanup as ordinary refactoring.

---

# 19. Cross-package Contract Changes

When changing:

* shared types;
* schemas;
* store contracts;
* service interfaces;
* package exports;
* shared defaults;
* package names;
* runtime protocols;

identify all relevant consumers.

A passing core unit test is not sufficient proof for a cross-package contract change.

Verify real consumer paths where practical.

Before adding a public export, ask:

> Does the caller actually need to know this?

---

# 20. Architecture Guard Philosophy

Prefer guards that protect invariants over guards that preserve historical file layout.

Good architecture guards protect:

* dependency direction;
* unauthorized I/O;
* source-of-truth boundaries;
* public/private import seams;
* schema contracts;
* package dependency rules;
* production wiring.

Treat guards based on:

* exact file lists;
* exact module counts;
* historical wrappers

as potential migration constraints rather than eternal design truth.

Do not modify architecture guards casually.

If a valid deepening refactor conflicts with a historical structural guard, determine whether the guard protects a true invariant or only old decomposition.

---

# 21. Linear Workflow

For Linear-backed work:

1. read the issue and latest comments before implementation;
2. verify assumptions against the repository;
3. set `In Progress`;
4. record meaningful design decisions/blockers;
5. implement and verify;
6. create the PR when requested;
7. set `In Review`;
8. leave a concise evidence-based summary.

Do not blindly follow inaccurate SPEC assumptions.

Do not create ceremonial comments with no useful information.

---

# 22. Existing PR Workflow

When asked to review/fix an existing PR:

1. fetch all current reviews/comments;
2. inspect current diff;
3. inspect CI/check status;
4. classify findings;
5. fix valid in-scope blockers together where practical;
6. push;
7. re-fetch reviews/comments/checks;
8. converge.

Retry GitHub/API access when transient failures occur.

Do not ask the Owner to relay comments unless access genuinely fails.

A current-PR blocker is normally:

* P0;
* P1;
* P2 violating explicit acceptance criteria or creating material correctness/safety risk.

Adjacent hardening becomes follow-up work.

---

# 23. PR Creation and Merge

Before creating a PR:

1. read `.github/PULL_REQUEST_TEMPLATE.md`;
2. preserve its structure;
3. fill all agent-owned sections;
4. run adversarial self-review;
5. verify diff scope;
6. run required tests;
7. create the PR.

Never push directly to `main`.

Never use:

* `gh pr merge`;
* auto-merge;
* equivalent automatic merge mechanisms.

The Owner performs final merge.

---

# 24. Adversarial Self-review

Before handoff, review the whole diff as if trying to reject it.

Ask:

* Did I implement an assumption instead of repository reality?
* Did I create a second source of truth?
* Did I create a speculative seam?
* Did I introduce a shallow wrapper?
* Could an existing module have hidden this complexity?
* Did I expose internals unnecessarily?
* Did I widen scope?
* Does production actually call the changed code?
* Are tests exercising only helpers?
* Did I miss cross-package consumers?
* Are failure/degraded paths correct?
* Did I weaken a contract to make tests pass?
* Did I revive retired architecture?
* Did complexity increase more than capability?

Use `code-review` for substantial implementation when available.

Fix valid findings before handoff.

---

# 25. Verification

Use targeted tests during implementation.

Before final handoff run the current canonical merge gate:

```bash
npm run verify:merge
```

Also run task-specific tests not covered by that gate.

Do not delete, disable, weaken or rewrite valid tests merely to obtain green CI.

If a failure is confirmed pre-existing/environmental:

* provide evidence;
* distinguish it from current regressions;
* document it clearly.

---

# 26. Private Docs Access

PD keeps a separate **private repository** for Owner-sensitive docs:
governance, domain guides, product emotional-value, plans, ADRs, runbooks,
quality reports, and other material that must not be published.

Private docs are never copied into the public repository.

**Know it exists — check it when relevant:**

* when a task touches governance, product emotional-value, domain semantics,
  plans, ADRs, runbooks or quality reports, look for relevant guidance in the
  private docs and read it;
* keep the private docs current: when your work changes what those docs
  describe, update them in the private repo.

**Location (current environment):**

* private repo clone: `D:\Code\principles-private`;
* docs root: `D:\Code\principles-private\docs`;
* resolved programmatically with `$PD_PRIVATE_DOCS_DIR` when configured,
  otherwise it defaults to `~/principles-private/docs`.

Rules:

* read/search private docs from the private repo;
* do not assume public-repo `rg` includes them;
* edit private docs only inside the private repo;
* commit/push private-doc changes there (`git -C <private-repo> ...`);
* never paste private content into public PRs/issues/commit messages;
* reference paths only when public discussion needs to acknowledge them.

Private docs are read DIRECTLY from the independent private repo. There is no
`docs/.private` junction in the public worktree — that model was retired in
Aug 2026. To verify the private-docs path resolves, run:

`node scripts/setup-private-docs-symlink.mjs --check`

---

# 27. Owner Review Card

Every non-trivial completion report must begin with:

```text
Owner Review Card

1. Problem
   What real problem was verified?

2. Before
   What did the system actually do before?

3. After
   What does it do now?

4. Existing mechanism reused
   Which existing authority/module/subsystem was extended?

5. Complexity Delta
   New source of truth:
   New persisted state:
   New subsystem:
   New public abstraction:
   New feature flag:
   New cross-package dependency:
   New host-specific behavior:
   New external/network capability:

6. Design reason
   Why is this the smallest coherent solution?

7. Verification
   What evidence proves the intended behavior?

8. Risk
   What could still go wrong?

9. Rollback / recovery
   How can the change be disabled, reverted or repaired?

10. Follow-ups
    What adjacent issues were deliberately NOT included?
```

Write this for the Owner.

Do not assume the Owner will inspect implementation code.

---

# 28. Dedicated Architecture Health Work

When explicitly asked to improve architecture, report candidates before implementation.

Use:

```text
Architecture Candidate

Area:
Current public interface:
Hidden complexity:
Leaked complexity:
Why this appears shallow:
Deletion test:
Real seam or speculative seam:
Typical files touched per change:
Test-surface problem:
Proposed deeper boundary:
Expected interface reduction:
Migration risk:
Product value:
Recommendation:
```

Rank:

* HIGH — frequent change + high cognitive cost + clear bounded improvement
* MEDIUM — useful but not urgent
* LOW — mostly theoretical cleanliness

Do not refactor LOW-value areas merely because a skill detects them.

---

# 29. Definition of Done

A task is complete only when:

* repository reality was investigated;
* intended behavior is understood;
* authoritative state is identified;
* scope is controlled;
* speculative abstraction was avoided;
* Complexity Delta is understood;
* relevant installed skills were used where valuable;
* real behavior is verified;
* production wiring was checked;
* targeted tests are green;
* merge gate is green or proven pre-existing failure is documented;
* PR feedback has converged when applicable;
* Linear is updated when applicable;
* PR is created when requested;
* Owner Review Card is delivered;
* AI has not merged the PR.

---

# 30. Default Working Loop

```text
Survey
↓
Establish implementation truth
↓
Establish intent truth
↓
Identify authority and existing owner
↓
Define observable acceptance evidence
↓
Select relevant engineering skill when useful
↓
Design the smallest coherent change
↓
Prefer deep existing boundaries over new shallow abstractions
↓
Implement
↓
Verify through the real interface / production path
↓
Measure Complexity Delta
↓
Adversarial review
↓
Explain the system change to the Owner
↓
Create PR / update Linear
```

When uncertain, prefer:

> fewer concepts
> fewer public interfaces
> fewer truth sources
> fewer speculative seams
> stronger encapsulation
> stronger evidence

The goal is not to make PD look architecturally sophisticated.

The goal is to make PD increasingly difficult to misunderstand and increasingly easy to change safely.
