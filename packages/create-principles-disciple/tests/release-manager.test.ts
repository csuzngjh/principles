import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ReleaseManager, ReleaseManagerError } from '../src/update/release-manager.js';
import {
  BootstrapProtocolError,
  handleBootstrapRequest,
  parseBootstrapRequest,
  serializeBootstrapResponse,
} from '../src/update/bootstrap-protocol.js';
import { ensurePdHomeLayout, resolvePdHomePaths } from '../src/update/install-layout.js';
import { writeActiveRecord } from '../src/update/transaction-journal.js';
import type { LegacyUpdaterDecision } from '../src/update/release-manager.js';
import { createShadowFixture, disposeShadowFixtures, trackTempDir } from './helpers/shadow-release-fixture.js';

afterEach(async () => {
  await disposeShadowFixtures();
});

// Full shadow-mode integration: a local signed TUF repository serves the
// channel metadata chain plus the channel payload target; the ReleaseManager
// resolves it against ~/.pd and compares its decision with a legacy updater.
// The fixture itself lives in tests/helpers/shadow-release-fixture.ts.

describe('ReleaseManager shadow mode', () => {
  it('inspects an empty installation as layout none with safe defaults', () => {
    const pdHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-shadow-empty-'));
    trackTempDir(pdHome);
    const manager = new ReleaseManager({
      pdHome: path.join(pdHome, '.pd'),
      metadataBaseUrl: 'http://127.0.0.1:1',
      openclawHome: path.join(pdHome, 'no-openclaw'),
    });
    const status = manager.inspect();
    expect(status).toMatchObject({
      layout: 'none',
      productVersion: null,
      releaseId: null,
      generation: null,
      bootstrapVersion: null,
      channel: 'stable',
    });
  });

  it('inspects a dual-slot installation with bootstrap and active record', () => {
    const pdHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-shadow-dual-'));
    trackTempDir(pdHome);
    const paths = resolvePdHomePaths(path.join(pdHome, '.pd'));
    ensurePdHomeLayout(paths);
    fs.writeFileSync(paths.bootstrapManifestPath, `${JSON.stringify({ bootstrapVersion: '1.2.0', installedAt: '2026-08-25T00:00:00Z' })}\n`);
    writeActiveRecord(paths.activeRecordPath, {
      generation: 3,
      releaseId: 'c'.repeat(64),
      releaseMetadataDigest: 'd'.repeat(64),
      previousReleaseId: null,
      transactionId: 'txn-fixture-inspect',
      productVersion: '1.222.0',
    });
    const manager = new ReleaseManager({ pdHome: paths.home, metadataBaseUrl: 'http://127.0.0.1:1' , openclawHome: path.join(os.tmpdir(), 'pd-test-no-openclaw-')});
    expect(manager.inspect()).toMatchObject({
      layout: 'dual-slot',
      productVersion: '1.222.0',
      releaseId: 'c'.repeat(64),
      generation: 3,
      bootstrapVersion: '1.2.0',
    });
  });

  it('refuses a corrupt active record with a recovery next action instead of guessing', () => {
    const pdHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-shadow-corrupt-'));
    trackTempDir(pdHome);
    const paths = resolvePdHomePaths(path.join(pdHome, '.pd'));
    ensurePdHomeLayout(paths);
    fs.writeFileSync(paths.activeRecordPath, JSON.stringify({ generation: 'three' }));
    const manager = new ReleaseManager({ pdHome: paths.home, metadataBaseUrl: 'http://127.0.0.1:1' , openclawHome: path.join(os.tmpdir(), 'pd-test-no-openclaw-')});
    expect(() => manager.inspect()).toThrow(ReleaseManagerError);
    try {
      manager.inspect();
    } catch (error) {
      const refusal = error as ReleaseManagerError;
      expect(refusal.reason).toBe('active_record_corrupt');
      expect(refusal.nextAction).toMatch(/journal-confirmed/i);
    }
  });

  it('maps a non-JSON active record to active_record_corrupt, never a bare SyntaxError', () => {
    const pdHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-shadow-syntax-'));
    trackTempDir(pdHome);
    const paths = resolvePdHomePaths(path.join(pdHome, '.pd'));
    ensurePdHomeLayout(paths);
    fs.writeFileSync(paths.activeRecordPath, '{"generation": 3, "releaseId":'); // torn write
    const manager = new ReleaseManager({ pdHome: paths.home, metadataBaseUrl: 'http://127.0.0.1:1', openclawHome: path.join(os.tmpdir(), 'pd-test-no-openclaw-') });
    try {
      manager.inspect();
      throw new Error('expected inspect() to refuse a torn active record');
    } catch (error) {
      const refusal = error as ReleaseManagerError;
      expect(refusal).toBeInstanceOf(ReleaseManagerError);
      expect(refusal.reason).toBe('active_record_corrupt');
      expect(refusal.nextAction).toMatch(/journal-confirmed/i);
    }
  });

  it('checks a verified channel and compares decisions with the legacy updater', async () => {
    const fixture = await createShadowFixture();
    const agreeLegacy: LegacyUpdaterDecision = {
      source: 'legacy-updater',
      latestVersion: '1.223.0',
      updateAvailable: true,
    };
    const manager = new ReleaseManager({
      pdHome: fixture.pdHome,
      metadataBaseUrl: fixture.repository.baseUrl,
      legacyCheck: async () => agreeLegacy,
    });
    const check = await manager.check('stable');
    expect(check.candidate).toMatchObject({ productVersion: '1.223.0', publicationSequence: 9 });
    expect(check.decision).toEqual({ allowed: true, direction: 'update' });
    expect(check.shadowComparison.agrees).toBe(true);
    expect(check.shadowComparison.note).toBeNull();
  });

  it('records a structured disagreement note when the legacy updater decides differently', async () => {
    const fixture = await createShadowFixture();
    const disagreeLegacy: LegacyUpdaterDecision = {
      source: 'legacy-updater',
      latestVersion: '1.222.0',
      updateAvailable: false,
    };
    const manager = new ReleaseManager({
      pdHome: fixture.pdHome,
      metadataBaseUrl: fixture.repository.baseUrl,
      legacyCheck: async () => disagreeLegacy,
    });
    const check = await manager.check('stable');
    expect(check.shadowComparison.agrees).toBe(false);
    expect(check.shadowComparison.note).toMatch(/decision mismatch/);
  });

  it('survives a failing legacy comparison without failing the new check', async () => {
    const fixture = await createShadowFixture();
    const manager = new ReleaseManager({
      pdHome: fixture.pdHome,
      metadataBaseUrl: fixture.repository.baseUrl,
      legacyCheck: async () => {
        throw new Error('registry unreachable');
      },
    });
    const check = await manager.check('stable');
    expect(check.decision.allowed).toBe(true);
    expect(check.shadowComparison.agrees).toBeNull();
    expect(check.shadowComparison.note).toMatch(/legacy updater failed/);
  });

  it('refuses apply and rollback in shadow mode with owner-facing next actions', async () => {
    const fixture = await createShadowFixture();
    const manager = new ReleaseManager({ pdHome: fixture.pdHome, metadataBaseUrl: fixture.repository.baseUrl , openclawHome: path.join(os.tmpdir(), 'pd-test-no-openclaw-')});
    await expect(manager.apply()).rejects.toMatchObject({ reason: 'shadow_mode_read_only' });
    await expect(manager.rollback()).rejects.toMatchObject({ reason: 'shadow_mode_read_only' });
  });
});

describe('bootstrap protocol', () => {
  it('accepts exactly one well-formed JSON object per request', () => {
    expect(parseBootstrapRequest('{"op":"inspect"}')).toEqual({ op: 'inspect' });
    expect(parseBootstrapRequest('{"op":"check","channel":"candidate"}')).toEqual({ op: 'check', channel: 'candidate' });
    expect(parseBootstrapRequest('{"op":"apply","releaseId":"' + 'a'.repeat(64) + '"}')).toMatchObject({ op: 'apply' });
    for (const bad of [
      '',
      '{} {}',
      '{"op":"inspect"} {"op":"inspect"}',
      '[]',
      'null',
      '"inspect"',
      '{"op":"restart"}',
      '{"op":"check"}',
      '{"op":"check","channel":"beta"}',
      '{"op":"apply","releaseId":""}',
      '{"op":"inspect","extra":1}',
      '{"op":"check","channel":"stable","extra":1}',
      '{"op":"apply","releaseId":"abc","extra":1}',
    ]) {
      let captured: unknown;
      try {
        parseBootstrapRequest(bad);
      } catch (error) {
        captured = error;
      }
      expect(captured, bad).toBeInstanceOf(BootstrapProtocolError);
      const reason = (captured as { reason?: unknown }).reason;
      expect(typeof reason).toBe('string');
      expect((reason as string).startsWith('protocol_')).toBe(true);
    }
  });

  it('emits exactly one JSON object per response', () => {
    const line = serializeBootstrapResponse({ ok: true, result: { layout: 'none' } });
    expect(line.endsWith('\n')).toBe(true);
    expect(() => JSON.parse(line)).not.toThrow();
    const parsed: unknown = JSON.parse(line);
    expect(typeof parsed).toBe('object');
  });

  it('dispatches inspect and surfaces manager refusals as structured failures', async () => {
    const pdHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-shadow-proto-'));
    trackTempDir(pdHome);
    const manager = new ReleaseManager({ pdHome: path.join(pdHome, '.pd'), metadataBaseUrl: 'http://127.0.0.1:1', openclawHome: path.join(pdHome, 'no-openclaw') });

    const inspect = await handleBootstrapRequest({ op: 'inspect' }, manager);
    expect(inspect).toMatchObject({ ok: true, result: { layout: 'none' } });

    const apply = await handleBootstrapRequest({ op: 'apply', releaseId: 'a'.repeat(64) }, manager);
    expect(apply).toMatchObject({
      ok: false,
      reason: 'shadow_mode_read_only',
    });
    if (!apply.ok) {
      expect(apply.nextAction.length).toBeGreaterThan(10);
    }

    const rollback = await handleBootstrapRequest({ op: 'rollback' }, manager);
    expect(rollback).toMatchObject({ ok: false, reason: 'shadow_mode_read_only' });
  });
});
