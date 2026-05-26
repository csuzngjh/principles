# create-principles-disciple

MVP-First Integration Wizard for [Principles Disciple](https://github.com/csuzngjh/principles).

## What This Installer Delivers

| Component | Status | Description |
|-----------|--------|-------------|
| Runtime integration | Installed & verified | OpenClaw plugin with MVP activation channels |
| Operator CLI (`pd`) | Installed & verified | Command-line tool for diagnostics and demo |
| Review console | **Not yet deliverable** | Owner review surface is a release-blocking gap |

### MVP Activation Channels

Only three channels are enabled by default:

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
--channels <list>       Comma-separated MVP channels: prompt,code_tool_hook,defer_archive
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
