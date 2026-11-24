/**
 * Red-proof for the real-home write sentinel (2026-11-19).
 *
 * The sentinel only earns its keep if it actually fails when a fixture leaks —
 * a guard that can never go red is documentation, not a control. These cases
 * pin HOME+USERPROFILE to a temp dir (the "watched home"), write into it, and
 * require the guard to throw with the offending path named.
 *
 * The real user profile is never touched: the watched home is the sandbox
 * itself, and the package-wide setup sentinel snapshots the actual profile
 * before this file runs.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  assertRealHomeStateUnchanged,
  pinHomeTo,
  snapshotRealHomeState,
  type HomePin,
} from './helpers/home-sandbox.js';

describe('real-home write sentinel', () => {
  let watchedHome: string;
  let homePin: HomePin;

  beforeEach(() => {
    watchedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-home-guard-'));
    homePin = pinHomeTo(watchedHome);
    fs.mkdirSync(path.join(watchedHome, '.pd'), { recursive: true });
  });

  afterEach(() => {
    homePin.restore();
    fs.rmSync(watchedHome, { recursive: true, force: true });
  });

  it('stays silent when only sandbox-internal paths are written', () => {
    const before = snapshotRealHomeState();
    fs.mkdirSync(path.join(watchedHome, 'project'), { recursive: true });
    expect(() => assertRealHomeStateUnchanged(before, 'sandbox-only writes')).not.toThrow();
  });

  it('fails and names the record when a fixture writes active.json', () => {
    const before = snapshotRealHomeState();
    fs.writeFileSync(
      path.join(watchedHome, '.pd', 'active.json'),
      `${JSON.stringify({ productVersion: '1.230.2' }, null, 2)}\n`,
    );
    expect(() => assertRealHomeStateUnchanged(before, 'simulated leak')).toThrow(/Real-home write detected/);
    expect(() => assertRealHomeStateUnchanged(before, 'simulated leak')).toThrow(/active\.json/);
  });

  it('fails when a transaction journal appears in the watched home', () => {
    const before = snapshotRealHomeState();
    fs.mkdirSync(path.join(watchedHome, '.pd', 'transactions'), { recursive: true });
    fs.writeFileSync(path.join(watchedHome, '.pd', 'transactions', 'install-1.jsonl'), '{}\n');
    expect(() => assertRealHomeStateUnchanged(before, 'simulated leak')).toThrow(/transactions/);
  });

  it('fails when an install manifest changes', () => {
    const manifest = path.join(watchedHome, '.pd', 'install.json');
    fs.writeFileSync(manifest, '{}\n');
    const before = snapshotRealHomeState();
    fs.writeFileSync(manifest, `${JSON.stringify({ layoutVersion: 1, hosts: ['openclaw'], workspaces: [] })}\n`);
    expect(() => assertRealHomeStateUnchanged(before, 'simulated leak')).toThrow(/install\.json/);
  });

  // ── WorkBuddy governance workspace coverage (2026-11-22 incident) ──────
  // The watched home doubles as the "real" profile: pinning makes
  // `<watchedHome>/.workbuddy/pd-workspace/...` a guarded target.

  const governanceFile = (...segs: string[]) =>
    path.join(watchedHome, '.workbuddy', 'pd-workspace', ...segs);

  it('fails and names config.yaml when a fixture overwrites the governance config', () => {
    fs.mkdirSync(path.dirname(governanceFile('.pd', 'config.yaml')), { recursive: true });
    fs.writeFileSync(governanceFile('.pd', 'config.yaml'), 'version: 1\n');
    const before = snapshotRealHomeState();
    fs.writeFileSync(governanceFile('.pd', 'config.yaml'), 'version: 1\nfeatures: {}\n');
    expect(() => assertRealHomeStateUnchanged(before, 'simulated leak')).toThrow(/config\.yaml/);
  });

  it('fails when trajectory.db is overwritten', () => {
    fs.mkdirSync(path.dirname(governanceFile('.state', 'trajectory.db')), { recursive: true });
    fs.writeFileSync(governanceFile('.state', 'trajectory.db'), 'sqlite-governance-data');
    const before = snapshotRealHomeState();
    fs.writeFileSync(governanceFile('.state', 'trajectory.db'), 'overwritten');
    expect(() => assertRealHomeStateUnchanged(before, 'simulated leak')).toThrow(/trajectory\.db/);
  });

  it('fails when a guarded file is deleted', () => {
    fs.mkdirSync(path.dirname(governanceFile('.pd', 'config.yaml')), { recursive: true });
    fs.writeFileSync(governanceFile('.pd', 'config.yaml'), 'version: 1\n');
    const before = snapshotRealHomeState();
    fs.rmSync(governanceFile('.pd', 'config.yaml'));
    expect(() => assertRealHomeStateUnchanged(before, 'simulated leak')).toThrow(/config\.yaml/);
  });

  it('fails when an unexpected directory appears under the config root', () => {
    const before = snapshotRealHomeState();
    fs.mkdirSync(path.join(watchedHome, '.workbuddy', 'sneaky-fixture'), { recursive: true });
    expect(() => assertRealHomeStateUnchanged(before, 'simulated leak')).toThrow(/\.workbuddy/);
  });

  it('fails on a write under an ambient WORKBUDDY_CONFIG_DIR outside every home', () => {
    const external = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-wb-external-'));
    const previous = process.env.WORKBUDDY_CONFIG_DIR;
    process.env.WORKBUDDY_CONFIG_DIR = external;
    try {
      const before = snapshotRealHomeState();
      fs.mkdirSync(path.join(external, 'pd-workspace', '.pd'), { recursive: true });
      fs.writeFileSync(path.join(external, 'pd-workspace', '.pd', 'config.yaml'), 'version: 1\n');
      expect(() => assertRealHomeStateUnchanged(before, 'simulated leak')).toThrow(/config\.yaml/);
    } finally {
      if (previous === undefined) delete process.env.WORKBUDDY_CONFIG_DIR;
      else process.env.WORKBUDDY_CONFIG_DIR = previous;
      fs.rmSync(external, { recursive: true, force: true });
    }
  });
});
