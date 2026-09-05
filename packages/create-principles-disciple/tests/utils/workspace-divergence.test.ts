import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { detectOpenClawMainWorkspaceDivergence } from '../../src/utils/workspace-divergence.js';

let configDir: string;
let configPath: string;

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-divergence-test-'));
  configPath = path.join(configDir, 'openclaw.json');
});

afterEach(() => {
  fs.rmSync(configDir, { recursive: true, force: true });
});

function writeConfig(cfg: unknown): void {
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf-8');
}

// Platform-neutral workspace literals (Windows drive letters are not
// portable across CI runners — path.resolve mangles them on POSIX).
const customRoot = path.join(os.tmpdir(), 'custom-ws');
const otherRoot = path.join(os.tmpdir(), 'other-ws');

describe('detectOpenClawMainWorkspaceDivergence (PRI-686 Fix C)', () => {
  it('flags the split case: unpinned main under custom defaults.workspace root', () => {
    // The live 2026-09-05 incident shape: defaults.workspace = custom root,
    // entries.main = {} → OpenClaw resolves <root>/main, PD pins <root>.
    writeConfig({
      agents: {
        defaults: { workspace: customRoot },
        entries: { main: {} },
      },
    });
    const finding = detectOpenClawMainWorkspaceDivergence(customRoot, configPath);
    expect(finding.divergent).toBe(true);
    expect(finding.openclawMainWorkspace).toBe(path.join(customRoot, 'main'));
    expect(finding.nextAction).toContain('agents.entries.main');
  });

  it('reports no divergence when main is pinned to the PD canonical workspace', () => {
    writeConfig({
      agents: {
        defaults: { workspace: customRoot },
        entries: {
          main: { workspace: customRoot },
          dreamer: { workspace: customRoot },
        },
      },
    });
    const finding = detectOpenClawMainWorkspaceDivergence(customRoot, configPath);
    expect(finding.divergent).toBe(false);
  });

  it('reports divergence when main is pinned to a different workspace than PD canonical', () => {
    writeConfig({
      agents: {
        entries: { main: { workspace: otherRoot } },
      },
    });
    const finding = detectOpenClawMainWorkspaceDivergence(customRoot, configPath);
    expect(finding.divergent).toBe(true);
    expect(finding.openclawMainWorkspace).toBe(path.resolve(otherRoot));
  });

  it('reports no divergence when openclaw.json is missing (default layout)', () => {
    const finding = detectOpenClawMainWorkspaceDivergence(customRoot, path.join(configDir, 'nonexistent.json'));
    expect(finding.divergent).toBe(false);
    expect(finding.openclawMainWorkspace).toBeNull();
  });

  it('reports no divergence when agents.defaults.workspace is absent', () => {
    writeConfig({
      agents: {
        entries: { main: {} },
      },
    });
    const finding = detectOpenClawMainWorkspaceDivergence(customRoot, configPath);
    expect(finding.divergent).toBe(false);
  });

  it('reports no divergence when agents section is not an object', () => {
    writeConfig({ agents: 'nonsense' });
    const finding = detectOpenClawMainWorkspaceDivergence(customRoot, configPath);
    expect(finding.divergent).toBe(false);
  });
});
