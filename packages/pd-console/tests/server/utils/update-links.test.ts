import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { collectFileDepLinkSpecs } from '../../../src/server/utils/update-links.js';

/**
 * Unit tests for the staged-manifest link derivation: whatever the freshly
 * extracted components declare as `file:` dependencies becomes the link
 * spec list, with targets mapped to the deployed layout dirs by basename.
 * Reading the DEPLOYED manifests instead is the generation-gap bug this
 * exists to prevent.
 */

const readDepsFromDisk = (manifestDir: string): Record<string, string> => {
  try {
    const pkg: unknown = JSON.parse(fs.readFileSync(path.join(manifestDir, 'package.json'), 'utf8'));
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
  it('maps staged file: refs to the deployed layout dir of the target basename', () => {
    const staged = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pd-links-'));
    const consoleStaged = path.join(staged, 'console');
    const coreStaged = path.join(staged, 'core');
    const deployedConsole = path.join(staged, 'deployed', 'console');
    const deployedCore = path.join(staged, 'deployed', 'core');
    fs.mkdirSync(consoleStaged, { recursive: true });
    fs.mkdirSync(coreStaged, { recursive: true });
    fs.mkdirSync(deployedConsole, { recursive: true });
    fs.mkdirSync(deployedCore, { recursive: true });
    fs.writeFileSync(
      path.join(consoleStaged, 'package.json'),
      JSON.stringify({ dependencies: { '@principles/core': 'file:../core' } }),
    );
    const specs = collectFileDepLinkSpecs(
      [
        { manifestDir: consoleStaged, deployedDir: deployedConsole },
        { manifestDir: coreStaged, deployedDir: deployedCore },
      ],
      readDepsFromDisk,
    );
    expect(specs).toEqual([
      {
        linkPath: path.join(deployedConsole, 'node_modules', '@principles/core'),
        target: deployedCore,
        stagedTarget: coreStaged,
      },
    ]);
  });

  it('skips deps whose staged target basename has no deployed counterpart', () => {
    const staged = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pd-links-'));
    const consoleStaged = path.join(staged, 'console');
    fs.mkdirSync(consoleStaged, { recursive: true });
    fs.writeFileSync(
      path.join(consoleStaged, 'package.json'),
      JSON.stringify({ dependencies: { '@principles/codex-adapter': 'file:../codex-adapter' } }),
    );
    const deployedConsole = path.join(staged, 'deployed', 'console');
    fs.mkdirSync(deployedConsole, { recursive: true });
    const specs = collectFileDepLinkSpecs(
      [{ manifestDir: consoleStaged, deployedDir: deployedConsole }],
      readDepsFromDisk,
    );
    expect(specs).toEqual([]);
  });

  it('derives one spec per declaring component and dedupes identical link paths', () => {
    const staged = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pd-links-'));
    const consoleStaged = path.join(staged, 'console');
    const pdCliStaged = path.join(staged, 'pd-cli');
    const installStaged = path.join(staged, 'install-layout');
    const deployedConsole = path.join(staged, 'deployed', 'console');
    const deployedPdCli = path.join(staged, 'deployed', 'pd-cli');
    const deployedInstall = path.join(staged, 'deployed', 'install-layout');
    for (const dir of [consoleStaged, pdCliStaged, installStaged, deployedConsole, deployedPdCli, deployedInstall]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    for (const dir of [consoleStaged, pdCliStaged]) {
      fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ dependencies: { '@principles/install-layout': 'file:../install-layout' } }),
      );
    }
    const specs = collectFileDepLinkSpecs(
      [
        { manifestDir: consoleStaged, deployedDir: deployedConsole },
        { manifestDir: pdCliStaged, deployedDir: deployedPdCli },
        { manifestDir: installStaged, deployedDir: deployedInstall },
      ],
      readDepsFromDisk,
    );
    expect(specs).toEqual([
      {
        linkPath: path.join(deployedConsole, 'node_modules', '@principles', 'install-layout'),
        target: deployedInstall,
        stagedTarget: installStaged,
      },
      {
        linkPath: path.join(deployedPdCli, 'node_modules', '@principles', 'install-layout'),
        target: deployedInstall,
        stagedTarget: installStaged,
      },
    ]);
  });

  it('returns no specs for unreadable manifests or non-file dependencies', () => {
    const staged = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pd-links-'));
    const broken = path.join(staged, 'broken');
    const clean = path.join(staged, 'clean');
    const deployed = path.join(staged, 'deployed');
    fs.mkdirSync(broken, { recursive: true });
    fs.writeFileSync(path.join(broken, 'package.json'), 'not-json{');
    fs.mkdirSync(clean, { recursive: true });
    fs.writeFileSync(path.join(clean, 'package.json'), JSON.stringify({ dependencies: { express: '^4.0.0' } }));
    fs.mkdirSync(deployed, { recursive: true });
    expect(
      collectFileDepLinkSpecs(
        [
          { manifestDir: broken, deployedDir: deployed },
          { manifestDir: clean, deployedDir: deployed },
        ],
        readDepsFromDisk,
      ),
    ).toEqual([]);
  });
});
