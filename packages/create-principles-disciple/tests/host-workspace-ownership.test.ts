import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { findForeignWorkspaceHost, findForeignWorkspaceOwner, resolveCodexPluginDataRoot } from '@principles/install-layout';
import { resolvePluginDataRoot } from '../src/installers/codex-host-installer.js';
import { findForeignWorkspaceHostFallback, findForeignWorkspaceOwnerFallback } from '../src/utils/host-workspace-ownership.js';

/**
 * The installer cannot statically import a not-yet-published install-layout
 * export without crashing `npx` installs against the current registry version
 * (PRI-669 shape). The fallback is therefore a real production path until the
 * release train publishes the shared rule; this test keeps both byte-equivalent
 * in behavior.
 */
describe('host workspace ownership — fallback parity with install-layout', () => {
  const home = path.resolve('/home/owner');
  const codexHome = path.join(home, 'custom-codex');
  const paths = [
    path.join(home, 'clawd'),
    path.join(home, 'clawd', 'project'),
    path.join(home, '.openclaw', 'workspace'),
    path.join(home, '.openclaw', 'workspace', 'project'),
    path.join(home, '.codex', 'pd-workspace'),
    path.join(codexHome, 'pd-workspace'),
    path.join(home, '.workbuddy', 'pd-workspace'),
    path.join(home, 'custom-openclaw', 'workspace'),
    path.join(home, 'custom-workbuddy', 'pd-workspace'),
    path.join(home, 'projects', 'app'),
    '',
  ];

  for (const platform of ['posix', 'win32'] as const) {
    for (const host of ['openclaw', 'codex', 'workbuddy'] as const) {
      for (const workspaceDir of paths) {
        it(`${platform} ${host} -> ${workspaceDir || '<empty>'}`, () => {
          const options = {
            homeDir: home,
            codexHome,
            openclawHome: path.join(home, 'custom-openclaw'),
            workbuddyConfigDir: path.join(home, 'custom-workbuddy'),
            platform,
          };
          expect(findForeignWorkspaceHostFallback(host, workspaceDir, options))
            .toBe(findForeignWorkspaceHost(host, workspaceDir, options));
        });
      }
    }
  }
});

/**
 * Review 2026-11-18: declaration-aware ownership must read declarations from
 * the ACTUAL OpenClaw root (custom openclawHome), not a fixed `<home>/.openclaw`
 * — the launcher resolves the same actual root, so reading only the default
 * lets the installer write bindings the launcher then refuses. Real temp fs,
 * both implementations (shared + fallback) must agree.
 */
describe('declaration-aware ownership under a custom openclawHome — fallback parity with install-layout', () => {
  const temps: string[] = [];
  afterEach(() => {
    for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function makeHome(): string {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-owner-openclawhome-'));
    temps.push(home);
    return home;
  }

  it('a declaration under the CUSTOM openclawHome is honored by BOTH implementations', () => {
    const home = makeHome();
    const openclawHome = path.join(home, 'custom-openclaw');
    const declared = path.join(home, 'governance');
    fs.mkdirSync(declared, { recursive: true });
    fs.mkdirSync(openclawHome, { recursive: true });
    fs.writeFileSync(
      path.join(openclawHome, 'principles-disciple.json'),
      JSON.stringify({ workspace: declared }),
    );
    const options = { homeDir: home, openclawHome, platform: process.platform };
    expect(findForeignWorkspaceOwnerFallback('codex', declared, options).owners).toEqual(['openclaw']);
    expect(findForeignWorkspaceOwner('codex', declared, options).owners).toEqual(['openclaw']);
  });

  it('a declaration under the DEFAULT root is not consulted when openclawHome points elsewhere — the launcher reads only the actual root', () => {
    const home = makeHome();
    const openclawHome = path.join(home, 'custom-openclaw');
    const declared = path.join(home, 'governance');
    fs.mkdirSync(declared, { recursive: true });
    fs.mkdirSync(openclawHome, { recursive: true });
    fs.mkdirSync(path.join(home, '.openclaw'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.openclaw', 'principles-disciple.json'),
      JSON.stringify({ workspace: declared }),
    );
    const options = { homeDir: home, openclawHome, platform: process.platform };
    expect(findForeignWorkspaceOwnerFallback('codex', declared, options).owners).toEqual([]);
    expect(findForeignWorkspaceOwner('codex', declared, options).owners).toEqual([]);
  });
});

describe('Codex plugin data root — installer parity with install-layout', () => {
  const temps: string[] = [];
  afterEach(() => {
    for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function makeHome(dataDirs: readonly string[]): string {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-data-root-parity-'));
    temps.push(home);
    for (const name of dataDirs) fs.mkdirSync(path.join(home, 'plugins', 'data', name), { recursive: true });
    return home;
  }

  it('agrees with the shared resolver for zero, one and multiple data dirs', () => {
    for (const dataDirs of [[], ['principles-disciple-principles'], ['principles-disciple-a', 'principles-disciple-b']]) {
      const home = makeHome(dataDirs);
      for (const marketplace of ['principles', 'other']) {
        expect(resolvePluginDataRoot(home, marketplace))
          .toBe(resolveCodexPluginDataRoot(home, marketplace));
      }
    }
  });
});
