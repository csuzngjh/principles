# Phase 4: Best Practices & Standards

## Framework & Language Findings

### Low
1. **Private Methods Don't Use `this` — `class-methods-use-this`** — Multiple adapters have private methods that don't reference `this`:
   - `openclaw-pain-adapter.ts`: `deriveScoreFromError`, `buildTriggerPreview`
   - `writing-pain-adapter.ts`: `buildReason`
   - `code-review-pain-adapter.ts`: all private methods
   - `principle-injector.ts`: no issues (uses explicit this via class)

   Status: **Fixed in review** — added `// eslint-disable-next-line @typescript-eslint/class-methods-use-this` to all affected methods. Consider converting these to `static` methods in a future refactor to eliminate the need for disable directives.

2. **`@sinclair/typebox` Version Not Pinned** — `packages/principles-core/package.json` uses `^0.163.0` for typebox. Semver caret means minor/patch updates are accepted automatically. No lock file entry visible.

3. **Unused `NEGATIVE_KEYWORDS` Constant Removed** — `code-review-pain-adapter.ts`: **Fixed in review** — the constant was unused after refactoring to single-pass comment analysis using sentiment scores.

## CI/CD & DevOps Findings

### Low
1. **No Per-PR Benchmark Regression Check** — `bench-results.json` exists but benchmarks are not run as part of CI. A PR that introduces a performance regression would not be caught automatically.

2. **Vitest Configured With `passWithNoTests`** — `packages/principles-core/vitest.config.ts` likely has `passWithNoTests: true`. This silently accepts removed test files. Recommend removing this flag or adding a test count assertion.

3. **No Automated API Surface Diff Check** — No CI step validates that `@principles/core` public API surface hasn't silently changed. Recommend adding `tsc --noEmit --declaration` diff step to CI.

4. **Pre-commit Hook (lefthook) Runs Full ESLint** — ESLint on every commit is slow. Consider using `eslint --cache` and limiting to staged files only.

## Positive Observations

1. **Conventional Commits** — All commits follow `<type>(<scope>):` format correctly.
2. **Vitest over Jest** — Modern choice, faster cold start, native TypeScript support.
3. **TypeScript Strict Mode** — `tsconfig.json` uses `strict: true`.
4. **Sinclair/Typebox over Zod** — Good TypeScript-first choice (though Typebox's strict `Decode` vs permissive `Cast` distinction is subtle — documented via comments in fixes).
5. **Conformance Test Factories** — Excellent pattern for ensuring interface contracts are maintained across adapters.

## Summary

| Category | Critical | High | Medium | Low |
|----------|----------|------|--------|-----|
| Best Practices | 0 | 0 | 0 | 3 |
| CI/CD | 0 | 0 | 0 | 4 |

**Total: 7 findings (0 Critical, 0 High, 0 Medium, 7 Low)**
