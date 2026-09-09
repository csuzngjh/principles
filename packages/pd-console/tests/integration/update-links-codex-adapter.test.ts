/**
 * PRI-711 — the full-update pipeline's data-driven link derivation must cover
 * the codex-adapter component.
 *
 * collectFileDepLinkSpecs used to skip the adapter entirely (documented as
 * "a separate host install, not part of this layout" — a stale assumption
 * since the installer bundled it into the runtime layout and pd-cli's eager
 * import graph began resolving it). The 1.231.2 update therefore never
 * derived codex-adapter/node_modules/@principles/{core,host-runtime} links
 * and every pd command crashed at startup. These tests pin the staged→
 * deployed derivation pairs the update route now declares.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { collectFileDepLinkSpecs, type StagedComponent } from '../../src/server/utils/update-links.js';

function writeStagedManifest(stagedRoot: string, component: string, dependencies: Record<string, string>): string {
  const dir = path.join(stagedRoot, component);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: component, version: '0.0.0-test', ...(Object.keys(dependencies).length > 0 ? { dependencies } : {}) }),
  );
  return dir;
}

function deployedLayout(fixedRoot: string): Record<string, string> {
  return {
    'pd-cli': path.join(fixedRoot, 'runtime', 'pd-cli'),
    'codex-adapter': path.join(fixedRoot, 'runtime', 'codex-adapter'),
    core: path.join(fixedRoot, 'runtime', 'core'),
    'host-runtime': path.join(fixedRoot, 'runtime', 'host-runtime'),
  };
}

function readDeps(manifestDir: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(manifestDir, 'package.json'), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return {};
    const deps = (parsed as { dependencies?: unknown }).dependencies;
    if (typeof deps !== 'object' || deps === null) return {};
    const out: Record<string, string> = {};
    for (const [name, ref] of Object.entries(deps as Record<string, unknown>)) {
      if (typeof ref === 'string') out[name] = ref;
    }
    return out;
  } catch {
    return {};
  }
}

describe('collectFileDepLinkSpecs — codex-adapter derivation (PRI-711)', () => {
  it('derives adapter dep links and the pd-cli→adapter link when the adapter is staged', () => {
    const stagedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-link-specs-staged-'));
    const fixedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-link-specs-deployed-'));
    try {
      const layout = deployedLayout(fixedRoot);
      writeStagedManifest(stagedRoot, 'pd-cli', { '@principles/codex-adapter': 'file:../codex-adapter' });
      writeStagedManifest(stagedRoot, 'codex-adapter', {
        '@principles/core': 'file:../core',
        '@principles/host-runtime': 'file:../host-runtime',
      });
      writeStagedManifest(stagedRoot, 'core', {});
      writeStagedManifest(stagedRoot, 'host-runtime', {});

      const stagedComponents: StagedComponent[] = [
        { manifestDir: path.join(stagedRoot, 'pd-cli'), deployedDir: layout['pd-cli'] },
        { manifestDir: path.join(stagedRoot, 'codex-adapter'), deployedDir: layout['codex-adapter'] },
        { manifestDir: path.join(stagedRoot, 'core'), deployedDir: layout['core'] },
        { manifestDir: path.join(stagedRoot, 'host-runtime'), deployedDir: layout['host-runtime'] },
      ];

      const specs = collectFileDepLinkSpecs(stagedComponents, readDeps);
      const byLinkPath = new Map(specs.map((spec) => [spec.linkPath, spec.target]));

      expect(byLinkPath.get(path.join(layout['pd-cli'], 'node_modules', '@principles', 'codex-adapter'))).toBe(
        layout['codex-adapter'],
      );
      expect(byLinkPath.get(path.join(layout['codex-adapter'], 'node_modules', '@principles', 'core'))).toBe(
        layout['core'],
      );
      expect(byLinkPath.get(path.join(layout['codex-adapter'], 'node_modules', '@principles', 'host-runtime'))).toBe(
        layout['host-runtime'],
      );
    } finally {
      fs.rmSync(stagedRoot, { recursive: true, force: true });
      fs.rmSync(fixedRoot, { recursive: true, force: true });
    }
  });

  it('derives nothing for the adapter when it is NOT in the staged pairing (the old hole, pinned)', () => {
    const stagedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-link-specs-staged-'));
    const fixedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-link-specs-deployed-'));
    try {
      const layout = deployedLayout(fixedRoot);
      writeStagedManifest(stagedRoot, 'pd-cli', { '@principles/codex-adapter': 'file:../codex-adapter' });
      writeStagedManifest(stagedRoot, 'codex-adapter', { '@principles/core': 'file:../core' });
      writeStagedManifest(stagedRoot, 'core', {});

      // Staged pairing without codex-adapter — the pre-PRI-711 declaration.
      const stagedComponents: StagedComponent[] = [
        { manifestDir: path.join(stagedRoot, 'pd-cli'), deployedDir: layout['pd-cli'] },
        { manifestDir: path.join(stagedRoot, 'core'), deployedDir: layout['core'] },
      ];

      const specs = collectFileDepLinkSpecs(stagedComponents, readDeps);

      expect(specs).toEqual([]);
    } finally {
      fs.rmSync(stagedRoot, { recursive: true, force: true });
      fs.rmSync(fixedRoot, { recursive: true, force: true });
    }
  });
});
