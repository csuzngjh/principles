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
import Database from 'better-sqlite3';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXPERIMENT_ROOT,
  PRODUCTION_WORKSPACE,
  SNAPSHOT_DIR,
  armWorkspaceDir,
  assertArtifactReuseSafety,
  assertWorkspaceFileIdentity,
  childEnv,
  materializeWorkspace,
  preflightIsolation,
  recordArtifactProvenance,
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
const heldAside: Array<{ from: string; to: string }> = [];

/** Track and best-effort remove everything this test created (git-4: own artifacts only). */
function track(p: string): string {
  createdPaths.push(p);
  return p;
}
function mkdtempOutside(label: string): string {
  return track(fs.mkdtempSync(path.join(os.tmpdir(), `pd-fence-${label}-`)));
}
/**
 * PRI-1252 r4 (P1-1): plantDirLink NEVER deletes a pre-existing path. The old
 * "replace" semantics (`existsSync -> rmSync recursive`) could delete REAL
 * experiment data when a fixture path collided with a previous run's
 * workspace (reproduced hazard). If anything already exists at linkPath the
 * test fails loudly instead of removing it.
 */
function plantDirLink(linkPath: string, targetDir: string): void {
  const existing = (() => { try { return fs.lstatSync(linkPath); } catch { return null; } })();
  if (existing !== null) {
    throw new Error(`plantDirLink: refusing to overwrite pre-existing path ${linkPath} `
      + `(lstat=${existing.isDirectory() ? 'directory' : existing.isSymbolicLink() ? 'link' : 'file'}) `
      + `— the fixture must target a fresh path owned by this test run`);
  }
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.symlinkSync(targetDir, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
  track(linkPath);
}
/**
 * PRI-1252 r4 (P1-1): non-destructive "replace" primitive. Renames a real
 * directory ASIDE (all content preserved) so a junction can be planted at the
 * original path; the hold is restored in afterEach. Used ONLY for the
 * workspaces-level replacement scenarios — data is moved, never deleted.
 */
function holdAsideForJunction(realDir: string): void {
  const st = (() => { try { return fs.lstatSync(realDir); } catch { return null; } })();
  if (st !== null && st.isSymbolicLink()) throw new Error(`holdAsideForJunction: ${realDir} is already a link — refusing`);
  const hold = `${realDir}.held-by-test-${process.pid}-${heldAside.length}`;
  if (st !== null) {
    fs.renameSync(realDir, hold);
    createdPaths.push(hold); // restore target; afterEach renames it back FIRST
  }
  heldAside.push({ from: realDir, to: hold });
}
/**
 * PRI-1252 r4 (P1-1): remove a path ONLY if this test run created it (must be
 * in the tracked list) — ownership-verified deletion, fail-closed otherwise.
 */
function removeOwnTracked(p: string): void {
  if (!createdPaths.includes(p)) {
    throw new Error(`removeOwnTracked: refusing to remove ${p} — not created by this test run`);
  }
  fs.rmSync(p, { recursive: true, force: true });
}

beforeEach(() => {
  createdPaths.length = 0;
  heldAside.length = 0;
  spawns.calls.length = 0;
});
afterEach(() => {
  // 1) Restore every rename-aside hold FIRST (the original location may now
  //    hold a junction/link; rename back only after removing that link).
  for (const { from, to } of heldAside.reverse()) {
    try {
      const link = (() => { try { return fs.lstatSync(from); } catch { return null; } })();
      if (link !== null && link.isSymbolicLink()) fs.rmSync(from, { force: true }); // link only
      fs.renameSync(to, from);
    } catch { /* best effort — reported by the owning test */ }
  }
  // 2) Remove tracked fixtures (links first — rmSync on a reparse point
  //    deletes the link only — then real dirs, then outside temps).
  for (const p of createdPaths.reverse()) {
    try {
      const st = (() => { try { return fs.lstatSync(p); } catch { return null; } })();
      if (st === null) continue;
      if (!st.isSymbolicLink() && heldAside.some((h) => h.to === p)) continue; // already restored
      fs.rmSync(p, { recursive: true, force: true });
    } catch { /* best effort */ }
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
    // PRI-1252 r4: RENAME the real workspaces dir aside (data preserved,
    // restored in afterEach) instead of recursively deleting it.
    holdAsideForJunction(WORKSPACES_DIR);
    plantDirLink(WORKSPACES_DIR, outside);

    const iso = preflightIsolation();
    expect(iso.ok, `preflight missed workspaces-level junction; failures=${JSON.stringify(iso.failures)}`).toBe(false);
    // The held-aside real content must still exist.
    const holds = heldAside.map((h) => h.to);
    expect(holds.length).toBe(1);
    expect(fs.existsSync(holds[0])).toBe(true);
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
    holdAsideForJunction(WORKSPACES_DIR); // PRI-1252 r4: rename aside, never delete
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
    removeOwnTracked(ws); // PRI-1252 r4: ownership-verified removal only
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
    removeOwnTracked(ws); // PRI-1252 r4: ownership-verified removal only
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

// ---------------------------------------------------------------------------
// PRI-1252 r4 — TEST-2694-A/B (fixture safety) and TEST-2694-C/D (file-level
// identity / NTFS hardlink fence). Real Windows NTFS: junctions planted with
// fs.symlinkSync(..., 'junction'), hardlinks with fs.linkSync — no mocks.
// ---------------------------------------------------------------------------
import { createHash } from 'node:crypto';
const sha256Of = (p: string): string => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
type FileRow = { p: string; sha: string };
function manifestOf(root: string): FileRow[] {
  const out: FileRow[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push({ p: full, sha: sha256Of(full) });
    }
  };
  walk(root);
  return out.sort((a, b) => (a.p < b.p ? -1 : a.p > b.p ? 1 : 0));
}

describe('PRI-1252 r4 — fixture ownership safety (TEST-2694-A/B)', () => {
  it('TEST-2694-A: a pre-existing foreign workspace with a sentinel survives every junction scenario', () => {
    // FOREIGN data (not tracked by this suite) — the exact hazard class the
    // old `rmSync(recursive)` in plantDirLink could destroy on a name clash.
    const foreignWs = path.join(WORKSPACES_DIR, 'r4-foreign-sentinel');
    fs.mkdirSync(path.join(foreignWs, '.state'), { recursive: true });
    const sentinelPath = path.join(foreignWs, '.state', 'sentinel.txt');
    fs.writeFileSync(sentinelPath, 'prior-experiment-data-must-survive', 'utf8');
    const sentinelShaBefore = sha256Of(sentinelPath);
    const foreignManifestBefore = manifestOf(foreignWs);

    // 1) plantDirLink must refuse to overwrite the foreign directory outright.
    const outside = mkdtempOutside('sentinel-out');
    expect(() => plantDirLink(foreignWs, outside)).toThrow(/refusing to overwrite pre-existing path/);

    // 2) run the junction scenario classes with NON-colliding names; the
    //    foreign workspace must be untouched by every one of them.
    plantDirLink(armWorkspaceDir('v2', 'rsent1'), outside);
    expect(preflightIsolation().ok).toBe(false);
    if (prodWsPresent) {
      plantDirLink(armWorkspaceDir('v2', 'rsentprod'), PRODUCTION_WORKSPACE);
      expect(preflightIsolation().ok).toBe(false);
    }
    if (canCreateSymlink) {
      plantDirLink(armWorkspaceDir('v2', 'rsentsym'), outside);
      expect(preflightIsolation().ok).toBe(false);
    }

    // 3) foreign data byte-identical, still at its original location.
    expect(fs.existsSync(sentinelPath)).toBe(true);
    expect(sha256Of(sentinelPath)).toBe(sentinelShaBefore);
    expect(manifestOf(foreignWs)).toEqual(foreignManifestBefore);
  });

  it('TEST-2694-B: the full scenario cycle repeats three times with no cross-run deletion or leftover pollution', () => {
    const foreignWs = path.join(WORKSPACES_DIR, 'r4-foreign-repeat');
    fs.mkdirSync(path.join(foreignWs, '.state'), { recursive: true });
    const sentinelPath = path.join(foreignWs, '.state', 'sentinel.txt');
    fs.writeFileSync(sentinelPath, 'repeat-run-data', 'utf8');
    const sentinelShaBefore = sha256Of(sentinelPath);

    for (let run = 1; run <= 3; run++) {
      const outside = mkdtempOutside(`repeat-${run}`);
      const probe = armWorkspaceDir('v2', `rrepeat${run}`);
      // plantDirLink over a stale leftover from a previous iteration must
      // FAIL LOUDLY, not recursively delete it (the r4 contract).
      plantDirLink(probe, outside); // fresh name per iteration
      expect(preflightIsolation().ok).toBe(false);
      expect(() => plantDirLink(probe, outside)).toThrow(/refusing to overwrite pre-existing path/);
      removeOwnTracked(probe); // ownership-verified cleanup of THIS run's fixture
      // no leftover junction from this iteration remains under workspaces/
      expect(fs.existsSync(probe)).toBe(false);
      // foreign data still intact between iterations
      expect(sha256Of(sentinelPath)).toBe(sentinelShaBefore);
    }
    expect(fs.existsSync(sentinelPath)).toBe(true);
    expect(sha256Of(sentinelPath)).toBe(sentinelShaBefore);
  });
});

describe('PRI-1252 r4 — file-level identity / NTFS hardlink fence (TEST-2694-C/D)', () => {
  it('TEST-2694-C: an external hardlink onto .state/trajectory.db is refused — no reuse, no spawn, external file untouched', () => {
    if (!snapshotPresent) return; // materialize needs the frozen snapshot trajectory.db (CI: absent)
    const shard = 'r4hardlink';
    // Baseline: normal create, then PROVENANCE-backed reuse works (control).
    const first = materializeWorkspace('v2', { shardId: shard });
    track(first.workspace);
    expect(first.trajectory).toBe('created');
    expect(materializeWorkspace('v2', { shardId: shard }).trajectory).toBe('reused');

    // Attack: external file hardlinked onto the artifact path.
    const externalDir = mkdtempOutside('hardlink-victim');
    const extFile = path.join(externalDir, 'victim.db');
    fs.writeFileSync(extFile, 'external-victim-content', 'utf8');
    const extShaBefore = sha256Of(extFile);
    const ws = armWorkspaceDir('v2', shard);
    const dbPath = path.join(ws, '.state', 'trajectory.db');
    fs.rmSync(dbPath); // the attacker clears the target first (linkSync needs a free name)
    fs.linkSync(extFile, dbPath); // REAL NTFS hardlink — shared inode, nlink >= 2
    expect(fs.lstatSync(dbPath).nlink).toBeGreaterThanOrEqual(2);

    // materializeWorkspace must REFUSE — never report 'reused' for it.
    let refusal = '';
    try { materializeWorkspace('v2', { shardId: shard }); } catch (e) { refusal = e instanceof Error ? e.message : String(e); }
    expect(refusal).toMatch(/nlink/);
    expect(refusal).toMatch(/materialize:reuse/);

    // The exported safety gate refuses with the same reason class.
    expect(() => assertArtifactReuseSafety(ws, path.join('.state', 'trajectory.db'), 'test:gate')).toThrow(/nlink/);

    // The spawn boundary must refuse: no child may start against this ws.
    const spawnCallsBefore = spawns.calls.length;
    expect(() => runPd('v2', ['fence-probe'], { shardId: shard })).toThrow(/nlink/);
    expect(spawns.calls.length, 'no child may start against a hardlink-swapped workspace').toBe(spawnCallsBefore);

    // The external victim file is untouched.
    expect(sha256Of(extFile)).toBe(extShaBefore);

    // Recovery: force re-materialize recreates a clean owned artifact.
    const healed = materializeWorkspace('v2', { shardId: shard, force: true });
    expect(healed.trajectory).toBe('created');
    expect(fs.lstatSync(dbPath).nlink).toBe(1);
    expect(sha256Of(extFile)).toBe(extShaBefore); // victim still untouched
    // and the healed workspace passes the spawn boundary identity again
    expect(() => assertWorkspaceFileIdentity(ws, 'test:healed')).not.toThrow();
  });

  it('TEST-2694-C2: reusing a plausible DB without provenance is refused (unverified pre-existing artifact)', () => {
    if (!snapshotPresent) return; // CI: absent
    const shard = 'r4noprovenance';
    const ws = armWorkspaceDir('v2', shard);
    track(ws);
    fs.mkdirSync(path.join(ws, '.state'), { recursive: true });
    fs.mkdirSync(path.join(ws, '.pd'), { recursive: true });
    // A trajectory.db that EXISTS but was never written by this harness flow:
    // no provenance manifest → reuse must fail closed, not silently adopt it.
    fs.copyFileSync(path.join(SNAPSHOT_DIR, 'trajectory.db'), path.join(ws, '.state', 'trajectory.db'));
    let refusal = '';
    try { materializeWorkspace('v2', { shardId: shard }); } catch (e) { refusal = e instanceof Error ? e.message : String(e); }
    expect(refusal).toMatch(/no provenance record/);
    expect(refusal).toMatch(/materialize:reuse/);
  });

  it('TEST-2694-D: normal create → provenance reuse → spawn-boundary identity all pass (no false positives)', () => {
    if (!snapshotPresent) return; // CI: absent
    const shard = 'r4normal';
    const wsPath = armWorkspaceDir('v2', shard);
    track(wsPath);
    const m1 = materializeWorkspace('v2', { shardId: shard });
    expect(m1.trajectory).toBe('created');
    expect(m1.config).toBe('created');
    expect(fs.existsSync(path.join(wsPath, '.materialize-provenance.json'))).toBe(true);
    // immediate reuse verifies against the recorded identity
    const m2 = materializeWorkspace('v2', { shardId: shard });
    expect(m2.trajectory).toBe('reused');
    expect(m2.config).toBe('reused');
    // the spawn-boundary identity check accepts the healthy workspace
    expect(() => assertWorkspaceFileIdentity(wsPath, 'test:normal')).not.toThrow();
    // ab-stage's seedArm reuse gate accepts it too (same helper, config path)
    expect(() => assertArtifactReuseSafety(wsPath, path.join('.pd', 'config.yaml'), 'test:seed-control')).not.toThrow();
  });
});

describe('PRI-1252 r5 — mutable SQLite identity is separate from content integrity', () => {
  function createProvenancedWorkspace(shard: string): { ws: string; dbPath: string } {
    const ws = armWorkspaceDir('v2', shard);
    track(ws);
    fs.mkdirSync(path.join(ws, '.state'), { recursive: true });
    fs.mkdirSync(path.join(ws, '.pd'), { recursive: true });
    const dbPath = path.join(ws, '.state', 'trajectory.db');
    const db = new Database(dbPath);
    db.exec('CREATE TABLE pain_events (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)');
    db.close();
    fs.writeFileSync(path.join(ws, '.pd', 'config.yaml'), 'schemaVersion: 1\n', 'utf8');
    recordArtifactProvenance(ws);
    return { ws, dbPath };
  }

  it('TEST-2694-E: real SQLite pain-event writes preserve file identity and allow the next diagnose spawn', async () => {
    const shard = `r5mutable${process.pid}`;
    const { ws, dbPath } = createProvenancedWorkspace(shard);
    const before = fs.statSync(dbPath);
    const provenance = JSON.parse(fs.readFileSync(path.join(ws, '.materialize-provenance.json'), 'utf8'));
    const dbIdentity = provenance.artifacts[path.join('.state', 'trajectory.db')];
    const configIdentity = provenance.artifacts[path.join('.pd', 'config.yaml')];
    expect(dbIdentity).not.toHaveProperty('size');
    expect(dbIdentity).not.toHaveProperty('mtimeMs');
    expect(configIdentity).toHaveProperty('size');
    expect(configIdentity).toHaveProperty('mtimeMs');
    const db = new Database(dbPath);
    const insert = db.prepare('INSERT INTO pain_events (payload) VALUES (?)');
    const payload = 'session-bound-pain-event:'.padEnd(2048, 'x');
    db.transaction(() => {
      for (let i = 0; i < 128; i += 1) insert.run(`${i}:${payload}`);
    })();
    db.close();

    const after = fs.statSync(dbPath);
    expect(after.ino, 'SQLite must update the original database file, not replace it').toBe(before.ino);
    expect(after.size, 'the real SQLite write must change the database contents').toBeGreaterThan(before.size);
    expect(() => assertWorkspaceFileIdentity(ws, 'test:after-session-pain-record')).not.toThrow();

    const result = await runPd('v2', ['diagnose', 'run', '--json'], { shardId: shard });
    expect(result.code).toBe(0);
    expect(spawns.calls).toHaveLength(1);
    expect(spawns.calls[0].args).toContain('diagnose');
    expect(spawns.calls[0].args).toContain('run');
    expect(spawns.calls[0].cwd).toBe(ws);
  });

  it('TEST-2694-F: mutable SQLite remains protected against an external NTFS hardlink', () => {
    const shard = `r5hardlink${process.pid}`;
    const { ws, dbPath } = createProvenancedWorkspace(shard);
    const externalDir = path.join(path.dirname(EXPERIMENT_ROOT), `.pd-hardlink-victim-${process.pid}`);
    track(externalDir);
    fs.mkdirSync(externalDir, { recursive: true });
    const externalFile = path.join(externalDir, 'victim.db');
    fs.writeFileSync(externalFile, 'external victim must remain untouched', 'utf8');
    const externalBefore = fs.readFileSync(externalFile);

    fs.rmSync(dbPath);
    fs.linkSync(externalFile, dbPath);
    expect(fs.lstatSync(dbPath).nlink).toBeGreaterThanOrEqual(2);
    expect(() => assertWorkspaceFileIdentity(ws, 'test:hardlink-after-provenance')).toThrow(/nlink/);

    const spawnCount = spawns.calls.length;
    expect(() => runPd('v2', ['diagnose', 'run'], { shardId: shard })).toThrow(/nlink/);
    expect(spawns.calls).toHaveLength(spawnCount);
    expect(fs.readFileSync(externalFile)).toEqual(externalBefore);
  });

  it('TEST-2694-G: deleting and recreating trajectory.db with identical bytes and mtime is rejected as a different file', async () => {
    const shard = `r5replacement${process.pid}`;
    const { ws, dbPath } = createProvenancedWorkspace(shard);
    const originalBytes = fs.readFileSync(dbPath);
    const originalStat = fs.statSync(dbPath);

    const replacementPath = path.join(
      path.dirname(dbPath),
      `.trajectory-replacement-${process.pid}-${Date.now()}`,
    );
    const retiredPath = track(path.join(
      path.dirname(dbPath),
      `.trajectory-retired-${process.pid}-${Date.now()}`,
    ));
    // Create the replacement as a genuinely different file before the
    // protected pathname is retired. This models delete/recreate rather than
    // mutating the original inode/file-id in place.
    fs.writeFileSync(replacementPath, originalBytes);
    fs.utimesSync(replacementPath, originalStat.atime, originalStat.mtime);
    fs.renameSync(dbPath, retiredPath);
    await new Promise((resolve) => setTimeout(resolve, 25));
    // Publish the replacement atomically into the original pathname. The
    // test never performs a check-then-open sequence on the protected path.
    fs.renameSync(replacementPath, dbPath);

    const replacementStat = fs.statSync(dbPath);
    expect(fs.readFileSync(dbPath)).toEqual(originalBytes);
    expect(replacementStat.size).toBe(originalStat.size);
    expect(
      replacementStat.ino !== originalStat.ino || replacementStat.birthtimeMs !== originalStat.birthtimeMs,
      'the replacement must have a new filesystem identity even when bytes and mtime are preserved',
    ).toBe(true);
    expect(() => assertWorkspaceFileIdentity(ws, 'test:delete-recreate')).toThrow(/identity mismatch/);

    const spawnCount = spawns.calls.length;
    expect(() => runPd('v2', ['diagnose', 'run'], { shardId: shard })).toThrow(/identity mismatch/);
    expect(spawns.calls).toHaveLength(spawnCount);
  });

  it('TEST-2694-H: unchanged legacy provenance migrates once before SQLite becomes mutable', () => {
    const shard = `r5legacy${process.pid}`;
    const { ws, dbPath } = createProvenancedWorkspace(shard);
    const manifestPath = path.join(ws, '.materialize-provenance.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const st = fs.statSync(dbPath);
    manifest.artifacts[path.join('.state', 'trajectory.db')] = {
      fileid: String(st.ino),
      nlink: st.nlink,
      size: st.size,
      mtimeMs: st.mtimeMs,
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    expect(() => assertWorkspaceFileIdentity(ws, 'test:legacy-provenance-migration')).not.toThrow();
    const upgraded = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const upgradedDb = upgraded.artifacts[path.join('.state', 'trajectory.db')];
    expect(upgradedDb.device).toBe(String(st.dev));
    expect(upgradedDb.birthtimeMs).toBe(st.birthtimeMs);
    expect(upgradedDb).not.toHaveProperty('size');
    expect(upgradedDb).not.toHaveProperty('mtimeMs');

    const db = new Database(dbPath);
    db.prepare('INSERT INTO pain_events (payload) VALUES (?)').run('post-migration mutable write');
    db.close();
    expect(() => assertWorkspaceFileIdentity(ws, 'test:legacy-after-mutable-write')).not.toThrow();
  });
});
