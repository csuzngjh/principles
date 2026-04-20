# @principles/pd-cli

PD CLI — Pain recording, sample management, and evolution tasks for the Principles system.

## Installation

```bash
npm install -g @principles/pd-cli
```

## Commands

### `pd pain record`

Record a pain signal to the workspace's `.pain_flag` file.

```bash
pd pain record --reason "edited file without reading first" --score 75
```

Options:
- `--reason, -r` — Pain reason (required)
- `--score, -s` — Pain score 0-100 (default: 80)
- `--session-id` — Session ID (default: auto-generated)

## Migration from openclaw tools

The `pd pain record` CLI and the existing `write_pain_flag` tool write to the same pain flag file (`.state/.pain_flag`). They can coexist safely:

- **Concurrency**: `recordPainSignal` in the SDK uses an in-process async queue lock to serialize writes within a single process. For cross-process safety (e.g., simultaneous tool + CLI calls), both paths rely on atomic file rename via `atomicWriteFileSync`.
- **Progressive migration**: Agents using openclaw tools can migrate to `pd pain record` incrementally — both paths write the same format and are processed identically by the evolution system.
- **No dual-write data loss**: The pain flag is a point-in-time snapshot; each write is atomic. Conflicting concurrent writes result in last-write-wins on the flag content, which is acceptable for pain signals.
