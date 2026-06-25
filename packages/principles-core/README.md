# @principles/core

> **Pure logic only — no I/O.** This package must not import `fs`, `path`, or any
> I/O module. All filesystem/DB/network operations belong in `openclaw-plugin`.

## Boundary enforcement (PRI-450 / PRI-462)

Three automated layers prevent I/O from leaking into core:

1. **I/O seam registry** — `io-seam-registry.json` is the single source of truth
   for which production files may import `fs`/`path`. Each file belongs to a
   named seam with a description explaining WHY the I/O is allowed. Both the
   architecture-regression test and ESLint derive their exemption lists from
   this registry — there is no second hand-maintained list.

2. **Architecture-regression test** — `runtime-v2/__tests__/architecture-regression.test.ts`
   loads the registry, scans every `.ts` file under `src/` for `fs`/`path` imports,
   and verifies they match the registry. Any new I/O file must be added to the
   registry — otherwise CI fails.

3. **ESLint `no-restricted-imports`** — `eslint.config.js` bans `fs`/`path` imports
   in `packages/principles-core/src/`. The exemption list is generated from the
   registry at lint time.

### Named I/O seams

| Seam | Files | Why allowed |
|------|-------|-------------|
| `ledger-tree` | `principle-tree-ledger.ts` | File-based principle ledger SSOT; pd-cli reads/writes without importing openclaw-plugin |
| `sdk-store` | `evolution-store.ts`, `trajectory-store.ts`, `workflow-funnel-loader.ts` | Standalone SDK store primitives exposed as package subpaths |
| `sqlite-state-store` | `runtime-v2/store/sqlite-connection.ts`, `runtime-v2/store/runtime-state-manager.ts` | runtime-v2 state.db connection + manager |
| `cli-runtime-adapter` | `runtime-v2/adapter/openclaw-cli-runtime-adapter.ts` | Spawns openclaw CLI process |
| `read-model` | 5 `*read-model*.ts` files | Read-only composite models querying state.db + ledger |
| `audit-observability` | `candidate-audit.ts`, `pain-signal-observability.ts` | Audit + pain signal observability writers |
| `remediation-review` | `internalization-integrity-remediation.ts`, `pruning-review-log.ts` | Integrity remediation + pruning review log |

### Adding a new I/O file (rare — prefer plugin)

If a core file genuinely needs I/O:

1. Add the file path to the appropriate seam in `io-seam-registry.json`
   (or create a new seam with a name and description)
2. Explain in the PR why the I/O cannot live in `openclaw-plugin`
3. Both the architecture-regression test and ESLint exemption update automatically

## Usage

```bash
npm install @principles/core
```

```typescript
import { /* ... */ } from '@principles/core';
```

See `package.json` `exports` for available subpaths.
