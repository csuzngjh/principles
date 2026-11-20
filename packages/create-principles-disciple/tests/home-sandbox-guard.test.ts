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
});
