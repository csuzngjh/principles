import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CODEX_INGESTION_VERIFIED_VERSION, CODEX_INGESTION_MIN_VERSION } from '@principles/codex-adapter';
import { assessCodexInstall } from '../../src/commands/health-codex-install.js';
import { selectMarketplaceCacheVersionDir } from '../../src/services/codex-plugin-install.js';

/**
 * PRI-953 R1 merge-readiness (A1–A4): install-mode classification, fail-open
 * fake-health prevention, marketplace-pin selection, and CLI version signal
 * provenance.
 *
 * Evidence discipline: every case names the review finding it pins down.
 * The probe (`codex --version`) is injected as a stub so tests never depend
 * on the host machine's Codex installation.
 */

function bumpPatch(version: string): string {
  const [major, minor, patch] = version.split('.').map((n) => Number.parseInt(n, 10));
  return `${major}.${minor}.${patch + 1}`;
}

function makeCodexHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pd-health-codex-install-'));
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

function writePin(home: string, versionDir: string, adapterVersion: string): void {
  writeJson(path.join(home, 'plugins', 'cache', 'principles', 'principles-disciple', versionDir, 'runtime-version.json'), {
    codexAdapter: adapterVersion,
    hostRuntime: '0.8.2',
    core: '1.291.4',
  });
}

function writeInstalledRuntime(home: string, adapterVersion: string): void {
  writeJson(path.join(home, 'plugins', 'data', 'principles-disciple-principles', 'runtime', 'node_modules', '@principles', 'codex-adapter', 'package.json'), {
    name: '@principles/codex-adapter',
    version: adapterVersion,
  });
}

function writeRollout(home: string, cliVersion: string, mtimeMs: number): void {
  const file = path.join(home, 'sessions', '2026', '10', '13', `rollout-2026-10-13T00-00-0${mtimeMs % 10}-0b21621e-0000-4000-8000-00000000000${mtimeMs % 10}.jsonl`);
  writeJson(file + '.tmp', {});
  fs.writeFileSync(
    file,
    JSON.stringify({
      timestamp: '2026-10-13T00:00:00Z',
      ordinal: 0,
      type: 'session_meta',
      payload: { session_id: 's', cwd: 'D:\\ws\\probe', cli_version: cliVersion },
    }) + '\n',
  );
  fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
}

describe('assessCodexInstall — R1 merge-readiness (A1–A4)', () => {
  it('PLUGIN_DATA missing → MISSING_RUNTIME (not a false ok/matched)', () => {
    const home = makeCodexHome();
    try {
      writePin(home, '0.1.0', '0.5.3');
      const result = assessCodexInstall({ CODEX_HOME: home });
      expect(result).toMatchObject({ ok: true, installMode: 'MISSING_RUNTIME', staleInstall: false, pluginDataAdapterVersion: null });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('Marketplace pin missing → PIN_UNAVAILABLE even when a runtime is installed', () => {
    const home = makeCodexHome();
    try {
      writeInstalledRuntime(home, '0.5.3');
      const result = assessCodexInstall({ CODEX_HOME: home });
      expect(result).toMatchObject({ ok: true, installMode: 'PIN_UNAVAILABLE', staleInstall: false });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('Marketplace pin corrupt JSON → PIN_UNAVAILABLE (unreadable ≠ matched)', () => {
    const home = makeCodexHome();
    try {
      writeInstalledRuntime(home, '0.5.3');
      const pinPath = path.join(home, 'plugins', 'cache', 'principles', 'principles-disciple', '0.1.0', 'runtime-version.json');
      fs.mkdirSync(path.dirname(pinPath), { recursive: true });
      fs.writeFileSync(pinPath, '{ not json');
      const result = assessCodexInstall({ CODEX_HOME: home });
      expect(result).toMatchObject({ ok: true, installMode: 'PIN_UNAVAILABLE' });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('multiple cache versions → the highest semver wins, non-semver dirs ignored (A3)', () => {
    const home = makeCodexHome();
    try {
      writePin(home, '0.0.9', '0.4.7');
      writePin(home, '0.1.0', '0.5.3');
      // non-semver directory: must be ignored, never selected by readdir order
      const junk = path.join(home, 'plugins', 'cache', 'principles', 'principles-disciple', 'not-a-version');
      writeJson(path.join(junk, 'runtime-version.json'), { codexAdapter: '9.9.9-bogus' });
      const selection = selectMarketplaceCacheVersionDir(home);
      expect(selection?.dirName).toBe('0.1.0');
      expect(selection?.pin.codexAdapter).toBe('0.5.3');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('installed differs from pin → STALE_INSTALL (F1)', () => {
    const home = makeCodexHome();
    try {
      writeInstalledRuntime(home, '0.4.7');
      writePin(home, '0.1.0', '0.5.3');
      const result = assessCodexInstall({ CODEX_HOME: home });
      expect(result).toMatchObject({ ok: true, installMode: 'STALE_INSTALL', staleInstall: true });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('installed matches pin → INSTALLED_AND_MATCHED (not stale)', () => {
    const home = makeCodexHome();
    try {
      writeInstalledRuntime(home, '0.5.3');
      writePin(home, '0.1.0', '0.5.3');
      const result = assessCodexInstall({ CODEX_HOME: home });
      expect(result).toMatchObject({ ok: true, installMode: 'INSTALLED_AND_MATCHED', staleInstall: false });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('both layers exist but version strings unreadable → VERSION_UNREADABLE (never matched)', () => {
    const home = makeCodexHome();
    try {
      // installed package.json present but without a version field
      writeJson(path.join(home, 'plugins', 'data', 'principles-disciple-principles', 'runtime', 'node_modules', '@principles', 'codex-adapter', 'package.json'), { name: '@principles/codex-adapter' });
      writePin(home, '0.1.0', '0.5.3');
      const result = assessCodexInstall({ CODEX_HOME: home });
      expect(result).toMatchObject({ ok: true, installMode: 'VERSION_UNREADABLE', staleInstall: false });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('CLI signal: newest historical rollout classifies with explicit rollout provenance (A4)', () => {
    const home = makeCodexHome();
    try {
      writeInstalledRuntime(home, '0.5.3');
      writePin(home, '0.1.0', '0.5.3');
      // A version ABOVE the verified ceiling in the newest rollout — must be
      // classified unverified and must NOT be presented as the current binary.
      const unverified = bumpPatch(CODEX_INGESTION_VERIFIED_VERSION);
      writeRollout(home, unverified, 2000);
      const result = assessCodexInstall({ CODEX_HOME: home });
      expect(result).toMatchObject({
        ok: true,
        currentCliVersion: null,
        lastRolloutCliVersion: unverified,
        cliStatus: 'unverified_above',
        cliStatusSource: 'last_rollout',
      });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('no current CLI probe and no rollouts → cliStatus unknown with source none', () => {
    const home = makeCodexHome();
    try {
      writeInstalledRuntime(home, '0.5.3');
      writePin(home, '0.1.0', '0.5.3');
      const result = assessCodexInstall({ CODEX_HOME: home });
      expect(result).toMatchObject({ ok: true, cliStatus: 'unknown', cliStatusSource: 'none' });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
