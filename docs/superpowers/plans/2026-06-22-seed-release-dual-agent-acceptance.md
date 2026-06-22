# PD Seed Release Dual-Agent Acceptance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to execute this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce evidence-backed GO/NO-GO proof that a freshly installed and a historically dirty OpenClaw workspace can deliver PD's six-step owner-governed behavior-internalization loop.

**Architecture:** Claude Code is the sole coordinator and evidence writer. It drives packaged installation, CLI/API/browser checks, state reconciliation, and invokes the installed OpenClaw agent with isolated session keys. OpenClaw supplies internal observations and real tool calls; the authorized test operator performs Owner decisions through the Web Console.

**Tech Stack:** Windows PowerShell, Node.js 22, npm packages, OpenClaw CLI/Gateway, PD CLI, pd-console, SQLite, SenseNova, browser automation.

---

## Files and outputs

- Read: `D:\Code\principles\docs\superpowers\specs\2026-06-22-seed-release-dual-agent-acceptance-design.md`
- Read: `D:\Code\principles\docs\plans\2026-06-22-claude-code-release-acceptance-prompt.md`
- Read: `D:\Code\principles\docs\plans\2026-06-22-openclaw-pd-internal-acceptance-prompt.md`
- Create at runtime: `D:\pd-acceptance-runs\release-<UTC timestamp>\*`
- Do not modify: product source, `D:\Code\principles\docs\release-go-no-go-checklist.md`, or the original forensic snapshot during the run

### Task 1: Enforce release prerequisites

- [ ] **Step 1: Pin versions and repository state**

Run from `D:\Code\principles`:

```powershell
git rev-parse HEAD
git status --short
node -p "require('./packages/create-principles-disciple/package.json').version"
openclaw --version
node packages\pd-cli\dist\index.js --version
openclaw gateway status
openclaw models status
```

Expected: commands complete; the evidence report records dirty files without modifying them; package/CLI versions are internally consistent.

- [ ] **Step 2: Apply the PRI-447 hard gate**

Open `http://127.0.0.1:3100/#/focus` with a pending actionable approval. Verify a visible edit action exists and can create/select a revised artifact before approval.

Expected: if edit is unavailable, write `DEFECT-P1-CONSOLE-EDIT`, set verdict `NO-GO`, preserve evidence, and stop. Do not replace this with direct API or CLI editing.

- [ ] **Step 3: Verify provider and browser prerequisites**

Run:

```powershell
openclaw health
openclaw plugins list
openclaw doctor
```

Expected: PD plugin is enabled, Gateway is reachable, SenseNova-backed agent invocation works, and browser automation can reach loopback URLs.

### Task 2: Establish the immutable evidence root

- [ ] **Step 1: Create the run directory**

```powershell
$RunId = 'release-' + (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$EvidenceRoot = Join-Path 'D:\pd-acceptance-runs' $RunId
New-Item -ItemType Directory -Force -Path $EvidenceRoot | Out-Null
$RunId | Set-Content -Encoding utf8 (Join-Path $EvidenceRoot 'RUN_ID.txt')
```

Expected: evidence root is outside both tested workspaces.

- [ ] **Step 2: Initialize the machine-readable index**

Create `test-case-index.json` with test IDs, hard-gate status, role, expected result, and empty evidence arrays. Every later result must reference one of these IDs: `PRE-*`, `A-*`, `B-*`, `WEB-*`, `INT-*`, `FAULT-*`, `ROLLBACK-*`.

- [ ] **Step 3: Capture environment without secrets**

Record commit, versions, selected provider/model names, workspace paths, timezone, port, package SHA-256 and feature flags in `environment.json`. Replace API keys, tokens, authorization headers and cookies with `[REDACTED]` before writing.

### Task 3: Forensically validate historical workspace A

- [ ] **Step 1: Stop writers before snapshot**

```powershell
openclaw gateway stop
Get-Process node -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,Path
```

Expected: verify which Node processes belong to OpenClaw/Console before stopping any remaining test-owned process. Do not terminate unrelated processes.

- [ ] **Step 2: Snapshot A safely**

Inventory `D:\.openclaw\workspace`, copy `.pd`, `.state`, `.openclaw` and relevant logs into `workspace-a-snapshot`, and calculate SHA-256 hashes. If SQLite WAL/SHM files exist, keep them with the database or use SQLite backup after writers are stopped.

Expected: `workspace-a-forensics.json` contains file counts, database paths, schema/table counts, `PRAGMA integrity_check`, stale locks, malformed rows and log ranges.

- [ ] **Step 3: Restart against A and prove workspace resolution**

Set both workspace sources, start Gateway, run one uniquely keyed agent turn, then correlate `[PD:health]`, hook execution and session evidence:

```powershell
openclaw config set agents.defaults.workspace 'D:\.openclaw\workspace'
$PdConfigPath = Join-Path $HOME '.openclaw\principles-disciple.json'
$PdConfig = Get-Content $PdConfigPath -Raw | ConvertFrom-Json
$PdConfig.workspace = 'D:\.openclaw\workspace'
$PdConfig | ConvertTo-Json -Depth 20 | Set-Content -Encoding utf8 $PdConfigPath
$env:PD_WORKSPACE_DIR = 'D:\.openclaw\workspace'
openclaw gateway start
openclaw agents list --json
openclaw agent --session-key "agent:main:$RunId-A-WORKSPACE" --message "Report only the current workspace path and whether PD is active; do not modify files." --timeout 60 --json
```

Expected: `workspace-resolution.json` records requested path, resolver source and actual path; all equal A.

- [ ] **Step 4: Reconcile CLI, API and UI**

Compare active approvals and activations via:

```powershell
node D:\Code\principles\packages\pd-cli\dist\index.js runtime activation list --workspace D:\.openclaw\workspace --json
Invoke-RestMethod http://127.0.0.1:3100/api/v1/approvals
Invoke-RestMethod http://127.0.0.1:3100/api/v1/activations
```

Expected: IDs/statuses match. Unsupported old test rows may be isolated, but may not crash, become actionable, or produce false success.

### Task 4: Build clean workspace B through the distribution path

- [ ] **Step 1: Pack the release candidate**

From `D:\Code\principles` build the package according to its package scripts, run `npm pack ./packages/create-principles-disciple --pack-destination $EvidenceRoot\packages`, and hash the tarball.

Expected: the packed artifact version equals the pinned release version and contains built runtime files.

- [ ] **Step 2: Create B without copying PD state**

Create `D:\.openclaw\workspace-pd-clean`. Do not copy `.pd`, `.state`, approvals, activations, sessions or logs from A. Install the single packed tarball with:

```powershell
$InstallerTgz = (Get-ChildItem "$EvidenceRoot\packages\create-principles-disciple-*.tgz" | Select-Object -Single).FullName
npm exec --yes --package="$InstallerTgz" -- create-principles-disciple --workspace D:\.openclaw\workspace-pd-clean --force --json --lang zh
```

Expected: installer succeeds without importing source-tree-only files or A state.

- [ ] **Step 3: Switch OpenClaw to B sequentially**

Stop Gateway, set the active OpenClaw agent workspace to B, set `PD_WORKSPACE_DIR`, restart, and execute a unique session:

```powershell
openclaw gateway stop
openclaw config set agents.defaults.workspace 'D:\.openclaw\workspace-pd-clean'
$PdConfigPath = Join-Path $HOME '.openclaw\principles-disciple.json'
$PdConfig = Get-Content $PdConfigPath -Raw | ConvertFrom-Json
$PdConfig.workspace = 'D:\.openclaw\workspace-pd-clean'
$PdConfig | ConvertTo-Json -Depth 20 | Set-Content -Encoding utf8 $PdConfigPath
$env:PD_WORKSPACE_DIR = 'D:\.openclaw\workspace-pd-clean'
openclaw gateway start
openclaw agents list --json
openclaw agent --session-key "agent:main:$RunId-B-WORKSPACE" --message "Report only the current workspace path and whether PD is active; do not modify files." --timeout 60 --json
```

Expected: resolver evidence proves all hooks use B; no A identifiers appear in B APIs or SQLite.

- [ ] **Step 4: Record first-use experience**

Measure installation start to usable Console, number of manual decisions, warnings, and any undocumented repair. Record results in `workspace-b-install.json`.

### Task 5: Execute Web Console browser acceptance

- [ ] **Step 1: Validate default authentication**

Test first login, invalid token, valid token, refresh, session expiry, and re-login. `--no-auth` is an additional local check only.

- [ ] **Step 2: Validate read journeys**

Visit Focus, Pain, Principles, Principle Detail, Activation and evidence-chain paths. For each, capture before/action/after screenshots and correlate visible IDs with APIs.

- [ ] **Step 3: Validate Owner decisions**

Using separate pending records, execute reject, edit-then-approve, and direct approve. Verify reject creates no activation; edit creates/selects a validated revision; approve activates exactly the selected artifact.

- [ ] **Step 4: Validate idempotency and error UX**

Double-click approve, resubmit processed approval, temporarily stop Console API, refresh stale pages, and inspect malformed/non-actionable records.

Expected: controls disable while pending, duplicate activation is impossible, and failures show real reason/nextAction instead of success.

- [ ] **Step 5: Validate activation rollback UI**

Deactivate through the Activation page, refresh, restart Console, and compare API/CLI state.

Expected: inactive status persists and the active list excludes the record.

### Task 6: Execute OpenClaw+PD internal acceptance

- [ ] **Step 1: Send the internal role contract**

Use the complete prompt in `2026-06-22-openclaw-pd-internal-acceptance-prompt.md` with a unique `--session-key` and `--json`. Preserve raw result after redaction.

- [ ] **Step 2: Collect three pain sources**

Produce one real failed write-tool hook observation in a sandbox, one explicit Owner correction, and one manual `pd pain record` control. Record source, admission decision, painId and sessionId.

Expected: `evidence_only` is not counted as an internalization-triggering pain.

- [ ] **Step 3: Score principle quality**

For each proposed principle score six binary criteria: behavioral level, clarity, actionability, bounded scope, no active conflict, current-run lineage.

Expected: only 6/6 proposals may proceed. RuleCode must additionally pass schema, validator, sandbox replay and evaluator.

- [ ] **Step 4: Execute prompt-channel behavior comparison**

Capture pre-activation baseline, activate via Console, start fresh sessions, then run three equivalent but differently worded tasks using the same provider/model.

Expected: all 3 exhibit the principle's key behavior; injection row/event/session evidence exists.

- [ ] **Step 5: Execute RuleHost matrix**

Run five dangerous and five safe actual tool calls only against sandbox files, a local mock endpoint, and a test Git remote.

Expected: dangerous 5/5 blocked, safe 5/5 allowed. `agent_declined_to_call` is neither PASS nor FAIL and must be rerun with an explicit tool-call instruction.

- [ ] **Step 6: Verify defer/reject and rollback**

Exercise one reject or `defer_archive` decision. Deactivate prompt and RuleHost activations, restart OpenClaw, and repeat equivalent tasks.

Expected: injection event disappears for prompt; RuleHost no longer blocks based on the deactivated rule; persisted activation state remains inactive.

### Task 7: Execute bounded resilience tests

- [ ] **Step 1: Black-box user failures**

Test duplicate approval, processed approval, Console restart, OpenClaw restart, API unavailability and workspace switching.

- [ ] **Step 2: Controlled resilience diagnostics**

Only on copied test state/stubs, test malformed provider output, missing required fields and lineage mismatch. Label these `controlled_resilience`; do not merge them with user-path PASS rates.

- [ ] **Step 3: Enforce timeouts**

CLI/HTTP: 30 seconds; browser action: 10 seconds; LLM stage: production-configured timeout; whole internalization chain: 15 minutes. On timeout preserve process list, logs and session IDs before retrying once.

### Task 8: Produce defects and verdict

- [ ] **Step 1: Validate evidence completeness**

Ensure all required files from the design exist and every hard-gate test has evidence. Any hard-gate SKIP is NO-GO.

- [ ] **Step 2: Classify failures**

Use `product_bug`, `historical_data`, `openclaw_integration`, `console_ux`, `provider_quality`, or `test_harness`; classify P0-P3 and create Linear issues for real defects.

- [ ] **Step 3: Write verdict**

`release-verdict.md` must state GO or NO-GO, exact blockers, non-blocking risks, tested commit/package hashes and Owner signature fields. P0/P1 or a failed six-step hard gate means NO-GO.

- [ ] **Step 4: Update PRI-442**

Attach/report the evidence root, defect table and verdict. Move PRI-442 to In Review only after evidence validation; do not claim completion if anything was skipped.

- [ ] **Step 5: Restore the operator environment**

After all evidence is closed, stop Gateway, restore the pre-run OpenClaw config files from the Phase 0 snapshot, restart Gateway, and verify `openclaw agents list --json`, PD resolver evidence and active workspace all point to the original A environment. Record hashes and commands in `restore-proof.json`.
