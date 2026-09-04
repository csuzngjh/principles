import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * PRI-561 follow-up — delivery-surface parity contract (ERR-040 lesson).
 *
 * Every `@principles/*` (and `principles-disciple`) RUNTIME dependency of a
 * bundled package must be handled by ALL THREE delivery surfaces:
 *
 *   S1 publish   — create-principles-disciple/scripts/bundle-plugin.mjs
 *                  rewrites/removes the dep and copies the providing package
 *                  directory (XXX_REQUIRED list).
 *   S2 install   — create-principles-disciple/src/installer.ts delivers the
 *                  providing directory and creates the resolution links
 *                  (syncPdCli) so fresh installs resolve it.
 *   S3 update    — packages/pd-console/src/server/routes/update.ts
 *                  (/apply-full) copies the providing directory and creates
 *                  the same resolution links; the inline updater skips
 *                  npm install, so it must self-provision.
 *
 * Missing ONE surface is exactly how PRI-561 happened: PR #1371 wired S1+S2
 * for @principles/host-runtime but S3 copied only plugin/console/core/
 * pd-cli, so pre-2026-08-14 installs crashed their console on first start
 * after a full update. This test turns the handbook lesson into a CI gate.
 */
describe('delivery-surface parity for @principles/* runtime dependencies (PRI-561 / ERR-040)', () => {
  // Repo roots, resolved relative to THIS file so the test works in any
  // worktree layout.
  const INSTALLER_PKG_ROOT = path.resolve(__dirname, '..');
  const MONOREPO_ROOT = path.resolve(INSTALLER_PKG_ROOT, '..', '..');

  const read = (p: string): string => {
    if (!fs.existsSync(p)) {
      throw new Error(`Required file missing: ${p} — the delivery surfaces moved; update this contract.`);
    }
    return fs.readFileSync(p, 'utf-8');
  };

  const bundleScript = read(path.join(INSTALLER_PKG_ROOT, 'scripts', 'bundle-plugin.mjs'));
  const installerSource = read(path.join(INSTALLER_PKG_ROOT, 'src', 'installer.ts'));
  const updaterSource = read(
    path.join(MONOREPO_ROOT, 'packages', 'pd-console', 'src', 'server', 'routes', 'update.ts'),
  );

  // Package directories whose dist/ the installer delivers. Must mirror
  // bundle-plugin.mjs's DEST constants (PLUGIN/PD_CLI/CONSOLE/CORE/
  // HOST_RUNTIME). A new DEST there means a new shipped package here.
  const BUNDLED_PACKAGE_DIRS = [
    'openclaw-plugin',
    'pd-cli',
    'pd-console',
    'principles-core',
    'host-runtime',
    // PRI-672: the installer package's own dist ships as the release-manager
    // payload component so the installed console can import the
    // ReleaseManager authority module.
    'create-principles-disciple',
  ] as const;

  // Deps deliberately OUTSIDE the three-surface contract. Every entry must
  // stay accurate — the staleness guard below fails when a listed dep no
  // longer exists in any shipped package.
  const EXCEPTIONS: Record<string, string> = {
    // Codex-host distribution (ADR-0020): ships as a standalone npm package,
    // never bundled into the extension dir, so no surface touches it.
    '@principles/codex-adapter':
      'standalone Codex-host distribution — see ADR-0020 / pd-codex docs',
    // pd-cli's dependency on the plugin package itself: S1 rewrites it to
    // file:../plugin, S2 creates the node_modules/principles-disciple link,
    // and S3 needs NO extra mapping because plugin/* flattens onto extDir
    // (update.ts step 5a IS the plugin delivery).
    'principles-disciple':
      'plugin self-dependency — covered by plugin flattening onto extDir',
  };

  /** package dir under packages/ → its label in bundle-plugin.mjs DEST calls */
  const CONSUMER_LABEL: Record<string, string> = {
    'openclaw-plugin': 'plugin',
    'pd-cli': 'pd-cli',
    'pd-console': 'console',
    'principles-core': 'core',
    'host-runtime': 'host-runtime',
    'create-principles-disciple': 'release-manager',
  };

  /**
   * Parsed (label, dep) pairs from bundle-plugin.mjs's rewrite/remove calls,
   * e.g. "console @principles/host-runtime". Attribution matters: a pd-cli
   * rewrite must NOT satisfy a pd-console check — that exact looseness would
   * have let PRI-561-class gaps through.
   */
  function parseBundleRewrites(): Set<string> {
    const pairs = new Set<string>();
    for (const m of bundleScript.matchAll(
      /(?:rewrite|remove)BundledDependency\(join\([A-Z0-9_]+_DEST,\s*'[^']*'\),\s*'([^']+)',\s*'([^']+)'/g,
    )) {
      pairs.add(`${m[1]} ${m[2]}`);
    }
    if (pairs.size === 0) {
      throw new Error(
        'bundle-plugin.mjs yielded zero rewrite/remove calls — the parser in this test no longer matches the script; fix the contract, do not delete it.',
      );
    }
    return pairs;
  }

  interface ShippedDep {
    /** consuming package directory under packages/ */
    consumerDir: string;
    /** dependency name, e.g. "@principles/host-runtime" */
    dep: string;
    /** providing package directory slug, e.g. "host-runtime" */
    providerSlug: string;
  }

  function collectShippedDeps(): ShippedDep[] {
    const deps: ShippedDep[] = [];
    for (const dir of BUNDLED_PACKAGE_DIRS) {
      const pkgPath = path.join(MONOREPO_ROOT, 'packages', dir, 'package.json');
      const pkg = JSON.parse(read(pkgPath)) as { dependencies?: Record<string, string> };
      for (const name of Object.keys(pkg.dependencies ?? {})) {
        const relevant =
          name.startsWith('@principles/') ||
          name === 'principles-disciple' ||
          // PRI-672: the console's runtime dependency on the ReleaseManager
          // authority module shipped inside the installer package.
          name === 'create-principles-disciple';
        if (!relevant) continue;
        deps.push({
          consumerDir: dir,
          dep: name,
          providerSlug: name.replace('@principles/', ''),
        });
      }
    }
    return deps;
  }

  it('every bundled package directory in this contract still exists and is copied by bundle-plugin', () => {
    for (const dir of BUNDLED_PACKAGE_DIRS) {
      // The DEST constants join ROOT_DIR with 'packages' and the dir name.
      expect(bundleScript).toContain(`'${dir}'`);
    }
  });

  it('exception list stays accurate (no stale exemptions)', () => {
    const allDeps = new Set(collectShippedDeps().map((d) => d.dep));
    for (const [dep] of Object.entries(EXCEPTIONS)) {
      expect(allDeps.has(dep)).toBe(true);
    }
  });

  it('every shipped @principles/* dependency is handled by ALL THREE delivery surfaces', () => {
    const failures: string[] = [];
    const s1Calls = parseBundleRewrites();

    for (const { consumerDir, dep, providerSlug } of collectShippedDeps()) {
      if (EXCEPTIONS[dep]) continue;

      // ── S1: publish surface (bundle-plugin.mjs) ──
      // The dep must be rewritten or removed FOR THIS CONSUMER (label-attributed).
      const label = CONSUMER_LABEL[consumerDir];
      if (!label) {
        failures.push(`contract gap: no CONSUMER_LABEL mapping for packages/${consumerDir}`);
      } else if (!s1Calls.has(`${label} ${dep}`)) {
        failures.push(
          `S1(bundle): ${consumerDir} depends on ${dep} but bundle-plugin.mjs never rewrites/removes it for label '${label}'`,
        );
      }
      // ...and the providing directory must be in a REQUIRED copy list.
      const requiredConst =
        providerSlug.toUpperCase().replace(/-/g, '_') + '_REQUIRED';
      if (!new RegExp(`\\b${requiredConst}\\s*=`).test(bundleScript)) {
        failures.push(
          `S1(bundle): ${dep} has no ${requiredConst} copy list in bundle-plugin.mjs`,
        );
      }

      // ── S2: fresh-install surface (installer.ts) ──
      // The installer must reference the providing package (directory
      // install and/or resolution-link creation).
      const s2Hit =
        installerSource.includes(`'${providerSlug}'`) ||
        installerSource.includes(dep);
      if (!s2Hit) {
        failures.push(
          `S2(installer): ${consumerDir} depends on ${dep} but installer.ts never references '${providerSlug}'`,
        );
      }

      // ── S3: full-update surface (pd-console update.ts /apply-full) ──
      const s3Hit =
        updaterSource.includes(`'${providerSlug}'`) || updaterSource.includes(dep);
      if (!s3Hit) {
        failures.push(
          `S3(updater): ${consumerDir} depends on ${dep} but update.ts /apply-full never references '${providerSlug}' — a full update will not deliver it (PRI-561 class)`,
        );
      }
    }

    expect(failures, failures.join('\n')).toEqual([]);
  });
});
