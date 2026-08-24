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

  it('fails observable and preserves runtime when the manifest is malformed', () => {
    writeManifest(['codex', 'unknown']);
    const plan = planSharedRuntimeUninstall('codex');
    expect(plan.removeSharedRuntime).toBe(false);
    expect(plan.warning).toContain('install_manifest_malformed');
  });
});
