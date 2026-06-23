# @principles/core

> **Pure logic only — no I/O.** This package must not import `fs`, `path`, or any
> I/O module. All filesystem/DB/network operations belong in `openclaw-plugin`.

## Boundary enforcement (PRI-450)

Three automated layers prevent I/O from leaking into core:

1. **Architecture-regression test** — `runtime-v2/__tests__/architecture-regression.test.ts`
   scans every `.ts` file under `src/` for `fs`/`path` imports and compares against
   an explicit whitelist (`ALLOWED_IO_FILES`). Any new I/O file must be added there.

2. **ESLint `no-restricted-imports`** — `eslint.config.js` bans `fs`/`path` imports
   in `packages/principles-core/src/`. Whitelisted files and test files are exempt.

3. **PR template & AGENTS.md** — the PR checklist asks whether new `fs`/`path` imports
   were added; AGENTS.md lists "writing I/O code in core" as an anti-pattern trigger.

### Adding a new I/O file (rare — prefer plugin)

If a core file genuinely needs I/O:

1. Add the file path to `ALLOWED_IO_FILES` in `architecture-regression.test.ts`
2. Add the file path to the exemption list in `eslint.config.js`
3. Explain in the PR why the I/O cannot live in `openclaw-plugin`

## Usage

```bash
npm install @principles/core
```

```typescript
import { /* ... */ } from '@principles/core';
```

See `package.json` `exports` for available subpaths.
