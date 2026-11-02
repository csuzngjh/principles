import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  collectReleaseManagerPayload,
  RELEASE_MANAGER_ENTRY_MODULES,
  RELEASE_MANAGER_KNOWN_ORPHANS,
} from '../scripts/release-manager-payload.mjs';

/**
 * G2 payload trim guard (artifact-size-audit D8/P6): the release-manager
 * component ships ONLY the runtime update-seam closure. The bundle step and
 * this test share one definition (scripts/release-manager-payload.mjs), so
 * the contract cannot drift between "what the audit proved" and "what ships".
 */
describe('release-manager payload closure (G2 trim)', () => {
  const pkgRoot = path.resolve(__dirname, '..');

  const closure = (): string[] => collectReleaseManagerPayload(pkgRoot);

  it('requires the compiled dist to exist (build is a test prerequisite)', () => {
    for (const rel of RELEASE_MANAGER_ENTRY_MODULES) {
      const abs = path.join(pkgRoot, rel);
      expect(
        fs.existsSync(abs),
        `${rel} missing — run npm run build --workspace=create-principles-disciple`,
      ).toBe(true);
    }
  });

  it('carries every runtime-critical module of the update seam', () => {
    const modules = new Set(closure());
    // Console seam entries + deployed bootstrap executor entry.
    for (const rel of RELEASE_MANAGER_ENTRY_MODULES) {
      expect(modules.has(rel), `entry ${rel} must ship`).toBe(true);
    }
    // The update transaction core and the authority/journal contracts.
    for (const rel of [
      'dist/update/release-manager.js',
      'dist/update/release-manager-authority.js',
      'dist/update/console-surface.js',
      'dist/update/apply-payload.js',
      'dist/update/transaction-journal.js',
      'dist/update/bootstrap-executor.js',
      'dist/update/bootstrap-protocol.js',
      'dist/update/trust-metadata.js',
      'dist/update/trust-root-provisioning.js',
    ]) {
      expect(modules.has(rel), `${rel} must ship`).toBe(true);
    }
    // CRITICAL constraint: release-manager.js/apply-payload.js dynamically
    // import('../installer.js') to run the install transaction — installer.js
    // and its whole static closure must never be dropped from the payload.
    for (const rel of [
      'dist/installer.js',
      'dist/installers/index.js',
      'dist/installers/workbuddy-host-installer.js',
      'dist/installers/codex-host-installer.js',
      'dist/installers/openclaw-host-installer.js',
      'dist/mvp-config.js',
      'dist/i18n.js',
    ]) {
      expect(modules.has(rel), `${rel} must ship (installer.js closure)`).toBe(true);
    }
  });

  it('excludes every CLI-only / test-only / tooling-only module', () => {
    const modules = new Set(closure());
    for (const orphan of RELEASE_MANAGER_KNOWN_ORPHANS) {
      expect(modules.has(orphan), `${orphan} is CLI/test/tooling-only and must not ship`).toBe(false);
    }
    // The closure is JS-only: compile-time artifacts of the trimmed component.
    for (const rel of modules) {
      expect(rel.endsWith('.js'), `closure must contain only runtime JS, got ${rel}`).toBe(true);
    }
  });

  it('tracks new runtime imports automatically (closure recomputes from dist)', () => {
    // Auto-tracking proof on a throwaway copy of dist: a NEW relative import
    // extends the closure without any list edit. This is what keeps the trim
    // safe when someone later adds a runtime import to the update seam.
    const labRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pd-rm-closure-'));
    try {
      fs.cpSync(path.join(pkgRoot, 'dist'), path.join(labRoot, 'dist'), { recursive: true });
      const extra = path.join(labRoot, 'dist', 'update', 'probe-extra-module.js');
      fs.writeFileSync(extra, 'export const probe = 1;\n', 'utf-8');
      const seam = path.join(labRoot, 'dist', 'update', 'release-manager.js');
      const source = fs.readFileSync(seam, 'utf-8');
      fs.writeFileSync(seam, `import { probe } from './probe-extra-module.js';\n${source}`, 'utf-8');

      const grown = collectReleaseManagerPayload(labRoot);
      expect(grown.includes('dist/update/probe-extra-module.js')).toBe(true);
    } finally {
      fs.rmSync(labRoot, { recursive: true, force: true });
    }
  });

  it('fails loud when a trimmed module gains a runtime consumer', () => {
    // If someone wires an orphan (here: rollback-policy) into the runtime
    // graph, the collector must refuse — resurrecting it is a deliberate
    // audit decision, never a silent list drift.
    const labRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pd-rm-orphan-'));
    try {
      fs.cpSync(path.join(pkgRoot, 'dist'), path.join(labRoot, 'dist'), { recursive: true });
      const seam = path.join(labRoot, 'dist', 'update', 'release-manager.js');
      const source = fs.readFileSync(seam, 'utf-8');
      fs.writeFileSync(seam, `import './rollback-policy.js';\n${source}`, 'utf-8');

      expect(() => collectReleaseManagerPayload(labRoot)).toThrow(/rollback-policy/);
    } finally {
      fs.rmSync(labRoot, { recursive: true, force: true });
    }
  });

  it('bundled payload (when materialized) ships exactly the closure', () => {
    // The in-package payload dir exists after `npm run bundle` (prepack does
    // this before publish/CI smokes). Fast unit runs without a bundle skip —
    // the bundle-time verification block and the packaged/asset smokes cover
    // that environment.
    const payloadDir = path.join(pkgRoot, 'release-manager');
    if (!fs.existsSync(path.join(payloadDir, 'dist'))) {
      return;
    }
    const expected = closure();
    const shipped: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(abs);
        } else {
          shipped.push(path.relative(payloadDir, abs).split(path.sep).join('/'));
        }
      }
    };
    walk(path.join(payloadDir, 'dist'));
    expect(shipped.sort()).toEqual([...expected].sort());
    expect(fs.existsSync(path.join(payloadDir, 'package.json'))).toBe(true);
  });
});
