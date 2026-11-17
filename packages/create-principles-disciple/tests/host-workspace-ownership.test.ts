import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { findForeignWorkspaceHost, resolveCodexPluginDataRoot } from '@principles/install-layout';
import { resolvePluginDataRoot } from '../src/installers/codex-host-installer.js';
import { findForeignWorkspaceHostFallback } from '../src/utils/host-workspace-ownership.js';

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
