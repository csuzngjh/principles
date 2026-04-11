# STRUCTURE.md - Directory Layout & Organization

## Root Structure

```
D:\Code\principles/
├── packages/
│   ├── openclaw-plugin/          # Core plugin (principles-disciple)
│   └── create-principles-disciple/  # CLI installer
├── .planning/                    # GSD planning artifacts
│   └── codebase/                 # Codebase mapping documents (this directory)
├── .claude/                      # Claude Code configuration
├── .qwen/                        # Qwen Code configuration
├── .agents/                      # Shared agent skills
├── .state/                       # Runtime state files
├── .principles/                  # Principles DNA (SOUL.md, AGENTS.md)
├── .githooks/                    # Custom git hooks
├── .github/                      # GitHub workflows
├── .husky/                       # Husky git hooks
├── .learnings/                   # Agent learning records
├── conductor/                    # Conductor tracks/plans
├── docs/                         # Project documentation
├── memory/                       # Agent memory files
├── ops/                          # Operations (ai-sprints)
├── scripts/                      # Build/utility scripts
├── tests/                        # Test files (mirrors src/)
├── assets/                       # Static assets
├── tmp/                          # Temporary files
├── STATE_DIR/                    # State directory
├── package.json                  # Root workspace config
├── eslint.config.js              # ESLint flat config
├── .gitignore                    # Git ignore rules
├── .releaserc.json               # Semantic release config
├── AGENTS.md                     # Agent workspace guide
├── QWEN.md                       # Qwen-specific context
├── MEMORY.md                     # Agent long-term memory
├── README.md / README_ZH.md / README_AGENT.md
└── CHANGELOG.md / CONTRIBUTING.md / LICENSE
```

## Plugin Package (`packages/openclaw-plugin/`)

```
packages/openclaw-plugin/
├── src/
│   ├── index.ts                  # Plugin entry (777 lines)
│   ├── types.ts                  # Global types
│   ├── core/                     # Domain logic (73 files)
│   ├── hooks/                    # OpenClaw hooks (16 files)
│   ├── service/                  # Background services (17 files)
│   ├── commands/                 # CLI commands (20 files)
│   ├── tools/                    # Tool definitions
│   ├── http/                     # HTTP routes
│   ├── utils/                    # Utilities
│   ├── constants/                # Constants
│   ├── config/                   # Config & errors
│   ├── i18n/                     # i18n (zh/en)
│   ├── types/                    # Type definitions
│   └── ui/src/                   # React web console
├── tests/                        # Test files (143 files, mirrors src/)
│   ├── core/
│   ├── hooks/
│   ├── commands/
│   ├── service/
│   ├── integration/
│   ├── http/
│   ├── scripts/
│   └── utils/
├── dist/                         # Build output
├── package.json
├── tsconfig.json
├── vitest.config.ts
└── scripts/
    └── build-web.mjs             # Web UI build script
```

## Installer Package (`packages/create-principles-disciple/`)

```
packages/create-principles-disciple/
├── src/
│   └── index.ts                  # CLI entry point
├── package.json
├── tsconfig.json
└── dist/                         # Build output
```

## Key File Locations

| Purpose | Path |
|---------|------|
| Plugin entry | `packages/openclaw-plugin/src/index.ts` |
| Evolution engine | `packages/openclaw-plugin/src/core/evolution-engine.ts` |
| Evolution worker | `packages/openclaw-plugin/src/service/evolution-worker.ts` (2133 lines) |
| Prompt hook | `packages/openclaw-plugin/src/hooks/prompt.ts` (1049 lines) |
| Pain detection | `packages/openclaw-plugin/src/core/pain.ts` |
| Gating | `packages/openclaw-plugin/src/hooks/gate.ts` |
| Error hierarchy | `packages/openclaw-plugin/src/config/errors.ts` |
| Retry utilities | `packages/openclaw-plugin/src/utils/retry.ts` (546 lines) |
| Web console | `packages/openclaw-plugin/src/ui/src/App.tsx` |
| ESLint config | `eslint.config.js` (root) |
| Test config | `packages/openclaw-plugin/vitest.config.ts` |

## Naming Conventions

- **Files**: kebab-case (`evolution-engine.ts`, `file-lock.ts`)
- **Directories**: kebab-case (`subagent-workflow/`, `principle-internalization/`)
- **Classes**: PascalCase (`EvolutionEngine`, `PdError`, `WorkspaceContext`)
- **Functions/Variables**: camelCase (`handleBeforePromptBuild`, `workspaceDir`)
- **Constants**: UPPER_SNAKE_CASE (`PD_LOCAL_PROFILES`, `DEFAULT_EVOLUTION_CONFIG`)
- **Types**: PascalCase (`EvolutionState`, `PainContext`, `WorkflowManager`)
