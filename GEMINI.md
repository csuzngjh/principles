# GEMINI.md

This file contains Gemini CLI-specific operating guidance for Principles Disciple.

The canonical engineering policy is:

`AGENTS.md`

**Read and follow `AGENTS.md` first.**

Do not duplicate or override its product, architecture, stable rule IDs, Error Experience, verification or PR policy.

---

## 1. Orientation

Before substantial coding inspect:

* `AGENTS.md`
* relevant current production code
* applicable issue/SPEC
* relevant ADRs
* relevant tests
* `ERROR_PATTERN_INDEX.md`

Do not rely on old architecture descriptions.

Use normal repository search to find current symbols, callers and consumers.

---

## 2. Architecture

Follow the ownership and I/O rules in `AGENTS.md`.

In particular:

* do not assume `principles-core` is absolutely I/O-free;
* do not add unregistered core I/O;
* do not assume all I/O belongs to OpenClaw;
* preserve real host boundaries;
* do not revive retired architecture.

---

## 3. Skills

When installed and relevant, use the engineering skill routing defined by `AGENTS.md`.

Do not invoke architecture/refactoring skills just because nearby code could be cleaner.

---

## 4. Error Experience

Use `ERROR_PATTERN_INDEX.md` as retrieval memory.

Load relevant detailed ERR entries only when needed.

There is no mandatory minimum ERR count.

Classify real review findings and record reusable root-cause lessons according to `AGENTS.md`.

---

## 5. Verification

Choose the test strategy according to `Verification First`.

Use targeted tests during implementation.

Before final handoff:

```bash
npm run verify:merge
```

Do not weaken tests merely to obtain green CI.

---

## 6. Linear / PR

Read issue state before implementation.

Keep Linear status current.

Read the PR template before PR creation.

Never merge PRs.

Provide the Owner Review Card on substantial completion.

---

## 7. Private Docs

PD keeps a separate private repository for Owner-sensitive docs
(domain guides, product emotional-value, plans, runbooks, quality reports).

Follow `AGENTS.md` §26 Private Docs Access.

Resolve location via `$PD_PRIVATE_DOCS_DIR`
(current environment: `D:\Code\principles-private\docs`).

Read relevant private docs when the task touches governance, product
emotional-value, domain semantics, plans or runbooks. Edit them only inside
the private repo, then commit + push there.

Never expose private-doc content through public repository artifacts.

---

## 8. Default Gemini Working Rule

```text
Survey
→ verify
→ identify authority
→ choose smallest coherent change
→ verify real behavior
→ self-review
→ explain to Owner
```

Prefer fewer concepts and stronger evidence over architectural novelty.
