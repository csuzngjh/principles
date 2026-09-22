// PRI-905 (RAH-1): cross-platform dist cleaner.
// tsc never deletes outputs it no longer recognizes, so switching to a
// filtered build config (tsconfig.build.json) still leaves previously
// compiled test artifacts and stale orphan trees in dist. Removing dist
// before each build makes build output a pure function of current src.
// Invoked from package scripts whose cwd is the package root; deliberately
// hardcodes the single legal target instead of taking argv, so no caller
// can point it at an arbitrary path.
import { rmSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });
