# create-principles-disciple

MVP-First Prerequisite Installer for [Principles Disciple](https://github.com/csuzngjh/principles).

## What This Installer Delivers

| Component | Status | Description |
|-----------|--------|-------------|
| Runtime integration | Installed & verified | OpenClaw plugin with MVP activation channels |
| Operator CLI (`pd`) | Installed & verified | Command-line tool for diagnostics and demo |
| Review console | Installed & configured | Local web UI for principle review (loopback only) |

### MVP Activation Channels

Three MVP-Core channels are always enabled and cannot be disabled:

- `prompt` — soft principle injection
- `code_tool_hook` — RuleHost hard enforcement
- `defer_archive` — graceful deferral

Quiet and gone capabilities (gfi, nocturnal, idle_trigger) are **not surfaced** to users.

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

1. **Configuration** — `.pd/config.yaml` is generated and validated (ADR-0016: replaces the legacy `.pd/feature-flags.yaml`)
2. **Demo verification** — `pd demo first-principle` is executed to confirm runtime integration
3. **Console health** — `/api/health` is checked on the local console instance

After a successful install, you can re-verify at any time:

```bash
pd runtime canary --workspace "<path>" --json
```

## Console

The installer delivers a local pd-console web UI for principle review.

### Starting the Console

```bash
pd console --workspace "/path/to/workspace" --no-auth
```

The console listens on **127.0.0.1 only** (loopback) — it is not accessible from other machines on the network. When using `--no-auth`, loopback binding is enforced; the server will refuse to start if `--no-auth` is combined with a non-loopback host.

Open `http://127.0.0.1:3100` in your browser to access the console.

### Console Security

- Default binding: `127.0.0.1` (loopback only)
- `--no-auth` is only permitted with loopback binding
- For network access, use `--host <ip>` with `--token <secret>` or set `PD_CONSOLE_TOKEN` environment variable

## Rerun / Reinstall

Re-running the installer updates the `.pd/config.yaml`. All three MVP-Core channels
are always enabled — the installer does not allow partial disabling of core channels.
The installer reads actual enabled channels from disk and reports them in the output.

## Update Failure Recovery

If an update fails, the installer automatically restores the previous working installation from backup. No manual recovery steps are needed.

If the installer cannot restore the backup (rare), re-run the installer with `--force`.

## Updating

PD supports updating through the Web UI:

1. Open PD Console (http://localhost:3100)
2. Navigate to Settings → Update
3. Check for updates and review version info
4. Click "Update Now" to apply

### Update Options

- **Merge Strategy**: How to handle workspace file changes
  - `smart`: Generate .update files for manual merge
  - `overwrite`: Force overwrite workspace files
  - `keep`: Keep existing workspace files unchanged
- **Backup**: Create backup before update (recommended for rollback support)

### API Endpoints

- `GET /api/update/check` — Check for available updates
- `POST /api/update/apply` — Apply an update
- `GET /api/update/status` — Get current update status
- `POST /api/update/rollback` — Rollback to previous version

## Commands

- `install` — Install PD (default command)
- `uninstall` — Remove PD (preserves user data)
- `status` — Show installation status

## Requirements

- Node.js >= 22.0.0

Self-contained native release assets are built locally (never cross-labelled) for:

| Platform | Architectures | Node.js major / ABI |
| --- | --- | --- |
| Windows | x64 | 22 / 127, 24 / 137, 26 / 147 |
| Linux | x64, arm64 | 22 / 127, 24 / 137, 26 / 147 |
| macOS | x64, arm64 | 22 / 127, 24 / 137, 26 / 147 |

Release builds require a fixed `SOURCE_DATE_EPOCH`. The output directory is published through one atomic rename and contains `payload/`, immutable `asset.tar`, and detached `asset.tar.sha256`. The installed machine does not run npm, lifecycle scripts, or native compilation.

PR feedback uses the single-target `.github/workflows/release-reproducibility.yml` quick check. Before npm publication, `publish-npm.yml` must call `.github/workflows/release-reproducibility-full.yml`: for every supported OS/CPU/Node target it builds the real production asset twice from a clean checkout, byte-compares the archives and detached digests, then installs from the archive without npm. Evidence limits: Node versions are pinned exactly, but GitHub runner images float beneath the label — the same-job double build controls toolchain drift within a job; cross-runner absolute byte-equality is not claimed. Committed dependency locks under `release-locks/` are regenerated by maintainers via `npm run generate:release-locks` and verified installable by `npm run check:release-locks`.

## License

MIT
