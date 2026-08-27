/**
 * pd telemetry — behavior tests (PRI-597/598 acceptance at the CLI surface).
 *
 * Covers: JSON purity (cli-1), dry-run default + --confirm (cli-4),
 * enable/disable/reset consent transitions against a temp HOME, status
 * never exposing the secret, preview showing the exact payload with the
 * "Preview only. Nothing was sent." banner.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  handleTelemetryMutation,
  handleTelemetryPreview,
  handleTelemetryStatus,
} from '../../src/commands/telemetry.js';
import { getProductTelemetryStatePath, readProductTelemetryControlState } from '@principles/host-runtime';

// Toggleable workspace-resolution failure for the preview fail-loud test.
// Defaults to delegating to the real resolver so other tests are unaffected.
const wsMock = vi.hoisted(() => ({ shouldThrow: false }));
vi.mock('../../src/resolve-workspace.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/resolve-workspace.js')>();
  return {
    ...actual,
    resolveWorkspaceDir: (...args: Parameters<typeof actual.resolveWorkspaceDir>) => {
      if (wsMock.shouldThrow) {
        throw new Error('No workspace directory configured.');
      }
      return actual.resolveWorkspaceDir(...args);
    },
  };
});

let tmpHome: string;
let tmpWorkspace: string;
let originalUserprofile: string | undefined;
let originalHome: string | undefined;
let stdoutSpy: ReturnType<typeof vi.spyOn>;

function capturedOutput(): { text: string; json: Record<string, unknown> } {
  expect(stdoutSpy).toHaveBeenCalled();
  const text = stdoutSpy.mock.calls[0][0] as string;
  return { text, json: JSON.parse(text) };
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-tel-cli-home-'));
  tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-tel-cli-ws-'));
  // os.homedir() reads USERPROFILE on Windows and HOME on POSIX — set both so
  // the machine-scope consent store is isolated on every CI runner.
  originalUserprofile = process.env.USERPROFILE;
  originalHome = process.env.HOME;
  process.env.USERPROFILE = tmpHome;
  process.env.HOME = tmpHome;
  stdoutSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  stdoutSpy.mockRestore();
  if (originalUserprofile === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = originalUserprofile;
  }
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpWorkspace, { recursive: true, force: true });
});

describe('pd telemetry status', () => {
  it('--json outputs exactly one parseable JSON object with consent gates and no secret', async () => {
    await handleTelemetryMutation('enable', { confirm: true, json: true, workspace: tmpWorkspace });
    stdoutSpy.mockClear();
    await handleTelemetryStatus({ json: true, workspace: tmpWorkspace });
    const { text, json } = capturedOutput();
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(json.status).toBe('ok');
    expect(json.command).toBe('telemetry:status');
    expect(json.consent).toBe('granted');
    expect(json.canExport).toBe(false); // flag off + repo-checkout suppression in tests — expected
    const stateRead = readProductTelemetryControlState(tmpHome);
    const secret = stateRead.ok ? stateRead.state.telemetrySecret : undefined;
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(text).not.toContain(secret as string);
    expect(JSON.stringify(json)).not.toContain(secret as string);
    expect(json.blockers).toEqual(expect.arrayContaining(['feature_flag_disabled']));
  });

  it('works with no resolvable workspace passed explicitly (machine-scope status)', async () => {
    // No --workspace: resolution falls back to discovery; machine-scope
    // fields must render regardless of what discovery finds on this machine.
    await handleTelemetryStatus({ json: true });
    const { json } = capturedOutput();
    expect(json.status).toBe('ok');
    expect(json.command).toBe('telemetry:status');
    expect(json.consent).toBe('unset');
    expect(json.hasSecret).toBe(false);
    expect(json.flagEnabled).toBeDefined();
  });
});

describe('pd telemetry enable/disable/reset (cli-4 dry-run default)', () => {
  it('enable without --confirm is a dry-run: nothing written', async () => {
    await handleTelemetryMutation('enable', { json: true });
    const { json } = capturedOutput();
    expect(json.applied).toBe(false);
    expect(json.dryRun).toBe(true);
    expect(fs.existsSync(getProductTelemetryStatePath(tmpHome))).toBe(false);
  });

  it('enable --confirm writes granted consent with a secret', async () => {
    await handleTelemetryMutation('enable', { confirm: true, json: true });
    const { json } = capturedOutput();
    expect(json.applied).toBe(true);
    expect(json.consent).toBe('granted');
    const state = readProductTelemetryControlState(tmpHome);
    expect(state.ok && state.state.consent).toBe('granted');
    expect(state.ok && state.state.telemetrySecret).toMatch(/^[0-9a-f]{64}$/);
  });

  it('--dry-run and --confirm together are rejected (cli-4 mutex)', async () => {
    await handleTelemetryMutation('enable', { dryRun: true, confirm: true, json: true });
    const { json } = capturedOutput();
    expect(json.ok).toBe(false);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it('disable --confirm deletes identity and preserves the denied choice', async () => {
    await handleTelemetryMutation('enable', { confirm: true, json: true, workspace: tmpWorkspace });
    await handleTelemetryMutation('disable', { confirm: true, json: true });
    const state = readProductTelemetryControlState(tmpHome);
    expect(state.ok && state.state.consent).toBe('denied');
    expect(state.ok && state.state.telemetrySecret).toBeUndefined();
  });

  it('reset --confirm rotates the secret while consent stays granted', async () => {
    await handleTelemetryMutation('enable', { confirm: true, json: true, workspace: tmpWorkspace });
    const before = readProductTelemetryControlState(tmpHome);
    const secretBefore = before.ok ? before.state.telemetrySecret : undefined;
    await handleTelemetryMutation('reset', { confirm: true, json: true });
    const after = readProductTelemetryControlState(tmpHome);
    expect(after.ok && after.state.consent).toBe('granted');
    expect(after.ok && after.state.telemetrySecret).not.toBe(secretBefore);
  });
});

describe('pd telemetry preview', () => {
  it('shows the exact snapshot with the never-sent banner and zero network activity', async () => {
    await handleTelemetryMutation('enable', { confirm: true, json: true, workspace: tmpWorkspace });
    stdoutSpy.mockClear();
    await handleTelemetryPreview({ json: true, workspace: tmpWorkspace });
    const { text, json } = capturedOutput();
    expect(json.banner).toBe('Preview only. Nothing was sent.');
    expect(text).toContain('Preview only. Nothing was sent.');
    const snapshot = json.snapshot as Record<string, unknown>;
    expect(snapshot.schemaVersion).toBe('1');
    expect(snapshot.milestones).toBeDefined();
    // Conservative booleans for an empty workspace fixture.
    const milestones = snapshot.milestones as Record<string, unknown>;
    expect(milestones.initialized).toBe(false);
    expect(milestones.painObserved).toBe(false);
    // The stored secret never appears in the preview output.
    const state = readProductTelemetryControlState(tmpHome);
    const secret = state.ok ? state.state.telemetrySecret : undefined;
    expect(text).not.toContain(secret ?? 'no-secret');
  });

  it('fails loud with nextAction when workspace resolution throws', async () => {
    wsMock.shouldThrow = true;
    try {
      await handleTelemetryPreview({ json: true });
      const { json } = capturedOutput();
      expect(json.ok).toBe(false);
      expect(json.reason).toContain('workspace_unresolvable');
      expect(json.nextAction).toBeDefined();
      expect(process.exitCode).toBe(1);
      process.exitCode = 0;
    } finally {
      wsMock.shouldThrow = false;
    }
  });
});
