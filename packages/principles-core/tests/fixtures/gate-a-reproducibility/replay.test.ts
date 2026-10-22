// PRI-1000 freshness replay harness: runs the two verbatim Gate A fixtures
// (assertions unchanged) against the f2539e07e source mirror. Vitest is used
// only as the TS loader; pass/fail is read from each fixture's own JSON report.
import { expect, it } from 'vitest';

it('replays fixture-ledger against f2539e07e mirror', async () => {
  await import('./fixture-ledger.ts');
  expect(true).toBe(true);
});

it('replays fixture-sqlite against f2539e07e mirror', async () => {
  await import('./fixture-sqlite.ts');
  expect(true).toBe(true);
});
