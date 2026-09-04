/**
 * PRI-664 — installer ↔ transaction journal integration (ADR-0024 D-2).
 *
 * Flow-level tests over install() using the same harness as installer.test.ts
 * (auto-mocked fs + mocked gateway control). The transaction journal module is
 * only PARTIALLY mocked: appendJournalTransition is a spy so tests can capture
 * the emitted transitions (journal-first ordering, terminal states, Tier-1
 * refusal) without touching the real ~/.pd directory.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { install } from '../src/installer.js';
import { checkOpenClawGateway, stopOpenClawGateway, restartOpenClawGateway } from '../src/utils/env.js';
import { setLanguage } from '../src/i18n.js';
import type { InstallOptions } from '../src/prompts.js';
import { appendJournalTransition, type JournalTransition } from '../src/update/transaction-journal.js';

vi.mock('fs');
vi.mock('child_process', () => ({
  execFileSync: vi.fn(() => ''),
  execSync: vi.fn(() => ''),
}));
vi.mock('../src/utils/env.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    checkOpenClawGateway: vi.fn(),
    stopOpenClawGateway: vi.fn(),
    restartOpenClawGateway: vi.fn(),
  };
});
// Capture journal appends; default no-op (fs is auto-mocked anyway).
vi.mock('../src/update/transaction-journal.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/update/transaction-journal.js')>();
  return {
    ...actual,
    appendJournalTransition: vi.fn(),
  };
});

const baseInstallOptions: InstallOptions = {
  language: 'en',
  mode: 'smart',
  workspaceDir: '/tmp/pd-journal-test-ws',
  channels: [],
  overwriteConfig: false,
  host: 'openclaw',
  stopGateway: false,
};

const PLUGIN_MANIFEST = JSON.stringify({
  name: 'principles-disciple',
  activation: { onCapabilities: ['hook'] },
});

function capturedTransitions(): JournalTransition[] {
  return vi.mocked(appendJournalTransition).mock.calls.map((call) => call[1] as JournalTransition);
}

describe('install() transaction journal integration (ADR-0024 D-2)', () => {
  let savedLegacyNpmInstall: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: journal appends succeed as a recorded no-op (fs is auto-mocked).
    vi.mocked(appendJournalTransition).mockImplementation(() => undefined);
    savedLegacyNpmInstall = process.env.PD_ALLOW_LEGACY_NPM_INSTALL;
    // Legacy install path: skips the self-contained asset preflight, so the
    // flow reaches the journal gate directly (the subject under test).
    process.env.PD_ALLOW_LEGACY_NPM_INSTALL = '1';
    setLanguage('en');
    vi.mocked(checkOpenClawGateway).mockResolvedValue({ isRunning: false });
    vi.mocked(stopOpenClawGateway).mockResolvedValue({ ok: true });
    vi.mocked(restartOpenClawGateway).mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(fs.existsSync).mockReset();
    vi.mocked(fs.readFileSync).mockReset();
    vi.mocked(fs.readdirSync).mockReset();
    vi.mocked(fs.renameSync).mockReset();
    if (savedLegacyNpmInstall === undefined) delete process.env.PD_ALLOW_LEGACY_NPM_INSTALL;
    else process.env.PD_ALLOW_LEGACY_NPM_INSTALL = savedLegacyNpmInstall;
    setLanguage('zh');
  });

  /** checkBuiltPlugin passes; plugin package.json carries the expected setupEntry. */
  function mockHappyFs(): void {
    vi.mocked(fs.existsSync).mockImplementation((value) => {
      const s = String(value);
      // No existing workspace PD state → the legacy rule contract preflight
      // (which needs a real pd-cli subprocess) is skipped entirely.
      if (s.endsWith(path.join('.pd', 'state.db'))) return false;
      // No existing install manifest → resolveInstallManifestHosts treats
      // current as undefined (fresh install) instead of re-reading it.
      if (s.endsWith('install.json')) return false;
      return true;
    });
    vi.mocked(fs.readFileSync).mockImplementation((value) => {
      const filePath = String(value);
      if (filePath.endsWith('openclaw.plugin.json')) return PLUGIN_MANIFEST;
      if (filePath.endsWith('install.json')) {
        throw new Error(`ENOENT: ${filePath}`);
      }
      return JSON.stringify({ name: 'pd-cli', version: '1.74.1', openclaw: { setupEntry: './dist/bundle.js' } });
    });
    vi.mocked(fs.readdirSync).mockReturnValue([]);
  }

  it('Tier-1: refuses to install (zero mutation) when the journal cannot be written', async () => {
    mockHappyFs();
    vi.mocked(appendJournalTransition).mockImplementation(() => {
      throw new Error('EACCES: ~/.pd/transactions is not writable');
    });

    const result = await install(baseInstallOptions, '/asset', { quiet: true });

    expect(result.success).toBe(false);
    expect(result.reason).toMatch(/^transaction_journal_unavailable:/);
    expect(result.error).toMatch(/unjournaled/i);
    expect(result.journal).toMatchObject({ degraded: true });
    // Journal-first guarantee: the refusal happens BEFORE the first mutation.
    expect(fs.renameSync).not.toHaveBeenCalled();
    expect(fs.cpSync).not.toHaveBeenCalled();
    expect(fs.rmSync).not.toHaveBeenCalled();
  });

  it('records planned → failed when the backup rename throws (no backup, no rolled_back)', async () => {
    mockHappyFs();
    vi.mocked(fs.renameSync).mockImplementation(() => {
      throw new Error('EPERM: operation not permitted, rename locked');
    });

    const result = await install(baseInstallOptions, '/asset', { quiet: true });

    expect(result.success).toBe(false);
    // Journal-first ordering: 'planned' was recorded BEFORE the mutation attempt.
    const transitions = capturedTransitions();
    expect(transitions.map((t) => t.to)).toEqual(['planned', 'failed']);
    expect(transitions[0]).toMatchObject({ from: null, transactionId: expect.stringMatching(/^install-\d+-[0-9a-f]{8}$/) });
    expect(transitions[1]?.detail).toMatch(/EPERM/);
    // No backup existed -> no rolled_back (nothing was restored).
    expect(transitions.map((t) => t.to)).not.toContain('rolled_back');
    expect(result.journal).toMatchObject({ degraded: false });
  });

  it('records planned → failed → rolled_back when a post-backup step throws', async () => {
    // Everything happy EXCEPT the bundled core directory is missing, which
    // deterministically throws inside installBundledCore — AFTER the backup
    // rename succeeded (hasBackup=true).
    vi.mocked(fs.existsSync).mockImplementation((value) => {
      const s = String(value);
      if (s.endsWith('install.json')) return false;
      if (s.endsWith(path.join('.pd', 'state.db'))) return false;
      if (s === path.join('/asset', 'core') || s.startsWith(path.join('/asset', 'core') + path.sep)) return false;
      return true;
    });
    vi.mocked(fs.readFileSync).mockImplementation((value) => {
      const filePath = String(value);
      if (filePath.endsWith('openclaw.plugin.json')) return PLUGIN_MANIFEST;
      if (filePath.endsWith('install.json')) throw new Error(`ENOENT: ${filePath}`);
      return JSON.stringify({ name: 'pd-cli', version: '1.74.1', openclaw: { setupEntry: './dist/bundle.js' } });
    });
    vi.mocked(fs.readdirSync).mockReturnValue([]);

    const result = await install(baseInstallOptions, '/asset', { quiet: true });

    expect(result.success).toBe(false);
    const transitions = capturedTransitions();
    // `failed` and `rolled_back` are both terminal states; a journal file ends
    // at exactly ONE terminal state — a successful backup restore is a
    // rollback, not a failure.
    expect(transitions.map((t) => t.to)).toEqual(['planned', 'rolled_back']);
    expect(transitions[1]?.from).toBe('planned');
    // Every transition belongs to ONE transaction id (one journal file each).
    const ids = new Set(transitions.map((t) => t.transactionId));
    expect(ids.size).toBe(1);
    // All transitions share the payload identity fields.
    for (const t of transitions) {
      expect(t.releaseId).toMatch(/^bundled-1\.74\.1-[0-9a-f]{12}$/);
      expect(t.productVersion).toBe('1.74.1');
      expect(t.releaseMetadataDigest).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(result.journal).toMatchObject({ degraded: false });
  });

  it('writes each transaction to its own journal file under ~/.pd/transactions (D-6)', async () => {
    mockHappyFs();
    vi.mocked(fs.renameSync).mockImplementation(() => {
      throw new Error('EPERM: rename locked');
    });

    await install(baseInstallOptions, '/asset', { quiet: true });

    const paths = vi.mocked(appendJournalTransition).mock.calls.map((call) => String(call[0]));
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) {
      expect(p).toMatch(/[\\/]\.pd[\\/]transactions[\\/]install-\d+-[0-9a-f]{8}\.jsonl$/);
    }
  });
});
