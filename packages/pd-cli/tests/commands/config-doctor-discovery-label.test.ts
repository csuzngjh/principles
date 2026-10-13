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
    value: null as null | {
      workspaceDefault: string;
      configPath: string;
      source: 'cwd' | 'env_var' | 'openclaw_default' | 'openclaw_plugin_config';
      declared: boolean;
    },
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
});
