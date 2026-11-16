# Codex async-append acceptance probe (PRI-1196)

Reproduces the ticket's core claim on a real Codex hook path:

> first request leaves as **Native** while the Adaptive decision is still in
> flight; after a qualified read-only tool, **one** later request receives the
> selected principle, exactly once, and the real `dist/pd-hook.js` appends it
> exactly once.

Everything runs locally: a scripted Responses SSE stub is the model provider
and a gated loopback HTTPS server is the decision service. No outbound
network, no API key, no transcript upload.

## Prerequisites

1. Build the packages the hook runs from:
   ```bash
   npm run build --workspace=@principles/core
   npm run build --workspace=@principles/host-runtime
   npm run build --workspace=@principles/codex-adapter
   ```
2. A Codex CLI whose hook payloads match the ones recorded here. Verified with
   `codex-cli 0.169.0`; `packages/codex-adapter/tests/fixtures/g1-contract/hook-payloads/`
   also holds captures for 0.148.0 / 0.150.1 / 0.162.1.
   Codex desktop embeds its own codex-core build — run `codex --version` for the
   binary you pass and do not treat a different desktop build as covered.
3. On Windows pass the **JS entry** (`.ps1`/`.cmd` shims cannot be spawned
   directly):
   ```powershell
   node scripts/dev/async-append-probe/probe.mjs `
     --codex "$env:APPDATA\npm\node_modules\@openai\codex\bin\codex.js"
   ```
   On PowerShell, `codex --version` reports the installed version; use that to
   fill in the version statement in the PR.
4. On POSIX `--codex codex` (or `PD_CODEX_CLI=codex`) is enough.

## Run

```bash
node scripts/dev/async-append-probe/probe.mjs --codex <codex-entry>
```

Optional:

| Flag | Meaning |
| --- | --- |
| `--out <dir>` | output root (default `<repo>/.tmp/codex-async-append-probe/run-<ts>`) |
| `--emit-fixtures <dir>` | write normalized hook stdin payloads (`01-session-start.json` … `05-stop.json`) |
| `--timeout-ms <n>` | Codex run timeout (default 120000) |

Outputs:

- stdout: one JSON report;
- `<out>/probe.json`: the same report;
- `<out>/hook-logs/*.json`: one file per hook invocation (stdin, stdout, stderr,
  start/completion timestamps) — this is the "host independent-request" evidence.

## Pass criteria

`passed: true`, exit code 0, and all of:

| Check | Meaning |
| --- | --- |
| `nativeFirst` | request 1 carries the Native principles and **not** the target |
| `decisionHeldAtFirstRequest` | request 1 was captured before the decision response was released |
| `decisionRequestedOnce` | exactly one scoring request for the turn |
| `laterRequestGotTargetOnce` | the target first appears in request ≥ 2 and no body contains it twice |
| `realHookAppendedOnce` | exactly one PostToolUse stdout contains a `<directive ` block |
| `readOnlyToolRan` | the host ran the read-only `Bash` tool |
| `codexExitedCleanly` | Codex exited 0 |

A typical passing report:

```json
{
  "checks": {
    "nativeFirst": true,
    "decisionHeldAtFirstRequest": true,
    "decisionRequestedOnce": true,
    "laterRequestGotTargetOnce": true,
    "realHookAppendedOnce": true,
    "readOnlyToolRan": true,
    "codexExitedCleanly": true
  },
  "passed": true,
  "decisionRequests": 1,
  "firstTargetRequestIndex": 2,
  "firstRequestAfterHookMs": 90,
  "appendHookCount": 1
}
```

`firstRequestAfterHookMs` varies by machine; it is reported for context, not
asserted. The checks are structural (request ordering and held-response order),
not timing thresholds.

## Notes

- The decision response is released by the probe 250 ms after request 1 was
  observed, which is the proof that request 1 did not wait for it. Releasing at
  request 2 would exceed the 2 s decision-request budget and produce a false
  negative.
- `--emit-fixtures` rewrites only synthetic ids and probe paths; `tool_response`
  is replaced so fixtures stay machine-independent. Do not point it at a
  directory containing real Owner payloads.
- `test/fixtures/g1-contract/hook-payloads/` is consumed by
  `pd-hook-adaptive-background.test.ts` ("real captured Codex payloads carry
  turn lineage"), so a new capture becomes a CI assertion automatically.
