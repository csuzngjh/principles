/**
 * PRI-1252 r1 (PD-Lab v0.3) — childEnv(extra) pointer re-injection guard.
 * PRI-1252 r2 (PR #2694 review round 3) — shard workspace realpath fence.
 *
 * r1 review defect (PR #2694): childEnv(extra) strips the five workspace/state
 * pointer vars from process.env, but then spreads `extra` OVER the stripped
 * result — so any caller could silently re-inject PD_STATE_DIR /
 * OPENCLAW_HOME / OPENCLAW_WORKSPACE / OPENCLAW_WORKSPACE_DIR, the exact
 * production-pointer hazard class the strip exists to prevent (2026-11-12
 * incident). The fix merges `extra` first and then force-strips the pointer
 * set, keeping PD_WORKSPACE_DIR as the ONLY pointer var `extra` may inject:
 * the experiment-sandbox pointer that runPd() (ab-lib.mjs) and runPdIn()
 * (ab-stage.mjs) legitimately inject, always an armWorkspaceDir() path under
 * EXPERIMENT_ROOT (rg evidence recorded in the PR).
 *
 * r2 review defect (PR #2694, reproduced on real Windows): preflightIsolation()
 * only validated the two FIXED v1/v2 arm workspaces while the actual shard
 * paths come from armWorkspaceDir(arm, shardId) — a junction planted at
 * `workspaces/v2-ssreview-probe` pointing outside the experiment root (or at
 * the production workspace) passed preflight (startsWith cannot resolve
 * junctions) and childEnv kept the escaped PD_WORKSPACE_DIR. The r2 fix adds
 * ONE unified physical validator (lexical + per-level reparse lstat + realpath
 * containment + production overlap) wired into preflightIsolation,
 * materializeWorkspace, the spawn wiring (spawnPdChild, used by runPd AND
 * runPdIn) and the childEnv PD_WORKSPACE_DIR value gate, plus structural
 * arm/shardId component validation in armWorkspaceDir.
 *
 * ONE FILE for both rounds on purpose: the fence scenarios plant REAL
 * junctions in the SHARED experiment root (EXPERIMENT_ROOT/workspaces), and
 * preflightIsolation() sweeps that same tree — running planter and sweeper in
 * parallel vitest workers would race (observed pre-merge). Within one file
 * vitest executes sequentially, so planter and sweeper never overlap.
 *
 * Coverage layers (EP-09: the negative control must fail against the pre-fix
 * state; tests must exercise the production boundary, not only the helper):
 *   1. unit — extra re-injecting each forbidden pointer is stripped
 *      (negative control that FAILED against the r1 pre-fix implementation);
 *   2. caller path — the real runPd() spawn wiring: the env argument actually
 *      handed to node:child_process.spawn carries exactly the sandbox
 *      PD_WORKSPACE_DIR and never a forbidden pointer;
 *   3. production isolation path — preflightIsolation() (the Gate 0 NC5
 *      gate) stays ok with production pointers planted in the parent env;
 *   4. tripwire — every `childEnv({ ... })` call site under the harness
 *      scripts injects only whitelisted pointer names (source scan);
 *   5. r2 fence — real-FS junction/symlink/traversal negative controls at
 *      preflight / materialize / spawn phases, with spawn-count proof that
 *      the child is never started for an out-of-bounds workspace.
 *
 * Run: npx vitest run experiment/prompt-v2/scripts/__tests__/pdspec001-childenv-pointer-isolation.test.ts
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXPERIMENT_ROOT,
  PRODUCTION_WORKSPACE,
  armWorkspaceDir,
  childEnv,
  materializeWorkspace,
  preflightIsolation,
  runPd,
} from '../ab/ab-lib.mjs';

/**
 * The workspace/state pointer vars the harness must keep out of every child
 * environment. TRIPWIRE — controlled duplication with a declared update
 * obligation: this list mirrors the strip list in ab-lib.mjs childEnv(), and
 * POINTER_ENV_VARS in scripts/__tests__/pd-lab-harness-characterization.test.ts
 * mirrors the same set. Adding/removing a pointer var in the harness strip
 * list MUST update all three lists in the same change (PRI-1252 r1).
 */
const POINTER_STRIP_LIST = [
  'PD_WORKSPACE_DIR',
  'OPENCLAW_WORKSPACE',
  'OPENCLAW_WORKSPACE_DIR',
  'PD_STATE_DIR',
  'OPENCLAW_HOME',
];

/**
 * Production state/host pointer vars that have NO legitimate `extra` caller:
 * rg evidence (PRI-1252 r1) — the only `childEnv({...})` injections in the
 * harness are `childEnv({ PD_WORKSPACE_DIR: ws })` in ab-lib.mjs runPd() and
 * ab-stage.mjs runPdIn(), with ws from armWorkspaceDir() (experiment
 * sandbox). These four must never survive, not even via `extra`.
 */
const FORBIDDEN_EXTRA_POINTERS = [
  'OPENCLAW_WORKSPACE',
  'OPENCLAW_WORKSPACE_DIR',
  'PD_STATE_DIR',
  'OPENCLAW_HOME',
];

/** Plant parent-env pointers for the duration of `run`, restore afterwards. */
async function withParentPointers<T>(plant: Record<string, string>, run: () => T | Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(plant)) {
    saved[name] = process.env[name];
    process.env[name] = value;
  }
  try {
    return await run();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

/** Worst-case parent env: every pointer carries a production-looking value. */
function allPointersPlanted(): Record<string, string> {
  return Object.fromEntries(POINTER_STRIP_LIST.map((name) => [name, `D:/.openclaw/workspace/prod-${name}`]));
}

/**
 * Capture what runPd() actually hands to spawn without running the pd-cli
 * child: spawn is replaced with a recorder that resolves the child on the
 * next microtask, and fs.existsSync is narrowed to the one check runPd()
 * performs (the arm pd-cli dist path — absent on clean CI runners).
 */
interface SpawnCall {
  file: string;
  args: string[];
  env: Record<string, string | undefined>;
  cwd: string | undefined;
}
const spawns = vi.hoisted(() => {
  const calls: { file: string; args: string[]; env: Record<string, string | undefined>; cwd: string | undefined }[] = [];
  return { calls };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const spawn = (file: string, args: string[], opts: { env?: Record<string, string | undefined>; cwd?: string }) => {
    spawns.calls.push({ file, args, env: opts?.env ?? {}, cwd: opts?.cwd });
    const child = {
      stdout: { on: () => undefined },
      stderr: { on: () => undefined },
      on: (event: string, cb: (code: number) => void) => {
        if (event === 'close') queueMicrotask(() => cb(0));
        return child;
      },
      kill: () => undefined,
    };
    return child;
  };
  return { ...actual, spawn };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  // PRI-1252 r2: ONLY runPd's arm pd-cli dist probe is pinned to true (the
  // dist is absent on clean CI runners); every other existsSync call falls
  // through to the REAL fs so the r2 fence scenarios below exercise real
  // junction/lstat/realpath physics. All other fs methods were always real.
  const isCliDist = (p: unknown) =>
    typeof p === 'string' && p.replace(/\\/g, '/').endsWith('/packages/pd-cli/dist/index.js');
  const patchedExists = (p: unknown) => (isCliDist(p) ? true : actual.existsSync(p as string));
  return {
    ...actual,
    default: Object.assign({}, actual.default, { existsSync: patchedExists }),
    existsSync: patchedExists,
  };
});

describe('PRI-1252 r1 — childEnv(extra) forbidden-pointer re-injection guard', () => {
  it('strips all four forbidden pointers when extra re-injects them (negative control — failed pre-fix)', async () => {
    await withParentPointers(allPointersPlanted(), async () => {
      const env = childEnv({
        OPENCLAW_WORKSPACE: 'D:/.openclaw/workspace',
        OPENCLAW_WORKSPACE_DIR: 'D:/.openclaw/workspace',
        PD_STATE_DIR: 'C:/Users/Administrator/.pd',
        OPENCLAW_HOME: 'C:/Users/Administrator/.openclaw',
        PD_CHAR_TEST_EXTRA_CONTROL: 'allowed',
      });
      for (const name of FORBIDDEN_EXTRA_POINTERS) {
        expect(Object.hasOwn(env, name), `childEnv(extra) must not let extra restore ${name}`).toBe(false);
      }
      // Control: a non-pointer var passed via extra must survive untouched —
      // the guard is a targeted pointer deny rule, not an extra wipe.
      expect(env['PD_CHAR_TEST_EXTRA_CONTROL']).toBe('allowed');
    });
  });

  it.each(FORBIDDEN_EXTRA_POINTERS)(
    'strips %s when extra is its only injection channel, independently of the parent env',
    async (name) => {
      await withParentPointers(allPointersPlanted(), async () => {
        const env = childEnv({ [name]: 'C:/Users/Administrator/production-pointer' });
        expect(Object.hasOwn(env, name), `extra-injected ${name} must be force-stripped`).toBe(false);
      });
    },
  );

  it('keeps the sandbox whitelist: PD_WORKSPACE_DIR from extra still wins over an inherited production pointer', async () => {
    await withParentPointers(allPointersPlanted(), async () => {
      const sandbox = armWorkspaceDir('v2', 'iso');
      const env = childEnv({ PD_WORKSPACE_DIR: sandbox });
      expect(env['PD_WORKSPACE_DIR']).toBe(sandbox);
      for (const name of FORBIDDEN_EXTRA_POINTERS) {
        expect(Object.hasOwn(env, name)).toBe(false);
      }
    });
  });

  it('runPd() hands spawn an env carrying exactly the sandbox PD_WORKSPACE_DIR and no forbidden pointer', async () => {
    spawns.calls.length = 0;
    const result = await withParentPointers(allPointersPlanted(), () =>
      runPd('v2', ['diagnose', 'run', '--task-id', 'iso-probe'], { shardId: 'iso' }),
    );
    expect(result.code).toBe(0);
    expect(spawns.calls).toHaveLength(1);
    const { args, env, cwd } = spawns.calls[0];
    const sandbox = armWorkspaceDir('v2', 'iso');
    expect(env['PD_WORKSPACE_DIR']).toBe(sandbox);
    for (const name of FORBIDDEN_EXTRA_POINTERS) {
      expect(Object.hasOwn(env, name), `spawn env must not carry ${name}`).toBe(false);
    }
    // The child resolves its workspace twice over: env pointer AND the
    // explicit --workspace flag/cwd, both pointing at the same sandbox path.
    expect(args).toContain('--workspace');
    expect(args[args.indexOf('--workspace') + 1]).toBe(sandbox);
    expect(cwd).toBe(sandbox);
    // spawn(process.execPath, [cli, ...]) — the CLI lives in args[0], not in file.
    expect(args[0].replace(/\\/g, '/').endsWith('packages/pd-cli/dist/index.js')).toBe(true);
  });

  it('preflightIsolation() stays ok with production pointers planted in the parent env (NC5 production path)', async () => {
    await withParentPointers(
      { PD_STATE_DIR: 'D:/some/production/state', OPENCLAW_HOME: 'C:/Users/Administrator/.openclaw' },
      async () => {
        const iso = preflightIsolation();
        expect(iso.failures).toEqual([]);
        expect(iso.ok).toBe(true);
      },
    );
  });

  it('every childEnv({ ... }) call site in the harness injects only whitelisted pointer names (source tripwire)', () => {
    const scriptsDir = path.resolve(fileURLToPath(import.meta.url), '..', '..', );
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.mjs')) files.push(full);
      }
    };
    walk(scriptsDir);
    expect(files.length).toBeGreaterThan(0);
    const allowed = ['PD_WORKSPACE_DIR'];
    const findings: string[] = [];
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      for (const m of src.matchAll(/childEnv\(\s*\{([^}]*)\}/g)) {
        for (const key of m[1].matchAll(/([A-Za-z_$][\w$]*)\s*:/g)) {
          if (!allowed.includes(key[1])) findings.push(`${file}: childEnv({ ${key[1]}: ... })`);
        }
      }
    }
    expect(
      findings,
      `non-whitelisted childEnv extra injections found:\n${findings.join('\n')}`,
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// PRI-1252 r2 — shard workspace realpath fence (real FS negative controls)
// ---------------------------------------------------------------------------

/** True when the production workspace exists on this machine (absent on CI). */
const prodWsPresent = (() => {
  try { return fs.statSync(PRODUCTION_WORKSPACE).isDirectory(); } catch { return false; }
})();

/** True when the frozen snapshot trajectory.db exists (needed by materialize). */
const snapshotPresent = (() => {
  try {
    const wt = 'D:/Code/_worktrees/principles/adhoc-20261115-prompt-v2-k4wz9t';
    return fs.statSync(path.join(wt, '.tmp/prompt-v2-inventory/snapshot/trajectory.db')).size > 0;
  } catch { return false; }
})();

/**
 * True when this process may create real symlinks (POSIX or Windows dev
 * mode). Unprivileged Windows cannot: the junction-based scenarios cover the
 * same detection code path (lstat().isSymbolicLink()), so the pure-symlink
 * scenario is skipped with that reason rather than weakened.
 */
const canCreateSymlink = (() => {
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-fence-symprobe-'));
  try {
    fs.symlinkSync(probeDir, path.join(probeDir, 'self'), 'dir');
    return true;
  } catch { return false; } finally {
    fs.rmSync(probeDir, { recursive: true, force: true });
  }
})();

/** Bounded read-only manifest of a directory tree (path + size + mtime). */
interface TreeEntry { p: string; size: number; mtimeMs: number }
function treeManifest(root: string): TreeEntry[] {
  const out: TreeEntry[] = [];
  const walk = (dir: string): void => {
    if (out.length > 50_000) return; // bounded scan
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      let st: fs.Stats;
      try { st = fs.lstatSync(full); } catch { continue; }
      out.push({ p: full, size: st.size, mtimeMs: st.mtimeMs });
      if (st.isDirectory() && !st.isSymbolicLink()) walk(full);
    }
  };
  walk(root);
  return out.sort((a, b) => (a.p < b.p ? -1 : a.p > b.p ? 1 : 0));
}

const WORKSPACES_DIR = path.join(EXPERIMENT_ROOT, 'workspaces');
const createdPaths: string[] = [];

/** Track and best-effort remove everything this test created (git-4: own artifacts only). */
function track(p: string): string {
  createdPaths.push(p);
  return p;
}
function mkdtempOutside(label: string): string {
  return track(fs.mkdtempSync(path.join(os.tmpdir(), `pd-fence-${label}-`)));
}
/** Plant a junction (Windows, no privilege needed) or a dir symlink (POSIX). */
function plantDirLink(linkPath: string, targetDir: string): void {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  // "Replace" semantics: a reparse point cannot be created over an existing
  // real directory — remove it first (these fixtures are created by this
  // test file only and tracked for cleanup).
  if (fs.existsSync(linkPath)) fs.rmSync(linkPath, { recursive: true, force: true });
  fs.symlinkSync(targetDir, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
  track(linkPath);
}

beforeEach(() => {
  createdPaths.length = 0;
  spawns.calls.length = 0;
});
afterEach(() => {
  // Remove the LINK first (rmSync on a reparse point deletes the link only —
  // probed during planning), then real dirs, then outside temps.
  for (const p of createdPaths.reverse()) {
    try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe('PRI-1252 r2 — shard workspace realpath fence (real FS negative controls)', () => {
  it('preflightIsolation detects a shard workspace junction planted inside workspaces/ (defect repro)', () => {
    const outside = mkdtempOutside('shard-out');
    const probe = armWorkspaceDir('v2', 'sfence1');
    plantDirLink(probe, outside);

    const iso = preflightIsolation();
    expect(iso.ok, `preflight missed planted shard junction; failures=${JSON.stringify(iso.failures)}`).toBe(false);
    expect(iso.failures.some((f) => f.includes('sfence1'))).toBe(true);
  });

  it('preflightIsolation detects a junction replacement of the workspaces level itself', () => {
    const outside = mkdtempOutside('ws-level-out');
    plantDirLink(WORKSPACES_DIR, outside);

    const iso = preflightIsolation();
    expect(iso.ok, `preflight missed workspaces-level junction; failures=${JSON.stringify(iso.failures)}`).toBe(false);
  });

  it('preflightIsolation detects a shard junction pointing at the production workspace (read-only probe)', () => {
    if (!prodWsPresent) return; // CI: production workspace absent — production-overlap scenario runs on Windows hosts
    const probe = armWorkspaceDir('v2', 'sfenceprod');
    plantDirLink(probe, PRODUCTION_WORKSPACE);

    const iso = preflightIsolation();
    expect(iso.ok, `preflight missed production-pointing shard junction; failures=${JSON.stringify(iso.failures)}`).toBe(false);
    expect(iso.failures.some((f) => f.includes('sfenceprod'))).toBe(true);
  });

  it('materializeWorkspace refuses a shard dir that is a junction outside the root — before writing anything into the target', () => {
    if (!snapshotPresent) return; // materialize needs the frozen snapshot trajectory.db (CI: absent)
    const outside = mkdtempOutside('mat-out');
    const before = treeManifest(outside);
    plantDirLink(armWorkspaceDir('v2', 'sfencemat'), outside);

    expect(() => materializeWorkspace('v2', { shardId: 'sfencemat' })).toThrow();

    expect(treeManifest(outside)).toEqual(before); // nothing materialized through the link
  });

  it('materializeWorkspace refuses when the workspaces parent level itself was replaced by a junction', () => {
    if (!snapshotPresent) return; // CI: absent
    const outside = mkdtempOutside('mat-wslevel-out');
    plantDirLink(WORKSPACES_DIR, outside);

    expect(() => materializeWorkspace('v2', { shardId: 'sfencemat2' })).toThrow();

    expect(fs.existsSync(path.join(outside, 'v2-sfencemat2'))).toBe(false);
  });

  it('refuses at materialize when a previously valid shard dir is swapped for a junction after preflight (phase ⑨)', () => {
    if (!snapshotPresent) return; // CI: absent
    const shard = 'sfenceswap';
    const ws = armWorkspaceDir('v2', shard);
    fs.mkdirSync(ws, { recursive: true });
    track(ws);

    const baseline = preflightIsolation();
    expect(baseline.ok, `baseline preflight must be clean; failures=${JSON.stringify(baseline.failures)}`).toBe(true);

    // Swap: real dir -> junction pointing outside the experiment root.
    const outside = mkdtempOutside('swap-out');
    fs.rmSync(ws, { recursive: true, force: true });
    plantDirLink(ws, outside);
    const before = treeManifest(outside);

    expect(() => materializeWorkspace('v2', { shardId: shard })).toThrow();
    expect(treeManifest(outside)).toEqual(before);
    // The refusal is auditable with its phase, not a bare crash.
    try { materializeWorkspace('v2', { shardId: shard }); } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      expect(message).toMatch(/materialize/);
    }
  });

  it('materializeWorkspace still succeeds for a NORMAL shard and stays inside the experiment root (positive control)', () => {
    if (!snapshotPresent) return; // CI: absent — spawn-level positive control covers the fence pass-through
    const shard = 'sfenceokmat';
    const ws = armWorkspaceDir('v2', shard);
    track(ws);
    const res = materializeWorkspace('v2', { shardId: shard });
    expect(res.workspace).toBe(ws);
    expect(fs.existsSync(path.join(ws, '.pd', 'config.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(ws, '.state', 'trajectory.db'))).toBe(true);
    const real = fs.realpathSync.native(ws);
    expect(path.resolve(real).toLowerCase().startsWith(path.resolve(EXPERIMENT_ROOT).toLowerCase() + path.sep)).toBe(true);
  });

  it('armWorkspaceDir rejects shard path traversal, absolute injection and illegal characters (scenario ⑤)', () => {
    for (const bad of ['../..', '../../outside', 'a/b', 'a\\b', 'C:/abs', 'C:\\abs', 'a:b', '', '.', '..', 'a b', 'a"b']) {
      expect(() => armWorkspaceDir('v2', bad), `shardId ${JSON.stringify(bad)} must be rejected`).toThrow();
    }
    for (const badArm of ['../x', 'a/b', 'a:b', '']) {
      expect(() => armWorkspaceDir(badArm, null), `arm ${JSON.stringify(badArm)} must be rejected`).toThrow();
    }
    // Legitimate ids used by the real harness entry points must keep working.
    for (const good of ['pa', 'solo', 'iso', 'nc6', 'up-S01', 'v2c-pS01-r0']) {
      expect(armWorkspaceDir('v2', good)).toBe(path.join(EXPERIMENT_ROOT, 'workspaces', `v2-s${good}`));
    }
  });

  it('childEnv(expected) refuses a production PD_WORKSPACE_DIR injected via extra — value-level, not name-level (scenario ⑦)', () => {
    const expected = armWorkspaceDir('v2', 'sfence7');
    expect(() => childEnv({ PD_WORKSPACE_DIR: PRODUCTION_WORKSPACE }, expected)).toThrow();
  });

  it('childEnv(expected) keeps a sandbox PD_WORKSPACE_DIR that matches the expected workspace (scenario ⑧ control)', () => {
    const expected = armWorkspaceDir('v2', 'sfence8');
    const env = childEnv({ PD_WORKSPACE_DIR: expected }, expected);
    expect(env['PD_WORKSPACE_DIR']).toBe(expected);
  });

  it('a plain symlink shard (not junction) is detected the same way (scenario ③; platform-adaptive)', (ctx) => {
    if (!canCreateSymlink) {
      // Unprivileged Windows cannot create real symlinks; the junction
      // scenarios above drive the exact same lstat().isSymbolicLink() branch.
      ctx.skip();
    }
    const outside = mkdtempOutside('sym-out');
    plantDirLink(armWorkspaceDir('v2', 'sfencesym'), outside);
    const iso = preflightIsolation();
    expect(iso.ok, `preflight missed symlink shard; failures=${JSON.stringify(iso.failures)}`).toBe(false);
  });

  it('validator layer reports structured, auditable reasons for every escape class', async () => {
    const { validateWorkspaceIsolation } = await import('../ab/ab-lib.mjs');
    // ① junction → outside the root
    const outside = mkdtempOutside('val-out');
    plantDirLink(armWorkspaceDir('v2', 'sfenceval1'), outside);
    const v1 = validateWorkspaceIsolation(armWorkspaceDir('v2', 'sfenceval1'), { phase: 'test:outside' });
    expect(v1.ok).toBe(false);
    expect(v1.failures.some((f) => f.reason === 'reparse_point')).toBe(true);

    // ② junction → production workspace (read-only validator probe)
    if (prodWsPresent) {
      plantDirLink(armWorkspaceDir('v2', 'sfencevalprod'), PRODUCTION_WORKSPACE);
      const v2 = validateWorkspaceIsolation(armWorkspaceDir('v2', 'sfencevalprod'), { phase: 'test:prod' });
      expect(v2.ok).toBe(false);
      expect(v2.failures.some((f) => f.reason === 'reparse_point')).toBe(true);
      expect(v2.failures.some((f) => f.reason === 'realpath_escapes_experiment_root' || f.reason === 'production_overlap')).toBe(true);
    }

    // ⑤ lexical traversal rejected by containment even without a planted link
    const v5 = validateWorkspaceIsolation(path.join(EXPERIMENT_ROOT, '..', 'outside-target'), { phase: 'test:traversal' });
    expect(v5.ok).toBe(false);
    expect(v5.failures.some((f) => f.reason === 'escapes_experiment_root')).toBe(true);

    // normal shard dir passes (positive control)
    const okDir = track(armWorkspaceDir('v2', 'sfencevalok'));
    fs.mkdirSync(okDir, { recursive: true });
    const vok = validateWorkspaceIsolation(okDir, { phase: 'test:ok' });
    expect(vok.ok, `normal shard must pass; failures=${JSON.stringify(vok.failures)}`).toBe(true);
    const realOk = fs.realpathSync.native(okDir);
    expect(vok.real?.toLowerCase()).toBe(realOk.toLowerCase());
  });
});

describe('PRI-1252 r2 — spawn-level shard workspace fence', () => {
  const forbidden = ['OPENCLAW_WORKSPACE', 'OPENCLAW_WORKSPACE_DIR', 'PD_STATE_DIR', 'OPENCLAW_HOME'];

  it('runPd refuses to spawn when the shard dir is a junction outside the root (spawn count stays 0)', () => {
    const outside = mkdtempOutside('out');
    plantDirLink(armWorkspaceDir('v2', 'sfencespawn1'), outside);

    expect(() => runPd('v2', ['fence-probe'], { shardId: 'sfencespawn1' })).toThrow();
    expect(spawns.calls, 'child must NOT be started for an out-of-bounds shard workspace').toHaveLength(0);
  });

  it('runPd refuses to spawn when the shard dir is a junction at the production workspace (spawn count stays 0)', () => {
    if (!prodWsPresent) return; // CI: production workspace absent — refusal proven by the uniform validator above
    plantDirLink(armWorkspaceDir('v2', 'sfencespawnprod'), PRODUCTION_WORKSPACE);

    expect(() => runPd('v2', ['fence-probe'], { shardId: 'sfencespawnprod' })).toThrow();
    expect(spawns.calls).toHaveLength(0);
  });

  it('refuses to spawn when the shard dir is swapped for a junction after materialize, before spawn (scenario ⑩)', () => {
    const ws = armWorkspaceDir('v2', 'sfencespawn2');
    fs.mkdirSync(ws, { recursive: true });
    track(ws);
    // First call passes the fence (normal dir) — behavior-preservation control.
    const first = runPd('v2', ['fence-probe'], { shardId: 'sfencespawn2' });
    first.then(() => undefined, () => undefined);
    expect(spawns.calls).toHaveLength(1);

    // Swap the REAL dir for a junction pointing outside the experiment root.
    const outside = mkdtempOutside('swap');
    fs.rmSync(ws, { recursive: true, force: true });
    plantDirLink(ws, outside);

    expect(() => runPd('v2', ['fence-probe'], { shardId: 'sfencespawn2' })).toThrow();
    expect(spawns.calls, 'no second spawn may happen after the swap').toHaveLength(1);
  });

  it('normal shard behavior is preserved: spawn env/flag/cwd all point at the sandbox workspace (scenario ⑧)', async () => {
    const ws = armWorkspaceDir('v2', 'sfenceok');
    fs.mkdirSync(ws, { recursive: true });
    track(ws);
    // Worst-case inherited production pointers must still be stripped.
    const saved: Record<string, string | undefined> = {};
    for (const name of [...forbidden, 'PD_WORKSPACE_DIR']) {
      saved[name] = process.env[name];
      process.env[name] = 'D:/.openclaw/workspace/production-pointer';
    }
    let result: { code: number | undefined } | null = null;
    try {
      result = await runPd('v2', ['diagnose', 'run', '--task-id', 'fence-ok'], { shardId: 'sfenceok' });
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
    expect(result?.code).toBe(0);
    expect(spawns.calls).toHaveLength(1);
    const { args, env, cwd } = spawns.calls[0];
    expect(env['PD_WORKSPACE_DIR']).toBe(ws);
    for (const name of forbidden) {
      expect(Object.hasOwn(env, name), `spawn env must not carry ${name}`).toBe(false);
    }
    expect(args).toContain('--workspace');
    expect(args[args.indexOf('--workspace') + 1]).toBe(ws);
    expect(cwd).toBe(ws);
  });

  it('source tripwire: ab-stage.mjs runPdIn delegates spawning to the shared validated spawn helper', () => {
    const stageSrc = fs.readFileSync(
      fileURLToPath(new URL('../ab/ab-stage.mjs', import.meta.url)), 'utf8',
    );
    // The ONLY spawn wiring lives in ab-lib spawnPdChild; runPdIn must delegate
    // (no local env-builder pointer injection, no local process.execPath spawn).
    expect(stageSrc).toMatch(/spawnPdChild\(/);
    expect(stageSrc).not.toMatch(/process\.execPath/);
    expect(stageSrc).not.toMatch(/childEnv\s*\(/);
  });
});
