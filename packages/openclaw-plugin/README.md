<!-- generated-by: gsd-doc-writer -->
# principles-disciple

Native OpenClaw plugin for Principles Disciple: an evolutionary programming agent framework with strategic guardrails and reflection loops.

## Installation

```bash
npm install principles-disciple
```

Requires OpenClaw `>=2026.4.4` as a peer dependency.

## Usage

This plugin integrates with OpenClaw to provide an evolutionary programming framework. It intercepts agent operations through hooks to enforce security guardrails, track pain points, collect trajectory data, and enable deep reflection capabilities.

### Slash Commands

All commands support **short aliases** for easier input:

| Short | Full Command | Description |
|-------|--------------|-------------|
| `/pdi` | `/pd-init` | Initialize workspace |
| `/pdb` | `/pd-bootstrap` | Scan environment tools |
| `/pdr` | `/pd-research` | Research tools and capabilities |
| `/pdt` | `/pd-thinking` | Manage thinking models |
| `/pdrl` | `/pd-reflect` | Manually trigger nocturnal reflection |
| `/pdd` | `/pd-daily` | Configure and send daily report |
| `/pdg` | `/pd-grooming` | Workspace cleanup |
| `/pdh` | `/pd-help` | Show command reference |

| Command | Description |
|---------|-------------|
| `/pd-status` | View evolution status |
| `/pd-context` | Control context injection |
| `/pd-focus` | Focus file management |
| `/pd-evolution-status` | View evolution state |
| `/pd-rollback` | Rollback to previous state |
| `/pd-export` | Export trajectory/correction data |
| `/pd-samples` | Review correction samples |
| `/pd-nocturnal-review` | Review nocturnal training samples |
| `/nocturnal-train` | Nocturnal training operations |
| `/nocturnal-rollout` | Nocturnal rollout and promotion |
| `/pd-workflow-debug` | Debug workflow state |

### Configuration

The plugin accepts the following configuration options:

| Option | Default | Description |
|--------|---------|-------------|
| `language` | `zh` | Interaction language (`en` or `zh`) |
| `auditLevel` | `medium` | Security guardrail level (`low`, `medium`, `high`) |
| `riskPaths` | `[]` | High-risk directories requiring explicit authorization |

## Part of the principles monorepo

See the root [README.md](https://github.com/csuzngjh/principles#readme) for the full project overview.

## License

MIT License - [LICENSE](https://github.com/csuzngjh/principles/blob/main/LICENSE)
