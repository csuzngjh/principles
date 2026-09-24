/**
 * PRI-912 (SPEC-P1′-A) — canonical junction reconciliation for the plugin's
 * bundled @principles/core copy.
 *
 * Real-fs tests over reconcilePluginCoreCanonicalJunction(): the installer
 * pass that replaces a materialized <plugin>/node_modules/@principles/core
 * with a junction (Windows) / relative symlink (Unix) to the runtime root
 * core — and ONLY when the strict contract holds (package identity, declared
 * file: relationship resolving to the canonical core, content digest).
 *
 * Coverage map (task §6):
 *   A. digest match → converted → runtime resolution probe through the link
 *   B. digest mismatch → skip, materialized copy preserved
 *   C. idempotency — second run is a no-op (alreadyCanonical)
 *   D. rollback — rmSync over a tree containing the junction (what
 *      restoreBackup does) never touches the canonical target
 *   E. Windows — junction creation + readlink + resolution through it
 * plus the contract-refusal skips (identity / declaration / traversal).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { reconcilePluginCoreCanonicalJunction } from '../src/installer.js';

// Injection seams for the mid-conversion failure tests: the installer imports
// symlinkSync/rmSync from the 'fs' SPECIFIER, so mocking 'fs' (this file's own
// helpers keep using the real 'node:fs') reaches exactly the conversion path.
//   - linkFailure.active   → symlinkSync throws before creating the link
//   - linkFailure.dangling → symlinkSync creates a link to a missing target,
//     so realpathSync fails and the RESTORE path must unlink the dangling link
//   - backupRemoveFailure  → rmSync throws only for *.pri912-materialized
//     backup paths, exercising the "backup cleanup must never fail the install"
//     contract on both the stale-residue and post-conversion removal sites.
const linkFailure = vi.hoisted(() => ({ active: false, dangling: false }));
const backupRemoveFailure = vi.hoisted(() => ({ active: false }));
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    symlinkSync: (target: string, linkPath: string, type?: 'junction' | 'dir' | 'file') => {
      if (linkFailure.active) throw new Error('injected symlink failure');
      if (linkFailure.dangling) {
        // Un-normalized '../' is fine: the link must simply never resolve.
        return actual.symlinkSync(linkPath + '/../pri912-dangling-missing-target', linkPath, type);
      }
      return actual.symlinkSync(target, linkPath, type);
    },
    rmSync: (target: string, options?: fs.RmOptions) => {
      // Realistic failure: EBUSY hits an EXISTING locked tree, not an absent
      // pre-clean — so the post-conversion cleanup site is still reachable.
      if (
        backupRemoveFailure.active
        && typeof target === 'string'
        && target.endsWith('.pri912-materialized')
        && actual.existsSync(target)
      ) {
        throw Object.assign(new Error('injected EBUSY'), { code: 'EBUSY' });
      }
      return actual.rmSync(target, options);
    },
  };
});

let fixtureRoot: string;

function runtimeDir(): string {
  return path.join(fixtureRoot, '.pd', 'runtime');
}

function runtimeCoreDir(): string {
  return path.join(runtimeDir(), 'core');
}

function pluginDirs(): string[] {
  return [
    path.join(runtimeDir(), 'plugin'),
    path.join(fixtureRoot, '.openclaw', 'extensions', 'principles-disciple'),
  ];
}

function coreSlots(): string[] {
  return pluginDirs().map((dir) => path.join(dir, 'node_modules', '@principles', 'core'));
}

function writeRuntimeCore(marker: string): void {
  fs.mkdirSync(path.join(runtimeCoreDir(), 'dist', 'deep'), { recursive: true });
  fs.writeFileSync(
    path.join(runtimeCoreDir(), 'package.json'),
    JSON.stringify({ name: '@principles/core', version: '9.9.9-test', main: './dist/entry.js' }),
  );
  fs.writeFileSync(path.join(runtimeCoreDir(), 'dist', 'entry.js'), `export const marker = '${marker}';\n`);
  fs.writeFileSync(path.join(runtimeCoreDir(), 'dist', 'deep', 'lib.js'), 'export const lib = true;\n');
}

/**
 * Lays out a plugin the way installPluginToStaging + the release payload do:
 * a materialized node_modules copy (the asset builder refuses symlinks) plus
 * the <plugin>/core file-dep slot linked to the canonical runtime core.
 */
function writePluginWithMaterializedCopy(pluginDir: string, options: { copyMarker?: string; declaredRef?: string; linkCoreSlot?: boolean } = {}): void {
  const { copyMarker = 'canonical', declaredRef = 'file:./core', linkCoreSlot = true } = options;
  fs.mkdirSync(path.join(pluginDir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify({
    name: 'principles-disciple',
    version: '9.9.9-test',
    dependencies: { '@principles/core': declaredRef },
  }));
  fs.writeFileSync(path.join(pluginDir, 'dist', 'bundle.js'), 'export const bundle = true;\n');

  const slot = path.join(pluginDir, 'node_modules', '@principles', 'core');
  fs.mkdirSync(slot, { recursive: true });
  fs.cpSync(runtimeCoreDir(), slot, { recursive: true });
  if (copyMarker !== 'canonical') {
    // Mutate AFTER the copy so digests genuinely diverge.
    fs.writeFileSync(path.join(slot, 'dist', 'entry.js'), `export const marker = '${copyMarker}';\n`);
  }

  if (linkCoreSlot) {
    fs.symlinkSync(runtimeCoreDir(), path.join(pluginDir, 'core'), 'junction');
  }
}

function resolveFromPlugin(pluginDir: string, specifier: string): string {
  return createRequire(path.join(pluginDir, 'probe.cjs')).resolve(specifier);
}

beforeEach(() => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pri912-core-junction-'));
  vi.stubEnv('HOME', fixtureRoot);
  vi.stubEnv('USERPROFILE', fixtureRoot);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('reconcilePluginCoreCanonicalJunction', () => {
  it('A: converts a digest-identical materialized copy in every plugin dir and resolution goes through the canonical core', () => {
    writeRuntimeCore('canonical');
    for (const pluginDir of pluginDirs()) writePluginWithMaterializedCopy(pluginDir);

    const result = reconcilePluginCoreCanonicalJunction();

    expect(result.converted).toHaveLength(coreSlots().length);
    expect(result.skipped).toEqual([]);
    for (const [index, slot] of coreSlots().entries()) {
      expect(result.converted).toContain(slot);
      expect(fs.lstatSync(slot).isSymbolicLink()).toBe(true);
      expect(fs.realpathSync(slot)).toBe(fs.realpathSync(runtimeCoreDir()));
      // The actual contract: a bare import from the plugin resolves to the
      // runtime core through the converted slot (PRI-711-style probe).
      const resolved = resolveFromPlugin(pluginDirs()[index] as string, '@principles/core');
      // resolve() returns the realpath; resolve the expected side too so the
      // comparison holds on macOS where os.tmpdir() is itself a symlink.
      expect(resolved).toBe(path.join(fs.realpathSync(runtimeCoreDir()), 'dist', 'entry.js'));
      expect(fs.readFileSync(resolved, 'utf8')).toContain("'canonical'");
    }
  });

  it('B: skips a digest-divergent copy and leaves the materialized tree untouched', () => {
    writeRuntimeCore('canonical');
    for (const pluginDir of pluginDirs()) writePluginWithMaterializedCopy(pluginDir, { copyMarker: 'divergent' });

    const result = reconcilePluginCoreCanonicalJunction();

    expect(result.converted).toEqual([]);
    for (const slot of coreSlots()) {
      expect(result.skipped.find((skip) => skip.dir === slot)?.reason).toContain('content_digest_mismatch');
      expect(fs.lstatSync(slot).isSymbolicLink()).toBe(false);
      expect(fs.readFileSync(path.join(slot, 'dist', 'entry.js'), 'utf8')).toContain("'divergent'");
    }
  });

  it('C: is idempotent — the second run converts nothing and reports the existing links', () => {
    writeRuntimeCore('canonical');
    for (const pluginDir of pluginDirs()) writePluginWithMaterializedCopy(pluginDir);

    const first = reconcilePluginCoreCanonicalJunction();
    expect(first.converted).toHaveLength(coreSlots().length);

    const second = reconcilePluginCoreCanonicalJunction();
    expect(second.converted).toEqual([]);
    expect(second.alreadyCanonical).toHaveLength(coreSlots().length);
    expect(second.skipped).toEqual([]);
    for (const slot of coreSlots()) {
      expect(fs.realpathSync(slot)).toBe(fs.realpathSync(runtimeCoreDir()));
    }
  });

  it('D: removing a tree containing the converted junction (the restoreBackup shape) never deletes the canonical core', () => {
    writeRuntimeCore('canonical');
    for (const pluginDir of pluginDirs()) writePluginWithMaterializedCopy(pluginDir);
    reconcilePluginCoreCanonicalJunction();

    // restoreBackup() does exactly this to a superseded tree: rmSync the
    // (junction-carrying) directory. The junction must be UNLINKED,
    // never followed.
    const extDir = pluginDirs()[1] as string;
    fs.rmSync(extDir, { recursive: true, force: true });

    // The canonical target survives with its content intact.
    expect(fs.existsSync(path.join(runtimeCoreDir(), 'dist', 'entry.js'))).toBe(true);
    expect(fs.readFileSync(path.join(runtimeCoreDir(), 'dist', 'entry.js'), 'utf8')).toContain("'canonical'");
    expect(fs.readdirSync(runtimeCoreDir(), { recursive: true })).toHaveLength(5);
    // The other slot is untouched and still resolves.
    expect(fs.realpathSync(coreSlots()[0] as string)).toBe(fs.realpathSync(runtimeCoreDir()));
  });

  it('E (Windows): the converted slot is a junction whose readlink target is the canonical core', () => {
    writeRuntimeCore('canonical');
    for (const pluginDir of pluginDirs()) writePluginWithMaterializedCopy(pluginDir);

    reconcilePluginCoreCanonicalJunction();

    if (process.platform === 'win32') {
      for (const slot of coreSlots()) {
        // Junctions are absolute; Node reports them as symlinks.
        expect(fs.readlinkSync(slot)).toBe(runtimeCoreDir());
      }
    } else {
      for (const [index, slot] of coreSlots().entries()) {
        // Unix slots carry a portability relative target computed from the
        // link's own directory.
        expect(fs.readlinkSync(slot)).toBe(
          path.relative(path.dirname(slot), runtimeCoreDir()),
        );
        expect(fs.realpathSync(slot)).toBe(fs.realpathSync(runtimeCoreDir()));
        expect(resolveFromPlugin(pluginDirs()[index] as string, '@principles/core')).toContain('dist/entry.js');
      }
    }
  });

  it('skips a copy whose package identity diverges from the canonical core', () => {
    writeRuntimeCore('canonical');
    for (const pluginDir of pluginDirs()) {
      writePluginWithMaterializedCopy(pluginDir);
      const slot = path.join(pluginDir, 'node_modules', '@principles', 'core');
      fs.writeFileSync(
        path.join(slot, 'package.json'),
        JSON.stringify({ name: '@principles/core-evil', version: '9.9.9-test', main: './dist/entry.js' }),
      );
    }

    const result = reconcilePluginCoreCanonicalJunction();

    expect(result.converted).toEqual([]);
    for (const slot of coreSlots()) {
      expect(result.skipped.find((skip) => skip.dir === slot)?.reason).toContain('package_identity_mismatch');
      expect(fs.lstatSync(slot).isSymbolicLink()).toBe(false);
    }
  });

  it('skips when the plugin manifest does not declare a file: dependency on the core', () => {
    writeRuntimeCore('canonical');
    for (const pluginDir of pluginDirs()) writePluginWithMaterializedCopy(pluginDir, { declaredRef: '^9.9.9' });

    const result = reconcilePluginCoreCanonicalJunction();

    expect(result.converted).toEqual([]);
    for (const slot of coreSlots()) {
      expect(result.skipped.find((skip) => skip.dir === slot)?.reason).toContain('declared_dependency_not_file_ref');
    }
  });

  it('refuses a traversal-shaped file ref (rc-1: manifest is untrusted input)', () => {
    writeRuntimeCore('canonical');
    for (const pluginDir of pluginDirs()) writePluginWithMaterializedCopy(pluginDir, { declaredRef: 'file:../../elsewhere/core' });

    const result = reconcilePluginCoreCanonicalJunction();

    expect(result.converted).toEqual([]);
    for (const slot of coreSlots()) {
      expect(result.skipped.find((skip) => skip.dir === slot)?.reason).toContain('declared_dependency_escapes_plugin_dir');
      expect(fs.lstatSync(slot).isSymbolicLink()).toBe(false);
    }
  });

  it('skips when the declared file: slot does not resolve to the canonical runtime core', () => {
    writeRuntimeCore('canonical');
    for (const pluginDir of pluginDirs()) {
      writePluginWithMaterializedCopy(pluginDir, { linkCoreSlot: false });
    }

    const result = reconcilePluginCoreCanonicalJunction();

    expect(result.converted).toEqual([]);
    for (const slot of coreSlots()) {
      expect(result.skipped.find((skip) => skip.dir === slot)?.reason).toContain('declared_file_dep_does_not_resolve_to_runtime_core');
      expect(fs.lstatSync(slot).isSymbolicLink()).toBe(false);
    }
  });

  it('skips every slot when the canonical runtime core is missing', () => {
    writeRuntimeCore('canonical');
    for (const pluginDir of pluginDirs()) writePluginWithMaterializedCopy(pluginDir);
    // The copies were built from the canonical tree; now remove it so the
    // pass finds no canonical source to link to.
    fs.rmSync(runtimeCoreDir(), { recursive: true, force: true });

    const result = reconcilePluginCoreCanonicalJunction();

    expect(result.converted).toEqual([]);
    expect(result.skipped).toHaveLength(coreSlots().length);
    for (const skip of result.skipped) {
      expect(skip.reason).toBe('canonical_runtime_core_missing');
    }
  });

  it('skips a slot that is already a link resolving elsewhere instead of re-pointing it', () => {
    writeRuntimeCore('canonical');
    for (const pluginDir of pluginDirs()) writePluginWithMaterializedCopy(pluginDir);
    // An unrelated lookalike tree one level above the fixture root is outside
    // the fixture — use a sibling inside it instead.
    const foreign = path.join(fixtureRoot, 'foreign-core');
    fs.mkdirSync(foreign, { recursive: true });
    fs.cpSync(runtimeCoreDir(), foreign, { recursive: true });
    for (const slot of coreSlots()) {
      fs.rmSync(slot, { recursive: true, force: true });
      fs.symlinkSync(foreign, slot, 'junction');
    }

    const result = reconcilePluginCoreCanonicalJunction();

    expect(result.converted).toEqual([]);
    for (const slot of coreSlots()) {
      expect(result.skipped.find((skip) => skip.dir === slot)?.reason).toBe('existing_link_resolves_elsewhere');
      expect(fs.realpathSync(slot)).toBe(fs.realpathSync(foreign));
    }
  });

  it('restores the materialized copy when link creation fails mid-conversion', () => {
    writeRuntimeCore('canonical');
    for (const pluginDir of pluginDirs()) writePluginWithMaterializedCopy(pluginDir);

    linkFailure.active = true;
    let result: ReturnType<typeof reconcilePluginCoreCanonicalJunction>;
    try {
      result = reconcilePluginCoreCanonicalJunction();
    } finally {
      linkFailure.active = false;
    }

    expect(result.converted).toEqual([]);
    for (const slot of coreSlots()) {
      expect(result.skipped.find((skip) => skip.dir === slot)?.reason).toContain('conversion_failed_restored');
      // The proven-identical copy is back, materialized and complete.
      expect(fs.lstatSync(slot).isSymbolicLink()).toBe(false);
      expect(fs.readFileSync(path.join(slot, 'dist', 'entry.js'), 'utf8')).toContain("'canonical'");
      expect(fs.existsSync(path.join(slot, 'dist', 'deep', 'lib.js'))).toBe(true);
    }
  });

  it('restores the copy when the fresh link is dangling (existsSync would miss it and block restore)', () => {
    writeRuntimeCore('canonical');
    for (const pluginDir of pluginDirs()) writePluginWithMaterializedCopy(pluginDir);

    // symlinkSync creates a link whose target does not resolve, so
    // realpathSync throws and we enter the restore path with a DANGLING link
    // sitting at coreSlot. The old guard-on-existsSync left that dangling link
    // in place (existsSync follows it to a missing target → false), making the
    // restore renameSync fail and the whole install roll back despite a
    // fully restorable copy.
    linkFailure.dangling = true;
    let result: ReturnType<typeof reconcilePluginCoreCanonicalJunction>;
    try {
      result = reconcilePluginCoreCanonicalJunction();
    } finally {
      linkFailure.dangling = false;
    }

    expect(result.converted).toEqual([]);
    for (const slot of coreSlots()) {
      expect(result.skipped.find((skip) => skip.dir === slot)?.reason).toContain('conversion_failed_restored');
      // No dangling link remains — the materialized copy was restored in its place.
      expect(fs.lstatSync(slot).isSymbolicLink()).toBe(false);
      expect(fs.readFileSync(path.join(slot, 'dist', 'entry.js'), 'utf8')).toContain("'canonical'");
    }
  });

  it('skips (does not fail) when the reserved backup name cannot be cleared before the swap', () => {
    writeRuntimeCore('canonical');
    for (const pluginDir of pluginDirs()) writePluginWithMaterializedCopy(pluginDir);
    for (const slot of coreSlots()) {
      fs.mkdirSync(slot + '.pri912-materialized', { recursive: true });
    }

    backupRemoveFailure.active = true;
    let result: ReturnType<typeof reconcilePluginCoreCanonicalJunction>;
    try {
      result = reconcilePluginCoreCanonicalJunction();
    } finally {
      backupRemoveFailure.active = false;
    }

    expect(result.converted).toEqual([]);
    for (const slot of coreSlots()) {
      expect(result.skipped.find((skip) => skip.dir === slot)?.reason).toContain('stale_backup_unremovable');
      // The working materialized copy is untouched — the install is no worse.
      expect(fs.lstatSync(slot).isSymbolicLink()).toBe(false);
      expect(fs.readFileSync(path.join(slot, 'dist', 'entry.js'), 'utf8')).toContain("'canonical'");
    }
  });

  it('keeps a healthy converted install when the redundant backup cannot be reclaimed', () => {
    writeRuntimeCore('canonical');
    for (const pluginDir of pluginDirs()) writePluginWithMaterializedCopy(pluginDir);

    // The link is created and verified successfully; only the post-conversion
    // backup cleanup throws. That is disk reclamation, not correctness — the
    // slot must still count as converted and the install must NOT roll back.
    let result: ReturnType<typeof reconcilePluginCoreCanonicalJunction>;
    try {
      backupRemoveFailure.active = true;
      result = reconcilePluginCoreCanonicalJunction();
    } finally {
      backupRemoveFailure.active = false;
    }

    expect(result.skipped).toEqual([]);
    for (const slot of coreSlots()) {
      expect(result.converted).toContain(slot);
      expect(fs.lstatSync(slot).isSymbolicLink()).toBe(true);
      expect(fs.realpathSync(slot)).toBe(fs.realpathSync(runtimeCoreDir()));
    }
  });
});
