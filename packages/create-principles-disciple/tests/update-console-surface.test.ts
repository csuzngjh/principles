/** Contract test for the registered console-facing update seam.
 *
 * ADR-0024 D-1: ReleaseManager is the sole update authority. The Console
 * reaches that authority exclusively through the `create-principles-disciple/update-console`
 * subpath registered in this package's `exports` map — never through `dist/`
 * deep imports. This test fails loudly if the seam is renamed, removed, or
 * stops carrying a symbol the Console contract needs.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('update-console public seam', () => {
  it('registers ./update-console in the package exports map', () => {
    const pkg = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf-8')) as {
      exports?: Record<string, unknown>;
    };
    expect(pkg.exports, 'package.json must declare an exports map so deep dist imports are structurally closed').toBeDefined();
    const subpath = pkg.exports?.['./update-console'] as { types?: string; default?: string } | undefined;
    expect(subpath, 'exports must register the ./update-console subpath').toBeDefined();
    expect(subpath?.default).toBe('./dist/update/console-surface.js');
    expect(subpath?.types).toBe('./dist/update/console-surface.d.ts');
  });

  it('the seam module re-exports every symbol the Console update contract consumes', async () => {
    const seam = await import('../src/update/console-surface.js');
    // ReleaseManager authority (update.ts routes)
    expect(typeof seam.createReleaseManagerAuthority).toBe('function');
    expect(typeof seam.mapReleaseManagerError).toBe('function');
    // Transaction journal / recovery surfaces (update-transaction.ts routes)
    expect(typeof seam.readTransactionJournalForRecovery).toBe('function');
    expect(typeof seam.recoverUnfinishedTransaction).toBe('function');
    expect(typeof seam.isTerminalTransactionState).toBe('function');
    expect(typeof seam.readActiveRecord).toBe('function');
    // ~/.pd runtime layout (bootstrap executor path resolution)
    expect(typeof seam.resolvePdHomePaths).toBe('function');
    // Error type carried by the authority contract (consumed by console tests)
    expect(typeof seam.ReleaseManagerError).toBe('function');
  });

  it('seam symbols are re-exports of the canonical modules, not copies', async () => {
    const [seam, authority, journal, layout, manager] = await Promise.all([
      import('../src/update/console-surface.js'),
      import('../src/update/release-manager-authority.js'),
      import('../src/update/transaction-journal.js'),
      import('../src/update/install-layout.js'),
      import('../src/update/release-manager.js'),
    ]);
    expect(seam.createReleaseManagerAuthority).toBe(authority.createReleaseManagerAuthority);
    expect(seam.mapReleaseManagerError).toBe(authority.mapReleaseManagerError);
    expect(seam.readTransactionJournalForRecovery).toBe(journal.readTransactionJournalForRecovery);
    expect(seam.recoverUnfinishedTransaction).toBe(journal.recoverUnfinishedTransaction);
    expect(seam.isTerminalTransactionState).toBe(journal.isTerminalTransactionState);
    expect(seam.readActiveRecord).toBe(journal.readActiveRecord);
    expect(seam.resolvePdHomePaths).toBe(layout.resolvePdHomePaths);
    expect(seam.ReleaseManagerError).toBe(manager.ReleaseManagerError);
  });
});
