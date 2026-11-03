// PD Release G3-R3 — H2: mechanical guard for the npm publish lifecycle.
//
// The immutable-candidate path packs with `--skip-pack-scripts` for legs whose
// prepack/build work is done EXPLICITLY in the action's "Build target package"
// branch (openclaw-plugin, pd-cli today). That equivalence is maintained by
// hand: a new `prepare` / `prepack` / `prepublishOnly` added to such a package
// would be silently skipped by `--ignore-scripts`, and a changed/removed
// explicit build command would silently ship stale or empty dist/.
//
// `prepublish` is a separate class: npm no longer runs it at all (see the
// measured order pinned below), so it is fail-closed for EVERY train package,
// not only the --ignore-scripts ones.
//
// This test derives its facts from the real sources (the train order in
// publish-npm.yml, each package.json, and the action's bash) and fails when the
// two sides stop agreeing. No runtime npm behaviour is changed.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as jsyamlNs from 'js-yaml';
import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');

const yamlNamespace = jsyamlNs as unknown as Record<string, unknown>;
const yamlDefault = yamlNamespace.default as Record<string, unknown> | undefined;
const yamlLoad: (text: string) => unknown =
  typeof yamlNamespace.load === 'function'
    ? (yamlNamespace.load as (text: string) => unknown)
    : typeof yamlDefault?.load === 'function'
      ? (yamlDefault.load as (text: string) => unknown)
      : () => {
          throw new Error('js-yaml load export not found');
        };

const ACTION_REL = '.github/actions/publish-npm-package/action.yml';
const TRAIN_REL = '.github/workflows/publish-npm.yml';

// npm hooks that `npm pack` executes from the package's own manifest.
//
// Measured 2026-11-03 with npm 11.19.0 (the major Node 24, which the release
// workflow pins, ships): `npm pack` ran prepack → prepare → postpack. It did
// NOT run prepublish.
const PACK_TIME_HOOKS = ['prepare', 'prepack', 'postpack'];
// Hooks that only run for a DIRECTORY publish. This train publishes a
// pre-packed tarball, so the tarball's own manifest never executes these.
// Measured: directory publish ran prepublishOnly → prepack → prepare →
// postpack → publish → postpublish; tarball publish ran NO hook at all.
const PUBLISH_ONLY_HOOKS = ['prepublishOnly', 'publish', 'postpublish'];
// Hooks npm NEVER executes for this release chain (deprecated `prepublish`).
// Fail-closed for every package: only an explicit build command in the leg's
// branch (proven by these tests) may justify a declaration.
const NEVER_RUN_HOOKS = ['prepublish'];

type Manifest = { name?: string; version?: string; scripts?: Record<string, string> };
type BranchCommand = { script: string; workspace: string; source: string };

type ActionDoc = {
  runs?: { steps?: Array<{ name?: string; run?: string }> };
};

function actionStepText(doc: ActionDoc, name: string): string {
  const step = doc.runs?.steps?.find((candidate) => candidate.name === name);
  if (!step || typeof step.run !== 'string') throw new Error(`action.yml has no runnable step named "${name}"`);
  return step.run;
}

/** Package directories from the release train authority (publish-npm.yml). */
export function parseTrainDirs(text: string): string[] {
  const match = /^\s*TRAIN_ORDER: ([a-z0-9,_-]+)$/m.exec(text);
  if (!match) throw new Error('publish-npm.yml has no TRAIN_ORDER list');
  return match[1].split(',').map((entry) => entry.trim()).filter(Boolean);
}

/**
 * Parse the explicit build branches: `if [ "$PKG_DIR" = "<dir>" ]; then ...`.
 * Only command lines that execute a build are recorded; comments, `export`
 * and shell plumbing are ignored.
 */
export function parseBuildBranches(run: string, packageNameOf: (dir: string) => string): Map<string, BranchCommand[]> {
  const branches = new Map<string, BranchCommand[]>();
  const branchStart = /^\s*(?:el)?if \[ "\$PKG_DIR" = "([^"]+)" \]; then\s*$/;
  let current: string | null = null;

  for (const line of run.split(/\r?\n/)) {
    const start = branchStart.exec(line);
    if (start) {
      current = start[1];
      branches.set(current, []);
      continue;
    }
    if (/^\s*else\s*$/.test(line)) {
      current = null;
      continue;
    }
    if (!current) continue;

    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const preamble = /^assert_preamble_dist ([a-z0-9-]+)$/.exec(trimmed);
    if (preamble) {
      // The caller's preamble runs `npm run build --workspace=<package>`
      // before any leg; asserting its dist is that build's explicit evidence.
      branches.get(current)?.push({
        script: 'build',
        workspace: packageNameOf(preamble[1]),
        source: trimmed,
      });
      continue;
    }

    const buildOnce = /^build_once (\S+) (\S+) (\S+)$/.exec(trimmed);
    if (buildOnce) {
      branches.get(current)?.push({ script: buildOnce[2], workspace: buildOnce[1], source: trimmed });
      continue;
    }

    const inPackage = /^cd packages\/([a-z0-9-]+) && npm run ([A-Za-z0-9:_-]+)$/.exec(trimmed);
    if (inPackage) {
      branches.get(current)?.push({
        script: inPackage[2],
        workspace: packageNameOf(inPackage[1]),
        source: trimmed,
      });
      continue;
    }

    const workspaceCommand = /^npm run ([A-Za-z0-9:_-]+) --workspace=(@?[A-Za-z0-9:._/-]+)$/.exec(trimmed);
    if (workspaceCommand) {
      branches.get(current)?.push({
        script: workspaceCommand[1],
        workspace: workspaceCommand[2],
        source: trimmed,
      });
    }
  }
  return branches;
}

/** Package directories whose leg runs the candidate pack with --ignore-scripts. */
export function parseSkipPackScriptDirs(candidateRun: string): string[] {
  const marker = candidateRun.indexOf('SKIP_PACK_SCRIPTS=1');
  if (marker < 0) throw new Error('the candidate step has no SKIP_PACK_SCRIPTS=1 assignment');
  const conditionStart = candidateRun.lastIndexOf('if [ "$PKG_DIR"', marker);
  if (conditionStart < 0) throw new Error('SKIP_PACK_SCRIPTS=1 is not guarded by a PKG_DIR condition');
  const condition = candidateRun.slice(conditionStart, candidateRun.indexOf('; then', marker));
  return [...condition.matchAll(/"([a-z0-9][a-z0-9-]*)"/g)].map((match) => match[1]);
}

/** `npm run a && npm run b` → ['a', 'b']; null when the guard cannot prove it. */
export function hookScriptSequence(script: string | undefined): string[] | null {
  if (typeof script !== 'string' || script.trim() === '') return null;
  const scripts: string[] = [];
  for (const token of script.split('&&').map((part) => part.trim()).filter(Boolean)) {
    const match = /^npm run ([\w-]+(?::[\w-]+)*)$/.exec(token);
    if (!match) return null;
    scripts.push(match[1]);
  }
  return scripts.length > 0 ? scripts : null;
}

function coveredByExplicitBuild(expected: string[], commands: BranchCommand[], workspace: string): boolean {
  let matched = 0;
  for (const command of commands) {
    if (matched < expected.length && command.script === expected[matched] && command.workspace === workspace) {
      matched += 1;
    }
  }
  return matched === expected.length;
}

/**
 * Audit the train against the action's explicit build + skip declaration.
 * Returns human-readable violations; an empty list is the only passing state.
 */
export function auditLifecycleGuard(input: {
  trainDirs: string[];
  packages: Record<string, Manifest>;
  branches: Map<string, BranchCommand[]>;
  skipDirs: string[];
}): string[] {
  const violations: string[] = [];
  const { trainDirs, packages, branches, skipDirs } = input;

  for (const dir of trainDirs) {
    const manifest = packages[dir];
    if (!manifest) {
      violations.push(`${dir}: package.json is missing from the workspace`);
      continue;
    }
    const commands = branches.get(dir);
    if (!commands) {
      // The action fails closed at runtime too, but a train leg added without
      // a branch would never be exercised by this guard.
      violations.push(`${dir}: no explicit build branch in action.yml — a new train leg must declare its build`);
      continue;
    }

    const scripts = manifest.scripts ?? {};
    const packageName = manifest.name ?? dir;
    const presentHooks = (hooks: string[]) =>
      hooks.filter((hook) => typeof scripts[hook] === 'string' && scripts[hook].trim() !== '');
    const packHooks = presentHooks(PACK_TIME_HOOKS);
    const publishOnlyHooks = presentHooks(PUBLISH_ONLY_HOOKS);
    const neverRunHooks = presentHooks(NEVER_RUN_HOOKS);

    // Deprecated hooks npm never executes here are fail-closed for EVERY
    // package — being outside SKIP_PACK_SCRIPTS is not a justification, because
    // pack and tarball publish skip them equally. The only opening is the
    // release build invoking the hook ITSELF for this package (proven here),
    // so an equivalent build elsewhere cannot quietly strand a dead hook.
    for (const hook of neverRunHooks) {
      if (!coveredByExplicitBuild([hook], commands, packageName)) {
        violations.push(
          `${dir}: ${hook} (${scripts[hook]}) never runs in this release chain (npm pack and tarball publish both skip it) — only an explicit "npm run ${hook}" in this leg's build branch may justify it`,
        );
      }
    }

    if (skipDirs.includes(dir)) {
      // Nothing in the package manifest runs: every hook needs an explicit,
      // provably equivalent build command in this leg's branch.
      for (const hook of [...packHooks, ...publishOnlyHooks]) {
        const sequence = hookScriptSequence(scripts[hook]);
        if (!sequence) {
          violations.push(
            `${dir}: ${hook} = ${JSON.stringify(scripts[hook])} cannot be proven equivalent to an explicit build command`,
          );
          continue;
        }
        if (!coveredByExplicitBuild(sequence, commands, packageName)) {
          violations.push(
            `${dir}: --ignore-scripts would silently skip ${hook} (${scripts[hook]}) — no matching explicit build command in this leg`,
          );
        }
      }
      continue;
    }

    // Pack-time hooks run from the manifest during the one `npm pack`.
    // Publish-only hooks never run for a tarball publish; they must either
    // duplicate a pack-time hook's exact command or be built explicitly.
    for (const hook of publishOnlyHooks) {
      const script = scripts[hook].trim();
      const duplicatedPackHook = packHooks.some(
        (packHook) => scripts[packHook].trim().replace(/\s+/g, ' ') === script.replace(/\s+/g, ' '),
      );
      if (duplicatedPackHook) continue;
      const sequence = hookScriptSequence(script);
      if (!sequence || !coveredByExplicitBuild(sequence, commands, packageName)) {
        violations.push(
          `${dir}: ${hook} (${script}) only runs for a directory publish, which this train never performs — register an explicit build equivalent`,
        );
      }
    }
  }

  for (const dir of branches.keys()) {
    if (!trainDirs.includes(dir)) violations.push(`${dir}: build branch is not part of the release train`);
  }
  for (const dir of skipDirs) {
    if (!trainDirs.includes(dir)) violations.push(`${dir}: SKIP_PACK_SCRIPTS entry is not part of the release train`);
  }

  return violations;
}

function readRepoSources() {
  const actionText = fs.readFileSync(path.join(REPO_ROOT, ACTION_REL), 'utf8');
  const action = yamlLoad(actionText) as ActionDoc;
  const packages: Record<string, Manifest> = {};
  const trainDirs = parseTrainDirs(fs.readFileSync(path.join(REPO_ROOT, TRAIN_REL), 'utf8'));
  for (const dir of trainDirs) {
    packages[dir] = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'packages', dir, 'package.json'), 'utf8')) as Manifest;
  }
  const packageNameOf = (dir: string) => packages[dir]?.name ?? dir;
  return {
    trainDirs,
    packages,
    action,
    actionText,
    packageNameOf,
    branches: parseBuildBranches(actionStepText(action, 'Build target package'), packageNameOf),
    skipDirs: parseSkipPackScriptDirs(actionStepText(action, 'Pack and verify immutable candidate')),
  };
}

describe('release train × action lifecycle guard (H2)', () => {
  const sources = readRepoSources();

  it('covers the eight-package train that is actually published', () => {
    expect(sources.trainDirs).toEqual([
      'principles-core',
      'install-layout',
      'host-runtime',
      'codex-adapter',
      'workbuddy-adapter',
      'openclaw-plugin',
      'pd-cli',
      'create-principles-disciple',
    ]);
    // Every package in the train must be a branch of the explicit build.
    expect([...sources.branches.keys()].sort()).toEqual([...sources.trainDirs].sort());
  });

  it('declares exactly the legs whose pack runs with --ignore-scripts', () => {
    expect(sources.skipDirs.sort()).toEqual(['openclaw-plugin', 'pd-cli']);
    // The declaration is only meaningful when it actually reaches the pack.
    const candidateStep = actionStepText(sources.action, 'Pack and verify immutable candidate');
    expect(candidateStep).toContain('if [ "$SKIP_PACK_SCRIPTS" = "1" ]; then');
    expect(candidateStep).toContain('ARGS+=(--skip-pack-scripts)');
  });

  it('passes the current configuration with no violations', () => {
    expect(
      auditLifecycleGuard({
        trainDirs: sources.trainDirs,
        packages: sources.packages,
        branches: sources.branches,
        skipDirs: sources.skipDirs,
      }),
    ).toEqual([]);
  });

  it('classifies every npm lifecycle hook exactly once (prepublish measured as never-run)', () => {
    const allHooks = [...PACK_TIME_HOOKS, ...PUBLISH_ONLY_HOOKS, ...NEVER_RUN_HOOKS];
    expect(new Set(allHooks).size).toBe(allHooks.length);
    // Probe pin (npm 11.19.0): `npm pack` ran prepack → prepare → postpack and
    // `prepublish` appeared in neither pack nor publish. Keep it out of the
    // pack-time class so a non-skipped declaration is not silently trusted.
    expect(NEVER_RUN_HOOKS).toEqual(['prepublish']);
    expect(PACK_TIME_HOOKS).not.toContain('prepublish');
  });

  it('covers every publish-relevant lifecycle hook of every train package', () => {
    const audited: Record<string, string[]> = {};
    for (const dir of sources.trainDirs) {
      const scripts = sources.packages[dir].scripts ?? {};
      audited[dir] = [...PACK_TIME_HOOKS, ...PUBLISH_ONLY_HOOKS, ...NEVER_RUN_HOOKS].filter(
        (hook) => typeof scripts[hook] === 'string',
      );
    }
    // Current facts: only the plugin/pd-cli declare prepack; the installer's
    // prepublishOnly duplicates its prepack exactly.
    expect(audited['openclaw-plugin']).toEqual(['prepack']);
    expect(audited['pd-cli']).toEqual(['prepack']);
    expect(audited['create-principles-disciple']).toEqual(['prepack', 'prepublishOnly']);
    expect(sources.packages['install-layout'].scripts?.prepack).toBeUndefined();
    expect(sources.packages['host-runtime'].scripts?.prepack).toBeUndefined();
  });
});

describe('lifecycle guard — negative mutations must fail (H2)', () => {
  const sources = readRepoSources();

  function audit(overrides: {
    trainDirs?: string[];
    packages?: Record<string, Manifest>;
    branches?: Map<string, BranchCommand[]>;
    skipDirs?: string[];
  }) {
    return auditLifecycleGuard({
      trainDirs: overrides.trainDirs ?? sources.trainDirs,
      packages: overrides.packages ?? sources.packages,
      branches: overrides.branches ?? sources.branches,
      skipDirs: overrides.skipDirs ?? sources.skipDirs,
    });
  }

  function withScript(dir: string, hook: string, command: string): Record<string, Manifest> {
    const manifests = { ...sources.packages };
    manifests[dir] = {
      ...manifests[dir],
      scripts: { ...(manifests[dir].scripts ?? {}), [hook]: command },
    };
    return manifests;
  }

  function withBuildRun(mutatedRun: string) {
    return parseBuildBranches(mutatedRun, sources.packageNameOf);
  }

  it('fails when a non-skipped package gains an unrunnable prepublish', () => {
    // Not being in SKIP_PACK_SCRIPTS does NOT make `prepublish` executed: the
    // probe showed npm pack and tarball publish both skip it.
    const violations = audit({ packages: withScript('codex-adapter', 'prepublish', 'npm run build:types') });
    expect(violations.join('\n')).toMatch(
      /codex-adapter: prepublish \(npm run build:types\) never runs in this release chain/,
    );
  });

  it('fails when a skipped package gains an unrunnable prepublish', () => {
    const violations = audit({ packages: withScript('pd-cli', 'prepublish', 'npm run build') });
    expect(violations.join('\n')).toMatch(/pd-cli: prepublish \(npm run build\) never runs in this release chain/);
  });

  it('accepts prepublish only when the build branch invokes that hook explicitly', () => {
    // The sanctioned opening: the leg's build runs `npm run prepublish` for the
    // package itself. An equivalent `npm run build` elsewhere stays fail-closed
    // (see the negative test above) so a dead hook cannot look alive.
    const mutatedRun = actionStepText(sources.action, 'Build target package').replace(
      /(elif \[ "\$PKG_DIR" = "codex-adapter" \]; then\n( *)build_once @principles\/codex-adapter build packages\/codex-adapter)/,
      '$1\n$2cd packages/codex-adapter && npm run prepublish',
    );
    const violations = audit({
      packages: withScript('codex-adapter', 'prepublish', 'npm run build'),
      branches: withBuildRun(mutatedRun),
    });
    expect(violations).toEqual([]);
  });

  it('fails when a skipped package gains an unmapped prepare', () => {
    const violations = audit({ packages: withScript('openclaw-plugin', 'prepare', 'npm run build') });
    expect(violations.join('\n')).toMatch(/openclaw-plugin: --ignore-scripts would silently skip prepare/);
  });

  it('fails when a skipped package gains an unmapped prepublishOnly', () => {
    const violations = audit({ packages: withScript('pd-cli', 'prepublishOnly', 'npm run build:types') });
    expect(violations.join('\n')).toMatch(/pd-cli: --ignore-scripts would silently skip prepublishOnly/);
  });

  it('fails when a prepack definition no longer matches the explicit build', () => {
    const violations = audit({
      packages: withScript('openclaw-plugin', 'prepack', 'npm run build:production && npm run build:bundle'),
    });
    expect(violations.join('\n')).toMatch(/openclaw-plugin: --ignore-scripts would silently skip prepack/);
  });

  it('fails when the explicit pd-cli build command disappears', () => {
    const mutatedRun = actionStepText(sources.action, 'Build target package').replace(
      'build_once @principles/pd-cli build packages/pd-cli',
      '',
    );
    const violations = audit({ branches: withBuildRun(mutatedRun) });
    expect(violations.join('\n')).toMatch(/pd-cli: --ignore-scripts would silently skip prepack/);
  });

  it('fails when a new train package has no explicit build branch', () => {
    const violations = audit({
      trainDirs: [...sources.trainDirs, 'extra-package'],
      packages: {
        ...sources.packages,
        'extra-package': { name: 'extra-package', version: '1.0.0', scripts: {} },
      },
    });
    expect(violations.join('\n')).toMatch(/extra-package: no explicit build branch/);
  });

  it('fails when a skip declaration escapes the train', () => {
    const violations = audit({ skipDirs: [...sources.skipDirs, 'retired-package'] });
    expect(violations.join('\n')).toMatch(/retired-package: SKIP_PACK_SCRIPTS entry is not part of the release train/);
  });

  it('does not flag a prepare on a pack-owned package: npm pack executes it', () => {
    // The risk this guard targets is --ignore-scripts. A non-skipped package's
    // prepare runs during the one real `npm pack`, so it is not silent.
    expect(audit({ packages: withScript('codex-adapter', 'prepare', 'npm run build') })).toEqual([]);
  });
});
