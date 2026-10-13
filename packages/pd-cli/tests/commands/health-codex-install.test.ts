import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CODEX_INGESTION_VERIFIED_VERSION, CODEX_INGESTION_MIN_VERSION } from '@principles/codex-adapter';
import { assessCodexInstall } from '../../src/commands/health-codex-install.js';

/**
 * PRI-953 (F1/F2): the install/version observability layer must see what the
 * hooks actually execute (PLUGIN_DATA runtime), what a $pd-setup re-run would
 * install (marketplace pin), and the Codex CLI version the machine actually
 * runs (newest rollout session_meta) — staleness and unverified versions are
 * never silent.
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

function writeRollout(home: string, cliVersion: string, mtimeMs: number): string {
  const file = path.join(home, 'sessions', '2026', '10', '13', `rollout-2026-10-13T00-00-00-0b21621e-0000-4000-8000-00000000000${String(mtimeMs % 10)}.jsonl`);
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
  return file;
}

describe('assessCodexInstall (PRI-953 F1/F2 observability)', () => {
  it('missing CODEX_HOME degrades with reason + nextAction, never guesses', () => {
    const result = assessCodexInstall({ CODEX_HOME: path.join(os.tmpdir(), 'pd-health-codex-missing-home') });
    expect(result).toMatchObject({ ok: false, reason: 'codex_home_missing' });
  });

  it('detects a stale PLUGIN_DATA install vs the marketplace pin (F1)', () => {
    const home = makeCodexHome();
    try {
      writeJson(path.join(home, 'plugins', 'data', 'principles-disciple-principles', 'runtime', 'node_modules', '@principles', 'codex-adapter', 'package.json'), { name: '@principles/codex-adapter', version: '0.4.7' });
      writeJson(path.join(home, 'plugins', 'cache', 'principles', 'principles-disciple', '0.1.0', 'runtime-version.json'), { codexAdapter: '0.5.3', hostRuntime: '0.8.2', core: '1.291.4' });
      const result = assessCodexInstall({ CODEX_HOME: home });
      expect(result).toMatchObject({
        ok: true,
        pluginDataAdapterVersion: '0.4.7',
        marketplacePinAdapterVersion: '0.5.3',
        staleInstall: true,
        latestObservedCliVersion: null,
        cliStatus: 'unknown',
      });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('matching install and pin is not stale', () => {
    const home = makeCodexHome();
    try {
      writeJson(path.join(home, 'plugins', 'data', 'principles-disciple-principles', 'runtime', 'node_modules', '@principles', 'codex-adapter', 'package.json'), { name: '@principles/codex-adapter', version: '0.5.3' });
      writeJson(path.join(home, 'plugins', 'cache', 'principles', 'principles-disciple', '0.1.0', 'runtime-version.json'), { codexAdapter: '0.5.3' });
      const result = assessCodexInstall({ CODEX_HOME: home });
      expect(result).toMatchObject({ ok: true, staleInstall: false });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('reads the newest rollout cli_version and classifies an unverified CLI (F2)', () => {
    const home = makeCodexHome();
    try {
      const unverified = bumpPatch(CODEX_INGESTION_VERIFIED_VERSION);
      writeRollout(home, CODEX_INGESTION_MIN_VERSION, 1000);
      writeRollout(home, unverified, 2000); // newest by mtime wins
      const result = assessCodexInstall({ CODEX_HOME: home });
      expect(result).toMatchObject({
        ok: true,
        latestObservedCliVersion: unverified,
        cliStatus: 'unverified_above',
      });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('a supported CLI version classifies as supported', () => {
    const home = makeCodexHome();
    try {
      writeRollout(home, CODEX_INGESTION_VERIFIED_VERSION, 1000);
      const result = assessCodexInstall({ CODEX_HOME: home });
      expect(result).toMatchObject({ ok: true, cliStatus: 'supported' });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
