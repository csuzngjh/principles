# Technology Stack

**Analysis Date:** 2026-04-02

## Languages & Runtime

**Primary:**
- TypeScript 6.0+ — All source code in `packages/openclaw-plugin/src/` and `packages/create-principles-disciple/src/`
- JavaScript (ESM) — Build scripts: `esbuild.config.js`, `scripts/build-web.mjs`, `scripts/install-dependencies.cjs`

**Secondary:**
- TSX/React — Web UI in `packages/openclaw-plugin/ui/src/` (`.tsx` files)
- CSS — Styling in `packages/openclaw-plugin/ui/src/styles.css`
- JSON — Config files, templates, schemas throughout

**Runtime:**
- Node.js ≥ 18 (enforced via `engines` field in `packages/create-principles-disciple/package.json`)
- Target: ES2022 (`tsconfig.json: "target": "ES2022"`)
- Module system: ESM (`"type": "module"` in both package.json files)

## Frameworks

**Core Platform:**
- OpenClaw Plugin SDK — Peer dependency (`"openclaw": ">=1.0.0"`, optional). Provides hook system, command registration, service lifecycle, HTTP route registration. Type definitions in `packages/openclaw-plugin/src/openclaw-sdk.d.ts`.

**Web UI (Principles Console):**
- React 19.2+ — Dashboard SPA in `packages/openclaw-plugin/ui/src/`
- React Router DOM 7.9+ — Client-side routing (`BrowserRouter`, `NavLink`, `Routes`)
- Lucide React — Icon library (BarChart3, GitBranch, FileCheck, Brain, etc.)

**Build UI via esbuild:**
- esbuild bundles the UI from `ui/src/main.tsx` → `dist/web/assets/app.js`
- JSX transform: `"jsx": "automatic"` in esbuild config
- CSS loader built into esbuild

## Dependencies (Production)

**Plugin (`packages/openclaw-plugin/`):**

| Package | Version | Purpose | Where Used |
|---------|---------|---------|------------|
| `better-sqlite3` | ^12.8.0 | Embedded SQLite database for trajectory, workflow, control UI, and central aggregation data | `src/core/trajectory.ts`, `src/core/control-ui-db.ts`, `src/service/central-database.ts`, `src/service/subagent-workflow/workflow-store.ts` |
| `@sinclair/typebox` | ^0.34.48 | JSON Schema type builder for tool parameter validation (used by OpenClaw SDK types) | `src/openclaw-sdk.d.ts`, `src/tools/deep-reflect.ts` |
| `micromatch` | ^4.0.8 | Glob pattern matching for file path risk checks and gate decisions | `src/utils/glob-match.ts` |
| `react` | ^19.2.0 | UI rendering for Principles Console dashboard | `ui/src/App.tsx`, `ui/src/charts.tsx` |
| `react-dom` | ^19.2.0 | React DOM renderer | `ui/src/main.tsx` |
| `react-router-dom` | ^7.9.4 | Client-side routing for multi-page dashboard | `ui/src/App.tsx` |
| `lucide-react` | ^1.7.0 | Icon components for UI | `ui/src/App.tsx` |

**CLI Installer (`packages/create-principles-disciple/`):**

| Package | Version | Purpose |
|---------|---------|---------|
| `@inquirer/prompts` | ^8.3.0 | Interactive CLI prompts for install wizard |
| `commander` | ^14.0.3 | CLI argument parsing and command routing |
| `fs-extra` | ^11.2.0 | Enhanced file system operations |
| `ora` | ^9.3.0 | Terminal spinners for install progress |
| `picocolors` | ^1.0.0 | Terminal color output |

## Dependencies (Development)

**Plugin (`packages/openclaw-plugin/`):**

| Package | Version | Purpose |
|---------|---------|---------|
| `vitest` | ^4.1.0 | Test runner (NOT Jest) |
| `@vitest/coverage-v8` | ^4.1.0 | V8-based code coverage |
| `esbuild` | ^0.27.4 | Production bundling (plugin + web UI) |
| `typescript` | ^6.0.2 | Type checking and compilation |
| `jsdom` | ^29.0.1 | DOM environment for React component tests |
| `@testing-library/react` | ^16.3.0 | React component testing utilities |
| `ws` | ^8.18.0 | WebSocket client (dev/test) |
| `@types/better-sqlite3` | ^7.6.13 | SQLite type definitions |
| `@types/node` | ^25.5.0 | Node.js type definitions |
| `@types/react` | ^19.2.2 | React type definitions |
| `@types/react-dom` | ^19.2.2 | React DOM type definitions |
| `@types/ws` | ^8.5.13 | WebSocket type definitions |
| `@types/micromatch` | ^4.0.10 | Micromatch type definitions |

**Root (`package.json`):**

| Package | Version | Purpose |
|---------|---------|---------|
| `semantic-release` | ^25.0.3 | Automated versioning and changelog |
| `@semantic-release/changelog` | ^6.0.3 | Changelog generation plugin |
| `@semantic-release/git` | ^10.0.1 | Git commit/release plugin |

**CLI Installer (`packages/create-principles-disciple/`):**

| Package | Version | Purpose |
|---------|---------|---------|
| `typescript` | ^6.0.2 | Compilation |
| `@types/fs-extra` | ^11.0.4 | Type definitions |
| `@types/node` | ^25.5.0 | Node.js type definitions |

## Build & Tooling

**Build Pipeline (Plugin):**

The plugin has a multi-stage build process:

1. **`npm run build`** — TypeScript compilation via `tsc` (strict mode, ES2022 target, ESM output to `dist/`)
   - Config: `packages/openclaw-plugin/tsconfig.json`
   - Output: `dist/**/*.js` + `dist/**/*.d.ts`

2. **`npm run build:bundle`** — esbuild production bundle
   - Config: `packages/openclaw-plugin/esbuild.config.js`
   - Bundles `dist/index.js` → `dist/bundle.js`
   - Externalizes: `openclaw`, `@openclaw/sdk`, `@openclaw/plugin-kit`, `better-sqlite3`
   - Platform: `node20`, format: `esm`
   - Copies `templates/`, `agents/`, `openclaw.plugin.json` into `dist/`

3. **`npm run build:web`** — esbuild web UI bundle
   - Config: `packages/openclaw-plugin/scripts/build-web.mjs`
   - Bundles `ui/src/main.tsx` → `dist/web/assets/app.js`
   - Platform: `browser`, format: `esm`
   - Generates `dist/web/index.html`

4. **`npm run build:production`** — Full pipeline: `tsc` + `esbuild --production` + `build-web --production` + `verify-build.mjs`

**Build Pipeline (CLI Installer):**
- **`npm run build`** — `tsc` with `module: "NodeNext"`, `moduleResolution: "NodeNext"`
- **`npm run bundle`** — `scripts/bundle-plugin.mjs` creates standalone bundle
- **`npm run prepack`** — Build + bundle (runs before npm publish)

**Postinstall Hook:**
- `packages/openclaw-plugin/scripts/install-dependencies.cjs` — Auto-installs `micromatch`, `@sinclair/typebox`, `better-sqlite3` if missing from `node_modules/`

**TypeScript Configuration:**

| Package | Target | Module | Module Resolution | Strict | JSX |
|---------|--------|--------|-------------------|--------|-----|
| `openclaw-plugin` | ES2022 | ESNext | bundler | true | react-jsx |
| `create-principles-disciple` | ES2022 | NodeNext | NodeNext | true | N/A |
| `nocturnal` | ES2022 | ESNext | node | true | N/A |

**Test Configuration:**

| Config | Value |
|--------|-------|
| Runner | Vitest 4.1+ |
| Environment | `node` (primary), `jsdom` (React tests) |
| Pool | `forks` (isolated per file) |
| Coverage provider | V8 |
| Test include | `tests/**/*.test.ts`, `tests/**/*.test.tsx` |
| Config file | `packages/openclaw-plugin/vitest.config.ts` |

**Run Commands:**
```bash
# Plugin
cd packages/openclaw-plugin
npm run build              # TypeScript compile
npm run build:production   # Full production build
npm test                   # Run all Vitest tests

# CLI installer
cd packages/create-principles-disciple
npm run build              # TypeScript compile
npm run bundle             # Create standalone bundle

# Root
npm run release            # Semantic release
npm run release:dry-run    # Dry run release
```

**Semantic Release:**
- Config: `.releaserc.json`
- Branches: `main`
- Commit format: `<type>(<scope>): <subject>`
- Release rules: `Breaking` → major, `New Features` → minor, all others → patch
- Plugins: commit-analyzer, release-notes-generator, changelog, npm, git

## Configuration

**Plugin Configuration (`openclaw.plugin.json`):**
- Language: `en` | `zh` (default: `zh`)
- Audit level: `low` | `medium` | `high` (default: `medium`)
- Risk paths: Custom array of protected directories
- Deep reflection: enabled/disabled, auto/forced mode

**Runtime Configuration:**
- Pain dictionary: `templates/pain_dictionary.json`, `templates/langs/{zh,en}/pain_dictionary.json`
- Pain settings: `templates/pain_settings.json`
- Workspace templates: `templates/workspace/` (PROFILE.json, PRINCIPLES.md, THINKING_OS.md, etc.)
- Language templates: `templates/langs/{zh,en}/` with skills, core docs, pain dictionaries

**Path Resolution:**
- `PathResolver` (`src/core/path-resolver.ts`) — Central path management, set via `api.rootDir`
- `PD_DIRS` constants (`src/core/paths.ts`) — `.principles/`, `.state/`, `memory/`, `memory/okr/`, etc.
- `api.resolvePath()` — The ONLY compliant path resolution entry point

**No External Config Files Required:**
- No `.env` files needed
- No linter/formatter config (no ESLint, no Prettier)
- No Docker configuration

## Platform Requirements

**Development:**
- Node.js ≥ 18
- npm (for package management)
- Native build toolchain for `better-sqlite3` (node-gyp, C++ compiler)

**Production:**
- OpenClaw Gateway (host platform)
- Node.js ≥ 18 (for native `better-sqlite3` bindings)
- Plugin distributed via npm as `principles-disciple`
- No Docker, no serverless, no cloud services
- All data stored locally in SQLite databases and JSON/JSONL files

---

*Stack analysis: 2026-04-02*
