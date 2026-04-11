# STACK.md - Technology Stack

## Project Type

**Monorepo** (npm workspaces) with 2 packages:

| Package | Path | Purpose |
|---------|------|---------|
| `principles-disciple` | `packages/openclaw-plugin` | Core OpenClaw plugin |
| `create-principles-disciple` | `packages/create-principles-disciple` | CLI installer |

## Runtime

- **Node.js** v24.14.0
- **TypeScript** ^6.0.2
- **ES Modules** (`"type": "module"`)

## TypeScript Configuration

**Plugin** (`packages/openclaw-plugin/tsconfig.json`):
- `target`: ES2022
- `module`: ESNext, `moduleResolution`: bundler
- `strict`: true
- `jsx`: react-jsx
- Output: `./dist`, Source: `./src`

**Installer** (`packages/create-principles-disciple/tsconfig.json`):
- `module`: NodeNext, `moduleResolution`: NodeNext
- Additional: `declarationMap`, `sourceMap`

## Core Dependencies

### Plugin (`packages/openclaw-plugin`)

**Runtime:**
- `@sinclair/typebox` ^0.34.48 — JSON Schema validation
- `better-sqlite3` ^12.8.0 — Embedded SQLite database
- `react` ^19.2.0 + `react-dom` ^19.2.0 — UI framework
- `react-router-dom` ^7.9.4 — Frontend routing
- `lucide-react` ^1.7.0 — Icon library
- `micromatch` ^4.0.8 — Glob pattern matching
- `openclaw` (peerDependency >=2026.4.4) — Host platform

**DevDependencies:**
- `vitest` ^4.1.0 + `@vitest/coverage-v8` ^4.1.0 — Test framework
- `esbuild` ^0.27.4 — Production bundler
- `eslint` ^10.1.0 + `@typescript-eslint/eslint-plugin` ^8.58.0 — Linting
- `jsdom` ^29.0.1 — DOM test environment
- `@testing-library/react` ^16.3.0 — React component testing

### Installer (`packages/create-principles-disciple`)

- `@inquirer/prompts` ^8.3.0 — Interactive CLI prompts
- `commander` ^14.0.3 — CLI command parsing
- `fs-extra` ^11.2.0 — File system utilities
- `ora` ^9.3.0 — Terminal spinner
- `picocolors` ^1.0.0 — Terminal coloring

## Build Toolchain

- **Dev build**: `tsc` (TypeScript compiler)
- **Production build**: `esbuild` → `dist/bundle.js` (externalizes `openclaw`, `better-sqlite3`)
- **Web UI build**: Custom `scripts/build-web.mjs`
- **Release**: `semantic-release` + `@changesets/cli`
- **Git Hooks**: `lint-staged` + `pre-commit`

## ESLint Configuration (`eslint.config.js`)

- Flat config format (`defineConfig`)
- Strict rules: all `'error'` level
- Key rules: `no-explicit-any`, `no-unused-vars`, `consistent-type-imports`, `prefer-readonly`, `class-methods-use-this`
- Test files have separate config with Vitest globals injected
- Ignored patterns: `**/dist/**`, `**/tests/**`, `**/ui/src/**`
