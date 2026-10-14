/**
 * PRI-957 — `pd config doctor` must not claim a declaration nobody made.
 *
 * The doctor prints the discovered workspace baseline next to the resolved one.
 * Only the cwd candidate may resolve to a bare directory (no `workspace.default`
 * anywhere in that config), and printing `workspace.default: <dir>` for it
 * would tell the operator to go edit a field that does not exist, hiding the
 * fact that the whole baseline came from "I am standing here".
 *
 * Discovery is the one input stubbed here (it reads the developer's real
 * home/workspace); everything else runs through the production handler.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const { discoveryRef } = vi.hoisted(() => ({
  discoveryRef: {
    value: null as
      | null
      | import('../../src/services/pd-config-loader.js').WorkspaceDiscoveryResult,
  },
}));

vi.mock('../../src/services/pd-config-loader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/pd-config-loader.js')>();
  return { ...actual, discoverWorkspaceDefault: () => discoveryRef.value };
});

import { handleConfigDoctor } from '../../src/commands/config-doctor.js';

let tmp: string;
let stdoutSpy: ReturnType<typeof vi.spyOn>;

function printed(): string {
  return stdoutSpy.mock.calls.map((args) => args.map(String).join(' ')).join('\n');
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pd-doctor-957-')));
  stdoutSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  stdoutSpy.mockRestore();
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe('config doctor — discovery label (PRI-957)', () => {
  it('labels a declared default as workspace.default', async () => {
    discoveryRef.value = {
      kind: 'resolved',
      workspaceDefault: tmp,
      configPath: path.join(tmp, '.pd', 'config.yaml'),
      source: 'cwd',
      declared: true,
    };

    await handleConfigDoctor({ workspace: tmp });

    expect(printed()).toContain(`workspace.default: ${tmp} (source: cwd)`);
    expect(printed()).toContain('✓ resolved path matches workspace.default');
  });

  it('labels a bare cwd hit as discovered, never as a declaration', async () => {
    discoveryRef.value = {
      kind: 'resolved',
      workspaceDefault: tmp,
      configPath: path.join(tmp, '.pd', 'config.yaml'),
      source: 'cwd',
      declared: false,
    };

    await handleConfigDoctor({ workspace: tmp });

    expect(printed()).toContain(
      `workspace (discovered, no workspace.default declared): ${tmp} (source: cwd)`,
    );
    expect(printed()).toContain('✓ resolved path matches the discovered workspace directory');
    expect(printed()).not.toContain(`workspace.default: ${tmp}`);
  });

  // PRI-957 review round 3 P1: an unparseable config means the declaration is
  // UNKNOWN. Labelling it "discovered, no workspace.default declared" would assert
  // a fact no readable config supports and hide that resolution now fails closed.
  it('labels an unparseable config as unknown, not as an absent declaration', async () => {
    const configPath = path.join(tmp, '.pd', 'config.yaml');
    discoveryRef.value = {
      kind: 'unparseable',
      configPath,
      source: 'cwd',
      reason: 'bad indentation at line 2',
    };

    await handleConfigDoctor({ workspace: tmp });

    const text = printed();
    expect(text).toContain(`workspace config UNPARSEABLE: ${configPath} (source: cwd)`);
    expect(text).toContain('bad indentation at line 2');
    expect(text).toContain('fail closed');
    expect(text).not.toContain('no workspace.default declared');
  });
});
