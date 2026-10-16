import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { planSharedRuntimeUninstall } from '../src/uninstaller.js';
import { getInstallManifestPath } from '../src/mvp-config.js';

let tempHome: string;
let savedHome: string | undefined;

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-uninstall-plan-'));
  savedHome = process.env.HOME;
  process.env.HOME = tempHome;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  fs.rmSync(tempHome, { recursive: true, force: true });
});

function writeManifest(hosts: string[]): void {
  const manifest = getInstallManifestPath();
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(manifest, JSON.stringify({ layoutVersion: 1, mode: 'canonical', hosts }));
}

describe('planSharedRuntimeUninstall', () => {
  it('preserves shared runtime when the other host remains installed', () => {
    writeManifest(['codex', 'openclaw']);
    expect(planSharedRuntimeUninstall('codex')).toMatchObject({
      removeSharedRuntime: false,
      remainingHosts: ['openclaw'],
      manifestHasTarget: true,
    });
  });

  it('removes shared runtime after the final host is uninstalled', () => {
    writeManifest(['codex']);
    expect(planSharedRuntimeUninstall('codex')).toMatchObject({
      removeSharedRuntime: true,
      remainingHosts: [],
      manifestHasTarget: true,
    });
  });

  // Forward compatibility (2026-10-16): an unknown host registration is a
  // warning, not a malformed manifest. Uninstalling a KNOWN host must carry
  // the unknown registration forward, and the shared runtime is only removed
  // when NO registration (known or unknown) remains.
  it('carries unknown host registrations forward when uninstalling a known host', () => {
    writeManifest(['codex', 'unknown']);
    expect(planSharedRuntimeUninstall('codex')).toMatchObject({
      removeSharedRuntime: false,
      remainingHosts: ['unknown'],
      manifestHasTarget: true,
    });
  });

  it('keeps the shared runtime while only an unknown host registration remains', () => {
    writeManifest(['codex', 'unknown']);
    const plan = planSharedRuntimeUninstall('codex');
    expect(plan.removeSharedRuntime).toBe(false);
    expect(plan.remainingHosts).toEqual(['unknown']);
  });

  it('fails observable and preserves runtime when the manifest is structurally broken', () => {
    writeManifest(['codex']);
    const manifest = getInstallManifestPath();
    fs.writeFileSync(manifest, JSON.stringify({ layoutVersion: 2, mode: 'canonical', hosts: ['codex'] }));
    const plan = planSharedRuntimeUninstall('codex');
    expect(plan.removeSharedRuntime).toBe(false);
    expect(plan.warning).toContain('install_manifest_unsupported_version');
  });
});
