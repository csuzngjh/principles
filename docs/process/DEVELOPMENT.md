<!-- generated-by: gsd-doc-writer -->
# Development

This document covers local development setup, build commands, code style, and contribution workflows for the Principles Disciple OpenClaw plugin.

## Local Setup

The main codebase is located in `packages/openclaw-plugin/`. All development is done there.

### Prerequisites

- Node.js >= 18 (peer dependency: `openclaw >=2026.4.4`)
- npm

### Installation

```bash
# Clone the repository
git clone https://github.com/csuzngjh/principles.git
cd principles

# Install root dependencies (for release tooling)
npm install

# Navigate to the plugin package and install dependencies
cd packages/openclaw-plugin
npm install

# Build the TypeScript source
npm run build
```

The plugin uses a `postinstall` script that automatically runs `node scripts/install-dependencies.cjs` after `npm install`.

## Build Commands

All commands run from `packages/openclaw-plugin/`:

| Command | Description |
|---------|-------------|
| `npm run build` | Compile TypeScript to JavaScript using `tsc` |
| `npm run build:web` | Build web assets via `node scripts/build-web.mjs` |
| `npm run build:bundle` | Create esbuild bundle and web assets |
| `npm run build:production` | Production build with esbuild (minification) + web + build verification |
| `npm run test` | Run the test suite with Vitest |
| `npm run test:coverage` | Run tests with coverage reporting (v8 provider) |
| `npm run lint` | Run ESLint on `src/` |

### Output

Build artifacts are placed in `packages/openclaw-plugin/dist/`. The main bundle is `dist/bundle.js`, which is the entry point configured in `openclaw.plugin.json`.

## Code Style

The project uses ESLint with TypeScript support.

### Tool Configuration

- **ESLint**: `packages/openclaw-plugin/eslint.config.js`
- **Parser**: `@typescript-eslint/parser`
- **Plugin**: `@typescript-eslint/eslint-plugin`

### Linting

```bash
npm run lint
```

### Key Rules

| Rule | Level | Note |
|------|-------|------|
| `no-empty` | error | Disallows empty block statements |
| `no-console` | warn | Warns on console usage (disabled in tests) |
| `complexity` | error | Max cyclomatic complexity of 10 |
| `@typescript-eslint/no-explicit-any` | warn | Warns on `any` type usage |
| `@typescript-eslint/no-unused-vars` | warn | Ignores variables prefixed with `_` |
| `@typescript-eslint/no-non-null-assertion` | warn | Warns on `!` assertion |

Tests (`tests/**/*.test.ts`) have relaxed rules: `no-explicit-any` and `no-console` are off, `no-empty` is warn.

## Branch Conventions

| Type | Format | Example |
|------|--------|---------|
| Feature | `feature/<name>` | `feature/evolution-points` |
| Bug Fix | `fix/<issue-id>-<name>` | `fix/18-trust-engine` |
| Bug Fix (simple) | `fix/<name>` | `fix/edit-verification` |
| Documentation | `docs/<name>` | `docs/readme-update` |

**Main branch**: `main` — direct pushes are prohibited. All changes must go through PR.

## PR Process

1. **Create a branch**:
   ```bash
   git checkout -b feature/your-feature
   ```

2. **Make changes and commit** using [Conventional Commits](https://www.conventionalcommits.org/):
   ```
   <type>(<scope>): <description>
   ```
   Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`

3. **Push and create PR**:
   ```bash
   git push -u origin feature/your-feature
   gh pr create --title "feat: your feature" --body "Description"
   ```

4. **PR Requirements**:
   - All existing tests must pass (`npm run test`)
   - Linting must pass (`npm run lint`)
   - Code style checks must pass
   - At least 1 reviewer approval required
   - CI pipeline must be green

5. **Merge**: Performed by project maintainers (Wesley)

### PR Description Checklist

When creating a PR, include:
- Change summary (brief description of what the PR does)
- Change type (bug fix, feature, docs, refactor, test)
- Test status (existing tests pass, new tests added, coverage > 60%)
- Code style compliance
- Documentation updates (if applicable)
- Related issues (e.g., `Closes #XX`)

## Testing

Tests use **Vitest** with **v8 coverage provider**.

### Running Tests

```bash
npm run test          # Run all tests once
npm run test:watch    # Run tests in watch mode (not in package.json scripts, use vitest directly)
npm run test:coverage # Run with coverage report
```

### Coverage Thresholds

| Type | Threshold |
|------|-----------|
| Lines | 70% |
| Functions | 70% |
| Branches | 60% |
| Statements | 70% |

### Test File Naming

Tests are co-located with source or in `tests/` directory:
- `tests/**/*.test.ts`
- `tests/**/*.test.tsx`

## Next Steps

- See [GETTING-STARTED.md](./GETTING-STARTED.md) for first-run instructions
- See [TESTING.md](./TESTING.md) for detailed testing documentation
- See [ARCHITECTURE.md](./ARCHITECTURE.md) for system design
- See [CONTRIBUTING.md](../CONTRIBUTING.md) for the full contribution guidelines
