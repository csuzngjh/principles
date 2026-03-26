# Technology Stack

**Analysis Date:** 2026-03-26

## Languages

**Primary:**
- TypeScript 5.0.0 - All source code in `packages/openclaw-plugin/src/` and `packages/create-principles-disciple/src/`

**Secondary:**
- JavaScript (ES2022) - Build output and scripts (`.mjs`, `.cjs`)
- JSON - Configuration files (`.json`)
- CSS - UI styles in `packages/openclaw-plugin/ui/src/styles.css`

## Runtime

**Environment:**
- Node.js >= 18.0.0 (required, tested on 18, 20, 22)

**Package Manager:**
- npm
- Lockfile: `package-lock.json` (version 3, present at root)

## Frameworks

**Core:**
- React 19.2.0 - Web UI framework (Principles Console)
- React DOM 19.2.0 - React DOM renderer
- React Router DOM 7.9.4 - Client-side routing for UI

**Testing:**
- Vitest 4.1.0 - Test runner and framework
- @vitest/coverage-v8 4.1.0 - Code coverage provider (v8 engine)
- jsdom 29.0.1 - DOM environment for React testing
- @testing-library/react 16.3.0 - React component testing utilities

**Build/Dev:**
- TypeScript 5.0.0 - Type checker and compiler
- esbuild 0.27.4 - Fast bundler for production builds
- semantic-release 25.0.3 - Automated versioning and publishing

## Key Dependencies

**Critical:**
- better-sqlite3 12.8.0 - SQLite database for trajectory and analytics data (used in `src/core/trajectory.ts`, `src/core/control-ui-db.ts`, `src/service/central-database.ts`)
- micromatch 4.0.8 - Glob pattern matching for file operations (used in `src/utils/glob-match.ts`)
- @sinclair/typebox 0.34.48 - JSON Schema validation for configuration

**UI Components:**
- lucide-react 0.468.0 - Icon library for Principles Console UI

**CLI Utilities (create-principles-disciple):**
- @inquirer/prompts 8.3.0 - Interactive CLI prompts
- commander 14.0.3 - CLI argument parsing
- fs-extra 11.2.0 - File system utilities
- ora 9.3.0 - CLI spinners/loaders
- picocolors 1.0.0 - Terminal colors

**Development Dependencies:**
- ws 8.18.0 - WebSocket for testing purposes
- esbuild 0.27.4 - Production bundler

## Configuration

**Environment:**
- Configured via `openclaw.plugin.json` (plugin manifest)
- Runtime settings in workspace `.state/` directories
- No external environment files (`.env`) in repository
- Language support: en, zh

**Build:**
- `packages/openclaw-plugin/tsconfig.json` - TypeScript config (strict mode, target ES2022, module ESNext)
- `packages/create-principles-disciple/tsconfig.json` - TypeScript config (strict mode, target ES2022, module NodeNext)
- `packages/openclaw-plugin/esbuild.config.js` - Production bundler configuration
- `packages/openclaw-plugin/vitest.config.ts` - Test runner configuration

## Platform Requirements

**Development:**
- Node.js >= 18.0.0
- npm (any version compatible with lockfile v3)
- TypeScript 5.0.0 (via npm)
- Git (for version control)

**Production:**
- Deployment target: npm registry (public packages)
- No Docker, no serverless deployment
- Plugin runs within OpenClaw Gateway environment
- Node.js runtime provided by OpenClaw Gateway

**Build Output:**
- `packages/openclaw-plugin/dist/` - Compiled plugin (ESM modules)
- `packages/openclaw-plugin/dist/bundle.js` - Production bundle (esbuild)
- `packages/openclaw-plugin/dist/web/` - Bundled UI assets
- `packages/create-principles-disciple/dist/` - CLI installer (ESM modules)

---

*Stack analysis: 2026-03-26*
