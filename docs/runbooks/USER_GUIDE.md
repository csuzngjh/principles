# Principles Disciple User Guide

This guide focuses on the commands and workflows that are actually useful in the current release. The version is defined by the installer's `package.json`; this guide does not pin a milestone number.

## What The System Does

Principles Disciple now has two main responsibilities:

1. Protect the workspace while the agent is working.
2. Turn repeated mistakes into reusable internalized behavior through principles, rule implementations, and replay evaluation.

You do not need to understand the full architecture to use it. Most people only need the commands below.

### Principle Lifecycle

Principles go through four statuses:

| Status | Meaning |
|--------|---------|
| `candidate` | Newly proposed, not yet reviewed |
| `probation` | Under trial / shadow mode — active but monitored for side effects |
| `active` | Officially in effect |
| `archived` | Kept for history, not active |

## Before You Start: Give PD an LLM

PD's internal agents — diagnostician, dreamer, scribe, artificer, signal collector — make their
LLM calls with **your** provider account. PD ships no keys and stores no key values.

Three fields on the `pd.default` profile in `<workspace>/.pd/config.yaml` decide whether they can run:

```yaml
runtimeProfiles:
  pd.default:
    type: pi-ai
    provider: anthropic            # installer accepts openai | anthropic | deepseek
    model: claude-3-5-haiku-latest
    apiKeyEnv: ANTHROPIC_API_KEY   # NAME of the env var holding your key, not the key
```

Pick them at install time instead, if you prefer:

```bash
npx create-principles-disciple --yes --provider anthropic --api-key-env ANTHROPIC_API_KEY
```

Or set them in the console: `pd console open --workspace "<path>"` → Control Center → runtime profiles.

**If you skip this**: pain evidence is still captured and kept, but diagnosis does not run and no
principle is proposed. `pd config doctor --workspace "<path>"` reports `needs_setup` and names the
missing field; Control Center marks the section `Needs Config`.

## Daily Commands

### `/pd-status`

Use this when the assistant seems stuck or confused.

- `/pd-status` shows the current fatigue/friction state.
- `/pd-status reset` clears the current session friction so the assistant can try again with a fresh state.
- `/pd-status empathy` shows emotion-event statistics.
- `/pd-status empathy --week` shows weekly trends.
- `/pd-status empathy --session` limits the view to the current session.

Use `reset` when the assistant is looping on the same mistake.

### `/pd-rollback last`

Use this when the empathy system penalized the wrong thing.

- `/pd-rollback last` rolls back the most recent empathy penalty in the current session.
- `/pd-rollback <eventId>` rolls back a specific empathy event.

This affects empathy-related GFI only. It does not erase the whole session state.

## Code Implementation Workflow

This workflow is for operators reviewing code implementations generated or maintained by the system.

### When To Use It

Use these commands when:

- a new candidate implementation appears
- you want to evaluate a candidate against replay data
- a promoted implementation regressed and needs to be disabled or rolled back
- an old implementation should be archived

### Step 1: List Candidates

```text
/pd-promote-impl list
```

This lists candidate implementations and tells you whether each one already has a passing replay report.

> ⚠️ **Note**: The legacy replay generation path was retired in PRI-230. There is currently no CLI entry point to generate new replay reports. Promotion only works for implementations that already have a pre-existing passing replay report. The `eval` subcommand referenced in older documentation no longer exists.

### Step 2: Inspect The Replay Report

```text
/pd-promote-impl show <implId>
```

This prints the latest replay report for the implementation.

Check:

- total sample count
- pass/fail decision
- which classifications were exercised
- whether the report is empty because no replay samples were available

### Step 3: Promote The Candidate

```text
/pd-promote-impl <implId>
```

Promotion rules:

- the implementation must be in `candidate` or `disabled`
- it must have a passing replay report
- if the same rule already has an active implementation, the old one is disabled automatically

This is the normal path from candidate to active.

### Step 4: Disable A Bad Implementation

```text
/pd-disable-impl list
/pd-disable-impl <implId> --reason "reason"
```

Use this when an implementation is causing bad runtime behavior and should stop applying immediately.

Disabling keeps the implementation in the ledger but removes it from active use.

### Step 5: Roll Back To The Previous Active Implementation

```text
/pd-rollback-impl list
/pd-rollback-impl <implId> --reason "reason"
```

Use this when the current active implementation should be reverted and the previous active version restored.

If there is no previous active implementation, the rule simply falls back to the hard host boundaries such as GFI and Progressive Gate.

### Step 6: Archive An Implementation

```text
/pd-archive-impl list
/pd-archive-impl <implId>
```

Use this for permanent cleanup when an implementation is no longer relevant.

Archiving is stronger than disabling. It is intended for old or obsolete implementations that should not be promoted again.

## Recommended Operator Sequence

When the system has produced a new code candidate, use this order:

1. `/pd-promote-impl list`
2. `/pd-promote-impl show <implId>`
3. `/pd-promote-impl <implId>`

If the promoted implementation regresses:

1. `/pd-disable-impl <implId> --reason "reason"`
2. `/pd-rollback-impl <implId> --reason "reason"` if you want to restore the previous active version
3. `/pd-archive-impl <implId>` only when the implementation is obsolete and should be retired

## How To Read Internalization Routes

Internalization route recommendations look like:

- `prompt`
- `code_tool_hook` (RuleHost)
- `defer_archive`

Interpret them like this:

- `prompt`: the principle likely needs prompt/SOP shaping first
- `code_tool_hook` (RuleHost): the principle is deterministic or high-risk enough for a code implementation
- `defer_archive`: there is not enough evidence yet, or forcing implementation would be premature

These are recommendations, not automatic actions.

## Troubleshooting

### "Promotion rejected: no passing replay report"

The legacy replay generation path was retired in PRI-230. There is currently no CLI entry point to generate new replay reports. Promotion only succeeds for implementations that already have a pre-existing passing replay report.

You can inspect the existing report with:

```text
/pd-promote-impl show <implId>
```

If no report exists, the implementation cannot be promoted through the CLI until the replay generation path is restored.

### “Replay report is empty”

This means the system did not find classified replay samples for that implementation yet.

Check:

- whether nocturnal/replay data exists for the workspace
- whether the implementation is attached to the expected rule
- whether recent sessions produced usable samples

### “The implementation was disabled but behavior still feels restricted”

That can be normal. Disabling a code implementation does not remove the host hard boundaries:

- Thinking checkpoint
- GFI
- Progressive Gate
- Edit verification

### “I only want to know whether the system is healthy”

Use:

```text
/pd-status
```

That is enough for most day-to-day use.

### “Some features seem disabled or missing”

Some subsystems (such as `correction_observer`) are **default OFF** by design (MVP-Quiet, ADR-0014). This is intentional — they are not broken. They will be enabled in a future release once seed-customer evidence justifies broader activation. You can verify which subsystems are enabled in your workspace's `.pd/config.yaml`.

### "It captures pain but never proposes a principle"

That is almost always the LLM runtime profile, not the pipeline. Diagnosing and proposing are LLM
calls made with your own provider account; when `provider`, `model` or `apiKeyEnv` is missing the
agents report `needs_setup` and stay off. Run `pd config doctor --workspace "<path>"` — it names the
missing field — then see
[Before You Start: Give PD an LLM](#before-you-start-give-pd-an-llm).

## Evaluating A Principle With Examiner

### What Examiner Does

Examiner is where the console evaluates whether a **single principle** actually changes behavior. It places that principle in a fixed set of comparison cases, runs the research pipeline, and produces a report.

The evaluated object is always one specific Principle (selected by principle id) — never the whole library, and never a single task run.

### How It Differs From Viewing Principle Details

| | Principle detail | Examiner |
|---|---|---|
| Question answered | What this principle says and what state it is in | Whether injecting it actually changed behavior |
| Data source | Ledger and activation records | Frozen experiment inputs + comparison runs + statistics |
| Output | Facts and status | Conclusion, evidence boundary, and next step |

Examiner never makes an automatic decision and never changes a principle's status.

### When To Use It

- A new principle is about to be promoted and you want to see its effect first.
- An active principle went live but did not produce the expected effect.
- You suspect the principle introduced a side effect.
- You changed the principle text or its rules and need to re-evaluate.

### First Run: Enter From Principle Detail

1. Open Controls → Principles.
2. Choose an `active` principle.
3. Click "Evaluate this principle's behavioral effect".
4. The console opens Examiner with that principle already selected.

Non-`active` principles do not show an executable entry, because the current research contract only accepts active principles. Finish the governance decision first, then come back.

### How To Read Production Evidence

The Examiner home page shows the selected principle's production evidence: ledger status, runtime activation, the production prompt-injection projection, and RuleCode attribution.

When evidence cannot be read, the page shows an explicit failure with a retry action — it never renders as "there is no evidence". Those are different facts: one is unavailable data, the other is confirmed absence.

### How To Tell Whether A Principle Can Be Evaluated (Eligibility)

Once a principle is selected, the configure page runs a read-only **eligibility pre-check**. There are three outcomes:

| Status | Meaning | What you can do |
|---|---|---|
| `ELIGIBLE` | The study can be created | Create it |
| `DEGRADED` | Creation is allowed, but some production data is unavailable | Create it, and keep the affected conclusions qualified |
| `BLOCKED` | It cannot be evaluated right now | Follow the reason and next step shown in the panel |

Common blockers:

- **Unsupported principle status**: only active principles can be evaluated.
- **Intervention not identifiable**: the workspace attributes a RuleCode to this principle but cannot show the two are independently controllable, so a bundled result cannot be attributed to the principle alone.
- **Research suite unavailable**: the selected suite does not compile.
- **Study root not writable**: the workspace research output directory failed its isolation check.

The pre-check writes nothing. When it says "creatable", creation re-runs the same checks on the server; when it says BLOCKED, creation is refused.

### How To Create A Study

1. Choose a principle.
2. Choose an experiment mode: `isolated_principle` (compare the single principle) or `full_library_incremental` (keep the library baseline).
3. Choose a server-fixed Challenge Suite (`didactic-pair` or `calibration-core`).
4. Create it.

After creation the page shows the Study ID, the production-snapshot difference markers, and the frozen inputs. Once frozen, later runs never re-read production data.

### How To Run Preflight

Preflight checks the study's integrity before execution and lists every blocker and warning:

- blocker: must be fixed; execution is refused until it is.
- warning: execution may proceed, but the result must be read with that limitation.

### How To Run An Offline Study

The offline run uses a deterministic offline simulator with **zero model calls**. It validates the research pipeline itself: input freezing, arm assignment, execution, statistics and report generation.

It **does not** prove that a real agent improved, and it does not prove a causal effect in production.

### How To Read Report V2

The first screen of a study report is the Owner Summary:

- **Conclusion**: one sentence plus a status tag.
- **What this confirmed**: three to five facts that actually matter.
- **What this cannot prove yet**: the current evidence boundary.
- **Evidence integrity**: coverage, as-of time, unresolved items, treatment fidelity, runtime loaded, control contamination, limitations.
- **Suggested next step**: gather more production evidence, repair identifiability, complete human Gold review, continue Host Readiness checks, wait for F2 authorization, or return to Principle Governance.

The report always states which execution mode produced it: offline contract validation (offline-stub), host readiness check (host-dry-run), or real host execution (f2-real-host).

### Owner Decision Handoff

The report page ends with a link back to principle governance. It only navigates: the target principle is unchanged, the report id maps to its study id, no principle status is modified, and no second decision system is created.

### Current Capability Limits And Safety Boundaries

- Every offline evaluation in this release is **offline contract validation**, not a real behavior experiment.
- **Host Dry-run** checks host run conditions (CLI, isolation, authorization file) with zero model calls; passing it is not evidence that behavior was validated.
- **F2 real-host execution is not enabled in the console.** The button is disabled and explains why; even if you call the API directly, the server still runs the Stage R and Owner authorization checks.
- **Independent human Gold review (Gate 1) is not complete.** Passing automated tests does not mean the challenge suite has independent human Gold review, so no formally trustworthy effect verdict is issued before Gate 1 clears.
- Evaluation results only support the Owner's next governance decision. They never auto-promote, auto-archive, or modify a principle.

## Console

If your deployment exposes the plugin UI, open:

```text
http://127.0.0.1:3100
```

Or launch it directly with the CLI:

```bash
pd console open --workspace "<path>"
```

Use the console for:

- reviewing queue and trend data
- inspecting correction samples
- watching principle and implementation activity at a glance

## Bottom Line

For normal use, remember only this:

1. use `/pd-status` when the assistant is stuck
2. use `/pd-rollback last` when empathy penalized the wrong thing
3. use `/pd-promote-impl ...` and related implementation commands only when you are operating candidate code implementations
