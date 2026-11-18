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

interface LoadError extends Error {
  problems?: Array<{ field: string; code: string; message: string }>;
  configSha256?: string;
}

/** Assert a rejection and return its problems for precise code/field checks. */
function expectRejected(configFile: string, options?: { runId?: string }): Array<{ field: string; code: string; message: string }> {
  let err: unknown;
  try {
    loadExperimentConfig(configFile, options);
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

/** rel path -> sha256 for every file under dir (side-effect detector). */
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
      if (st.isDirectory()) {
        out.set(`${prefix}${entry}/`, '<dir>');
        walk(full, `${prefix}${entry}/`);
      } else {
        out.set(`${prefix}${entry}`, sha256File(full));
      }
    }
  };
  walk(dir, '');
  return out;
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
    const problems = expectRejected(fx.writeConfig());
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

/* ═══════════════════════════ runId fence (§4.5) ════════════════════════ */

describe('PD-Lab T3a experiment-config: runId fence', () => {
  it('rejects a traversing runId before it can be joined into a path', () => {
    const fx = buildFixture('runid');
    const configFile = fx.writeConfig();
    // Separator/spaced forms fail the pattern outright:
    for (const runId of ['../evil', 'a/b', 'a\\b', 'a b']) {
      const problems = expectRejected(configFile, { runId });
      expect(hasProblem(problems, 'runId', 'invalid_run_id'), `runId=${runId}`).toBe(true);
    }
    // '.'-only forms MATCH the TECH pattern but must still be refused by the
    // strict under-runs re-check — path.join would normalize them onto the
    // runs dir itself or the experiment root.
    for (const runId of ['..', '.']) {
      const problems = expectRejected(configFile, { runId });
      expect(hasProblem(problems, 'runId', 'path_traversal'), `runId=${runId}`).toBe(true);
    }
  });

  it('accepts a well-formed runId and creates nothing', () => {
    const fx = buildFixture('runidok');
    const configFile = fx.writeConfig();
    const before = fingerprintTree(fx.root);
    const loaded = loadExperimentConfig(configFile, { runId: 'run.2026-11-18_a' });
    expect(loaded.experimentId).toBe(EXPERIMENT_ID);
    expect(fs.existsSync(path.join(fx.experimentRoot, 'runs'))).toBe(false);
    expect(Array.from(fingerprintTree(fx.root).keys())).toEqual(Array.from(before.keys()));
  });

  it('rejects a runId whose runs directory passes through a symlink (pre-write fence)', (ctx) => {
    const fx = buildFixture('runidlink');
    const outside = fs.mkdtempSync(path.join(tmpRoot(), 'pd-lab-t3a-runs-outside-'));
    const kind = createDirectoryAlias(outside, path.join(fx.experimentRoot, 'runs'));
    if (kind === null) {
      ctx.skip('platform refused symlink/junction creation');
      return;
    }
    const problems = expectRejected(fx.writeConfig(), { runId: 'legit-run' });
    expect(hasProblem(problems, 'runId', 'reparse_point')).toBe(true);
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
      const before = fingerprintTree(fx.root);
      expectRejected(configFile);
      const after = fingerprintTree(fx.root);
      expect(Array.from(after.entries()), `case ${label}`).toEqual(Array.from(before.entries()));
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
