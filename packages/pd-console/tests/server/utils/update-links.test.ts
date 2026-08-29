import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { collectFileDepLinkSpecs } from '../../../src/server/utils/update-links.js';

/**
 * Unit tests for the data-driven link derivation: whatever a deployed
 * component declares as `file:` dependencies becomes the link spec list —
 * this is what makes the updater immune to the generation gap (a hardcoded
 * list goes stale when a release adds a new internal dependency).
 */

const readDepsFromDisk = (componentDir: string): Record<string, string> => {
  try {
    const pkg: unknown = JSON.parse(fs.readFileSync(path.join(componentDir, 'package.json'), 'utf8'));
    if (typeof pkg !== 'object' || pkg === null) return {};
    const deps = (pkg as Record<string, unknown>).dependencies;
    if (typeof deps !== 'object' || deps === null) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(deps as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
};

describe('collectFileDepLinkSpecs', () => {
  it('derives link specs from declared file: dependencies whose target exists', () => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pd-links-'));
    const consoleDir = path.join(root, 'console');
    const coreDir = path.join(root, 'core');
    fs.mkdirSync(path.join(consoleDir, 'dist'), { recursive: true });
    fs.mkdirSync(coreDir, { recursive: true });
    fs.writeFileSync(
      path.join(consoleDir, 'package.json'),
      JSON.stringify({ name: '@principles/console', dependencies: { '@principles/core': 'file:../core', better: 'sqlite3' } }),
    );
    const specs = collectFileDepLinkSpecs([consoleDir], readDepsFromDisk, (dir) => fs.existsSync(dir));
    expect(specs).toEqual([
      { linkPath: path.join(consoleDir, 'node_modules', '@principles/core'), target: path.resolve(consoleDir, '../core') },
    ]);
  });

  it('skips file: dependencies whose target directory is not deployed', () => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pd-links-'));
    const consoleDir = path.join(root, 'console');
    fs.mkdirSync(consoleDir, { recursive: true });
    // codex-adapter is a separate host install — NOT part of this layout.
    fs.writeFileSync(
      path.join(consoleDir, 'package.json'),
      JSON.stringify({ dependencies: { '@principles/codex-adapter': 'file:../codex-adapter' } }),
    );
    const specs = collectFileDepLinkSpecs([consoleDir], readDepsFromDisk, (dir) => fs.existsSync(dir));
    expect(specs).toEqual([]);
  });

  it('deduplicates when multiple components declare the same dependency', () => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pd-links-'));
    const consoleDir = path.join(root, 'console');
    const pdCliDir = path.join(root, 'pd-cli');
    const installDir = path.join(root, 'install-layout');
    fs.mkdirSync(consoleDir, { recursive: true });
    fs.mkdirSync(pdCliDir, { recursive: true });
    fs.mkdirSync(installDir, { recursive: true });
    for (const dir of [consoleDir, pdCliDir]) {
      fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ dependencies: { '@principles/install-layout': 'file:../install-layout' } }),
      );
    }
    const specs = collectFileDepLinkSpecs([consoleDir, pdCliDir, installDir], readDepsFromDisk, (dir) => fs.existsSync(dir));
    expect(specs).toHaveLength(2);
    expect(specs[0]?.linkPath).toBe(path.join(consoleDir, 'node_modules', '@principles', 'install-layout'));
    expect(specs[1]?.linkPath).toBe(path.join(pdCliDir, 'node_modules', '@principles', 'install-layout'));
  });

  it('returns no specs for unreadable manifests or components without file: deps', () => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pd-links-'));
    const broken = path.join(root, 'broken');
    const clean = path.join(root, 'clean');
    fs.mkdirSync(broken, { recursive: true });
    fs.writeFileSync(path.join(broken, 'package.json'), 'not-json{');
    fs.mkdirSync(clean, { recursive: true });
    fs.writeFileSync(path.join(clean, 'package.json'), JSON.stringify({ dependencies: { express: '^4.0.0' } }));
    expect(collectFileDepLinkSpecs([broken, clean], readDepsFromDisk, () => true)).toEqual([]);
  });

  it('collapses parent-directory traversal before checking the target', () => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pd-links-'));
    const consoleDir = path.join(root, 'console');
    fs.mkdirSync(consoleDir, { recursive: true });
    fs.writeFileSync(
      path.join(consoleDir, 'package.json'),
      JSON.stringify({ dependencies: { '@principles/core': 'file:../core' } }),
    );
    fs.mkdirSync(path.join(root, 'core'), { recursive: true });
    const specs = collectFileDepLinkSpecs([consoleDir], readDepsFromDisk, (dir) => fs.existsSync(dir));
    expect(specs).toHaveLength(1);
    // path.resolve collapses ../ — the spec target is the canonical dir.
    expect(specs[0]?.target).toBe(path.resolve(consoleDir, '../core'));
  });
});
