# CLAUDE.md

This file contains Claude Code-specific operating guidance for Principles Disciple.

The canonical engineering policy is:

`AGENTS.md`

**Read and follow `AGENTS.md` first.**

Do not redefine or duplicate its:

* product boundary;
* stable rule IDs;
* architecture policy;
* verification strategy;
* Error Experience policy;
* PR governance.

---

## 1. Repository Orientation

Principles Disciple is a Node.js / TypeScript monorepo.

Do not rely on a hard-coded package inventory.

Useful orientation sources:

* `AGENTS.md`
* `docs/product/PRODUCT_IDENTITY.md`
* `docs/architecture/README.md`
* `docs/architecture/PD_ARCHITECTURE_OVERVIEW.md`
* `CONTEXT-MAP.md`
* package-level `CONTEXT.md`
* `docs/adr/`
* `docs/process/TESTING.md`
* `docs/process/error-management/ERROR_PATTERN_INDEX.md`

Navigation documents may drift.

Verify material architecture claims against current production code.

---

## 2. Repository Discovery

Before substantial coding:

```bash
git status
git log -n 5 --oneline
```

Use normal code-search tools freely:

```bash
rg "SymbolName"
rg "functionName"
rg "schemaField"
rg "new SomeService"
rg "from '@principles/"
```

Inspect real callers, entry points, stores, schemas and tests before designing.

---

## 3. Common Commands

From repository root:

```bash
npm install
npm run build
npm run lint
npm run verify:merge
```

For package-specific commands, read the current package `package.json`.

Do not assume this file contains an exhaustive command inventory.

Use targeted tests during implementation.

---

## 4. Architecture Placement

Follow `AGENTS.md`.

Do not simplify the repository into:

```text
pure logic -> principles-core
all I/O -> openclaw-plugin
```

Before adding core I/O inspect:

`packages/principles-core/io-seam-registry.json`

Do not add unregistered core I/O.

Determine whether behavior is:

* host-neutral;
* OpenClaw-specific;
* Codex-specific;
* shared runtime behavior.

Use the current owning package.

---

## 5. Engineering Skills

Use installed skills according to the routing policy in `AGENTS.md`.

Especially consider:

* `diagnosing-bugs` for non-trivial defects;
* `codebase-design` for new/changing seams and public abstractions;
* `tdd` where red-green-refactor is useful;
* `domain-modeling` when domain semantics change;
* `code-review` before substantial handoff;
* `improve-codebase-architecture` only for dedicated architecture-health work.

Skills are expert workflows, not universal rituals.

---

## 6. Existing PR Work

When asked to review/fix a PR:

1. fetch all current reviews/comments;
2. inspect current diff;
3. inspect checks;
4. classify findings;
5. fix valid in-scope blockers;
6. push;
7. re-fetch feedback/checks;
8. converge.

Do not ask the Owner to manually relay GitHub comments unless access genuinely fails.

---

## 7. Linear

For issue-backed work:

1. read current issue/comments;
2. verify assumptions against code;
3. set `In Progress`;
4. record meaningful decisions/blockers;
5. implement and verify;
6. create PR when requested;
7. set `In Review`;
8. leave concise evidence.

---

## 8. Private Docs

Private docs are stored outside the public repository.

Follow the private-doc policy in `AGENTS.md`.

Never paste private content into public PRs/issues/commits.

---

## 9. Git / PR

Use conventional commits.

Never push directly to `main`.

Never merge PRs.

Read `.github/PULL_REQUEST_TEMPLATE.md` before PR creation.

Before handoff:

* inspect the whole diff;
* run adversarial review;
* report Complexity Delta;
* run targeted tests;
* run `npm run verify:merge`;
* provide the Owner Review Card.

---

## 10. Default Claude Working Rule

```text
Do not begin by designing.

Begin by discovering what already exists.
```

Then:

```text
verify reality
→ identify authority
→ define acceptance evidence
→ choose relevant skill
→ make the smallest coherent change
→ test the real path
→ review unnecessary complexity
→ explain the result to the Owner
```

When a sophisticated new abstraction and a simpler extension of an existing mechanism both satisfy the verified requirement, prefer the simpler extension.
