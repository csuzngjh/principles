# create-principles-disciple

MVP-First Prerequisite Installer for [Principles Disciple](https://github.com/csuzngjh/principles).

> **Note:** This installer delivers runtime integration and operator CLI only.
> The owner review console is a **release-blocking gap** — the installer reports
> `success: false` until console delivery is complete. This is by design per
> ADR-0014 MVP-First strategy.

## What This Installer Delivers

| Component | Status | Description |
|-----------|--------|-------------|
| Runtime integration | Installed & verified | OpenClaw plugin with MVP activation channels |
| Operator CLI (`pd`) | Installed & verified | Command-line tool for diagnostics and demo |
| Review console | **Not yet deliverable** | Owner review surface is a release-blocking gap |

### MVP Activation Channels

Three MVP-Core channels are always enabled and cannot be disabled:

- `prompt` — soft principle injection
- `code_tool_hook` — RuleHost hard enforcement
- `defer_archive` — graceful deferral

Quiet and gone capabilities (gfi, nocturnal, idle_trigger, model_training, trainer) are **not surfaced** to users.

## Usage

### Interactive

```bash
npx create-principles-disciple
```

### Non-interactive / JSON

```bash
npx create-principles-disciple --yes --workspace "/path/to/workspace" --json
```

`--json` implies non-interactive. Output is exactly one parseable JSON object on stdout.

## Options

```text
--lang <en|zh>          Language preference (default: zh)
--force                 Force overwrite existing installation
--smart                 Smart merge mode (generate .update files)
--yes                   Non-interactive mode with defaults
--non-interactive       Skip prompts
--workspace <path>      Workspace directory
--json                  Output result as JSON (implies non-interactive)
```

## Post-Install Verification

The installer automatically verifies the installation during setup:

1. **Feature flags** — `.pd/feature-flags.yaml` is generated and validated
2. **Story A demo** — `pd demo story-a` is executed to confirm runtime integration

After a successful install, you can re-verify at any time:

```bash
pd runtime canary --workspace "<path>" --json
```

## Rerun / Reinstall

Re-running the installer updates the feature-flags.yaml. All three MVP-Core channels
are always enabled — the installer does not allow partial disabling of core channels.
The installer reads actual enabled channels from disk and reports them in the output.

## Update Failure Recovery

If an update fails, the installer automatically restores the previous working installation from backup. No manual recovery steps are needed.

If the installer cannot restore the backup (rare), re-run the installer with `--force`.

## Commands

- `install` — Install PD (default command)
- `uninstall` — Remove PD (preserves user data)
- `status` — Show installation status

## Requirements

- Node.js >= 18.0.0

## License

MIT
