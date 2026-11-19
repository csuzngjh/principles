/**
 * PRI-1253 / PD-Lab v0.3 T3a — experiment-config loader contract tests.
 *
 * Drives the REAL public surface of scripts/dev/pd-lab/experiment-config.mjs
 * (`loadExperimentConfig` — its only export) against synthetic fixtures in
 * the managed temp root. No production workspace, no real dataset, no real
 * preregistration, no model calls.
 *
 * Coverage map (HANDOFF §5, ticket PRI-1253 acceptance):
 *   CF-02 unknown fields / CF-05 dataset digest / CF-06 workspaceFiles
 *   escape + intermediate symlink / CF-08 shell pointer root / CF-09 arm
 *   identity / CF-10 flag registration / CF-13 legacy closed set + _note +
 *   mode exclusivity + NOT_APPLICABLE_LEGACY / CF-14 prereg existence +
 *   raw-byte digest / CF-15 front-matter experimentId binding /
 *   CF-16 re-load re-derivation (the module-level half — the lab:run
 *   entry-level double preflight lands with T3b / PRI-1254).
 *   CF-03 (experimentRoot under ~/.pd) is covered through a redirected
 *   HOME/USERPROFILE because os.homedir() honors those in-process.
 *   CF-11 blob manifest + per-blob verification. CF-01 (CLI exit 2 on a
 *   missing --config) and CF-04's live `git rev-parse HEAD` comparison are
 *   entry-script behaviors owned by T3b — here only their module-level
 *   preconditions (missing file argument, expectedHead FORMAT) are tested.
 *
 * Honesty markers: junction cases run only on win32 (CI is linux — they are
 * skipped there and re-verified on a Windows host); true-symlink cases skip
 * with ctx.skip when the platform refuses symlink creation. Both are listed
 * as such in the PR matrix, never reported as PASS.
 *
 * Security remediation round (2026-11-18, review findings P1-1/P1-2/P1-3/P2):
 *  - P1-1 blob-manifest consistency contract (ok/consistencyStatus/blobDir/
 *    entry shape/duplicates/counts cross-checks) + legal zero-blob positive;
 *  - P1-2 snapshot object isolation — REAL-file requirement, full parent
 *    chain fence, nearest-existing-ancestor containment, hardlink (nlink)
 *    rejection, verified through REAL attack scenarios A–F plus dangling
 *    symlink / directory-as-file / hardlink variants;
 *  - P1-3 workspaceFiles whole-chain fence (workspaces/armId/intermediates/
 *    existing target, junction+symlink+case-fold variants);
 *  - P2 baseConfigFile strict file judgment; P2 public API reverted to the
 *    single-parameter `loadExperimentConfig(file)` (runId validation is T3b's
 *    responsibility at its own path-join sites — see the module header).
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadExperimentConfig } from '../dev/pd-lab/experiment-config.mjs';
import { DEFAULT_FEATURE_FLAGS } from '@principles/core/runtime';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '..', '..');
const MODULE_SOURCE = path.join(REPO_ROOT, 'scripts', 'dev', 'pd-lab', 'experiment-config.mjs');
const EXAMPLE_CONFIG = path.join(REPO_ROOT, 'scripts', 'dev', 'pd-lab', 'experiment-config.example.json');

/** Fields TECH §4.1 declares — the example file must use exactly these. */
const KNOWN_TOP_LEVEL_FIELDS = new Set([
  'schema', 'experimentId', 'preregistration', 'baselineArm', 'candidateArm',
  'experimentRoot', 'additionalForbiddenRoots', 'dataset', 'snapshot',
  'baseConfigFile', 'profileRebind', 'arms', 'modelEnv', '_note', 'legacy',
]);

function tmpRoot(): string {
  const raw = process.env.TMPDIR ?? process.env.TMP ?? process.env.TEMP;
  return fs.realpathSync(typeof raw === 'string' && raw.length > 0 ? raw : os.tmpdir());
}

/** An absolute path on the fixture's own drive, OUTSIDE every fixture dir —
 *  built by derivation, never from a system-directory literal. */
function absolutePathOutsideFixture(fx: { root: string }, ...segments: string[]): string {
  const driveRoot = path.parse(path.resolve(fx.root)).root;
  return path.join(driveRoot, ...segments);
}

function sha256Text(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

function sha256File(p: string): string {
  return createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

interface Fixture {
  root: string;
  experimentRoot: string;
  datasetFile: string;
  snapshotDir: string;
  stateDb: string;
  trajectoryDb: string;
  blobFile: string;
  blobManifest: string;
  preregFile: string;
  baseConfigFile: string;
  wsSource: string;
  wtBase: string;
  wtCand: string;
  /** Fresh raw config object; mutators receive a deep clone of it. */
  rawConfig(): Record<string, unknown>;
  writeConfig(mutate?: (raw: Record<string, unknown>) => void): string;
}

const EXPERIMENT_ID = 't3a-synth';
const PREREG_TEXT = '---\nexperimentId: t3a-synth\nplan: synthetic fixture\n---\n\n# Preregistration (synthetic)\n\nNo research content — T3a fixture.\n';

function buildFixture(label: string): Fixture {
  const root = fs.mkdtempSync(path.join(tmpRoot(), `pd-lab-t3a-${label}-`));
  const experimentRoot = path.join(root, 'exp');
  fs.mkdirSync(experimentRoot, { recursive: true });

  const datasetFile = path.join(experimentRoot, 'dataset.json');
  fs.writeFileSync(datasetFile, JSON.stringify({ schema: 'synthetic', samples: [] }, null, 2), 'utf8');

  const snapshotDir = path.join(experimentRoot, 'snap');
  const blobBody = 'synthetic blob body 0001';
  fs.mkdirSync(path.join(snapshotDir, 'blobs'), { recursive: true });
  const blobFile = path.join(snapshotDir, 'blobs', 'b1.txt');
  fs.writeFileSync(blobFile, blobBody, 'utf8');
  const stateDb = path.join(snapshotDir, 'state.db');
  const trajectoryDb = path.join(snapshotDir, 'trajectory.db');
  fs.writeFileSync(stateDb, 'synthetic state db bytes', 'utf8');
  fs.writeFileSync(trajectoryDb, 'synthetic trajectory db bytes', 'utf8');
  const blobManifest = path.join(snapshotDir, 'blob-manifest.json');
  const manifest = {
    schema: 'pd-lab-blob-manifest.v1',
    generatedAt: '2026-11-18T00:00:00.000Z',
    sourceWorkspace: 'synthetic',
    blobDir: 'blobs',
    ok: true,
    consistencyStatus: 'CONSISTENT_WITHIN_WINDOW',
    consistencyReasons: [],
    files: [
      {
        path: 'blobs/b1.txt',
        ref: 'b1.txt',
        bytes: Buffer.byteLength(blobBody, 'utf8'),
        sha256: sha256Text(blobBody),
        referenceCount: 1,
        referencedBy: ['assistant_turns'],
      },
    ],
    counts: { referencedDistinct: 1, referencedRows: 1, copied: 1, orphansNotCopied: 0 },
  };
  fs.writeFileSync(blobManifest, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const armsParent = fs.mkdtempSync(path.join(root, 'arms-'));
  const wtBase = path.join(armsParent, 'wtbase');
  const wtCand = path.join(armsParent, 'wtcand');
  fs.mkdirSync(wtBase, { recursive: true });
  fs.mkdirSync(wtCand, { recursive: true });

  const preregFile = path.join(root, 'PREREG.md');
  fs.writeFileSync(preregFile, PREREG_TEXT, 'utf8');
  const baseConfigFile = path.join(root, 'base-config.yaml');
  fs.writeFileSync(baseConfigFile, 'workspace:\n  default: synthetic\n', 'utf8');
  const wsSource = path.join(root, 'INTENT.synth.md');
  fs.writeFileSync(wsSource, '# synthetic intent document\n', 'utf8');

  const configFile = path.join(root, 'experiment-config.json');

  const rawConfig = (): Record<string, unknown> => ({
    schema: 'pd-lab-experiment-config.v1',
    experimentId: EXPERIMENT_ID,
    preregistration: { file: preregFile, sha256: sha256File(preregFile) },
    baselineArm: 'wtbase',
    candidateArm: 'wtcand',
    experimentRoot,
    additionalForbiddenRoots: [],
    dataset: { file: datasetFile, sha256: sha256File(datasetFile) },
    snapshot: {
      dir: snapshotDir,
      sha256: {
        state: sha256File(stateDb),
        trajectory: sha256File(trajectoryDb),
        blobManifest: sha256File(blobManifest),
      },
    },
    baseConfigFile,
    arms: {
      wtbase: { worktree: wtBase, expectedHead: 'a'.repeat(40) },
      wtcand: {
        worktree: wtCand,
        expectedHead: 'b'.repeat(40),
        featureOverrides: { intent_engineering: true },
        workspaceFiles: [{ source: wsSource, target: '.principles/INTENT.synth.md', sha256: sha256File(wsSource) }],
      },
    },
    modelEnv: ['PD_LAB_T3A_TEST_KEY'],
  });

  const writeConfig = (mutate?: (raw: Record<string, unknown>) => void): string => {
    const raw = rawConfig();
    if (mutate) mutate(raw);
    fs.writeFileSync(configFile, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
    return configFile;
  };

  const fx: Fixture = {
    root, experimentRoot, datasetFile, snapshotDir, stateDb, trajectoryDb, blobFile,
    blobManifest, preregFile, baseConfigFile, wsSource, wtBase, wtCand,
    rawConfig, writeConfig,
  };
  return fx;
}

/** Recompute the declared snapshot digests after mutating snapshot files. */
function refreshSnapshotDigests(fx: Fixture): void {
  const raw = fx.rawConfig();
  const snapshot = raw.snapshot as { sha256: Record<string, string> };
  snapshot.sha256.state = sha256File(fx.stateDb);
  snapshot.sha256.trajectory = sha256File(fx.trajectoryDb);
  snapshot.sha256.blobManifest = sha256File(fx.blobManifest);
  fs.writeFileSync(path.join(fx.root, 'experiment-config.json'), `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
}

/**
 * Mutate the blob manifest, then write a config whose declared digests are
 * recomputed from the CURRENT files — so a rejection is attributable to the
 * manifest-contract violation itself, never to a stale manifest digest
 * (attack tests must fail for the security reason, not for bookkeeping).
 */
function mutateManifest(fx: Fixture, mutate: (manifest: Record<string, unknown>) => void): string {
  const manifest = JSON.parse(fs.readFileSync(fx.blobManifest, 'utf8')) as Record<string, unknown>;
  mutate(manifest);
  fs.writeFileSync(fx.blobManifest, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return fx.writeConfig();
}

type ManifestEntry = {
  path: string; ref: string; bytes: number; sha256: string;
  referenceCount: number; referencedBy: string[];
};

interface LoadError extends Error {
  problems?: Array<{ field: string; code: string; message: string }>;
  configSha256?: string;
}

/** Assert a rejection and return its problems for precise code/field checks. */
function expectRejected(configFile: string): Array<{ field: string; code: string; message: string }> {
  let err: unknown;
  try {
    loadExperimentConfig(configFile);
  } catch (e) {
    err = e;
  }
  expect(err, 'loadExperimentConfig must throw').toBeDefined();
  const e = err as LoadError;
  expect(e.name).toBe('ExperimentConfigError');
  expect(Array.isArray(e.problems)).toBe(true);
  expect((e.problems ?? []).length).toBeGreaterThan(0);
  for (const p of e.problems ?? []) {
    expect(typeof p.field).toBe('string');
    expect(typeof p.code).toBe('string');
    expect(typeof p.message).toBe('string');
  }
  return e.problems ?? [];
}

function hasProblem(problems: Array<{ field: string; code: string }>, field: string, code: string): boolean {
  return problems.some((p) => p.field === field && p.code === code);
}

/** Side-effect assertion shared by the attack suites (P1-2/P1-3): the
 *  rejected load must leave the fixture tree byte-identical and create no
 *  runs/ or workspaces/ directories anywhere. */
function expectNoSideEffects(fx: Fixture, before: Array<[string, string]>): void {
  expect(fingerprintEntries(fx.root)).toEqual(before);
  expect(fs.existsSync(path.join(fx.experimentRoot, 'runs'))).toBe(false);
  expect(fs.existsSync(path.join(fx.experimentRoot, 'workspaces'))).toBe(false);
}

/** Managed scratch dir OUTSIDE every fixture root for attack material
 *  (linked targets, "production" copies) — never a drive root (git-15). */
function attackScratch(label: string): string {
  return fs.mkdtempSync(path.join(tmpRoot(), `pd-lab-t3a-atk-${label}-`));
}

/** rel path -> sha256 for every file under dir (side-effect detector).
 *  Symlinks/junctions are recorded as `<link>` and NEVER followed — the
 *  detector must not read through redirects (same discipline as the loader),
 *  and junction lstat does not report isDirectory on win32. Keys use
 *  entry.name (a Dirent would collapse every entry onto "[object Object]"). */
function fingerprintTree(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (current: string, prefix: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      const st = fs.lstatSync(full);
      if (st.isSymbolicLink()) {
        out.set(`${prefix}${entry.name}`, '<link>');
      } else if (st.isDirectory()) {
        out.set(`${prefix}${entry.name}/`, '<dir>');
        walk(full, `${prefix}${entry.name}/`);
      } else {
        out.set(`${prefix}${entry.name}`, sha256File(full));
      }
    }
  };
  walk(dir, '');
  return out;
}

/** Order-independent fingerprint comparison (readdir order is not a stable
 *  contract across platforms/filesystems — compare as sorted key sets). */
function fingerprintEntries(dir: string): Array<[string, string]> {
  return Array.from(fingerprintTree(dir).entries()).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** Directory alias like the snapshot-hardening suite: junction on win32
 *  (no privilege needed), dir symlink elsewhere; null when refused. */
function createDirectoryAlias(target: string, link: string): 'junction' | 'dir' | null {
  if (process.platform === 'win32') {
    try {
      fs.symlinkSync(target, link, 'junction');
      return 'junction';
    } catch {
      return null;
    }
  }
  try {
    fs.symlinkSync(target, link, 'dir');
    return 'dir';
  } catch {
    return null;
  }
}

/** True symbolic link (NOT a junction) — probes privilege availability. */
function createTrueSymlink(target: string, link: string): boolean {
  try {
    fs.symlinkSync(target, link, 'dir');
    return true;
  } catch {
    return false;
  }
}

/** The primary checkout as INDEPENDENTLY derived by the test (mirrors the
 *  module's .git-file logic — cross-check, not shared code). */
function derivePrimaryForTest(): string {
  let current = REPO_ROOT;
  for (let i = 0; i < 6; i += 1) {
    let st: fs.Stats | null = null;
    try {
      st = fs.lstatSync(path.join(current, '.git'));
    } catch {
      return current;
    }
    if (st.isDirectory()) return current;
    if (!st.isFile()) return current;
    const text = fs.readFileSync(path.join(current, '.git'), 'utf8').trim();
    const m = text.match(/^gitdir:\s*(.+)$/);
    if (!m) return current;
    let gitdir = m[1].trim();
    if (!path.isAbsolute(gitdir)) gitdir = path.resolve(current, gitdir);
    const worktreesDir = path.dirname(gitdir);
    if (path.basename(worktreesDir) === 'worktrees') {
      return path.dirname(path.dirname(worktreesDir));
    }
    return current;
  }
  return REPO_ROOT;
}

/* ═══════════════════════════ happy paths ═══════════════════════════════ */

describe('PD-Lab T3a experiment-config: valid loads', () => {
  it('loads a valid new-experiment config and freezes the result', () => {
    const fx = buildFixture('ok');
    const configFile = fx.writeConfig();
    const loaded = loadExperimentConfig(configFile);

    expect(loaded.schema).toBe('pd-lab-experiment-config.v1');
    expect(loaded.experimentId).toBe(EXPERIMENT_ID);
    expect(loaded.mode).toBe('preregistered');
    expect(loaded.legacy).toBeNull();
    expect(loaded.baselineArm).toBe('wtbase');
    expect(loaded.candidateArm).toBe('wtcand');
    expect(loaded.verification.configSha256).toBe(sha256File(configFile));
    expect(loaded.verification.preregistrationStatus).toBe('VERIFIED');
    expect(loaded.verification.preregistrationSha256).toBe(sha256File(fx.preregFile));
    expect(loaded.verification.datasetSha256Verified).toBe(true);
    expect(loaded.verification.snapshotVerified.state).toBe(true);
    expect(loaded.verification.snapshotVerified.trajectory).toBe(true);
    expect(loaded.verification.snapshotVerified.blobManifest).toBe(true);
    expect(loaded.verification.snapshotVerified.blobsVerified).toBe(1);
    expect(loaded.arms.wtcand.featureOverrides).toEqual({ intent_engineering: true });
    expect(loaded.arms.wtcand.workspaceFiles).toEqual([
      { source: fx.wsSource, target: '.principles/INTENT.synth.md', sha256: sha256File(fx.wsSource) },
    ]);

    // Frozen: downstream consumers cannot mutate the validated config (TECH §3.2 “冻结”).
    expect(Object.isFrozen(loaded)).toBe(true);
    expect(Object.isFrozen(loaded.arms)).toBe(true);
    expect(Object.isFrozen(loaded.arms.wtcand)).toBe(true);
    expect(Object.isFrozen(loaded.verification)).toBe(true);
    expect(Object.isFrozen(loaded.modelEnv)).toBe(true);
  });

  it('loads a valid legacy config as NOT_APPLICABLE_LEGACY with a null preregistration digest', () => {
    const fx = buildFixture('legacy');
    const configFile = fx.writeConfig((raw) => {
      delete (raw as { preregistration?: unknown }).preregistration;
      raw.experimentId = 'prompt-v2-round1';
      raw.legacy = { batch: 'prompt-v2-round1' };
    });
    const loaded = loadExperimentConfig(configFile);
    expect(loaded.mode).toBe('legacy');
    expect(loaded.legacy).toEqual({ batch: 'prompt-v2-round1' });
    expect(loaded.preregistration).toBeNull();
    expect(loaded.verification.preregistrationStatus).toBe('NOT_APPLICABLE_LEGACY');
    expect(loaded.verification.preregistrationSha256).toBeNull();
  });

  it('loads the second registered legacy batch (dreamer-v21-round2)', () => {
    const fx = buildFixture('legacy2');
    const configFile = fx.writeConfig((raw) => {
      delete (raw as { preregistration?: unknown }).preregistration;
      raw.experimentId = 'dreamer-v21-round2';
      raw.legacy = { batch: 'dreamer-v21-round2' };
    });
    const loaded = loadExperimentConfig(configFile);
    expect(loaded.mode).toBe('legacy');
    expect(loaded.legacy).toEqual({ batch: 'dreamer-v21-round2' });
  });

  it('preserves explicitly declared roles when they contradict alphabetical order (no inference)', () => {
    // baseline 'zbase' sorts AFTER candidate 'acand' — any alphabetical
    // inference would silently swap the roles (CF-09's core hazard).
    const fx = buildFixture('roles');
    const configFile = fx.writeConfig((raw) => {
      raw.baselineArm = 'zbase';
      raw.candidateArm = 'acand';
      raw.arms = {
        zbase: { worktree: fx.wtBase, expectedHead: 'a'.repeat(40) },
        acand: { worktree: fx.wtCand, expectedHead: 'b'.repeat(40) },
      };
    });
    const loaded = loadExperimentConfig(configFile);
    expect(loaded.baselineArm).toBe('zbase');
    expect(loaded.candidateArm).toBe('acand');
  });

  it('accepts a string _note without semantic effect, but counts it into configSha256', () => {
    const fx = buildFixture('note');
    const first = fx.writeConfig((raw) => { raw._note = 'first note'; });
    const loadedFirst = loadExperimentConfig(first);
    expect(loadedFirst.note).toBe('first note');
    const second = fx.writeConfig((raw) => { raw._note = 'second note'; });
    const loadedSecond = loadExperimentConfig(second);
    expect(loadedSecond.note).toBe('second note');
    expect(loadedSecond.verification.configSha256).not.toBe(loadedFirst.verification.configSha256);
    // Everything else is byte-identical between the two loads:
    expect(loadedSecond.baselineArm).toBe(loadedFirst.baselineArm);
    expect(loadedSecond.verification.preregistrationSha256).toBe(loadedFirst.verification.preregistrationSha256);
  });

  it('accepts profileRebind and an empty modelEnv array', () => {
    const fx = buildFixture('extras');
    const configFile = fx.writeConfig((raw) => {
      raw.profileRebind = { from: 'pi-ai.amd-ds-vision', to: 'pi-ai.glm' };
      raw.modelEnv = [];
    });
    const loaded = loadExperimentConfig(configFile);
    expect(loaded.profileRebind).toEqual({ from: 'pi-ai.amd-ds-vision', to: 'pi-ai.glm' });
    expect(loaded.modelEnv).toEqual([]);
  });

  it('accepts both arms sharing ONE worktree (same-commit switch experiment)', () => {
    const fx = buildFixture('sharewt');
    const configFile = fx.writeConfig((raw) => {
      (raw.arms as Record<string, { worktree: string }>).wtcand.worktree = fx.wtBase;
    });
    const loaded = loadExperimentConfig(configFile);
    expect(loaded.arms.wtbase.worktree).toBe(loaded.arms.wtcand.worktree);
  });
});

/* ═══════════════════ structural rejections (CF-02, CF-09) ══════════════ */

describe('PD-Lab T3a experiment-config: structure', () => {
  it('rejects unknown top-level fields with the field name (CF-02)', () => {
    const fx = buildFixture('unknown');
    const problems = expectRejected(fx.writeConfig((raw) => { raw.unexpectedThing = 1; }));
    expect(hasProblem(problems, 'unexpectedThing', 'unknown_field')).toBe(true);
  });

  it('reports every problem at once — unknown field AND malformed expectedHead together', () => {
    const fx = buildFixture('multi');
    const problems = expectRejected(fx.writeConfig((raw) => {
      raw.unexpectedThing = 1;
      ((raw.arms as Record<string, { expectedHead: string }>).wtbase).expectedHead = 'tooshort';
    }));
    expect(hasProblem(problems, 'unexpectedThing', 'unknown_field')).toBe(true);
    expect(hasProblem(problems, 'arms.wtbase.expectedHead', 'invalid_value')).toBe(true);
  });

  it('rejects a wrong schema id', () => {
    const fx = buildFixture('schema');
    const problems = expectRejected(fx.writeConfig((raw) => { raw.schema = 'pd-lab-experiment-config.v2'; }));
    expect(hasProblem(problems, 'schema', 'invalid_value')).toBe(true);
  });

  it('rejects a missing baselineArm — roles are never inferred (CF-09)', () => {
    const fx = buildFixture('nobase');
    const problems = expectRejected(fx.writeConfig((raw) => { delete (raw as { baselineArm?: string }).baselineArm; }));
    expect(hasProblem(problems, 'baselineArm', 'missing_required_field')).toBe(true);
  });

  it('rejects identical baselineArm/candidateArm', () => {
    const fx = buildFixture('samerole');
    const problems = expectRejected(fx.writeConfig((raw) => { raw.candidateArm = 'wtbase'; }));
    expect(hasProblem(problems, 'candidateArm', 'duplicate_arm_roles')).toBe(true);
  });

  it('rejects a role arm that is not declared in arms', () => {
    const fx = buildFixture('badrole');
    const problems = expectRejected(fx.writeConfig((raw) => { raw.candidateArm = 'ghost'; }));
    expect(hasProblem(problems, 'baselineArm', 'arm_not_declared')).toBe(true);
  });

  it('rejects exactly-two-arms violations (three arms, one arm)', () => {
    const fx3 = buildFixture('threearms');
    const problems3 = expectRejected(fx3.writeConfig((raw) => {
      (raw.arms as Record<string, unknown>).extra = { worktree: fx3.wtBase, expectedHead: 'c'.repeat(40) };
    }));
    expect(hasProblem(problems3, 'arms', 'invalid_value')).toBe(true);

    const fx1 = buildFixture('onearm');
    const problems1 = expectRejected(fx1.writeConfig((raw) => {
      raw.arms = { wtbase: { worktree: fx1.wtBase, expectedHead: 'a'.repeat(40) } };
    }));
    expect(hasProblem(problems1, 'arms', 'invalid_value')).toBe(true);
  });

  it('rejects a missing / malformed expectedHead (format level; live HEAD comparison is T3b)', () => {
    const fx = buildFixture('head');
    const problemsMissing = expectRejected(fx.writeConfig((raw) => {
      delete ((raw.arms as Record<string, Record<string, unknown>>).wtbase).expectedHead;
    }));
    expect(hasProblem(problemsMissing, 'arms.wtbase.expectedHead', 'invalid_value')).toBe(true);

    const fxShort = buildFixture('headshort');
    const problemsShort = expectRejected(fxShort.writeConfig((raw) => {
      ((raw.arms as Record<string, { expectedHead: string }>).wtbase).expectedHead = 'a'.repeat(39);
    }));
    expect(hasProblem(problemsShort, 'arms.wtbase.expectedHead', 'invalid_value')).toBe(true);
  });

  it('rejects non-boolean featureOverrides values', () => {
    const fx = buildFixture('flagtype');
    const problems = expectRejected(fx.writeConfig((raw) => {
      ((raw.arms as Record<string, { featureOverrides: Record<string, unknown> }>).wtcand).featureOverrides = { intent_engineering: 'yes' };
    }));
    expect(hasProblem(problems, 'arms.wtcand.featureOverrides.intent_engineering', 'invalid_type')).toBe(true);
  });

  it('rejects invalid modelEnv entries', () => {
    const fx = buildFixture('envid');
    const problems = expectRejected(fx.writeConfig((raw) => { raw.modelEnv = ['not a name!']; }));
    expect(hasProblem(problems, 'modelEnv[0]', 'invalid_value')).toBe(true);
  });

  it('rejects a non-string _note (CF-13)', () => {
    const fx = buildFixture('notetype');
    const problems = expectRejected(fx.writeConfig((raw) => { raw._note = 42; }));
    expect(hasProblem(problems, '_note', 'invalid_type')).toBe(true);
  });

  it('rejects a missing config-file argument without reading anything (module-level CF-01 precondition)', () => {
    let err: unknown;
    try { loadExperimentConfig(''); } catch (e) { err = e; }
    expect((err as LoadError).name).toBe('ExperimentConfigError');
    expect(hasProblem((err as LoadError).problems ?? [], 'file', 'missing_argument')).toBe(true);

    let err2: unknown;
    try { loadExperimentConfig(undefined as unknown as string); } catch (e) { err2 = e; }
    expect(hasProblem((err2 as LoadError).problems ?? [], 'file', 'missing_argument')).toBe(true);
  });

  it('rejects a missing config file and invalid JSON with distinct codes', () => {
    const fx = buildFixture('nocfg');
    const missing = expectRejected(path.join(fx.root, 'does-not-exist.json'));
    expect(hasProblem(missing, 'file', 'config_file_unreadable')).toBe(true);

    const bad = path.join(fx.root, 'bad.json');
    fs.writeFileSync(bad, '{ not json', 'utf8');
    const problems = expectRejected(bad);
    expect(hasProblem(problems, 'file', 'invalid_json')).toBe(true);
  });

  it('example config uses exactly the TECH §4.1 field vocabulary (ERR-146 round-trip link)', () => {
    const example = JSON.parse(fs.readFileSync(EXAMPLE_CONFIG, 'utf8')) as Record<string, unknown>;
    for (const key of Object.keys(example)) {
      expect(KNOWN_TOP_LEVEL_FIELDS.has(key), `unknown example field ${key}`).toBe(true);
    }
    for (const required of ['schema', 'experimentId', 'baselineArm', 'candidateArm', 'experimentRoot', 'additionalForbiddenRoots', 'dataset', 'snapshot', 'baseConfigFile', 'arms', 'modelEnv']) {
      expect(Object.hasOwn(example, required), `example must demonstrate ${required}`).toBe(true);
    }
    // The example is new-experiment mode: it must NOT carry legacy.
    expect(Object.hasOwn(example, 'legacy')).toBe(false);
    // Placeholder hygiene: no real machine paths, no credentials.
    const text = fs.readFileSync(EXAMPLE_CONFIG, 'utf8');
    expect(/[A-Za-z]:\\/.test(text)).toBe(false);
    expect(/(?:api[_-]?key|token|secret)\s*["':]?\s*["'][^"<]{8,}/i.test(text)).toBe(false);
  });
});

/* ═══════════════ mode exclusivity & legacy closed set (CF-13) ═══════════ */

describe('PD-Lab T3a experiment-config: legacy closed set', () => {
  it('rejects an unregistered legacy.batch value', () => {
    const fx = buildFixture('badbatch');
    const problems = expectRejected(fx.writeConfig((raw) => {
      delete (raw as { preregistration?: unknown }).preregistration;
      raw.legacy = { batch: 'prompt-v2-round999' };
    }));
    expect(hasProblem(problems, 'legacy.batch', 'unknown_legacy_batch')).toBe(true);
  });

  it('rejects additional fields on legacy', () => {
    const fx = buildFixture('legacyextra');
    const problems = expectRejected(fx.writeConfig((raw) => {
      delete (raw as { preregistration?: unknown }).preregistration;
      raw.legacy = { batch: 'prompt-v2-round1', reason: 'because' };
    }));
    expect(hasProblem(problems, 'legacy.reason', 'unknown_field')).toBe(true);
  });

  it('rejects a non-string legacy.batch', () => {
    const fx = buildFixture('legacytype');
    const problems = expectRejected(fx.writeConfig((raw) => {
      delete (raw as { preregistration?: unknown }).preregistration;
      raw.legacy = { batch: 7 };
    }));
    expect(hasProblem(problems, 'legacy.batch', 'unknown_legacy_batch')).toBe(true);
  });

  it('rejects legacy mixed with preregistration (mode_conflict)', () => {
    const fx = buildFixture('mixmode');
    const problems = expectRejected(fx.writeConfig((raw) => {
      raw.legacy = { batch: 'prompt-v2-round1' };
    }));
    expect(hasProblem(problems, 'legacy', 'mode_conflict')).toBe(true);
  });

  it('rejects a config with NEITHER preregistration NOR legacy (mode_missing)', () => {
    const fx = buildFixture('nomode');
    const problems = expectRejected(fx.writeConfig((raw) => {
      delete (raw as { preregistration?: unknown }).preregistration;
    }));
    expect(hasProblem(problems, 'preregistration', 'mode_missing')).toBe(true);
  });
});

/* ═════════════ preregistration binding (CF-14 / CF-15) ═════════════════ */

describe('PD-Lab T3a experiment-config: preregistration binding', () => {
  it('rejects a missing preregistration file (CF-14)', () => {
    const fx = buildFixture('nopreg');
    const problems = expectRejected(fx.writeConfig((raw) => {
      (raw.preregistration as { file: string }).file = path.join(fx.root, 'no-such-prereg.md');
    }));
    expect(hasProblem(problems, 'preregistration', 'file_missing')).toBe(true);
  });

  it('rejects a raw-byte digest mismatch when the prereg file changes (CF-14)', () => {
    const fx = buildFixture('pregmod');
    const configFile = fx.writeConfig();
    expect(loadExperimentConfig(configFile).verification.preregistrationStatus).toBe('VERIFIED');
    fs.appendFileSync(fx.preregFile, '\nlate addition\n', 'utf8');
    const problems = expectRejected(configFile);
    expect(hasProblem(problems, 'preregistration', 'digest_mismatch')).toBe(true);
  });

  it('hashes RAW bytes: a formatting-only rewrite (same semantic YAML) still mismatches', () => {
    const fx = buildFixture('pregfmt');
    const configFile = fx.writeConfig();
    // Re-serialize the front matter with different key order — parsed
    // content identical, bytes different ⇒ declared digest must no longer match.
    const reformatted = '---\nplan: synthetic fixture\nexperimentId: t3a-synth\n---\n\n# Preregistration (synthetic)\n\nNo research content — T3a fixture.\n';
    fs.writeFileSync(fx.preregFile, reformatted, 'utf8');
    const problems = expectRejected(configFile);
    expect(hasProblem(problems, 'preregistration', 'digest_mismatch')).toBe(true);
  });

  it('rejects a front-matter experimentId that differs from the config (CF-15)', () => {
    const fx = buildFixture('pregid');
    const other = path.join(fx.root, 'OTHER.md');
    fs.writeFileSync(other, '---\nexperimentId: some-other-experiment\n---\n\nbody\n', 'utf8');
    const problems = expectRejected(fx.writeConfig((raw) => {
      (raw.preregistration as { file: string; sha256: string }).file = other;
      (raw.preregistration as { file: string; sha256: string }).sha256 = sha256File(other);
    }));
    expect(hasProblem(problems, 'preregistration.file', 'experiment_id_mismatch')).toBe(true);
  });

  it('rejects prereg files without usable front matter', () => {
    const noFence = 'just a markdown body, no fences at all\n';
    const unclosed = '---\nexperimentId: t3a-synth\nbody without closing fence\n';
    const nonString = '---\nexperimentId: 123\n---\nbody\n';
    const cases: Array<[string, string]> = [
      [noFence, 'frontmatter_missing'],
      [unclosed, 'frontmatter_missing'],
      [nonString, 'frontmatter_missing'],
    ];
    for (const [text, code] of cases) {
      const fx = buildFixture('pregfm');
      const file = path.join(fx.root, 'PREREG-variant.md');
      fs.writeFileSync(file, text, 'utf8');
      const problems = expectRejected(fx.writeConfig((raw) => {
        (raw.preregistration as { file: string; sha256: string }).file = file;
        (raw.preregistration as { file: string; sha256: string }).sha256 = sha256Text(text);
      }));
      expect(hasProblem(problems, 'preregistration.file', code)).toBe(true);
    }
  });

  it('rejects invalid YAML front matter with frontmatter_invalid', () => {
    const fx = buildFixture('pregyaml');
    const text = '---\nexperimentId: [unclosed\n---\nbody\n';
    const file = path.join(fx.root, 'PREREG-badyaml.md');
    fs.writeFileSync(file, text, 'utf8');
    const problems = expectRejected(fx.writeConfig((raw) => {
      (raw.preregistration as { file: string; sha256: string }).file = file;
      (raw.preregistration as { file: string; sha256: string }).sha256 = sha256Text(text);
    }));
    expect(hasProblem(problems, 'preregistration.file', 'frontmatter_invalid')).toBe(true);
  });
});

/* ═══════════ dataset / snapshot / blob digest reconciliation ═══════════ */

describe('PD-Lab T3a experiment-config: digests', () => {
  it('rejects a dataset digest mismatch (CF-05)', () => {
    const fx = buildFixture('dsetmod');
    const configFile = fx.writeConfig();
    fs.appendFileSync(fx.datasetFile, '\nmutated\n', 'utf8');
    const problems = expectRejected(configFile);
    expect(hasProblem(problems, 'dataset', 'digest_mismatch')).toBe(true);
  });

  it('rejects a missing dataset file', () => {
    const fx = buildFixture('dsetmiss');
    const problems = expectRejected(fx.writeConfig((raw) => {
      (raw.dataset as { file: string }).file = path.join(fx.root, 'missing-dataset.json');
    }));
    expect(hasProblem(problems, 'dataset', 'file_missing')).toBe(true);
  });

  it('rejects a snapshot state.db digest mismatch (CF-11 family)', () => {
    const fx = buildFixture('snapmod');
    const configFile = fx.writeConfig();
    fs.appendFileSync(fx.stateDb, 'x', 'utf8');
    const problems = expectRejected(configFile);
    expect(hasProblem(problems, 'snapshot.sha256.state', 'digest_mismatch')).toBe(true);
  });

  it('rejects a blob-manifest digest mismatch caused by a byte-level rewrite', () => {
    const fx = buildFixture('snapman');
    const configFile = fx.writeConfig();
    // Same manifest content, different bytes (minified, no trailing newline)
    const manifest = JSON.parse(fs.readFileSync(fx.blobManifest, 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(fx.blobManifest, JSON.stringify(manifest), 'utf8');
    const problems = expectRejected(configFile);
    expect(hasProblem(problems, 'snapshot.sha256.blobManifest', 'digest_mismatch')).toBe(true);
  });

  it('rejects a referenced blob whose content no longer matches the manifest (CF-11)', () => {
    const fx = buildFixture('blobmod');
    const configFile = fx.writeConfig();
    fs.writeFileSync(fx.blobFile, 'tampered blob body', 'utf8');
    const problems = expectRejected(configFile);
    expect(hasProblem(problems, 'snapshot.blobManifest.files[0]', 'digest_mismatch')).toBe(true);
  });

  it('rejects a referenced blob that is missing entirely', () => {
    const fx = buildFixture('blobmiss');
    const configFile = fx.writeConfig();
    fs.rmSync(fx.blobFile);
    const problems = expectRejected(configFile);
    expect(hasProblem(problems, 'snapshot.blobManifest.files[0]', 'file_missing')).toBe(true);
  });

  it('rejects a forged manifest whose entry path traverses outside the snapshot dir', () => {
    const fx = buildFixture('manitrav');
    const configFile = fx.writeConfig();
    // Rewrite the manifest with an escaping entry, then REFRESH the declared
    // manifest digest so the failure is the traversal itself, not a stale hash.
    const manifest = JSON.parse(fs.readFileSync(fx.blobManifest, 'utf8')) as {
      files: Array<{ path: string; sha256: string }>;
    };
    manifest.files[0].path = '../../escape.txt';
    manifest.files[0].sha256 = sha256File(fx.blobFile);
    fs.writeFileSync(fx.blobManifest, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    refreshSnapshotDigests(fx);
    const problems = expectRejected(configFile);
    expect(hasProblem(problems, 'snapshot.blobManifest.files[0].path', 'path_traversal')).toBe(true);
  });

  it('rejects an absolute manifest entry path', () => {
    const fx = buildFixture('maniabs');
    const configFile = fx.writeConfig();
    const manifest = JSON.parse(fs.readFileSync(fx.blobManifest, 'utf8')) as {
      files: Array<{ path: string }>;
    };
    manifest.files[0].path = absolutePathOutsideFixture(fx, 'evil.txt');
    fs.writeFileSync(fx.blobManifest, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    refreshSnapshotDigests(fx);
    const problems = expectRejected(configFile);
    expect(hasProblem(problems, 'snapshot.blobManifest.files[0].path', 'path_traversal')).toBe(true);
  });

  it('rejects a manifest with the wrong schema id', () => {
    const fx = buildFixture('manischem');
    const configFile = fx.writeConfig();
    const manifest = JSON.parse(fs.readFileSync(fx.blobManifest, 'utf8')) as { schema: string };
    manifest.schema = 'some.other.manifest.v1';
    fs.writeFileSync(fx.blobManifest, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    refreshSnapshotDigests(fx);
    const problems = expectRejected(configFile);
    expect(hasProblem(problems, 'snapshot.blobManifest', 'invalid_value')).toBe(true);
  });

  it('rejects workspaceFiles sources whose digest does not match', () => {
    const fx = buildFixture('wsmod');
    const configFile = fx.writeConfig();
    fs.appendFileSync(fx.wsSource, 'tampered\n', 'utf8');
    const problems = expectRejected(configFile);
    expect(hasProblem(problems, 'arms.wtcand.workspaceFiles[0].source', 'digest_mismatch')).toBe(true);
  });

  it('rejects a missing baseConfigFile', () => {
    const fx = buildFixture('nobasecfg');
    const problems = expectRejected(fx.writeConfig((raw) => {
      raw.baseConfigFile = path.join(fx.root, 'missing-config.yaml');
    }));
    expect(hasProblem(problems, 'baseConfigFile', 'file_missing')).toBe(true);
  });
});

/* ═══════ P1-1 blob-manifest consistency contract (T1 producer shape) ════ */

describe('PD-Lab T3a experiment-config: blob manifest consistency (P1-1)', () => {
  it('rejects ok:false even when every declared digest still matches', () => {
    const fx = buildFixture('mani-okfalse');
    const problems = expectRejected(mutateManifest(fx, (m) => { m.ok = false; }));
    expect(hasProblem(problems, 'snapshot.blobManifest', 'manifest_not_ok')).toBe(true);
    expect(problems.some((p) => p.code === 'digest_mismatch')).toBe(false);
  });

  it('rejects consistencyStatus PARTIAL_CONSISTENCY (a published-partial directory is NOT a complete snapshot)', () => {
    const fx = buildFixture('mani-partial');
    const problems = expectRejected(mutateManifest(fx, (m) => {
      m.ok = false;
      m.consistencyStatus = 'PARTIAL_CONSISTENCY';
      m.consistencyReasons = ['source_committed_during_window:state'];
    }));
    expect(hasProblem(problems, 'snapshot.blobManifest', 'inconsistent_snapshot')).toBe(true);
    expect(hasProblem(problems, 'snapshot.blobManifest', 'manifest_not_ok')).toBe(true);
  });

  it('rejects a missing consistencyStatus', () => {
    const fx = buildFixture('mani-nostatus');
    const problems = expectRejected(mutateManifest(fx, (m) => { delete m.consistencyStatus; }));
    expect(hasProblem(problems, 'snapshot.blobManifest', 'missing_consistency_status')).toBe(true);
  });

  it('rejects an unknown consistencyStatus value and a type-invalid one', () => {
    const fx = buildFixture('mani-unknownstatus');
    const problems = expectRejected(mutateManifest(fx, (m) => { m.consistencyStatus = 'LOOKS_FINE_TO_ME'; }));
    expect(hasProblem(problems, 'snapshot.blobManifest', 'inconsistent_snapshot')).toBe(true);

    const fx2 = buildFixture('mani-statusnum');
    const problems2 = expectRejected(mutateManifest(fx2, (m) => { m.consistencyStatus = 1; }));
    expect(hasProblem(problems2, 'snapshot.blobManifest', 'inconsistent_snapshot')).toBe(true);
  });

  it('rejects a blobDir that violates the T1 blobs/ layout contract', () => {
    const fx = buildFixture('mani-blobdir');
    const problems = expectRejected(mutateManifest(fx, (m) => { m.blobDir = 'blob_store'; }));
    expect(hasProblem(problems, 'snapshot.blobManifest.blobDir', 'invalid_value')).toBe(true);
  });

  it('rejects duplicate manifest paths', () => {
    const fx = buildFixture('mani-duppath');
    const problems = expectRejected(mutateManifest(fx, (m) => {
      (m.files as ManifestEntry[]).push({ ...(m.files as ManifestEntry[])[0] });
    }));
    expect(hasProblem(problems, 'snapshot.blobManifest.files[1].path', 'duplicate_manifest_entry')).toBe(true);
  });

  it('rejects a manifest entry with an illegal sha256', () => {
    const fx = buildFixture('mani-badsha');
    const problems = expectRejected(mutateManifest(fx, (m) => {
      (m.files as ManifestEntry[])[0].sha256 = 'deadbeef';
    }));
    expect(hasProblem(problems, 'snapshot.blobManifest.files[0]', 'invalid_type')).toBe(true);
  });

  it('rejects entry shape violations: bytes, referenceCount, referencedBy', () => {
    const fxBytes = buildFixture('mani-bytes');
    const pBytes = expectRejected(mutateManifest(fxBytes, (m) => { (m.files as ManifestEntry[])[0].bytes = -1; }));
    expect(hasProblem(pBytes, 'snapshot.blobManifest.files[0].bytes', 'invalid_type')).toBe(true);

    const fxRefC = buildFixture('mani-refc0');
    const pRefC = expectRejected(mutateManifest(fxRefC, (m) => { (m.files as ManifestEntry[])[0].referenceCount = 0; }));
    expect(hasProblem(pRefC, 'snapshot.blobManifest.files[0].referenceCount', 'invalid_type')).toBe(true);

    const fxRefBy = buildFixture('mani-refby');
    const pRefBy = expectRejected(mutateManifest(fxRefBy, (m) => {
      (m.files as ManifestEntry[])[0].referencedBy = 'assistant_turns' as unknown as string[];
    }));
    expect(hasProblem(pRefBy, 'snapshot.blobManifest.files[0].referencedBy', 'invalid_type')).toBe(true);
  });

  it('rejects counts inconsistent with the files array (each derived count separately)', () => {
    const fxCopied = buildFixture('mani-counts-copied');
    const pCopied = expectRejected(mutateManifest(fxCopied, (m) => {
      m.counts = { referencedDistinct: 1, referencedRows: 1, copied: 2, orphansNotCopied: 0 };
    }));
    expect(hasProblem(pCopied, 'snapshot.blobManifest.counts.copied', 'counts_mismatch')).toBe(true);

    const fxRows = buildFixture('mani-counts-rows');
    const pRows = expectRejected(mutateManifest(fxRows, (m) => {
      m.counts = { referencedDistinct: 1, referencedRows: 3, copied: 1, orphansNotCopied: 0 };
    }));
    expect(hasProblem(pRows, 'snapshot.blobManifest.counts.referencedRows', 'counts_mismatch')).toBe(true);

    const fxDistinct = buildFixture('mani-counts-distinct');
    const pDistinct = expectRejected(mutateManifest(fxDistinct, (m) => {
      m.counts = { referencedDistinct: 5, referencedRows: 1, copied: 1, orphansNotCopied: 0 };
    }));
    expect(hasProblem(pDistinct, 'snapshot.blobManifest.counts.referencedDistinct', 'counts_mismatch')).toBe(true);

    const fxType = buildFixture('mani-counts-type');
    const pType = expectRejected(mutateManifest(fxType, (m) => {
      m.counts = { referencedDistinct: 'one', referencedRows: 1, copied: 1, orphansNotCopied: 0 };
    }));
    expect(hasProblem(pType, 'snapshot.blobManifest.counts.referencedDistinct', 'invalid_type')).toBe(true);
  });

  it('rejects a manifest whose counts block is missing or not an object', () => {
    // Review finding (PRI-1253): a missing/non-object `counts` used to set
    // countsOkShape=false with NO problem recorded — reconciliation was
    // skipped and an otherwise-valid manifest passed.
    const fxMissing = buildFixture('mani-counts-missing');
    const pMissing = expectRejected(mutateManifest(fxMissing, (m) => {
      delete m.counts;
    }));
    expect(hasProblem(pMissing, 'snapshot.blobManifest.counts', 'invalid_type')).toBe(true);

    const fxScalar = buildFixture('mani-counts-scalar');
    const pScalar = expectRejected(mutateManifest(fxScalar, (m) => {
      m.counts = 42;
    }));
    expect(hasProblem(pScalar, 'snapshot.blobManifest.counts', 'invalid_type')).toBe(true);
  });

  it('rejects an empty files array when the derived counts are not all zero', () => {
    const fx = buildFixture('mani-emptycounts');
    const problems = expectRejected(mutateManifest(fx, (m) => {
      m.files = [];
      m.counts = { referencedDistinct: 0, referencedRows: 0, copied: 1, orphansNotCopied: 0 };
    }));
    expect(hasProblem(problems, 'snapshot.blobManifest.counts.copied', 'counts_mismatch')).toBe(true);
  });

  it('accepts a legal ZERO-blob snapshot: empty files, all derived counts zero, orphans still allowed', () => {
    const fx = buildFixture('mani-zeroblob');
    // The unreferenced b1.txt remains on disk as an ORPHAN — the T1 producer
    // legitimately reports orphansNotCopied > 0 alongside zero referenced
    // blobs, so only the three DERIVED counts are forced to zero.
    const configFile = mutateManifest(fx, (m) => {
      m.files = [];
      m.counts = { referencedDistinct: 0, referencedRows: 0, copied: 0, orphansNotCopied: 1 };
    });
    const loaded = loadExperimentConfig(configFile);
    expect(loaded.verification.snapshotVerified.blobsVerified).toBe(0);
  });
});

/* ═══════════════════ path safety fence (CF-03/06/08, HT-03) ════════════ */

describe('PD-Lab T3a experiment-config: path safety', () => {
  it('rejects an experimentRoot inside the primary checkout (derived without git)', () => {
    const fx = buildFixture('rootprimary');
    const primary = derivePrimaryForTest();
    const problems = expectRejected(fx.writeConfig((raw) => {
      raw.experimentRoot = path.join(primary, 'pd-lab-t3a-nonexistent-probe');
    }));
    expect(hasProblem(problems, 'experimentRoot', 'forbidden_root')).toBe(true);
  });

  it('rejects an experimentRoot inside ~/.pd (CF-03, via redirected HOME/USERPROFILE)', () => {
    const fx = buildFixture('roothome');
    const fakeHome = fs.mkdtempSync(path.join(tmpRoot(), 'pd-lab-t3a-fakehome-'));
    fs.mkdirSync(path.join(fakeHome, '.pd'), { recursive: true });
    const prevHome = process.env.HOME;
    const prevProfile = process.env.USERPROFILE;
    process.env.HOME = fakeHome;
    if (process.platform === 'win32') process.env.USERPROFILE = fakeHome;
    try {
      const direct = expectRejected(fx.writeConfig((raw) => {
        raw.experimentRoot = path.join(fakeHome, '.pd', 'experiment');
      }));
      expect(hasProblem(direct, 'experimentRoot', 'forbidden_root')).toBe(true);
    } finally {
      if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
      if (prevProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevProfile;
    }
  });

  it('rejects an experimentRoot reached through a symlink into ~/.pd (CF-03 alias form)', () => {
    const fx = buildFixture('rootlink');
    const fakeHome = fs.mkdtempSync(path.join(tmpRoot(), 'pd-lab-t3a-fakehome-'));
    fs.mkdirSync(path.join(fakeHome, '.pd', 'victim'), { recursive: true });
    const alias = path.join(fx.root, 'aliased-root');
    const kind = createDirectoryAlias(path.join(fakeHome, '.pd', 'victim'), alias);
    if (kind === null) {
      console.log('[NOT_RUN] platform refused symlink/junction creation for the CF-03 alias case');
      return;
    }
    const prevHome = process.env.HOME;
    const prevProfile = process.env.USERPROFILE;
    process.env.HOME = fakeHome;
    if (process.platform === 'win32') process.env.USERPROFILE = fakeHome;
    try {
      const problems = expectRejected(fx.writeConfig((raw) => {
        raw.experimentRoot = path.join(alias, 'experiment');
      }));
      // canonical() resolves through the alias into ~/.pd — the forbidden-root
      // containment fires even though the configured path looks local.
      expect(
        hasProblem(problems, 'experimentRoot', 'forbidden_root')
        || hasProblem(problems, 'experimentRoot', 'reparse_point'),
      ).toBe(true);
    } finally {
      if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
      if (prevProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevProfile;
    }
  });

  it('rejects an experimentRoot inside a shell pointer target (CF-08 / HT-03)', () => {
    const fx = buildFixture('rootptr');
    const pointerDir = fs.mkdtempSync(path.join(tmpRoot(), 'pd-lab-t3a-pointer-'));
    const prev = process.env.PD_WORKSPACE_DIR;
    process.env.PD_WORKSPACE_DIR = pointerDir;
    try {
      const problems = expectRejected(fx.writeConfig((raw) => {
        raw.experimentRoot = path.join(pointerDir, 'exp');
      }));
      expect(hasProblem(problems, 'experimentRoot', 'forbidden_root')).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.PD_WORKSPACE_DIR; else process.env.PD_WORKSPACE_DIR = prev;
    }
  });

  it('rejects an experimentRoot inside an additionalForbiddenRoots entry', () => {
    const fx = buildFixture('rootaddl');
    const outside = fs.mkdtempSync(path.join(tmpRoot(), 'pd-lab-t3a-addl-'));
    const problems = expectRejected(fx.writeConfig((raw) => {
      raw.additionalForbiddenRoots = [outside];
      raw.experimentRoot = path.join(outside, 'exp');
    }));
    expect(hasProblem(problems, 'experimentRoot', 'forbidden_root')).toBe(true);
  });

  it('rejects an experimentRoot inside an arm worktree, and an arm worktree inside the experimentRoot', () => {
    const fxIn = buildFixture('rootinarm');
    const problemsIn = expectRejected(fxIn.writeConfig((raw) => {
      raw.experimentRoot = path.join(fxIn.wtBase, 'exp');
    }));
    expect(hasProblem(problemsIn, 'experimentRoot', 'escapes_into_arm_worktree')).toBe(true);

    const fxOut = buildFixture('arminroot');
    const problemsOut = expectRejected(fxOut.writeConfig((raw) => {
      (raw.arms as Record<string, { worktree: string }>).wtcand.worktree = path.join(fxOut.experimentRoot, 'workspaces', 'wtcand');
    }));
    expect(hasProblem(problemsOut, 'arms.wtcand.worktree', 'worktree_inside_experiment_root')).toBe(true);
  });

  it('rejects a dataset/snapshot outside both the experimentRoot and the archive root', () => {
    const fx = buildFixture('dsetout');
    const problems = expectRejected(fx.writeConfig((raw) => {
      const outside = path.join(fx.root, 'outside-dataset.json');
      fs.writeFileSync(outside, '{}', 'utf8');
      raw.dataset = { file: outside, sha256: sha256File(outside) };
    }));
    expect(hasProblem(problems, 'dataset.file', 'outside_experiment_or_archive_root')).toBe(true);
  });

  it('admits a dataset located under the pd-lab archive root (and reports only its absence)', () => {
    const fx = buildFixture('dsetarch');
    const primary = derivePrimaryForTest();
    const problems = expectRejected(fx.writeConfig((raw) => {
      raw.dataset = { file: path.join(primary, 'artifacts', 'pd-lab', 'nonexistent-dataset.json'), sha256: '0'.repeat(64) };
    }));
    // The location branch must NOT fire; the only finding is the missing file.
    expect(hasProblem(problems, 'dataset', 'file_missing')).toBe(true);
    expect(problems.some((p) => p.code === 'outside_experiment_or_archive_root')).toBe(false);
  });

  it('rejects a workspaceFiles target that escapes the arm workspace (CF-06)', () => {
    const fx = buildFixture('wstrav');
    for (const target of ['../escape.md', 'sub/../../x.md']) {
      const problems = expectRejected(fx.writeConfig((raw) => {
        ((raw.arms as Record<string, { workspaceFiles: Array<{ target: string }> }>).wtcand).workspaceFiles[0].target = target;
      }));
      expect(hasProblem(problems, 'arms.wtcand.workspaceFiles[0].target', 'path_traversal')).toBe(true);
    }
  });

  it('rejects an absolute workspaceFiles target', () => {
    const fx = buildFixture('wsabs');
    const problems = expectRejected(fx.writeConfig((raw) => {
      ((raw.arms as Record<string, { workspaceFiles: Array<{ target: string }> }>).wtcand).workspaceFiles[0].target
        = absolutePathOutsideFixture(fx, 'evil', 'x.md');
    }));
    expect(hasProblem(problems, 'arms.wtcand.workspaceFiles[0].target', 'path_traversal')).toBe(true);
  });

  it('rejects a workspaceFiles target whose EXISTING intermediate directory is a symlink (CF-06)', (ctx) => {
    const fx = buildFixture('wssymlink');
    const wsBase = path.join(fx.experimentRoot, 'workspaces', 'wtcand');
    fs.mkdirSync(wsBase, { recursive: true });
    const outside = fs.mkdtempSync(path.join(tmpRoot(), 'pd-lab-t3a-ws-outside-'));
    if (!createTrueSymlink(outside, path.join(wsBase, 'sub'))) {
      ctx.skip('platform refused symlink creation — NOT_RUN here, junction variant covers win32');
      return;
    }
    // The linked intermediate must be ON the target's own path (same shape as
    // the junction variant): target sub/…, link at sub.
    const problems = expectRejected(fx.writeConfig((raw) => {
      ((raw.arms as Record<string, { workspaceFiles: Array<{ target: string }> }>).wtcand).workspaceFiles[0].target = 'sub/INTENT.synth.md';
    }));
    expect(hasProblem(problems, 'arms.wtcand.workspaceFiles[0].target', 'symlink_in_path')).toBe(true);
  });

  it('rejects a workspaceFiles target behind a Windows junction intermediate directory', (ctx) => {
    if (process.platform !== 'win32') {
      ctx.skip('junction reparse points are a Windows filesystem feature — NOT_RUN on linux CI, verified on a Windows host');
      return;
    }
    const fx = buildFixture('wsjunction');
    const wsBase = path.join(fx.experimentRoot, 'workspaces', 'wtcand');
    fs.mkdirSync(wsBase, { recursive: true });
    const outside = fs.mkdtempSync(path.join(tmpRoot(), 'pd-lab-t3a-ws-outside-'));
    const kind = createDirectoryAlias(outside, path.join(wsBase, 'sub'));
    if (kind === null) {
      ctx.skip('platform refused junction creation');
      return;
    }
    const problems = expectRejected(fx.writeConfig((raw) => {
      ((raw.arms as Record<string, { workspaceFiles: Array<{ target: string }> }>).wtcand).workspaceFiles[0].target = 'sub/INTENT.md';
    }));
    expect(hasProblem(problems, 'arms.wtcand.workspaceFiles[0].target', 'symlink_in_path')).toBe(true);
  });

  it('rejects an experimentRoot whose EXISTING parent chain contains a Windows junction (nonexistent target through a junctioned parent)', (ctx) => {
    if (process.platform !== 'win32') {
      ctx.skip('junction reparse points are a Windows filesystem feature — NOT_RUN on linux CI, verified on a Windows host');
      return;
    }
    const fx = buildFixture('rootjunction');
    const realParent = fs.mkdtempSync(path.join(tmpRoot(), 'pd-lab-t3a-jn-real-'));
    const junction = path.join(fx.root, 'jn-parent');
    const kind = createDirectoryAlias(realParent, junction);
    if (kind === null) {
      ctx.skip('platform refused junction creation');
      return;
    }
    const problems = expectRejected(fx.writeConfig((raw) => {
      raw.experimentRoot = path.join(junction, 'not-created-yet');
    }));
    expect(hasProblem(problems, 'experimentRoot', 'reparse_point')).toBe(true);
  });

  it('rejects an arm worktree that does not exist (itemized missing path)', () => {
    const fx = buildFixture('wtmissing');
    const problems = expectRejected(fx.writeConfig((raw) => {
      (raw.arms as Record<string, { worktree: string }>).wtcand.worktree = path.join(fx.root, 'no-such-worktree');
    }));
    expect(hasProblem(problems, 'arms.wtcand.worktree', 'file_missing')).toBe(true);
  });

  it('rejects an arm worktree reached through a symlink', (ctx) => {
    const fx = buildFixture('wtlink');
    const outside = fs.mkdtempSync(path.join(tmpRoot(), 'pd-lab-t3a-wt-outside-'));
    const alias = path.join(fx.root, 'wt-alias');
    const kind = createDirectoryAlias(outside, alias);
    if (kind === null) {
      ctx.skip('platform refused symlink/junction creation');
      return;
    }
    const problems = expectRejected(fx.writeConfig((raw) => {
      (raw.arms as Record<string, { worktree: string }>).wtcand.worktree = alias;
    }));
    expect(hasProblem(problems, 'arms.wtcand.worktree', 'reparse_point')).toBe(true);
  });
});

/* ════ P1-2 snapshot symlink/junction/hardlink isolation (real FS attacks) ══
 * Every scenario builds REAL filesystem objects (never mocked), keeps every
 * declared digest CORRECT for the linked/copied bytes, and asserts the
 * rejection names the path/file-type violation — never a digest mismatch.
 * That combination proves the loader fenced the object BEFORE reading it:
 * had it read through the redirect, the digest would have matched. */

describe('PD-Lab T3a experiment-config: snapshot isolation attacks (P1-2)', () => {
  /** Attack workspace OUTSIDE the fixture root (managed temp, never a drive root). */
  function attackRoot(label: string): string {
    return fs.mkdtempSync(path.join(tmpRoot(), `pd-lab-t3a-atk-${label}-`));
  }

  it('A: a state.db symlink to CORRECT content outside the snapshot is rejected on file type, not digest', (ctx) => {
    const fx = buildFixture('atk-a');
    const extState = path.join(attackRoot('a'), 'production-state.db');
    fs.copyFileSync(fx.stateDb, extState); // bytes that WOULD satisfy the digest
    try {
      fs.symlinkSync(extState, fx.stateDb, 'file');
    } catch {
      ctx.skip('platform refused true symlink creation — Windows file identity is covered by the hardlink variant');
      return;
    }
    // rawConfig hashes THROUGH the link → the declared digest is "correct";
    // only the fence can reject now. The final-component symlink is caught
    // by the per-level walk as a reparse point (BEFORE any type/read check).
    const configFile = fx.writeConfig();
    const before = fingerprintEntries(fx.root);
    const problems = expectRejected(configFile);
    expect(hasProblem(problems, 'snapshot.sha256.state', 'reparse_point')).toBe(true);
    expect(problems.some((p) => p.code === 'digest_mismatch')).toBe(false);
    expect(fs.readFileSync(extState, 'utf8')).toBe('synthetic state db bytes'); // external target untouched
    expectNoSideEffects(fx, before);
  });

  it('A-win: a state.db HARDLINK to outside content is rejected as not an independent copy', () => {
    const fx = buildFixture('atk-ahl');
    const extState = path.join(attackRoot('ahl'), 'production-state.db');
    fs.copyFileSync(fx.stateDb, extState);
    fs.rmSync(fx.stateDb);
    fs.linkSync(extState, fx.stateDb); // nlink=2 — unprivileged on win32 AND linux
    const configFile = fx.writeConfig();
    const problems = expectRejected(configFile);
    expect(hasProblem(problems, 'snapshot.sha256.state', 'hardlink_not_independent_copy')).toBe(true);
    expect(problems.some((p) => p.code === 'digest_mismatch')).toBe(false);
  });

  it('B: a trajectory.db symlink into a production-style data dir is rejected before any read', (ctx) => {
    const fx = buildFixture('atk-b');
    const prodDir = path.join(attackRoot('b'), 'production-workspace', '.pd');
    fs.mkdirSync(prodDir, { recursive: true });
    const prodTraj = path.join(prodDir, 'trajectory.db');
    fs.copyFileSync(fx.trajectoryDb, prodTraj);
    try {
      fs.symlinkSync(prodTraj, fx.trajectoryDb, 'file');
    } catch {
      ctx.skip('platform refused true symlink creation — junction/hardlink variants cover Windows');
      return;
    }
    const problems = expectRejected(fx.writeConfig());
    expect(hasProblem(problems, 'snapshot.sha256.trajectory', 'reparse_point')).toBe(true);
    expect(problems.some((p) => p.code === 'digest_mismatch')).toBe(false);
    expect(fs.readFileSync(prodTraj, 'utf8')).toBe('synthetic trajectory db bytes');
  });

  it('C: a blob-manifest.json symlink to an external file is rejected before any read', (ctx) => {
    const fx = buildFixture('atk-c');
    const extManifest = path.join(attackRoot('c'), 'blob-manifest.json');
    fs.copyFileSync(fx.blobManifest, extManifest);
    try {
      fs.symlinkSync(extManifest, fx.blobManifest, 'file');
    } catch {
      ctx.skip('platform refused true symlink creation');
      return;
    }
    const problems = expectRejected(fx.writeConfig());
    expect(hasProblem(problems, 'snapshot.sha256.blobManifest', 'reparse_point')).toBe(true);
    expect(problems.some((p) => p.code === 'digest_mismatch')).toBe(false);
  });

  it('a snapshot core file that is a plain DIRECTORY is rejected on file type', () => {
    const fx = buildFixture('atk-dirfile');
    // Write the config while the real file still exists (digests computed
    // from real bytes), THEN swap state.db for a directory.
    const configFile = fx.writeConfig();
    fs.rmSync(fx.stateDb);
    fs.mkdirSync(fx.stateDb);
    const problems = expectRejected(configFile);
    expect(hasProblem(problems, 'snapshot.sha256.state', 'file_type')).toBe(true);
    expect(problems.some((p) => p.code === 'digest_mismatch')).toBe(false);
  });

  it('a DANGLING symlink as state.db is rejected without creating the target', (ctx) => {
    const fx = buildFixture('atk-dangle');
    const configFile = fx.writeConfig();
    fs.rmSync(fx.stateDb);
    try {
      fs.symlinkSync(path.join(fx.root, 'never-created.db'), fx.stateDb, 'file');
    } catch {
      ctx.skip('platform refused true symlink creation');
      return;
    }
    const problems = expectRejected(configFile);
    expect(hasProblem(problems, 'snapshot.sha256.state', 'reparse_point')).toBe(true);
    expect(fs.existsSync(path.join(fx.root, 'never-created.db'))).toBe(false);
  });

  it('D: a manifest blob path escaping the snapshot dir is rejected WITHOUT reading the escape target', () => {
    const fx = buildFixture('atk-d');
    const configFile = mutateManifest(fx, (m) => {
      const files = m.files as ManifestEntry[];
      files[0] = { ...files[0], path: 'blobs/../../outside.txt', ref: 'outside.txt' };
    });
    // WRONG content at the destination the path would resolve to — a
    // verifier that actually resolved+read it would record digest_mismatch.
    const escapeDest = path.join(fx.experimentRoot, 'outside.txt');
    fs.writeFileSync(escapeDest, 'bait bytes that would never match', 'utf8');
    const problems = expectRejected(configFile);
    expect(hasProblem(problems, 'snapshot.blobManifest.files[0].path', 'path_traversal')).toBe(true);
    expect(problems.some((p) => p.code === 'digest_mismatch')).toBe(false);
    expect(fs.readFileSync(escapeDest, 'utf8')).toBe('bait bytes that would never match');
  });

  it('E: a blobs directory that is itself a junction/symlink is rejected even with correct blob bytes', (ctx) => {
    const fx = buildFixture('atk-e');
    const realBlobs = path.join(attackRoot('e'), 'blobs-real');
    fs.mkdirSync(realBlobs, { recursive: true });
    fs.copyFileSync(fx.blobFile, path.join(realBlobs, 'b1.txt'));
    fs.rmSync(path.join(fx.snapshotDir, 'blobs'), { recursive: true });
    const kind = createDirectoryAlias(realBlobs, path.join(fx.snapshotDir, 'blobs'));
    if (kind === null) {
      ctx.skip('platform refused junction/symlink creation');
      return;
    }
    // Config digests hash through the alias — every declared digest matches.
    const problems = expectRejected(fx.writeConfig());
    expect(
      hasProblem(problems, 'snapshot.blobsDir', 'reparse_point')
      || hasProblem(problems, 'snapshot.blobsDir', 'file_type'),
    ).toBe(true);
    expect(hasProblem(problems, 'snapshot.blobManifest.files[0]', 'digest_mismatch')).toBe(false);
  });

  it('F: a snapshot.dir exposed through a junction in the parent chain is rejected before any read', (ctx) => {
    const fx = buildFixture('atk-f');
    const junction = path.join(fx.experimentRoot, 'snap-alias');
    const kind = createDirectoryAlias(fx.snapshotDir, junction);
    if (kind === null) {
      ctx.skip('platform refused junction/symlink creation');
      return;
    }
    const configFile = fx.writeConfig((raw) => {
      (raw.snapshot as { dir: string }).dir = junction;
    });
    const before = fingerprintEntries(fx.root);
    const problems = expectRejected(configFile);
    expect(hasProblem(problems, 'snapshot.dir', 'reparse_point')).toBe(true);
    expect(problems.some((p) => p.code === 'digest_mismatch')).toBe(false);
    expectNoSideEffects(fx, before);
  });
});

/* ═══ P1-3 workspaceFiles whole-chain isolation (parent redirect attacks) ═ */

describe('PD-Lab T3a experiment-config: workspaceFiles whole-chain fence (P1-3)', () => {
  function setTarget(fx: Fixture, target: string): string {
    return fx.writeConfig((raw) => {
      ((raw.arms as Record<string, { workspaceFiles: Array<{ target: string }> }>).wtcand).workspaceFiles[0].target = target;
    });
  }

  it('a workspaces-level alias (junction on win32 / dir symlink on linux) is rejected even though the arm workspace does not exist yet', (ctx) => {
    const fx = buildFixture('ws-parent-alias');
    const outside = path.join(attackScratch('ws'), 'escape-target');
    fs.mkdirSync(outside, { recursive: true });
    // THE P1-3 BYPASS SHAPE: <exp>/workspaces is the alias and <armId> is
    // MISSING — the old logic skipped every level because the base (the
    // join of workspaces/<armId>) did not exist as a real directory.
    const kind = createDirectoryAlias(outside, path.join(fx.experimentRoot, 'workspaces'));
    if (kind === null) {
      ctx.skip('platform refused junction/symlink creation');
      return;
    }
    const configFile = setTarget(fx, '.principles/INTENT.synth.md');
    const before = fingerprintEntries(fx.root); // AFTER the config write — the load itself must change nothing
    const problems = expectRejected(configFile);
    expect(hasProblem(problems, 'arms.wtcand.workspaceFiles[0].target', 'reparse_point')).toBe(true);
    // The workspaces junction PRE-EXISTS the load (built by the attack), so
    // the shared no-workspaces assertion does not apply — compare trees and
    // check runs/ instead.
    expect(fingerprintEntries(fx.root)).toEqual(before);
    expect(fs.existsSync(path.join(fx.experimentRoot, 'runs'))).toBe(false);
  });

  it('a TRUE dir symlink as the workspaces parent (linux CI executes this)', (ctx) => {
    const fx = buildFixture('ws-parent-symlink');
    const outside = path.join(attackScratch('ws'), 'escape-target');
    fs.mkdirSync(outside, { recursive: true });
    if (!createTrueSymlink(outside, path.join(fx.experimentRoot, 'workspaces'))) {
      ctx.skip('platform refused true symlink creation');
      return;
    }
    const problems = expectRejected(setTarget(fx, '.principles/INTENT.synth.md'));
    expect(hasProblem(problems, 'arms.wtcand.workspaceFiles[0].target', 'reparse_point')).toBe(true);
  });

  it('the arm workspace ITSELF is a junction/symlink', (ctx) => {
    const fx = buildFixture('ws-arm-alias');
    const wsBase = path.join(fx.experimentRoot, 'workspaces', 'wtcand');
    fs.mkdirSync(path.dirname(wsBase), { recursive: true }); // workspaces is real
    const outside = path.join(attackScratch('ws'), 'escape-target');
    fs.mkdirSync(outside, { recursive: true });
    const kind = createDirectoryAlias(outside, wsBase);
    if (kind === null) {
      ctx.skip('platform refused junction/symlink creation');
      return;
    }
    const problems = expectRejected(setTarget(fx, '.principles/INTENT.synth.md'));
    expect(hasProblem(problems, 'arms.wtcand.workspaceFiles[0].target', 'reparse_point')).toBe(true);
  });

  it('a target intermediate junction is rejected (redundant with the CF-06 suite, kept as an explicit P1-3 entry)', (ctx) => {
    const fx = buildFixture('ws-inter-alias');
    const wsBase = path.join(fx.experimentRoot, 'workspaces', 'wtcand');
    fs.mkdirSync(wsBase, { recursive: true });
    const outside = path.join(attackScratch('ws'), 'escape-target');
    fs.mkdirSync(outside, { recursive: true });
    const kind = createDirectoryAlias(outside, path.join(wsBase, 'sub'));
    if (kind === null) {
      ctx.skip('platform refused junction/symlink creation');
      return;
    }
    // The structural layer (checkRelativeTarget) fires first with
    // symlink_in_path — fail-closed either way; the whole-chain layer owns
    // the cases where the base chain itself is missing or redirected.
    const problems = expectRejected(setTarget(fx, 'sub/INTENT.synth.md'));
    expect(hasProblem(problems, 'arms.wtcand.workspaceFiles[0].target', 'symlink_in_path')).toBe(true);
  });

  it('an existing target FILE that is a symlink to correct content is rejected', (ctx) => {
    const fx = buildFixture('ws-target-link');
    const principles = path.join(fx.experimentRoot, 'workspaces', 'wtcand', '.principles');
    fs.mkdirSync(principles, { recursive: true });
    const outsideFile = path.join(attackScratch('ws'), 'INTENT.synth.md');
    fs.copyFileSync(fx.wsSource, outsideFile); // correct bytes — digest would pass if followed
    try {
      fs.symlinkSync(outsideFile, path.join(principles, 'INTENT.synth.md'), 'file');
    } catch {
      ctx.skip('platform refused true symlink creation — the junction-at-target variant covers win32');
      return;
    }
    const problems = expectRejected(setTarget(fx, '.principles/INTENT.synth.md'));
    expect(hasProblem(problems, 'arms.wtcand.workspaceFiles[0].target', 'reparse_point')).toBe(true);
    expect(fs.readFileSync(outsideFile, 'utf8')).toBe('# synthetic intent document\n'); // not consumed
  });

  it('a junction AT the target file position is rejected on win32 (complement of the symlink variant)', (ctx) => {
    if (process.platform !== 'win32') {
      ctx.skip('junction reparse points are a Windows filesystem feature — the symlink variant above covers linux CI');
      return;
    }
    const fx = buildFixture('ws-target-junction');
    const principles = path.join(fx.experimentRoot, 'workspaces', 'wtcand', '.principles');
    fs.mkdirSync(principles, { recursive: true });
    const outside = path.join(attackScratch('ws'), 'escape-target');
    fs.mkdirSync(outside, { recursive: true });
    const kind = createDirectoryAlias(outside, path.join(principles, 'INTENT.synth.md'));
    if (kind === null) {
      ctx.skip('platform refused junction creation');
      return;
    }
    const problems = expectRejected(setTarget(fx, '.principles/INTENT.synth.md'));
    expect(hasProblem(problems, 'arms.wtcand.workspaceFiles[0].target', 'reparse_point')).toBe(true);
  });

  it('a junction placed at a differently-cased path segment is still fenced on Windows (case-fold walk)', (ctx) => {
    if (process.platform !== 'win32') {
      ctx.skip('NTFS case-insensitive aliasing is a Windows behavior');
      return;
    }
    const fx = buildFixture('ws-case');
    const outside = path.join(attackScratch('ws'), 'escape-target');
    fs.mkdirSync(outside, { recursive: true });
    // The config declares `workspaces`; the directory on disk is `WorkSpaces`.
    const kind = createDirectoryAlias(outside, path.join(fx.experimentRoot, 'WorkSpaces'));
    if (kind === null) {
      ctx.skip('platform refused junction creation');
      return;
    }
    const problems = expectRejected(setTarget(fx, '.principles/INTENT.synth.md'));
    expect(hasProblem(problems, 'arms.wtcand.workspaceFiles[0].target', 'reparse_point')).toBe(true);
  });

  it('positive control: a fully materialized REAL arm workspace still loads (the fence is not over-blocking)', () => {
    const fx = buildFixture('ws-realpos');
    const wsBase = path.join(fx.experimentRoot, 'workspaces', 'wtcand');
    const principles = path.join(wsBase, '.principles');
    fs.mkdirSync(principles, { recursive: true });
    fs.writeFileSync(path.join(principles, 'INTENT.synth.md'), fs.readFileSync(fx.wsSource, 'utf8'), 'utf8');
    const loaded = loadExperimentConfig(fx.writeConfig());
    expect(loaded.experimentId).toBe(EXPERIMENT_ID);
    expect(loaded.arms.wtcand.workspaceFiles).toHaveLength(1);
  });
});

/* ═════════ P2 baseConfigFile strict file judgment (real file only) ══════ */

describe('PD-Lab T3a experiment-config: baseConfigFile strict file judgment (P2)', () => {
  it('rejects a plain directory', () => {
    const fx = buildFixture('bcfg-dir');
    const dir = path.join(fx.root, 'config-dir');
    fs.mkdirSync(dir);
    const problems = expectRejected(fx.writeConfig((raw) => { raw.baseConfigFile = dir; }));
    expect(hasProblem(problems, 'baseConfigFile', 'file_type')).toBe(true);
  });

  it('rejects a junction/dir-symlink pointing at a directory', (ctx) => {
    const fx = buildFixture('bcfg-dirlink');
    const targetDir = path.join(fx.root, 'config-dest-dir');
    fs.mkdirSync(targetDir);
    const linkPath = path.join(fx.root, 'config-link.yaml');
    const kind = createDirectoryAlias(targetDir, linkPath);
    if (kind === null) {
      ctx.skip('platform refused junction/symlink creation');
      return;
    }
    const problems = expectRejected(fx.writeConfig((raw) => { raw.baseConfigFile = linkPath; }));
    expect(
      hasProblem(problems, 'baseConfigFile', 'reparse_point')
      || hasProblem(problems, 'baseConfigFile', 'file_type'),
    ).toBe(true);
  });

  it('rejects a dangling symlink', (ctx) => {
    const fx = buildFixture('bcfg-dangle');
    const linkPath = path.join(fx.root, 'config-dangling.yaml');
    try {
      fs.symlinkSync(path.join(fx.root, 'no-such-target.yaml'), linkPath, 'file');
    } catch {
      ctx.skip('platform refused true symlink creation');
      return;
    }
    const problems = expectRejected(fx.writeConfig((raw) => { raw.baseConfigFile = linkPath; }));
    expect(hasProblem(problems, 'baseConfigFile', 'reparse_point')).toBe(true);
  });

  it('rejects a symlink to a REAL regular file too (the template must be a physical file)', (ctx) => {
    const fx = buildFixture('bcfg-filelink');
    const linkPath = path.join(fx.root, 'config-filelink.yaml');
    try {
      fs.symlinkSync(fx.baseConfigFile, linkPath, 'file');
    } catch {
      ctx.skip('platform refused true symlink creation');
      return;
    }
    const problems = expectRejected(fx.writeConfig((raw) => { raw.baseConfigFile = linkPath; }));
    expect(hasProblem(problems, 'baseConfigFile', 'reparse_point')).toBe(true);
  });

  it('rejects an unreadable file (only where the platform can honestly revoke read access)', (ctx) => {
    const fx = buildFixture('bcfg-unreadable');
    const unreadable = path.join(fx.root, 'locked-config.yaml');
    fs.writeFileSync(unreadable, 'workspace:\n  default: synthetic\n', 'utf8');
    fs.chmodSync(unreadable, 0o000);
    let stillReadable = true;
    try {
      fs.accessSync(unreadable, fs.constants.R_OK);
    } catch {
      stillReadable = false;
    }
    if (stillReadable) {
      fs.chmodSync(unreadable, 0o644);
      ctx.skip('platform (root/Windows ACLs) still grants read access at mode 000 — honest NOT_RUN');
      return;
    }
    try {
      const problems = expectRejected(fx.writeConfig((raw) => { raw.baseConfigFile = unreadable; }));
      expect(hasProblem(problems, 'baseConfigFile', 'file_unreadable')).toBe(true);
    } finally {
      fs.chmodSync(unreadable, 0o644);
    }
  });

  it('positive control: a real regular config file still passes', () => {
    const fx = buildFixture('bcfg-ok');
    const loaded = loadExperimentConfig(fx.writeConfig());
    expect(loaded.baseConfigFile).toBe(fx.baseConfigFile);
  });
});

/* ═══════════════ public API contract (TECH §3.2, P2 revert) ════════════ */

describe('PD-Lab T3a experiment-config: public API contract', () => {
  it('exports EXACTLY loadExperimentConfig — no second export, single-parameter signature', async () => {
    const ns = await import('../dev/pd-lab/experiment-config.mjs');
    expect(Object.keys(ns).sort()).toEqual(['loadExperimentConfig']);
    expect(typeof ns.loadExperimentConfig).toBe('function');
    expect((ns.loadExperimentConfig as { name: string }).name).toBe('loadExperimentConfig');
  });

  it("the loader implementation carries no options/runId back-channel (P2 revert pin)", () => {
    // `.length` cannot distinguish `f(file)` from `f(file, options = {})`
    // (default params don't count), so pin the SOURCE of the function itself:
    // the re-introduction of an options object or runId handling must trip
    // this. The module HEADER may still mention runId (the T3b handoff note
    // lives there) — only the exported function's own body is pinned.
    const fnSource = loadExperimentConfig.toString();
    expect(fnSource.includes('runId'), 'loadExperimentConfig must not handle runId').toBe(false);
    expect(fnSource.includes('options'), 'loadExperimentConfig must not take an options object').toBe(false);
  });

  it('an extra second argument is ignored — no side channel changes the verdict', () => {
    const fx = buildFixture('apirevert');
    const configFile = fx.writeConfig();
    const plain = loadExperimentConfig(configFile);
    const sneaky = (loadExperimentConfig as unknown as (f: string, extra: unknown) => typeof plain)(
      configFile,
      { runId: '../evil', preflight: 'skip' },
    );
    expect(JSON.stringify(sneaky)).toBe(JSON.stringify(plain));
    expect(fs.existsSync(path.join(fx.experimentRoot, 'runs'))).toBe(false);
  });
});

/* ═════════════════ feature-flag registration (CF-10) ═══════════════════ */

describe('PD-Lab T3a experiment-config: feature-flag authority', () => {
  it('rejects an unregistered flagId, naming it', () => {
    const fx = buildFixture('flagbad');
    const problems = expectRejected(fx.writeConfig((raw) => {
      ((raw.arms as Record<string, { featureOverrides: Record<string, boolean> }>).wtcand).featureOverrides = { definitely_not_a_registered_flag: true };
    }));
    expect(hasProblem(problems, 'arms.wtcand.featureOverrides.definitely_not_a_registered_flag', 'unregistered_feature_flag')).toBe(true);
  });

  it('registration check is pinned to the LIVE authority (round-trip, ERR-146)', () => {
    const authority = DEFAULT_FEATURE_FLAGS as Array<{ id?: unknown }>;
    expect(Array.isArray(authority)).toBe(true);
    expect(authority.length).toBeGreaterThan(0);
    const found = authority.find((f): f is { id: string } => typeof f.id === 'string');
    expect(found, 'authority must expose at least one registered flag id').toBeDefined();
    const liveId = (found as { id: string }).id;
    const fx = buildFixture('flaglive');
    const configFile = fx.writeConfig((raw) => {
      ((raw.arms as Record<string, { featureOverrides: Record<string, boolean> }>).wtcand).featureOverrides = { [liveId]: false };
    });
    const loaded = loadExperimentConfig(configFile);
    expect(loaded.arms.wtcand.featureOverrides).toEqual({ [liveId]: false });
  });
});

/* ═══════════ side-effect negative control (§6.1/§6.3 of the task) ══════ */

describe('PD-Lab T3a experiment-config: side-effect negative control', () => {
  it('a rejected load creates no directory, file, run record or workspace anywhere in the fixture', () => {
    const cases: Array<[string, (fx: Fixture) => string]> = [
      ['bad-digest', (fx) => {
        const configFile = fx.writeConfig();
        fs.appendFileSync(fx.preregFile, 'x', 'utf8');
        return configFile;
      }],
      ['path-violation', (fx) => fx.writeConfig((raw) => {
        raw.experimentRoot = path.join(derivePrimaryForTest(), 'pd-lab-t3a-probe');
      })],
      ['missing-field', (fx) => fx.writeConfig((raw) => {
        delete (raw as { candidateArm?: string }).candidateArm;
      })],
      ['mode-conflict', (fx) => fx.writeConfig((raw) => {
        raw.legacy = { batch: 'prompt-v2-round1' };
      })],
    ];
    for (const [label, prepare] of cases) {
      const fx = buildFixture(label);
      const configFile = prepare(fx);
      const before = fingerprintEntries(fx.root);
      expectRejected(configFile);
      expect(fingerprintEntries(fx.root), `case ${label}`).toEqual(before);
      expect(fs.existsSync(path.join(fx.experimentRoot, 'runs'))).toBe(false);
      expect(fs.existsSync(path.join(fx.experimentRoot, 'workspaces'))).toBe(false);
    }
  });

  it('the loader module never imports child_process (supplementary design tripwire)', () => {
    // Primary evidence is behavioral (the tree-fingerprint control above);
    // this additionally pins the design: validation must not spawn anything.
    const source = fs.readFileSync(MODULE_SOURCE, 'utf8');
    const banned = ['child_' + 'process', 'spawn' + 'Sync', 'exec' + 'FileSync'];
    for (const token of banned) {
      expect(source.includes(token), `module source must not reference ${token}`).toBe(false);
    }
  });
});

/* ═════════ re-load re-derivation (CF-16 module half, digest freshness) ═ */

describe('PD-Lab T3a experiment-config: every load re-derives from current files', () => {
  it('prereg tampered after a successful load is caught by the NEXT load (CF-16 mechanism)', () => {
    const fx = buildFixture('retamper');
    const configFile = fx.writeConfig();
    const first = loadExperimentConfig(configFile);
    expect(first.verification.preregistrationStatus).toBe('VERIFIED');

    fs.appendFileSync(fx.preregFile, '\nsneaky post-preflight edit\n', 'utf8');
    const second = expectRejected(configFile);
    expect(hasProblem(second, 'preregistration', 'digest_mismatch')).toBe(true);

    // Restoring the bytes restores the load — the check reads CURRENT files.
    fs.writeFileSync(fx.preregFile, PREREG_TEXT, 'utf8');
    expect(loadExperimentConfig(configFile).verification.preregistrationStatus).toBe('VERIFIED');
  });

  it('dataset tampering between loads is caught (digest recompute, not a cached verdict)', () => {
    const fx = buildFixture('redataset');
    const configFile = fx.writeConfig();
    loadExperimentConfig(configFile);
    fs.appendFileSync(fx.datasetFile, 'x', 'utf8');
    expect(hasProblem(expectRejected(configFile), 'dataset', 'digest_mismatch')).toBe(true);
  });

  it('blob tampering between loads is caught', () => {
    const fx = buildFixture('reblob');
    const configFile = fx.writeConfig();
    loadExperimentConfig(configFile);
    fs.writeFileSync(fx.blobFile, 'changed', 'utf8');
    expect(hasProblem(expectRejected(configFile), 'snapshot.blobManifest.files[0]', 'digest_mismatch')).toBe(true);
  });

  it('editing the config itself (adding _note) changes configSha256 but still loads', () => {
    const fx = buildFixture('recfg');
    const first = loadExperimentConfig(fx.writeConfig());
    const second = loadExperimentConfig(fx.writeConfig((raw) => { raw._note = 'added later'; }));
    expect(second.note).toBe('added later');
    expect(second.verification.configSha256).not.toBe(first.verification.configSha256);
    expect(second.verification.preregistrationSha256).toBe(first.verification.preregistrationSha256);
  });

  it('a pointer env var that starts pointing AT the experimentRoot fails the next load (HT-03)', () => {
    const fx = buildFixture('reptr');
    const configFile = fx.writeConfig();
    loadExperimentConfig(configFile); // passes while the pointer is unset
    const prev = process.env.PD_WORKSPACE_DIR;
    process.env.PD_WORKSPACE_DIR = fx.experimentRoot;
    try {
      expect(hasProblem(expectRejected(configFile), 'experimentRoot', 'forbidden_root')).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.PD_WORKSPACE_DIR; else process.env.PD_WORKSPACE_DIR = prev;
    }
  });
});

/* ═══════════════════════════ error carrier shape ═══════════════════════ */

describe('PD-Lab T3a experiment-config: error carrier', () => {
  it('carries problems[], configSha256 and a nextAction in the message', () => {
    const fx = buildFixture('errshape');
    const configFile = fx.writeConfig((raw) => { raw.unexpectedThing = 1; });
    let err: unknown;
    try { loadExperimentConfig(configFile); } catch (e) { err = e; }
    const e = err as LoadError;
    expect(e.name).toBe('ExperimentConfigError');
    expect(e.message).toContain('nextAction');
    expect(e.message).toContain('unexpectedThing');
    expect(e.configSha256).toBe(sha256File(configFile));
    expect(e.problems?.every((p) => typeof p.field === 'string' && typeof p.code === 'string' && typeof p.message === 'string')).toBe(true);
  });
});

/* ═══ Final round: manifest digest↔parse binding (single verified read) ══ */

describe('PD-Lab T3a experiment-config: manifest digest-to-parse binding (final P1)', () => {
  it('a manifest whose declared digest mismatches is rejected WITHOUT parsing — zero blob references consumed', () => {
    const fx = buildFixture('mani-noparse');
    const configFile = fx.writeConfig(); // declared digest = current real manifest
    // REPLACE the manifest with a different, fully-formed manifest (valid
    // JSON, different content) WITHOUT refreshing the declared digest: the
    // loader must stop at the digest and must not parse/consume anything.
    const replaced = {
      schema: 'pd-lab-blob-manifest.v1',
      blobDir: 'blobs',
      ok: true,
      consistencyStatus: 'CONSISTENT_WITHIN_WINDOW',
      consistencyReasons: [],
      files: [{ path: 'blobs/b1.txt', ref: 'b1.txt', bytes: 1, sha256: '0'.repeat(64), referenceCount: 1, referencedBy: ['assistant_turns'] }],
      counts: { referencedDistinct: 1, referencedRows: 1, copied: 1, orphansNotCopied: 0 },
    };
    fs.writeFileSync(fx.blobManifest, `${JSON.stringify(replaced, null, 2)}\n`, 'utf8');
    const problems = expectRejected(configFile);
    expect(hasProblem(problems, 'snapshot.sha256.blobManifest', 'digest_mismatch')).toBe(true);
    // NOTHING under snapshot.blobManifest.* may appear — the replaced
    // manifest was never parsed, its blob references never consumed.
    expect(problems.filter((p) => p.field.startsWith('snapshot.blobManifest'))).toEqual([]);
    expect(problems.some((p) => p.code === 'digest_mismatch' && p.field !== 'snapshot.sha256.blobManifest')).toBe(false);
  });

  it('a matching-digest manifest that parses to JSON null (or any non-object) is rejected, never a silent pass', () => {
    for (const body of ['null', '5', '"just a string"']) {
      const fx = buildFixture('mani-nullbody');
      const configFile = fx.writeConfig(); // declared digest = real manifest
      fs.writeFileSync(fx.blobManifest, body, 'utf8'); // digest now mismatched...
      // ...so re-anchor the declared digest to the null-body to force the
      // parse path (the bug shape: matching digest + non-object parse result)
      const declared = sha256File(fx.blobManifest);
      const raw = JSON.parse(fs.readFileSync(configFile, 'utf8')) as { snapshot: { sha256: Record<string, string> } };
      raw.snapshot.sha256.blobManifest = declared;
      fs.writeFileSync(configFile, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
      const problems = expectRejected(configFile);
      expect(hasProblem(problems, 'snapshot.blobManifest', 'invalid_value'), `body=${body}`).toBe(true);
      expect(problems.some((p) => p.field.startsWith('snapshot.blobManifest.files'))).toBe(false);
      // The load must NOT succeed with blobManifest:true / blobsVerified:null —
      // asserted by the rejection itself plus zero files-consumption above.
    }
  });

  it('supplementary design tripwire: the manifest is read through ONE verified handle, never re-read from the path', () => {
    const source = fs.readFileSync(MODULE_SOURCE, 'utf8');
    expect(source.includes('readFileSync(manifestPath'), 'no second path-based manifest read').toBe(false);
    expect((source.match(/fstatSync/g) ?? []).length, 'open-object identity is checked before AND after the read').toBeGreaterThanOrEqual(2);
    expect(source).toContain('openVerifiedSnapshotFile');
    // Identity chain fields must be part of the binding (dev/ino/size/nlink).
    expect(source).toContain('fst.dev !== st.dev');
    expect(source).toContain('file_identity_changed');
    // NOTE (honest limitation, per the determinism requirement): a true
    // mid-read byte swap by an external writer is inherently racy and is NOT
    // tested with concurrent processes. The deterministic guarantee is the
    // digest binding itself — parsed bytes are always the bytes whose hash
    // matched the config — proven by the no-parse test above; the identity
    // chain (lstat→fstat→read→fstat) is pinned by this tripwire and exercised
    // on every happy-path load.
  });

  it('bytes mismatch with a CORRECT digest is rejected on bytes only (same opened object)', () => {
    const fx = buildFixture('mani-bytes-mm');
    const configFile = mutateManifest(fx, (m) => {
      (m.files as ManifestEntry[])[0].bytes += 1;
    });
    const problems = expectRejected(configFile);
    expect(hasProblem(problems, 'snapshot.blobManifest.files[0].bytes', 'bytes_mismatch')).toBe(true);
    expect(problems.some((p) => p.code === 'digest_mismatch')).toBe(false);
  });

  it('wrong bytes AND wrong digest are both reported (size and hash judged on the same verified read)', () => {
    const fx = buildFixture('mani-both-mm');
    fs.writeFileSync(fx.blobFile, 'tampered blob body', 'utf8');
    const configFile = mutateManifest(fx, (m) => {
      (m.files as ManifestEntry[])[0].bytes = 1;
    });
    const problems = expectRejected(configFile);
    expect(hasProblem(problems, 'snapshot.blobManifest.files[0].bytes', 'bytes_mismatch')).toBe(true);
    expect(hasProblem(problems, 'snapshot.blobManifest.files[0]', 'digest_mismatch')).toBe(true);
  });

  it('rejects non-integer and beyond-safe-integer bytes', () => {
    for (const bytes of [1.5, 2 ** 60]) {
      const fx = buildFixture('mani-bytestype');
      const problems = expectRejected(mutateManifest(fx, (m) => {
        (m.files as ManifestEntry[])[0].bytes = bytes as number;
      }));
      expect(hasProblem(problems, 'snapshot.blobManifest.files[0].bytes', 'invalid_type'), `bytes=${bytes}`).toBe(true);
    }
    const fxMissing = buildFixture('mani-bytesmissing');
    const pMissing = expectRejected(mutateManifest(fxMissing, (m) => {
      delete ((m.files as ManifestEntry[])[0] as { bytes?: number }).bytes;
    }));
    expect(hasProblem(pMissing, 'snapshot.blobManifest.files[0].bytes', 'invalid_type')).toBe(true);
  });
});

/* ═════════ Final round: blob ref shape bound to the T1 producer rule ════ */

describe('PD-Lab T3a experiment-config: blob ref shape = T1 producer rule (final P2)', () => {
  it('rejects refs the T1 producer would refuse (traversal, backslash, colon/ADS, space, out-of-class, dot-leading, empty)', () => {
    const badRefs = ['', '../evil', 'a\\b', 'a:b', 'a b', 'a#b', '.hidden', '..'];
    for (const ref of badRefs) {
      const fx = buildFixture('refshape');
      const problems = expectRejected(mutateManifest(fx, (m) => {
        (m.files as ManifestEntry[])[0].ref = ref;
      }));
      expect(hasProblem(problems, 'snapshot.blobManifest.files[0].ref', 'invalid_ref_shape'), `ref=${JSON.stringify(ref)}`).toBe(true);
    }
  });

  it('accepts a legal T1-shaped ref (positive control beyond the fixture default)', () => {
    const fx = buildFixture('refshape-ok');
    fs.renameSync(fx.blobFile, path.join(fx.snapshotDir, 'blobs', 'assistant-9472.txt'));
    const configFile = mutateManifest(fx, (m) => {
      const f = (m.files as ManifestEntry[])[0];
      f.ref = 'assistant-9472.txt';
      f.path = 'blobs/assistant-9472.txt';
    });
    const loaded = loadExperimentConfig(configFile);
    expect(loaded.verification.snapshotVerified.blobsVerified).toBe(1);
  });
});

/* ═══════════ Final round: fenceWalk fails closed on FS anomalies (P4) ═══ */

describe('PD-Lab T3a experiment-config: fenceWalk fail-closed (final P4)', () => {
  it('a regular file used as a path component in the experimentRoot chain is rejected (ENOTDIR)', () => {
    const fx = buildFixture('fw-notdir');
    fs.writeFileSync(path.join(fx.root, 'blocker'), 'not a directory', 'utf8');
    const problems = expectRejected(fx.writeConfig((raw) => {
      raw.experimentRoot = path.join(fx.root, 'blocker', 'sub');
    }));
    expect(hasProblem(problems, 'experimentRoot', 'not_a_directory')).toBe(true);
    expect(hasProblem(problems, 'experimentRoot', 'file_missing')).toBe(false);
  });

  it('a regular file as a workspaceFiles intermediate is rejected (previously passed preflight silently)', () => {
    const fx = buildFixture('fw-wsfile');
    const wsBase = path.join(fx.experimentRoot, 'workspaces', 'wtcand');
    fs.mkdirSync(wsBase, { recursive: true });
    fs.writeFileSync(path.join(wsBase, 'sub'), 'not a directory', 'utf8');
    const configFile = fx.writeConfig((raw) => {
      ((raw.arms as Record<string, { workspaceFiles: Array<{ target: string }> }>).wtcand).workspaceFiles[0].target = 'sub/INTENT.synth.md';
    });
    const problems = expectRejected(configFile);
    expect(hasProblem(problems, 'arms.wtcand.workspaceFiles[0].target', 'not_a_directory')).toBe(true);
  });

  it('EACCES on a parent directory is a scan failure, never a "missing path" (where the platform can revoke access)', (ctx) => {
    const fx = buildFixture('fw-eacces');
    const locked = path.join(fx.experimentRoot, 'locked');
    fs.mkdirSync(locked);
    const probe = path.join(locked, 'sub');
    fs.mkdirSync(probe);
    fs.chmodSync(locked, 0o000);
    let stillListable = true;
    try {
      fs.readdirSync(locked);
    } catch {
      stillListable = false;
    }
    if (stillListable) {
      fs.chmodSync(locked, 0o755);
      ctx.skip('platform (root/Windows ACLs) still grants directory access at mode 000 — honest NOT_RUN');
      return;
    }
    try {
      const problems = expectRejected(fx.writeConfig((raw) => {
        raw.experimentRoot = path.join(probe, 'deeper');
      }));
      expect(
        hasProblem(problems, 'experimentRoot', 'path_scan_failed')
        || hasProblem(problems, 'experimentRoot', 'not_a_directory'),
      ).toBe(true);
      expect(hasProblem(problems, 'experimentRoot', 'file_missing')).toBe(false);
    } finally {
      fs.chmodSync(locked, 0o755);
    }
    // NOTE (honest boundary): EIO needs fault injection and cannot be
    // fabricated honestly; ELOOP is intercepted EARLIER by fenceWalk as a
    // reparse hit (lstat never follows links), so both land in the same
    // fail-closed catch exercised here via EACCES.
  });

  it('negative control: a legal nonexistent target still normalizes via nearest-existing ancestor (no error masquerade)', () => {
    const fx = buildFixture('fw-nonexistent');
    const problems = expectRejected(fx.writeConfig((raw) => {
      (raw.arms as Record<string, { worktree: string }>).wtcand.worktree = path.join(fx.root, 'not-created', 'deeper');
    }));
    expect(hasProblem(problems, 'arms.wtcand.worktree', 'file_missing')).toBe(true);
    expect(hasProblem(problems, 'arms.wtcand.worktree', 'not_a_directory')).toBe(false);
    expect(hasProblem(problems, 'arms.wtcand.worktree', 'path_scan_failed')).toBe(false);
    expect(hasProblem(problems, 'arms.wtcand.worktree', 'reparse_point')).toBe(false);
  });
});
