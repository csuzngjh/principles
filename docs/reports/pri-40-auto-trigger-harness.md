# PRI-40: Deterministic OpenClaw Auto-Trigger Harness

**Status:** Track A ✅ PASS | Track B ⏸️ BLOCKED (gateway unavailable)
**Date:** 2026-05-03
**Issue:** [PRI-40](https://linear.app/principlesdisciple/issue/PRI-40/pri-29b-deterministic-openclaw-auto-trigger-harness)
**PR:** #457 (follow-up report fix)

---

## Security Notice

API key environment variable name: **`MINIMAX_CN_API_KEY`** (not `MINIMAX_API_KEY`).

**Never commit API keys to git or paste them in Linear comments.** Rotate/revoke if exposed.

---

## Track A — Manual Pain Trigger

### Result: ✅ PASS

```
pd pain record --reason "PRI-29B harness test" --score 100 --source manual --workspace "D:\.openclaw\workspace"
```

**Output:**
```
[OK] Pain signal recorded via PainToPrincipleService
   Pain ID: manual_1777794162410_3em1wa67
   Task ID: diagnosis_manual_1777794162410_3em1wa67
   Run ID: run_diagnosis_manual_1777794162410_3em1wa67_1
   Artifact ID: b8551fe4-bc72-40e9-a943-4286ec17e81a
   Candidate IDs: 6c4bc6f2-d849-4ead-92b5-9d148dd5c901
   Ledger Entry IDs: d4ccc420-2947-430c-a5a6-103ee454c45a
   Latency: 35625ms
```

**Verification commands:**

| Command | Result |
|---------|--------|
| `pd runtime health snapshot` | lastSuccessfulChain updated, status: succeeded ✅ |
| `pd runtime trace show --pain-id manual_1777794162410_3em1wa67` | Full chain (painId→taskId→runId→artifactId→candidateIds→ledgerEntryIds) present ✅ |
| `pd candidate audit` | status: ok, missingLedgerEntryIds: [] ✅ |

**Latency breakdown:**
- painToTask: 15ms
- taskToRun: 35592ms
- candidateToLedger: 12ms

---

## Track B — Gateway Tool Failure

### Status: ⏸️ BLOCKED

**Blocker:** OpenClaw gateway not reachable via `openclaw` CLI (module path broken after sync-plugin.mjs).

**Design intent (not yet executed):**

Goal: trigger OpenClaw `after_tool_call` failure through agent conversation, observe GFI accumulation.

**Minimum safe trigger task:**

```
Ask the agent to read a file that does not exist:
"Read the file at /tmp/nonexistent-guaranteed-fail-$(date +%s).txt"

Expected behavior:
1. Tool call: read /tmp/nonexistent-guaranteed-fail-<timestamp>.txt
2. Tool result: ENOENT / no such file
3. GFI accumulates: +30 (tool_failure_friction delta)
4. Single failure: GFI = 30 < painTrigger (40) → PAIN_GATE_REJECTED
5. To reach pain_detected: need 2 consecutive failures → GFI = 60 ≥ 40

Observe: PAIN_GATE_REJECTED log with reason/detail/gfi/score
```

**Alternative trigger path (if ENOENT doesn't accumulate GFI):**

Write to a genuinely protected path:
```
Write to /etc/protectedftest_<timestamp>.txt with content "test"
```

**Verification steps if gateway available:**

```bash
# 1. Send trigger message via OpenClaw gateway
# 2. Wait for GFI accumulation
# 3. Check health snapshot

pd runtime health snapshot --workspace "D:\.openclaw\workspace" --json
pd candidate audit --workspace "D:\.openclaw\workspace" --json

# 4. If pain_detected was emitted, trace it:
pd runtime trace show --pain-id <painId> --workspace "D:\.openclaw\workspace" --json
```

**Expected outcomes:**

| Outcome | Condition | Log Evidence |
|---------|-----------|-------------|
| GATED | GFI < 40 | `PAIN_GATE_REJECTED` with reason/detail/gfi/score |
| PASS | GFI ≥ 40 | `pain_detected` → PainToPrincipleService → full chain |

---

## Remaining Blocker for Track B

**Minimal blocker:** OpenClaw gateway CLI (`openclaw gateway start/status`) is broken after sync-plugin.mjs — the npm package path is stale.

**Minimum fix:** Either:
1. `openclaw gateway start` via a different entry point
2. Or use WebSocket client directly to send chat messages
3. Or document that Track B requires manual gateway interaction (not scriptable)

**Not in scope for PRI-29B:**
- Fixing OpenClaw CLI itself
- Runtime V2 refactoring
- Pain→principle core chain changes

---

## Conclusion

**Track A: PASS** — Manual pain trigger validates full pain→principle chain end-to-end. `MINIMAX_CN_API_KEY` required and configured.

**Track B: BLOCKED** — Gateway not scriptable via `openclaw` CLI. Requires either gateway CLI fix or manual agent conversation to validate.

**Recommended next step for Track B:** Use OpenClaw web UI or gateway WebSocket to send a chat message that triggers 2+ consecutive tool failures, then verify via `pd runtime health snapshot`.

---

## Key Findings

1. Environment variable: `MINIMAX_CN_API_KEY` (not `MINIMAX_API_KEY`)
2. Diagnostician requires `MINIMAX_CN_API_KEY` to be set for Runtime V2 UAT
3. `pd pain record --source manual` bypasses GFI gate entirely (direct PainToPrincipleService call)
4. Gateway tool failure path requires OpenClaw agent conversation — not trivially scriptable without gateway CLI fix