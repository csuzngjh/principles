# PRI-626 R1 — Consent UX Verification / Installed Rollout Gate (Evidence)

- **Date:** 2026-09-11
- **Gate:** Codex Governance Closure SPEC rev 2 §3 R1 (rollout gate)
- **Authority:** `docs/superpowers/specs/2026-08-28-codex-governance-closure-spec.md` (rev 2, contract frozen)
- **Machine:** Windows 11 x64 (dev+dogfood machine), Node v26.7.0, Codex CLI 0.154.0
- **Installed runtime under test:** `~/.pd/runtime` — pd-cli 1.147.14 (installer app stamp 1.233.0), codex-adapter pd-hook, host-runtime. Published to npm 2026-09-10T03:19Z; Slice D (PR #1536, merge commit `3ec948741`) is included. The installed pd-cli exposes the full `pd codex setup` consent surface (verified via `--help` and behavior probes).

## Verdict

**R1 = GO** for opt-in rollout. All four R1 behaviors were proven on the
**installed setup path** (real installed binaries, isolated sandbox workspaces,
never test doubles), by executable scenarios, with byte-level checks against
the G2A frozen decision package. The installed-binary real-LLM journey
(`scripts/dev/codex-owner-journey-e2e.mjs`, live-LLM mode) additionally drove
the chain correction → pain → diagnosis → candidates on the same installed
binaries and pushed the internalization pipeline to its designed
**Owner-decision exit** (see §5 for the exact terminal state — approval /
later-activation evidence is recorded when a run converges, and the probe
runs documented here ended at the reviewer's `needs_revision`).

## 1. Executable scenarios (what ran)

| Scenario | Artifact | Result |
| --- | --- | --- |
| Installed-path four-behavior gate | `scripts/dev/codex-r1-installed-gate.mjs` (new, this PR) against installed pd-cli/pd-hook | **4/4 gates PASS** (raw evidence lines in §2) |
| BDD §18-17/§18-15 consent & reversibility | `packages/pd-cli/tests/commands/codex-consent-reversibility.steps.test.ts` + `docs/specs/features/codex-governance/codex-consent-reversibility.feature` | 6/6 scenarios PASS |
| G2A frozen-text anti-weakening guard | `packages/host-runtime/tests/codex-disclosure-g2a-guard.test.ts` | 4/4 PASS |
| Ingestion flag contract (default off, quiet) | `packages/principles-core/src/runtime-v2/feature-flags/__tests__/codex-conversation-ingestion-flag.test.ts` | 4/4 PASS |
| Owner-journey E2E, live-LLM installed-binary mode | `scripts/dev/codex-owner-journey-e2e.mjs` (S6/S7/S9 wired in this PR) | see §5 |

`node scripts/dev/codex-r1-installed-gate.mjs` is re-runnable at any time;
it defaults to the installed binaries and re-extracts the frozen disclosure
from the G2A decision package at run time (same extraction algorithm as the
CI guard test), so the SSoT chain decision-package → installed-binary is
checked on every run.

## 2. Gate evidence — installed setup path (2026-09-11)

Run: `node scripts/dev/codex-r1-installed-gate.mjs --evidence-out r1-evidence.jsonl`
(exit 0; pd-cli = `~/.pd/runtime/pd-cli/dist/index.js`, pd-hook = `~/.pd/runtime/codex-adapter/dist/pd-hook.js`)

### R1-1 — setup presents the G2A-approved disclosure before ingestion can be enabled: PASS

```json
{"gate":"G1-disclosure","status":"passed","detail":{"frozenTextByteEqual":true,"disclosureVersion":"g2a-2026-08-28","ordering":"disclosure presented before accept; granted only after explicit accept","flagEnabled":true}}
```

- `pd codex setup --show-disclosure` (installed binary) output is **byte-equal** to the frozen Chinese text re-extracted from the G2A decision package (`docs/superpowers/specs/2026-08-28-codex-governance-closure-g0-g2a-decision.md` § "Frozen consent disclosure text").
- The grant exists only via an explicit accept; the consent record carries `disclosureVersion g2a-2026-08-28` and `decidedVia: pd_codex_setup`.
- The plugin `$pd-setup` surface presents the same frozen text before invoking the non-interactive accept/decline (the two flags exist exactly for that presentation-then-decide split; machine mode without a decision refuses with `decision_required` — proven by the BDD decision-guard scenario).

### R1-2 — declining leaves ingestion off and existing governance untouched: PASS

```json
{"gate":"G2-decline","status":"passed","detail":{"decision":"revoked","flagOff":true,"configDiffLines":["    enabled: true ->     enabled: false"],"existingGovernanceUntouched":true,"catchUpAfterDecline":"skipped/feature_disabled"}}
```

- Decline on a workspace with the flag hand-enabled: consent record = `revoked`, flag off.
- The full config.yaml diff is **exactly one line inside the `codex_conversation_ingestion` block** (`enabled: true → enabled: false`); every other feature (host.codex, prompt injection, RuleHost, tool governance configuration) is byte-identical.
- `pd codex ingest catch-up` afterwards reports `skipped / feature_disabled` — the existing behavior surface is unchanged.

### R1-3 — declining never opens or reads the transcript: PASS

```json
{"gate":"G3-no-read","status":"passed","detail":{"transcriptRemovedBeforeHook":true,"stopHookExit":0,"promptHookExit":0,"observationsWritten":0}}
```

- Stronger than "reads then discards": the transcript file was **removed from disk** after the decline, then Stop and UserPromptSubmit events were delivered through the installed pd-hook. Both exit 0 with a clean structured skip and write **zero** observations — the flag-off path provably never needs the transcript.

### R1-4 — upgrade never enables ingestion and never bypasses consent: PASS

```json
{"gate":"G4-upgrade","status":"passed","detail":{"reInitExit":0,"declinedRecordPreserved":true,"freshWorkspace":{"consentRecord":null,"ingestionDefaultOff":true},"installedCli":"Principles Disciple 1.233.0 (000000000000)"}}
```

- `pd runtime init --confirm` (the upgrade/re-init entry) over a **declined** workspace: exit 0, the declined consent record is preserved byte-for-byte, the flag stays off.
- On a **fresh** workspace the same initializer creates no consent record and leaves the ingestion flag at the registry default (off) — an upgrade cannot silently produce a consented state.
- The upgrade-time initializer and installer suites are additionally bound by BDD (§18-15 scenario "Re-running the upgrade-time initializer never enables ingestion"; uninstall/legacy-migration half in `create-principles-disciple`'s installer suites, per the feature-file header).

## 3. Release prerequisite (SPEC §3: "before any release that allows ingestion enablement through setup")

- Slice D merged 2026-09-07 (`3ec948741`).
- npm release stream containing it: `@principles/pd-cli` 1.147.12–1.147.17 published 2026-09-09 → 2026-09-10 (registry `npm view` timestamps). Installed runtime = 1.147.14.
- The consent surface ships disabled-by-default (`codex_conversation_ingestion` quiet flag, `enabled: false`, since 2026-08-29 — flag contract test pins this).

## 4. Rollout prerequisites recorded alongside (SPEC §3 / §17 — unchanged by this gate)

- macOS/Linux on-device probe fixtures remain required before those platforms are release-supported for ingestion (G1 §10 follow-up).
- Default-on remains blocked: it requires this R1 GO **plus** one opt-in dogfood release with no privacy/lineage P1 **plus** an explicit Owner decision (SPEC §17). This evidence does not decide default-on; it unblocks the opt-in dogfood step.

## 5. Installed-binary real-LLM journey (fixture transcript delivery, live LLM)

Naming note: the journey delivers the checked-in G1 transcript **fixture**
through the real installed pd-hook executable and drives every governance
stage with **real LLM calls** — it is NOT a live Codex CLI session (the
harness refuses to mislabel fixture delivery as a live session;
`--live-codex` stays unwired until the host path is exercised). The SPEC's
"real Codex E2E" completion contract therefore remains a separate,
explicitly-gated item; the evidence below claims the installed-binary,
real-LLM journey only.

The owner-journey harness wires the live-LLM stages (this PR):

- **S6 diagnosis** — the production Companion cycle (`pd codex worker --once`) executes the real Diagnostician and the bounded downstream consumer (intake → dreamer → philosopher → scribe → artificer → evaluator → rollout review) against an explicit pi-ai profile; the harness drives bounded cycles and fails loud on degraded modes.
- **S7 owner decision** — the pending approval is approved through `pd activation approve` (the same ApprovalQueue authority as the Console).
- **S9 later behavior (§18-14)** — the activation is observed active and a later prompt delivery works through the injection path.
- With `--skip-llm` the journey keeps its historical fixture-only semantics (S1–S5 + S8 pass; S6/S7/S9 reported as explicitly skipped — verified EXIT=0 after the wiring).

Live probe run on the installed binaries (isolated sandbox workspace, provider
Bai `glm-5.3-flash` via `BAI_API_KEY`, the profile combination previously
proven by the evolution lab; the same run path the harness encodes):

- Real correction delivered through the installed pd-hook (`UserPromptSubmit` correction + `Stop` with the G1 fixture transcript) → 1 governance observation, **1 canonical codex pain**, 1 admitted signal.
- Production worker cycles executed the real split-Diagnostician (router/root-cause/distiller, real LLM) → **3 evidence-linked principle candidates** (§18-13 satisfied: titles derived from the actual correction "修改前先调查已有实现").
- Downstream pipeline with real LLMs, multiple complete stage passes: dreamer ×3 succeeded, philosopher ×3 succeeded, scribe 2/5 succeeded, artificer succeeded (initial + one revision) → **evaluator succeeded ×2 → rollout reviewer succeeded ×2**. The reviewer returned substantive `needs_revision` decisions (confidence 0.85) whose required-changes list names real defects in the generated rule code — e.g. credential-validation fail-open on placeholder values, `WRITE_CMD_PATTERN` misjudging read-only commands (`grep`/`find`) as writes, missing `/dev/null` redirect-target parsing — i.e. the adversarial rollout gate **correctly refuses flawed artifacts** (the governance gate working as designed; the modeled pain itself was "调查后再改").
- Terminal state of this probe: revision budget exhausted (scribe/artificer `output_invalid`, the PRI-707-documented truncation/parse class) with the artifact held in reviewer `needs_revision` — the designed **Owner-decision exit** (SPEC §13; PRI-630 precedent), not a consent-path defect. Operational note: revision-budget resets between rounds were applied as direct task requeues, equivalent to the documented retry CLIs; every executed stage was a real runner invocation through the installed CLI.
- **Consequence for §18-14:** the harness S7 (approval via `pd activation approve`) and S9 (later prompt delivery with the active activation) stages are wired and re-runnable. Two formal live harness runs against the installed binaries both **passed S6** (first-cycle real diagnosis, 2 evidence-linked candidates, full downstream through evaluator/rollout-reviewer) and ended at S7's structured no-approval failure after the bounded cycle budget — the fail-loud path itself was thereby exercised (run 1 exposed a guard bug, fixed in this PR; run 2 recorded the structured failure). A green S7/S9 remains rerun-able when the reviewer accepts a generated artifact; per PRI-626's scope this does not affect R1: R1 gates the **consent UX**, and the opt-in dogfood release is precisely the next step where pipeline-quality convergence (PRI-630/PRI-707 follow-up family) is iterated under Owner governance.

## 6. What R1 does NOT claim

- No default-on decision is made or implied (SPEC §17 prerequisites beyond R1 remain open).
- No cross-host Stage2/GFI parity claim (PRI-632, explicitly outside rev2 closure).
- The LLM-semantics convergence of the internalization pipeline (scribe/artificer `output_invalid` classes) remains tracked under the existing PRI-630/PRI-707 follow-up family; it gates dogfood quality, not the consent rollout gate.
