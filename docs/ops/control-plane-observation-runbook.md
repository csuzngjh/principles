# Control Plane Observation Runbook

This runbook is for the post-Phase-2 observation window before entering Phase 3.

## Goal

Observe the production control plane long enough to verify:

- legacy trust stays frozen
- empathy events are logged authoritatively
- empathy rollback only removes the empathy slice
- queue, directive, session snapshots, and status output stay consistent

## Recommended Observation Window

- Minimum: 3 days
- Recommended: 7 days
- Best: 7 days including a weekend or low-traffic period

## Daily Snapshot Command

For Linux production, from the workspace root:

```bash
bash ./scripts/collect-control-plane-snapshot.sh /srv/principles
```

Optional:

```bash
bash ./scripts/collect-control-plane-snapshot.sh /srv/principles /srv/principles/.state/control-plane-observation 15
```

For local Windows reproduction:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\collect-control-plane-snapshot.ps1 -WorkspaceRoot "D:\Code\principles"
```

## Files That Matter Most

- `.state/AGENT_SCORECARD.json`
- `.state/logs/events.jsonl`
- `.state/logs/daily-stats.json`
- `.state/evolution_queue.json`
- `.state/evolution_directive.json`
- `.state/.pain_flag`
- `.state/sessions/*.json`
- `memory/logs/SYSTEM.log`

## What To Check Every Day

1. Trust did not increase because of `tool_success` or `subagent_success`.
2. `user_empathy` and `system_infer` appear in `events.jsonl` when expected.
3. A rollback decreases only the empathy slice of GFI, not the entire session GFI.
4. `daily-stats.json` does not report fake zeroes that contradict session state.
5. `evolution_queue.json` and `evolution_directive.json` are not obviously stale.
6. `gate_block` events continue to appear in the authoritative event log.

## Agent Prompt Template

Use this with a running agent after each snapshot is collected:

```text
Review the newest control-plane snapshot under .state/control-plane-observation/snapshots/.

Focus only on:
1. Whether legacy trust stayed frozen.
2. Whether empathy events were logged through authoritative pain_signal entries.
3. Whether any rollback appears to have cleared unrelated GFI.
4. Whether evolution queue, directive, and session snapshots disagree.
5. Whether daily-stats is misleading compared with raw session/runtime state.

Output:
- one short summary paragraph
- a list of findings ordered by severity
- a final verdict: continue_observation / patch_needed / ready_for_phase_3_shadow
```

## Gate To Phase 3 Shadow

Do not enter Phase 3 shadow mode until all of these are true:

1. At least 3 consecutive days show no trust inflation.
2. Empathy events appear in authoritative logs from both assistant self-report and observer inference when applicable.
3. Rollback no longer wipes unrelated GFI in observed sessions.
4. Status output stays explainable from raw state files.
5. No new hidden control authority is discovered during observation.
