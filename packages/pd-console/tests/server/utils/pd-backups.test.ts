/**
 * Unit tests for PD backup location utilities (pd-backups.ts).
 *
 * Invariants under test:
 * 1. The Console's backup root is the host-neutral <PD_HOME>/.pd/backups —
 *    NEVER inside the extensions dir that OpenClaw plugin discovery scans
 *    (duplicate plugin id warning, see pd-backups.ts header) and never the
 *    legacy OpenClaw-only <openclawHome>/pd-backups root.
 * 2. Same-millisecond reservations are unique.
 *
 * Legacy backup RELOCATION is not tested here on purpose: the Console performs
 * no backup migration. That behavior is an explicit installer operation tested
 * in create-principles-disciple tests/backup-location.test.ts
 * (migrateLegacyPdBackups).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import {
  resolvePdBackupsRoot,
  reservePdBackupDestination,
} from '../../../src/server/utils/pd-backups.js';

let tmpHome: string;
let savedOpenclawHome: string | undefined;
let savedExperimentRoot: string | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  tmpHome = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pd-backups-test-')));
  savedOpenclawHome = process.env.OPENCLAW_HOME;
  savedExperimentRoot = process.env.PD_EXPERIMENT_ROOT;
  process.env.PD_EXPERIMENT_ROOT = tmpHome;
  process.env.OPENCLAW_HOME = tmpHome;
});

afterEach(async () => {
  if (savedOpenclawHome === undefined) delete process.env.OPENCLAW_HOME;
  else process.env.OPENCLAW_HOME = savedOpenclawHome;
  if (savedExperimentRoot === undefined) delete process.env.PD_EXPERIMENT_ROOT;
  else process.env.PD_EXPERIMENT_ROOT = savedExperimentRoot;
  if (tmpHome && fs.existsSync(tmpHome)) {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

describe('resolvePdBackupsRoot', () => {
  it('is outside the extensions dir that OpenClaw scans for plugins', () => {
    const root = resolvePdBackupsRoot();
    expect(root).toBe(path.join(tmpHome, '.pd', 'backups'));
    expect(path.dirname(root)).toBe(path.join(tmpHome, '.pd'));
    expect(root).not.toContain(`${path.sep}extensions${path.sep}`);
    expect(root).not.toBe(path.join(tmpHome, 'pd-backups'));
  });
});

describe('reservePdBackupDestination', () => {
  it('reserves an existing directory under the backups root', () => {
    const dest = reservePdBackupDestination('principles-disciple');
    expect(path.dirname(dest)).toBe(resolvePdBackupsRoot());
    expect(fs.existsSync(dest)).toBe(true);
    expect(path.basename(dest).startsWith('principles-disciple-')).toBe(true);
  });

  it('returns unique paths for same-millisecond reservations', () => {
    const first = reservePdBackupDestination('principles-disciple');
    const second = reservePdBackupDestination('principles-disciple');
    expect(first).not.toBe(second);
    expect(fs.existsSync(first)).toBe(true);
    expect(fs.existsSync(second)).toBe(true);
  });
});
