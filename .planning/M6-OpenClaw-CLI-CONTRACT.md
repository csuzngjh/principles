# M6-OpenClaw-CLI-CONTRACT

> Date: 2026-04-24
> Source: origin/main (git show, not local dirty state)
> OpenClaw commit: origin/main (1548 commits ahead of local `main`)

## OpenClaw `openclaw agent` Command Contract

### CLI Entry Point

```
openclaw agent --agent <id> --message <text> [--json] [--local] [--timeout <seconds>]
```

### Core Options

| Option | Required | Description |
|--------|----------|-------------|
| `--agent <id>` | Yes (or `--to`/`--session-id`) | Target a configured agent directly |
| `--message <text>` | Yes | Message body to send |
| `--json` | No | Output JSON instead of text |
| `--local` | No | Run embedded agent directly (after plugin registry preload) |
| `--timeout <seconds>` | No | Override agent timeout (default 600s or config value) |
| `--thinking <level>` | No | Agent thinking level |

### Output Structure (`--json` mode)

```typescript
// CliOutput (from src/agents/cli-output.ts)
type CliOutput = {
  text: string;        // LLM output text — this is where DiagnosticianOutputV1 JSON lives
  rawText?: string;
  sessionId?: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
  finalPromptText?: string;
};
```

### Critical: Two-Workspace Boundary

**OpenClaw CLI has NO `--workspace` flag.**

- PD workspace: `D:\.openclaw\workspace` (or similar) — PD manages state here
- OpenClaw agent workspace: configured via agent config / profile / container — separate boundary

**Adapter MUST explicitly control via:**
- `cwd` passed to CLI process
- `env` variables (OPENCLAW_PROFILE, OPENCLAW_CONTAINER_HINT, etc.)
- agent config / profile settings
- **NO implicit assumptions about shared state or file paths**

### Error Structure

```typescript
// Error extraction: extractCliErrorMessage(raw: string): string | null
// Nested error fields checked:
// parsed.error.message
// parsed.message
// parsed.error (string)
```

### Exit Code Behavior

- Exit code 0: success
- Non-zero: failure (specific codes not documented in source)
- PD must map: non-zero exit → `execution_failed`

### JSON Parsing Notes

- OpenClaw uses `extractBalancedJsonFragments()` for embedded JSON in mixed output
- Parses `claude-stream-json` dialect specifically for Claude CLI provider
- Supports JSONL (newline-delimited JSON)

### What IS Supported

- `--json` flag ✓
- `--agent <id>` ✓
- `--message <text>` ✓
- `--timeout <seconds>` ✓
- `--local` flag ✓ (but must be explicit, not silent default)
- `--profile <name>` ✓ (environment control)
- `--container <id>` ✓ (workspace isolation)

### What Is NOT Supported

- No `--workspace` flag in `openclaw agent` ✗
- No `--extra-system-prompt` flag in `openclaw agent` ✗
- JSON output is `CliOutput`, NOT directly DiagnosticianOutputV1

### Version

```
OpenClaw origin/main: 608c08fc54 (2026-04-24)
Local main is 1548 commits behind origin/main
Local has dirty modification: src/plugins/tools.ts
```

### Design Implication for M6

The OpenClaw CLI `openclaw agent` command:
1. Is a **session-based** CLI (requires `--agent` or `--session-id` or `--to`)
2. Does NOT directly accept workspace path
3. Does NOT emit DiagnosticianOutputV1 directly — LLM must produce it in the `text` field
4. M6 needs to wrap this with a `DiagnosticianPromptBuilder` that sends structured JSON in `--message` and expects JSON in the response `text` field
5. PD must parse the `text` field, validate DiagnosticianOutputV1 schema, and map failures to `output_invalid`
6. `openclaw agent --local` and gateway mode are two different execution paths — both must be explicitly handled
