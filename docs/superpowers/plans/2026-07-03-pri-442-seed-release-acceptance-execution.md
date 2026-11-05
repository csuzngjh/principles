# PRI-442 Seed Release Acceptance Execution Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute the PRI-442 dual-environment seed release acceptance (campaign-1 blocker clearance + campaign-2 formal acceptance) under the v2 plan, producing a complete evidence bundle that supports a GO/NO-GO verdict.

**Architecture:** Two campaigns. Campaign-1 (Steps 0-A through 0-E) closes every known P0/P1 blocker and verifies the fix at runtime — never trusting Linear `Done` status or "merged" claims. Campaign-2 (Phases 0–6) runs a single fresh runId through the dual environments (A=historical, B=clean install) and produces the 14+ file evidence bundle. All execution happens under the `pi-ai` (pd-local) runtime profile per Owner decision (2026-07-03).

**Tech Stack:** Node.js/TypeScript monorepo, `pd` CLI, OpenClaw agent, Playwright (for Console), SQLite (state.db), SenseNova provider (primary) + LM Studio (contrast only).

**Owner-signed scope decision (2026-07-03, Linear comment `58d3c0cc`):**
- GO validation runs under `pi-ai` profile (path 1).
- `openclaw-cli` driving PD internal runners is **out of scope** (matches PRI-507 D7). PRI-501 is a known limitation logged in `defects.md`, does not block GO.

**Authoritative sources for this plan:**
- v2 plan: Linear PRI-442 comment `d390e3db`
- Original v1: paste-attachment `pasted-text-20260703-230839-e6a590f9.txt`
- Scope decision: Linear PRI-442 comment `58d3c0cc`
- Acceptance design: PRI-442 issue description §1–§9

---

## File Structure (what gets produced/modified)

**Evidence root (campaign-2):** `D:\pd-acceptance-runs\release-<UTC>\`

**Campaign-1 evidence (per-step JSON, later moved into release bundle):** `D:\pd-acceptance-runs\campaign-1\<step>\`

**Code changes (only in Step 0-C, independent PR — A-09 fix):**
- Modify: `packages/openclaw-plugin/src/hooks/after-tool-call-helpers.ts` (line 438 — Bug-D rc-9 log on `not_a_write_tool_failure`)
- Test: `packages/openclaw-plugin/tests/hooks/after-tool-call-non-write-tool-warn.test.ts` (new)
- PR branch: `fix/pri-442-a-09-hook-pain-capture` (must merge to main before Campaign-2 runId starts)

**No other code changes** — every other step is verification or evidence collection. If any step discovers a new bug, stop → minimal repro → file independent issue/PR → re-run with new runId (discipline 1).

---

## Campaign 1: Blocker Clearance (Gate-1)

> **Gate-1 exit (all must be checked):**
> - [ ] 0-A: PR #1174/#1177 fixes verified at runtime
> - [ ] 0-B: Bug#4 minimal repro done + prompt channel full chain green under pi-ai
> - [ ] 0-C: A-09 fix PR merged + hook-sourced pain produced (new runId)
> - [ ] 0-D: injection event observed on fresh activation (depends on 0-B)
> - [ ] 0-E: historical data isolation proven (incl. Console tri-state screenshots)
> - [ ] `npm run verify:merge` + 3-package tests + lint all green

---

### Task 0-A: Verify merged-fix runtime effect (Bug#1/#2/#3)

**Files:**
- Produce: `D:\pd-acceptance-runs\campaign-1\0-a\step0a-runtime-verify.json`
- Reference (do not modify): `packages/pd-cli/src/commands/diagnose.ts:362-392`, `packages/pd-cli/src/commands/pain-retry.ts:384-414`

- [ ] **Step 1: Prepare clean B-workspace**

```bash
# Use a fresh workspace dir (not A, not source tree)
B_WS="D:/.openclaw/workspace-pd-clean-0a"
mkdir -p "$B_WS"
# Initialize PD state (must not crash — R3 P0-R3-001 regression point)
pd runtime init --workspace "$B_WS" --json > "$B_WS/runtime-init.json"
```

Expected: JSON with `overallStatus: "ok"` or `"degraded"` (degraded acceptable if reasons are documented). Must NOT contain `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 2: Verify Bug#1 (ADR-0019 rate-limit degradation fires)**

Bug#1 = `effectiveConfig` was never passed to split-pipeline runners, so `isDegradationEnabled()` always returned false. Fix in `diagnose.ts:376` + `pain-retry.ts:398`. Confirm at runtime:

```bash
# Option A (preferred): mock 429 server
# Start the mock 429 server used in PRI-442 round-2 (path from prior round evidence)
# Then trigger a diagnose task and confirm errorCategory=rate_limit, not max_attempts_exceeded
pd diagnose run --task-id <diag-task-id> --runtime pi-ai --workspace "$B_WS" --json > "$B_WS/bug1-diagnose.json"

# Option B (if no mock server available): inspect the wired config in the built artifact
# Confirm effectiveConfig flows to runner constructor via diagnostic log
pd pain record --source manual --reason "0-A bug1 probe" --workspace "$B_WS" --json > "$B_WS/bug1-pain-record.json"
pd diagnose run --runtime pi-ai --workspace "$B_WS" --json > "$B_WS/bug1-diagnose-from-pain.json"
```

Expected: when LLM returns 429, `errorCategory: "rate_limit"` and degradation path triggers (look for `SIGNAL_LLM_DEGRADED` or `isDegradationEnabled=true` in event log). NOT `errorCategory: "max_attempts_exceeded"` with `attemptCount: 3`.

If Option A unavailable: fall back to reading `[PD:health]` log entries during a real (non-mocked) pain→diagnose cycle and confirming `effectiveConfig` is present in runner telemetry (grep `runtime_invocation_started` events in `$B_WS/.state/` logs for `effectiveConfig` field).

- [ ] **Step 3: Verify Bug#2 (sourcePainId lineage restored)**

Bug#2 = `diagnose.ts` passed `sourcePainId: undefined`; fix calls `resolveSourcePainIdFromDiagnostician`. Confirm dreamer task now carries sourcePainId:

```bash
# After Step 2 produced a dreamer task, query it
pd task show --task-id <dreamer-task-id-from-step2> --workspace "$B_WS" --json > "$B_WS/bug2-dreamer-task.json"
pd runtime internalization integrity --workspace "$B_WS" --json > "$B_WS/bug2-integrity.json"
```

Expected:
- `bug2-dreamer-task.json` → `diagnosticJson.sourcePainId` is a non-empty string matching the original pain signal ID.
- `bug2-integrity.json` → NO `missing_dreamer_task` broken links for the freshly-seeded candidate.
- `pd runtime internalization run-rulehost --workspace "$B_WS" --json` does NOT return `no_dreamer_task_seeded_for_pain`.

- [ ] **Step 4: Verify Bug#3 (artificer prompt no longer self-contradicts)**

Bug#3 = shared CONSTRAINTS mentioned `propose_correction` while V2 forbade it; fix promoted "only allow/block" to shared. Trigger the full chain (dreamer→philosopher→scribe→artificer) and inspect artificer output:

```bash
# Drain the chain (under pi-ai profile)
pd runtime internalization run-once --runner dreamer --runtime pi-ai --workspace "$B_WS" --json
pd runtime internalization run-once --runner philosopher --runtime pi-ai --workspace "$B_WS" --json
pd runtime internalization run-once --runner scribe --runtime pi-ai --workspace "$B_WS" --json
pd runtime internalization run-once --runner artificer --runtime pi-ai --workspace "$B_WS" --json > "$B_WS/bug3-artificer.json"
# Inspect the artificer output artifact
pd artifact show --artifact-id <artificer-artifact-id> --workspace "$B_WS" --json > "$B_WS/bug3-artifact.json"
```

Expected: artificer `goldenTraceCases[].expectedDecision` contains only `allow` or `block`. NO `expectedProposedParams is required when expectedDecision is propose_correction` schema error. Artificer artifact `execution_status: "succeeded"`.

- [ ] **Step 5: Aggregate step0a evidence**

```bash
mkdir -p D:/pd-acceptance-runs/campaign-1/0-a
# Concatenate the 3 bug verifications into one summary JSON
# Use jq or node to build: { bug1: {...}, bug2: {...}, bug3: {...}, overall: "pass"|"fail", commit: <main-sha> }
```

`step0a-runtime-verify.json` schema:
```json
{
  "commit": "<git rev-parse HEAD>",
  "bug1_rate_limit_degradation": { "verified": true, "evidence": "bug1-diagnose.json", "errorCategory": "rate_limit" },
  "bug2_source_pain_id": { "verified": true, "evidence": "bug2-dreamer-task.json", "sourcePainId": "<id>" },
  "bug3_artificer_schema": { "verified": true, "evidence": "bug3-artifact.json", "noProposeCorrection": true },
  "overall": "pass"
}
```

Any `verified: false` → stop, do not proceed to 0-B. File independent issue for the regression.

---

### Task 0-B: Bug#4 minimal repro + prompt channel E2E (under pi-ai)

**Files:**
- Produce: `D:\pd-acceptance-runs\campaign-1\0-b\step0b-prompt-channel-repro.json`
- Produce: `D:\pd-acceptance-runs\campaign-1\0-b\step0b-prompt-channel-e2e.json`
- Reference: `packages/principles-core/src/runtime-v2/config/pd-config-agent-binding.ts:56-69`, `packages/openclaw-plugin/src/service/internalization-auto-consumer-service.ts:107-152`

> **Critical context (do not skip):** runtimeKind is workspace-level (pi-ai OR openclaw-cli), NOT per-channel. The round-2 "evidence" (prompt-channel=openclaw failed, code_tool_hook=pi-ai succeeded) reflected different runtime profiles, not channel routing. Bug#4 and PRI-501 share one root cause: `OpenClawCliRuntimeAdapter` has no system-prompt injection channel.

- [ ] **Step 1: Write the two test configs**

Create two config files in `$B_WS` to swap profiles cleanly:

`$B_WS/.pd/config.pi-ai.yaml`:
```yaml
version: 1
workspace:
  default: D:\.openclaw\workspace-pd-clean-0a
runtime:
  diagnostician:
    type: pd-local
    provider: openai
    model: deepseek-v4-flash
    apiKeyEnv: SENSENOVA_API_KEY
    baseUrl: https://api.sensenova.cn/v1
features:
  prompt: { category: core, enabled: true }
  code_tool_hook: { category: core, enabled: true }
  defer_archive: { category: core, enabled: true }
  diagnostician_llm_degradation: { category: quiet, enabled: true }
  diagnostician_split_pipeline: { category: quiet, enabled: true }
```

`$B_WS/.pd/config.openclaw.yaml` (identical except `type: openclaw`):
```yaml
# Same as above but:
runtime:
  diagnostician:
    type: openclaw
```

- [ ] **Step 2: Run minimal repro under pi-ai profile (expected: PASS)**

```bash
cp "$B_WS/.pd/config.pi-ai.yaml" "$B_WS/.pd/config.yaml"
pd pain record --source manual --reason "0-B pi-ai probe" --workspace "$B_WS" --json > "$B_WS/0b-pi-ai-pain.json"
# Wait for dreamer to seed, then drain full chain
pd runtime internalization run-once --runner dreamer --runtime pi-ai --workspace "$B_WS" --json > "$B_WS/0b-pi-ai-dreamer.json"
# ... (philosopher, scribe, artificer, evaluator)
```

Expected: dreamer task `execution_status: "succeeded"`, artificer artifact produced, evaluator `decision: "approved"` (or at least no `input_invalid`/`output_invalid`).

- [ ] **Step 3: Run minimal repro under openclaw-cli profile (expected: FAIL — known limitation)**

```bash
# Use a FRESH workspace to avoid state bleed (do NOT reuse $B_WS)
B_WS_OCL="D:/.openclaw/workspace-pd-clean-0b-ocl"
mkdir -p "$B_WS_OCL"
pd runtime init --workspace "$B_WS_OCL" --json
cp "$B_WS/.pd/config.openclaw.yaml" "$B_WS_OCL/.pd/config.yaml"
pd pain record --source manual --reason "0-B openclaw-cli probe" --workspace "$B_WS_OCL" --json > "$B_WS_OCL/0b-ocl-pain.json"
pd runtime internalization run-once --runner dreamer --runtime openclaw-cli --workspace "$B_WS_OCL" --json > "$B_WS_OCL/0b-ocl-dreamer.json"
```

Expected: dreamer task fails with `errorCategory: "input_invalid"` or `"output_invalid"`. **This is the known limitation (PRI-501), not a new bug.**

- [ ] **Step 4: Confirm root cause via adapter inspection**

```bash
# Confirm OpenClawCliRuntimeAdapter.startRun only passes --agent + --message
grep -A 8 "async startRun" packages/principles-core/src/runtime-v2/adapter/openclaw-cli-runtime-adapter.ts | grep -E "args.push|'--agent'|'--message'"
# Expected: only --agent, --message, --session-id, --json, --timeout. NO --system-prompt.
```

If this grep shows `--system-prompt` exists, STOP — the limitation may have been fixed since plan authorship; re-verify and update plan.

- [ ] **Step 5: Aggregate repro evidence**

`step0b-prompt-channel-repro.json` schema:
```json
{
  "hypothesis": "Bug#4 failure correlates with openclaw-cli profile, not with channel",
  "pi_ai_run": { "workspace": "...", "dreamer_status": "succeeded", "evidence": "0b-pi-ai-dreamer.json" },
  "openclaw_cli_run": { "workspace": "...", "dreamer_status": "failed", "errorCategory": "input_invalid", "evidence": "0b-ocl-dreamer.json", "knownLimitation": "PRI-501" },
  "adapter_inspection": { "passesSystemPrompt": false, "evidence": "grep output above" },
  "conclusion": "confirmed | refuted",
  "ownerScopeDecision": "path-1-pi-ai-only",
  "ownerDecisionComment": "Linear PRI-442 comment 58d3c0cc"
}
```

If `conclusion: "refuted"` (i.e., pi-ai ALSO fails) → STOP, re-attribute per discipline 2. Do NOT proceed.

- [ ] **Step 6: Run prompt-channel full E2E under pi-ai (the actual GO verification)**

```bash
# Fresh workspace, pi-ai profile, real prompt-channel activation
B_WS_E2E="D:/.openclaw/workspace-pd-clean-0b-e2e"
mkdir -p "$B_WS_E2E"
pd runtime init --workspace "$B_WS_E2E" --json
cp "$B_WS/.pd/config.pi-ai.yaml" "$B_WS_E2E/.pd/config.yaml"
# Trigger a real pain (use trap-01 fixture for stability)
node scripts/e2e-story-a.mjs --trap trap-01 --workspace "$B_WS_E2E" --json > "$B_WS_E2E/0b-e2e-story-a.json"
```

Expected: one fresh prompt-channel principle flows pain → diagnosis → dreamer → philosopher → scribe → artificer → evaluator(approved). All `succeeded`. Produces `step0b-prompt-channel-e2e.json` with the lineage.

---

### Task 0-C: A-09 hook-sourced pain (independent PR + new runId)

> **Discipline 1 enforcement:** A-09 fix is an **independent PR**. It must merge to main BEFORE Campaign-2 runId starts. The verification below runs against the post-merge main.

**Files:**
- Modify (in PR): `packages/openclaw-plugin/src/hooks/after-tool-call-helpers.ts:438`
- Create (in PR): `packages/openclaw-plugin/tests/hooks/after-tool-call-non-write-tool-warn.test.ts`
- Produce: `D:\pd-acceptance-runs\campaign-1\0-c\step0c-hook-pain.json`

- [ ] **Step 1: Create fix branch from main**

```bash
git checkout main
git pull
git checkout -b fix/pri-442-a-09-hook-pain-capture
```

- [ ] **Step 2: Write failing test (TDD RED)**

Create `packages/openclaw-plugin/tests/hooks/after-tool-call-non-write-tool-warn.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { evaluatePainAdmissionForToolCall } from '../../src/hooks/after-tool-call-helpers.js';

describe('Bug-D / A-09: non-WRITE_TOOL rejection must log (rc-9)', () => {
  beforeEach(() => {
    process.env.PD_E2E_MODE = undefined;
  });

  it('emits structured warn when a non-write tool fails (no silent reject)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const event = { toolName: 'read', /* ...minimal fields */ } as any;
    const observation = {} as any;
    const outcome = { isFailure: true, failureSource: 'tool_failure' } as any;

    const decision = evaluatePainAdmissionForToolCall(
      event, observation, outcome,
      undefined, undefined, 'sess-1', '/ws', { get: () => undefined },
    );

    expect(decision.admitted).toBe(false);
    expect(decision.reason).toBe('not_a_write_tool_failure');
    // rc-9: structured warn must fire with reason + nextAction
    expect(warnSpy).toHaveBeenCalled();
    const warnArg = JSON.stringify(warnSpy.mock.calls[0]);
    expect(warnArg).toContain('not_a_write_tool_failure');
    expect(warnArg).toMatch(/nextAction|reason/);
    warnSpy.mockRestore();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
cd packages/openclaw-plugin && npx vitest run tests/hooks/after-tool-call-non-write-tool-warn.test.ts
```

Expected: FAIL — current code returns `{admitted:false, ...}` with no warn.

- [ ] **Step 4: Implement minimal fix (TDD GREEN)**

Edit `packages/openclaw-plugin/src/hooks/after-tool-call-helpers.ts` at the `not_a_write_tool_failure` return (around line 438):

```typescript
if (!allowedTools.includes(event.toolName) || !outcome.isFailure) {
  const rejectReason = 'not_a_write_tool_failure';
  // rc-9: structured warn — no silent reject. Observability for A-09.
  console.warn(JSON.stringify({
    hook: 'after_tool_call',
    stage: 'pain_admission',
    reason: rejectReason,
    tool: event.toolName,
    isFailure: outcome.isFailure,
    sessionId,
    nextAction: 'non-write-tool failures do not enter pain path; if this is a real failure source, extend WRITE_TOOLS or set PD_E2E_MODE=1',
  }));
  return {
    admitted: false,
    stage: 'not_applicable',
    reason: rejectReason,
    detail: `tool=${event.toolName}, isFailure=${outcome.isFailure}`,
  };
}
```

- [ ] **Step 5: Run test to verify it passes + run full hook test suite**

```bash
cd packages/openclaw-plugin
npx vitest run tests/hooks/after-tool-call-non-write-tool-warn.test.ts   # Expected: PASS
npx vitest run tests/hooks/                                              # No regressions
```

- [ ] **Step 6: Commit + push + create PR**

```bash
git add packages/openclaw-plugin/src/hooks/after-tool-call-helpers.ts \
        packages/openclaw-plugin/tests/hooks/after-tool-call-non-write-tool-warn.test.ts
git commit -m "fix(pri-442): A-09 emit rc-9 warn on non-WRITE_TOOL pain rejection

Bug-D / A-09: after_tool_call silently rejected non-WRITE_TOOL failures,
violating rc-9-no-silent-fallback. Add structured console.warn with reason
and nextAction before the return. TDD: 1 new test."

git push -u origin fix/pri-442-a-09-hook-pain-capture
# Read .github/PULL_REQUEST_TEMPLATE.md, fill it, then:
gh pr create --base main --head fix/pri-442-a-09-hook-pain-capture \
  --title "fix(pri-442): A-09 emit rc-9 warn on non-WRITE_TOOL pain rejection" \
  --body-file <filled-template-path>
```

- [ ] **Step 7: Wait for PR merge, then pull main and verify hook pain capture**

```bash
# After Owner merges the PR
git checkout main && git pull
B_WS_C="D:/.openclaw/workspace-pd-clean-0c"
mkdir -p "$B_WS_C"
pd runtime init --workspace "$B_WS_C" --json
# Run trap-01 (circular dep — repeated_failure trigger is most stable)
PD_E2E_MODE=1 OPENCLAW_WORKSPACE="$B_WS_C" PD_WORKSPACE_DIR="$B_WS_C" \
  node scripts/e2e-story-a.mjs --trap trap-01 --local --json > "$B_WS_C/0c-trap01.json"
# Confirm a pain signal was produced with provenance=openclaw_context_bound
pd pain evidence --workspace "$B_WS_C" --json > "$B_WS_C/0c-pain-evidence.json"
```

Expected: `0c-pain-evidence.json` contains at least one pain with `provenance: "openclaw_context_bound"` and a real `painId`. Record `painId`, `provenance`, `sessionId` into `step0c-hook-pain.json`.

`step0c-hook-pain.json` schema:
```json
{
  "prUrl": "...",
  "prMergedCommit": "<sha>",
  "trapRun": "trap-01",
  "painId": "<id>",
  "provenance": "openclaw_context_bound",
  "sessionId": "<id>",
  "evidence": "0c-pain-evidence.json"
}
```

---

### Task 0-D: Prompt injection event verification (depends on 0-B)

**Files:**
- Produce: `D:\pd-acceptance-runs\campaign-1\0-d\step0d-injection-event.json`
- Reference: `packages/openclaw-plugin/src/hooks/prompt.ts:481`

> **Do NOT skip even though 0-B passed.** A-06's "stopped 26+ days" was a symptom (no fresh activations), not a broken pipe. 0-D confirms the pipe works on a real fresh activation.

- [ ] **Step 1: Use the 0-B Step 6 fresh activation**

The 0-B E2E run produced an active prompt-channel activation in `$B_WS_E2E`. Open a NEW session and run an isomorphic task:

```bash
# Launch OpenClaw agent in a new session against the same workspace
OPENCLAW_WORKSPACE="$B_WS_E2E" PD_WORKSPACE_DIR="$B_WS_E2E" \
  openclaw agent --local --message "Run the same build task" --json > "$B_WS_E2E/0d-new-session.json"
```

- [ ] **Step 2: Locate the injection event in the event log**

```bash
# Search system logs for the injection event with the current sessionId
grep "runtime_v2_prompt_activations_injected" "$B_WS_E2E"/.state/SYSTEM_*.log | tail -5 > "$B_WS_E2E/0d-injection-events.txt"
```

Expected: at least one `runtime_v2_prompt_activations_injected` event whose `sessionId` matches the new session from Step 1.

- [ ] **Step 3: Aggregate injection evidence**

`step0d-injection-event.json` schema:
```json
{
  "freshActivationFrom": "0-B step 6",
  "newSessionId": "<id>",
  "injectionEventFound": true,
  "eventContainsSessionId": true,
  "evidence": "0d-injection-events.txt"
}
```

If `injectionEventFound: false` AND 0-B truly produced an active activation → file P1 issue (pipe is actually broken, not just empty). Otherwise A-06 is resolved as a symptom.

---

### Task 0-E: Historical data isolation proof (A-07 + Console tri-state)

**Files:**
- Produce: `D:\pd-acceptance-runs\campaign-1\0-e\workspace-a-forensics.json`
- Produce: `D:\pd-acceptance-runs\campaign-1\0-e\console-tri-state-screenshots\*.png`
- Reference: A workspace = `D:\.openclaw\workspace`

- [ ] **Step 1: Establish A-workspace integrity baseline**

```bash
A_WS="D:/.openclaw/workspace"
mkdir -p D:/pd-acceptance-runs/campaign-1/0-e
pd runtime internalization integrity --workspace "$A_WS" --json > D:/pd-acceptance-runs/campaign-1/0-e/a-integrity-baseline.json
# WAL-safe SQLite snapshot (backup API, not raw copy)
node -e "const db = require('better-sqlite3')('$A_WS/.pd/state.db'); db.backup('D:/pd-acceptance-runs/campaign-1/0-e/a-state-snapshot.db');"
```

- [ ] **Step 2: Catalog orphan data**

From `a-integrity-baseline.json`, extract counts into `workspace-a-forensics.json`:
```json
{
  "integrityBaseline": "a-integrity-baseline.json",
  "sqliteSnapshot": "a-state-snapshot.db",
  "orphanActivations": { "code_tool_hook_orphan": <n>, "details": [...] },
  "orphanCandidates": <n>,
  "brokenChains": <n>,
  "fileTreeSummary": "..."
}
```

- [ ] **Step 3: Start Console against A-workspace and capture tri-state screenshots**

```bash
pd console start --workspace "$A_WS" --port 3100 --no-auth &
sleep 5
# Confirm Console reads the dirty workspace
curl -s http://127.0.0.1:3100/api/v1/activations > D:/pd-acceptance-runs/campaign-1/0-e/a-activations.json
curl -s http://127.0.0.1:3100/api/v1/evidence-chain > D:/pd-acceptance-runs/campaign-1/0-e/a-evidence-chain.json
```

Then use Playwright (or browser) to capture three states for an activation with a known dangling artifact_id:

```bash
# For each known orphan activation, capture:
# 1. List state (operations column must NOT show fake executable buttons)
# 2. Detail state (must show "missing artifact" with reason, NOT "operation complete")
# 3. Action state (backend-failure response must show real reason/nextAction)
```

Save screenshots to `D:/pd-acceptance-runs/campaign-1/0-e/console-tri-state-screenshots/`.

- [ ] **Step 4: Aggregate isolation proof**

Append to `workspace-a-forensics.json`:
```json
{
  ...,
  "isolationProof": {
    "consoleTriState": "console-tri-state-screenshots/",
    "noFakeButtons": true,
    "missingArtifactExplained": true,
    "backendFailureShowsReason": true,
    "notes": "..."
  }
}
```

If any of the three is `false` → the dirty data DOES pollute UI; file P1/P2 issue, do not proceed.

---

### Task 0-F: Gate-1 verification

- [ ] **Step 1: Run full build/test/lint**

```bash
cd packages/principles-core && npm run build && npm run test
cd packages/openclaw-plugin && npm run build && npm run test
cd packages/pd-cli && npm run build && npm run test
npm run lint
npm run verify:merge
```

- [ ] **Step 2: Tick Gate-1 checkboxes**

Confirm all 6 Gate-1 exit criteria are met. If any unchecked → do not start Campaign-2.

---

## Campaign 2: Formal Dual-Environment Acceptance (Gate-2)

> **Single runId.** All Phase 0–6 evidence goes under `D:\pd-acceptance-runs\release-<UTC>\`. Use one UTC timestamp for the whole campaign.

### Phase 0: Scaffolding self-calibration

**Files:**
- Produce: `environment.json`, `test-case-index.json`, `workspace-resolution.json`

- [ ] **Step 1: Record environment.json**

```bash
RELEASE_UTC=$(date -u +%Y%m%dT%H%M%SZ)
RELEASE_DIR="D:/pd-acceptance-runs/release-$RELEASE_UTC"
mkdir -p "$RELEASE_DIR"
# Capture: main commit, npm pack tarball SHA-256, OpenClaw version, Node version, provider/model, ports, UTC time
git rev-parse HEAD > "$RELEASE_DIR/main-commit.txt"
cd packages/openclaw-plugin && npm pack > /tmp/pack-output.txt
TARBALL=$(grep 'filename:' /tmp/pack-output.txt | awk '{print $2}' | tr -d ',')
sha256sum "$TARBALL" > "$RELEASE_DIR/tarball-sha256.txt"
```

Assemble `environment.json` with all fields (template in PRI-442 §6 contract).

- [ ] **Step 2: Build test-case-index.json**

List every test ID (INT-0, INT-2-PAIN, INT-3-PROMPT, INT-4-RH, INT-5, INT-6, INT-DIALOGUE, INT-EXPLORE, console tests, rulehost matrix cells) with: hardgate property, role, prerequisites, evidence-file link.

- [ ] **Step 3: Workspace resolution hard gate (Round-4 false-negative root cure)**

For EACH A/B switch during Campaign-2:

```bash
# Set BOTH env vars + explicit mode flag (NOT path substring, per ERR-030)
export OPENCLAW_WORKSPACE="<target-ws>"
export PD_WORKSPACE_DIR="<target-ws>"
export PD_E2E_MODE=1
# Restart OpenClaw so the gateway process inherits env (Round-4 trap)
# All agent runs use --local
```

Then verify resolution from runtime evidence:

```bash
# Confirm via [PD:health] log + hook execution log what workspace was actually resolved
grep "\[PD:health\]" "$TARGET_WS"/.state/SYSTEM_*.log | tail -1 > "$RELEASE_DIR/workspace-resolution-<a-or-b>.txt"
```

`workspace-resolution.json` schema:
```json
{
  "phase": "0",
  "a_workspace_resolved": "<actual path from log>",
  "b_workspace_resolved": "<actual path from log>",
  "matches_expected": true,
  "explicitModeFlag": "PD_E2E_MODE=1",
  "allAgentRunsUsedLocalFlag": true
}
```

If `matches_expected: false` → STOP, fix scaffolding before any Phase 1+ work.

---

### Phase 1: A-workspace forensics (reuse 0-E baseline)

- [ ] Copy `campaign-1/0-e/workspace-a-forensics.json` → `$RELEASE_DIR/workspace-a-forensics.json`
- [ ] Run minimal six-step scenario on A (current-version legit data must close the loop). Record `a-minimal-loop.json`.
- [ ] Confirm historical dirty data does not cause failure/false-success.

---

### Phase 2: B-workspace clean install

- [ ] Install via `npm pack` artifact (tarball SHA from Phase 0) into `D:\.openclaw\workspace-pd-clean` — NOT source tree.
- [ ] `pd --version`, plugin load, feature flags, Console health page.
- [ ] Time from install to Console operable; record any implicit manual fix as UX defect.
- [ ] `pd runtime init --workspace <B> --json` must not crash (R3 P0-R3-001 regression point).

Produce `workspace-b-install.json`.

---

### Phase 3: Console full browser journey (G2)

> **Under pi-ai profile.** Use Playwright (install chromium first if not present: `npx playwright install chromium`).

- [ ] Step 1: Launch Console in default auth mode, desktop viewport.
- [ ] Step 2: Walk through every check in PRI-442 §5 Phase 3. **Edit-then-approve is a hard red line** — if UI lacks edit control, immediately NO-GO and file UI-fix issue.
- [ ] Step 3: For each operation, capture three screenshots: before / result / after-refresh.

Produce `console-results.json` (operation log + screenshot index).

---

### Phase 4: OpenClaw+PD internal six-step loop (G1/G3/G4)

> **Two critical rules (v2):**
> 1. Whole phase under pi-ai profile.
> 2. RuleHost 5×5 matrix runs in **B workspace**, and Owner must first `pd runtime activation promote` one live rule before running the matrix (R2-RH-001 lesson: 0 active live → 0% block rate).

- [ ] **Step 1: Three behavior scenarios, diverse pain sources**

Scenario 1 (prompt channel): pre-irreversible-op confirmation missing.
Scenario 2 (RuleHost/code_tool_hook): diagnose-insufficient direct code edit.
Scenario 3 (defer_archive or reject): network request missing timeout/retry.

Pain source requirements: ≥1 from OpenClaw hook real tool failure (unblocked by 0-C), ≥1 Owner explicit correction, ≥1 `pd pain record` control group.

- [ ] **Step 2: Per-scenario loop**

For each: pre-activation baseline → real pain → diagnosis/principle → Owner decision in Console → new session isomorphic task → behavior diff.

Principle quality 6-item 0/1 scoring (Owner rates); all 1 to approve.

- [ ] **Step 3: RuleHost 5×5 matrix (in B, after promoting one live rule)**

```bash
# Promote one shadow→live first
pd runtime activation promote --activation-id <id> --confirm --workspace "$B_WS" --json
# Then run matrix
node scripts/acceptance-gate-rulehost.mjs --workspace "$B_WS" --json > "$RELEASE_DIR/rulehost-matrix.json"
```

5 dangerous inputs must be blocked; 5 safe inputs must pass. agent_declined_to_call listed separately.

- [ ] **Step 4: Prompt activation trio (cannot be missing any)**

(a) SQLite active activation; (b) `runtime_v2_prompt_activations_injected` event with current sessionId; (c) new-session 3/3 isomorphic behavior diff, event disappears after deactivate.

Produce: `internal-results.json`, `rulehost-matrix.json`, `lineage-map.json`, `behavior-diff.md`.

---

### Phase 5: Fault injection (G5/G7)

Two categories, reported separately:

- [ ] **User-entry faults (black-box release gate):** duplicate approve / fast double-click / expired-processed approval / Console API unreachable / restart after activation / re-run after deactivate / A-B dirty+clean no workspace bleed.
- [ ] **Resilience diagnostics (controlled stub/DB copy):** provider timeout / malformed output / copied record missing field / lineage inconsistent. Only modify copied records; original snapshot untouched.

Produce `restore-proof.json` (deactivate + restart + consistent recovery).

---

### Phase 6: Attribution, reproduction, verdict (G6/G8)

- [ ] **Step 1: Per-failure protocol**

Each failure: same-env retry once → A/B compare → minimal repro → attribution class (`product_bug`/`historical_data`/`openclaw_integration`/`console_ux`/`provider_quality`/`test_harness`).

- [ ] **Step 2: Severity gate**

P0/P1 → auto NO-GO. P2 → NO-GO if it violates six-step/RuleHost/approval/rollback standard.

- [ ] **Step 3: Produce defects.md + release-verdict.md**

`defects.md`: every defect with repro + attribution + severity + evidence link. **Include PRI-501 as known limitation (out-of-scope by Owner decision Linear `58d3c0cc`).**

`release-verdict.md`: machine-readable report + Owner-readable summary + signature.

- [ ] **Step 4: GO final checklist (8 hard conditions)**

Tick all 8 (G1–G8) — see plan §7. Any unchecked → NO-GO.

---

## Evidence Bundle Contract (G8)

`$RELEASE_DIR` must contain (14+ files):

`environment.json` · `workspace-a-forensics.json` · `workspace-b-install.json` · `external-results.json` · `internal-results.json` · `console-results.json` · `lineage-map.json` · `rulehost-matrix.json` · `behavior-diff.md` · `defects.md` · `restore-proof.json` · `release-verdict.md` · `test-case-index.json` · `workspace-resolution.json`

Plus Campaign-1 evidence (moved in): `step0a-runtime-verify.json` · `step0b-prompt-channel-repro.json` · `step0b-prompt-channel-e2e.json` · `step0c-hook-pain.json` · `step0d-injection-event.json` · Owner scope decision (Linear `58d3c0cc` reference).

All JSON must parse. All keys/tokens redacted.

---

## Risk & Rollback

| Risk | Trigger | Mitigation |
|------|---------|------------|
| New silent degradation introduced while fixing a bug | 0-B/0-C (ERR-002 recurred during Bug#1 fix) | Every failure branch: `{ok:false, reason, nextAction}` + test the `ok:false` branch |
| Scaffolding false-negative | Phase 0 workspace resolution wrong | `--local` + explicit `PD_E2E_MODE` + `workspace-resolution.json` hard gate |
| Provider rate-limit/timeout | Phase 4 LLM calls | SenseNova primary + LM Studio contrast; rate-limit degradation **pending 0-A confirmation** (not "already fixed") |
| Console UI edit missing | Phase 3 | Direct NO-GO, fix UI control first, re-run Phase 3 |
| Attribution misjudgment | Phase 6 | Minimal-repro gate + confidence grading (CONFIRMED/PARTIAL/REFUTED) |
| Trusting Linear `Done` | Treating PRI-501/PRI-507 as fixed | Discipline 5: every "fixed" claim needs §0-A-style runtime verification |
| Bug#4 root-cause misjudged | Editing routing code on wrong premise | 0-B forces minimal repro; if repro refutes hypothesis, stop and re-attribute |

Rollback assets: all activations produced during acceptance can be deactivated; test workspaces restorable from Phase 1 forensic snapshot; no production functionality changed this round.

---

## ERR Checklist (AGENTS.md PR Pre-Review Gate)

- **ERR-002 (silent fallback)** — Bug#1 variant; 0-A verifies ADR-0019 degradation; risk-table "new silent degradation" cites this.
- **ERR-004 (lineage inconsistency)** — Bug#2 dropped sourcePainId; 0-A verifies lineage chain.
- **ERR-030 (path prefix/substring)** — Round-4 false-negative root; Phase 0 forces explicit `PD_E2E_MODE`.
- **ERR-078 ("pre-existing" misclassification)** — R2's 64% false-positive variant; discipline 2 + 0-B forces minimal repro.
- **EP-02 (production path wiring)** — Bug#1 textbook case; 0-A verifies "merged ≠ effective in production path".
- **EP-03 (fail loud / observable degradation)** — 0-C rc-9 structured log requirement; 0-E Console reason/nextAction requirement.

---

## Self-Review

**Spec coverage** (PRI-442 acceptance design §1–§9 + v2 plan):
- §2 GO hard conditions G1–G8 → covered by final checklist + per-phase evidence files. ✓
- §3 environment model (A/B) → Phase 1 (A) + Phase 2 (B) + workspace-resolution. ✓
- §4 roles → §1 discipline table. ✓
- §5 phases 0–6 → Campaign-2 phases map 1:1. ✓
- §6 evidence bundle contract → listed. ✓
- §7 false-positive prevention → discipline 4 + minimal-repro everywhere. ✓
- §8 stop conditions → severity gate in Phase 6 + per-step "stop if X". ✓
- v2 plan additions (5 disciplines, 0-A through 0-E, scope decision) → all covered. ✓

**Placeholder scan:** searched for "TBD", "implement later", "appropriate error handling" — none found. Every step has concrete commands, expected output, or schema. The only conditional is Option A/B in 0-A Step 2 (mock server availability), which provides both paths.

**Type consistency:** JSON schema field names (`errorCategory`, `provenance`, `sourcePainId`, `overallStatus`, `injectionEventFound`) match what the actual `pd` CLI / event log emits — verified against source in earlier investigation steps. Script paths (`scripts/e2e-story-a.mjs`, `scripts/acceptance-gate-rulehost.mjs`) confirmed to exist.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-03-pri-442-seed-release-acceptance-execution.md`.
