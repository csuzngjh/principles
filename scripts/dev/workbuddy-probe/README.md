# WorkBuddy host probes (Phase 0, SPEC §7.1 P01–P06)

Reproducible probe drivers executed against the REAL WorkBuddy Desktop 5.8.1 engine
(`codebuddy-lite-wb.mjs`, engine version 2.161.0) on 2026-10-12. They never touch the
real `~/.workbuddy`, `~/.codebuddy`, `~/.pd` or `~/.openclaw`: everything runs inside
an isolated config dir via `WORKBUDDY_CONFIG_DIR` + `CODEBUDDY_CONFIG_DIR` (both are
required for full isolation).

## Lab prerequisites (one-time, outside these scripts)

The lab lives in `D:/Code/_worktrees/wb-probe-lab/` (override with `WB_PROBE_LAB`):

```
iso-home/models.json          custom model "wb-probe-mock" -> http://127.0.0.1:39471/v1/chat/completions, apiKey "mock-key-probe"
iso-home/                     becomes the isolated WorkBuddy config dir
marketplace/.codebuddy-plugin/marketplace.json   local marketplace (plugins[0] = pd-probe, source ./pd-probe)
marketplace/pd-probe/         probe plugin (.codebuddy-plugin/plugin.json + hooks/hooks.json + scripts/hook-log.cjs)
plugin-pd-probe/              dev copy of the plugin (for --plugin-dir tests)
proj-a/                       synthetic project (cwd for sessions)
prompt2-feeder.cjs            feeds two stream-json user prompts (2nd fires UserPromptSubmit)
mock-server.mjs               OpenAI-compatible mock model, SSE-capable, logs request bodies
scenario.txt                  per-event hook scenario map ("pretooluse=exit2-stdout-msg", "*=neutral", "sleep:65:neutral" for timeouts)
```

Start the mock first: `cd <lab> && MOCK_PORT=39471 node mock-server.mjs &`

## Scripts

| Script | Probe | What it asserts |
| --- | --- | --- |
| `p01-plugin-lifecycle.mjs` | P01 | marketplace add → install → enabledPlugins format (`name@marketplace`:true) → installed_plugins.json v2 + versioned cache → SessionStart hook fires in new session → uninstall → settings entry removed → no hooks fire → reinstall |
| `p02-exit-code-matrix.mjs` | P02 | 13 scenarios × 4 events matrix (deny/exit0/exit1/exit2-stdout/exit2-stderr/exit3/bad-json/stdout-direct/addctx-json/continue-false/stdout-close-exit2/deps-missing/neutral): hooks fired, model requests, injection reached model, guarded file written or not. `--quick` runs 4 scenarios. Timeout cells: set `scenario.txt` to `sleep:65:...` manually (see frozen contract). |
| `p03-*` | P03 | payloads captured by matrix/tool runs; sanitized copies live in `packages/workbuddy-adapter/tests/fixtures/host-contract/events/` |
| `p04-*` | P04 | injection evidence = mock request bodies (`mock-req-log.jsonl`); shapes frozen in `model-request-injection-shapes.json` |
| `p05-runtime-env.mjs` | P05 | (see note) hook-launched `.cjs` wrapper facts: execPath/node version/Git Bash/space+Chinese paths/SQLite loadability |
| `p06-governance-dir.mjs` | P06 | OD-07 candidate `~/.workbuddy/pd-workspace` resolution: A/B project sharing, uninitialized/corrupt handling, isolation-env compatibility. Self-contained (no engine needed). |

P05 note: the environment facts were captured with a one-off plugin in
`<lab>/带空格 路径-lab/plugin-env-probe` loaded via `--plugin-dir` while cwd was
`<lab>/带空格 路径-lab/项目 甲`; the wrapper wrote `<lab>/hook-events/p05-env-log.jsonl`.
Re-run by pointing `--plugin-dir` at that fixture and starting a `-p` session.

## Engine facts (re-check on every host upgrade)

- Engine: `D:\Program Files\WorkBuddy\resources\app.asar.unpacked\cli\dist\codebuddy-lite-wb.mjs`
- `--version` 2.161.0; desktop 5.8.1 (install-manifest under `resources/`)
- Launch: `node <engine>` — usage `codebuddy|cbc`; useful flags: `-p`, `--input-format stream-json`,
  `--output-format stream-json`, `--plugin-dir`, `--settings`, `--setting-sources`,
  `--no-session-persistence`, `--serve`, `plugin` subcommand.
- Standalone engine has no account token; a models.json custom model (OpenAI-compatible,
  SSE) bypasses the auth gate — that is how the mock drives the agent loop.

## Outputs

Each script writes `<lab>/p0X-results.json`; full raw evidence is archived in the
private docs (`docs/reports/workbuddy-host-adapter-20261012/agents/probe-fg0phy/`),
and the frozen contract for the adapter lives in
`packages/workbuddy-adapter/tests/fixtures/host-contract/`.
