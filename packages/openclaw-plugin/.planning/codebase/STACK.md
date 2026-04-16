# Technology Stack

**Analysis Date:** 2026-04-15

## Languages

**Primary:**
- TypeScript 6.0.2 - Core plugin development
- JSX/TSX - UI components

**Secondary:**
- JavaScript (ES2022) - Build scripts and configuration

## Runtime

**Environment:**
- Node.js 20 (build target via esbuild)

**Package Manager:**
- pnpm 9.x
- Lockfile: `pnpm-lock.yaml` (present)

## Frameworks

**Core:**
- OpenClaw Plugin SDK (peer dependency) - Plugin architecture framework
- React 19.2.0 - UI layer
- React Router 7.9.4 - UI routing

**Database:**
- better-sqlite3 12.9.0 - Local SQLite database for trajectory and state persistence

**UI Components:**
- lucide-react 1.7.0 - Icon library

**Build:**
- esbuild 0.28.0 - Bundling plugin code
- TypeScript 6.0.2 - Type checking and compilation

**Testing:**
- Vitest 4.1.0 - Test runner
- @vitest/coverage-v8 4.1.0 - Coverage reporting
- jsdom 29.0.1 - DOM environment for React testing
- @testing-library/react 16.3.0 - React component testing

**Linting:**
- ESLint 10.1.0 - Code linting
- @typescript-eslint packages 8.58.0 - TypeScript ESLint support

## Key Dependencies

**Critical:**
- `@sinclair/typebox` 0.34.48 - JSON schema type generation
- `micromatch` 4.0.8 - Glob pattern matching for file paths

**Database:**
- `@types/better-sqlite3` 7.6.13 - TypeScript types for SQLite

**HTTP/WebSocket:**
- `ws` 8.18.0 - WebSocket support
- `@types/ws` 8.5.13 - TypeScript types for WebSocket

## Configuration

**Environment:**
- Plugin configuration via `openclaw.plugin.json`
- Workspace-level settings in `.state/pain_settings.json`
- No `.env` files (configuration is code-driven)

**Build:**
- `tsconfig.json` - TypeScript configuration (target: ES2022, module: ESNext)
- `esbuild.config.js` - Bundle configuration
- `vitest.config.ts` - Test configuration with layered projects (unit/integration)

## Platform Requirements

**Development:**
- Node.js 20+
- pnpm 9+

**Production:**
- OpenClaw >=2026.4.4 (peer dependency)
- Node.js 20 runtime

---

*Stack analysis: 2026-04-15*
