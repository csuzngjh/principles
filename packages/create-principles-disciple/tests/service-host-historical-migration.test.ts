import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mergeManifestProvisioningTargets,
  mergePendingProvisioningTargets,
  openClawMigrationRequiresGatewayCheck,
  shouldProvisionOnInstall,
} from '../src/installer.js';

const homes: string[] = [];
let home: string;
let previousHome: string | undefined;
let previousUserProfile: string | undefined;

function useIsolatedHome(): string {
  home = mkdtempSync(path.join(os.tmpdir(), 'pd-historical-migration-'));
  homes.push(home);
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.OPENCLAW_STATE_DIR;
  delete process.env.OPENCLAW_HOME;
  delete process.env.PD_HOME;
  return home;
}

function seedManifestAndOpenClawBinding(workspaceDir: string): void {
  const pdHome = path.join(home, '.pd');
  mkdirSync(pdHome, { recursive: true });
  writeFileSync(path.join(pdHome, 'install.json'), JSON.stringify({
    layoutVersion: 1,
    mode: 'canonical',
    hosts: [],
    workspaces: [workspaceDir],
  }), 'utf8');
  const openclawHome = path.join(home, '.openclaw');
  mkdirSync(openclawHome, { recursive: true });
  writeFileSync(path.join(openclawHome, 'principles-disciple.json'), JSON.stringify({ workspace: workspaceDir }), 'utf8');
}

beforeEach(() => {
  previousHome = process.env.HOME;
  previousUserProfile = process.env.USERPROFILE;
  useIsolatedHome();
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
  if (previousUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousUserProfile;
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('historical workspace migration eligibility', () => {
  it('explicit enable + verified scheduler + authoritative manifest registration is enough without a pending marker', () => {
    expect(shouldProvisionOnInstall({
      freshInstall: false,
      consentIntent: 'enable',
      consentSource: 'explicit_flag',
      schedulerState: 'enabled',
      workspaceRegistered: true,
    })).toBe(true);
  });

  it('unauthorized, unverified-scheduler, and unregistered workspaces remain ineligible', () => {
    const base = {
      freshInstall: false,
      consentIntent: 'enable',
      consentSource: 'explicit_flag',
      schedulerState: 'enabled',
      workspaceRegistered: true,
    };
    expect(shouldProvisionOnInstall({ ...base, consentIntent: 'refresh_if_registered' })).toBe(false);
    expect(shouldProvisionOnInstall({ ...base, consentSource: 'recommended_default' })).toBe(false);
    expect(shouldProvisionOnInstall({ ...base, schedulerState: 'registered_disabled' })).toBe(false);
    expect(shouldProvisionOnInstall({ ...base, workspaceRegistered: false })).toBe(false);
  });

  it('manifest targets are additive, canonical-deduplicated, and host-neutral until binding verification', () => {
    const existing = [{ host: 'codex' as const, workspaceDir: path.resolve('one') }];
    const merged = mergeManifestProvisioningTargets(existing, [path.resolve('one'), path.resolve('two')]);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toEqual(existing[0]);
    expect(merged[1]).toMatchObject({ host: 'none', workspaceDir: path.resolve('two') });
    expect(mergePendingProvisioningTargets(merged, [{
      workspaceDir: path.resolve('two'), host: 'openclaw', recordedAt: new Date().toISOString(),
    }])).toHaveLength(2);
  });
});

describe('OpenClaw migration gateway preflight authority', () => {
  it('requires the gateway check for an explicit hostless migration whose manifest workspace is OpenClaw-bound', () => {
    const workspaceDir = path.join(home, 'workspace with spaces');
    mkdirSync(workspaceDir, { recursive: true });
    seedManifestAndOpenClawBinding(workspaceDir);
    expect(openClawMigrationRequiresGatewayCheck({
      host: 'none',
      workspaceDir: path.join(home, 'elsewhere'),
      serviceHost: { intent: 'enable', source: 'explicit_flag' },
    })).toBe(true);
  });

  it('does not widen the check without explicit migration authorization or for a non-migration target', () => {
    const workspaceDir = path.join(home, 'workspace');
    mkdirSync(workspaceDir, { recursive: true });
    seedManifestAndOpenClawBinding(workspaceDir);
    expect(openClawMigrationRequiresGatewayCheck({ host: 'none', workspaceDir })).toBe(false);
    expect(openClawMigrationRequiresGatewayCheck({
      host: 'none',
      workspaceDir,
      serviceHost: { intent: 'refresh_if_registered', source: 'policy' },
    })).toBe(false);
  });
});
