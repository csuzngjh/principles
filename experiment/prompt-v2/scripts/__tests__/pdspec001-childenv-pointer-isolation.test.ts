/**
 * PRI-1252 r1 (PD-Lab v0.3) — childEnv(extra) pointer re-injection guard.
 *
 * Review defect (PR #2694): childEnv(extra) strips the five workspace/state
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
 * Coverage layers (EP-09: the negative control must fail against the pre-fix
 * state; tests must exercise the production boundary, not only the helper):
 *   1. unit — extra re-injecting each forbidden pointer is stripped
 *      (negative control that FAILED against the pre-fix implementation);
 *   2. caller path — the real runPd() spawn wiring: the env argument actually
 *      handed to node:child_process.spawn carries exactly the sandbox
 *      PD_WORKSPACE_DIR and never a forbidden pointer;
 *   3. production isolation path — preflightIsolation() (the Gate 0 NC5
 *      gate) stays ok with production pointers planted in the parent env;
 *   4. tripwire — every `childEnv({ ... })` call site under the harness
 *      scripts injects only whitelisted pointer names (source scan).
 *
 * Run: npx vitest run experiment/prompt-v2/scripts/__tests__/pdspec001-childenv-pointer-isolation.test.ts
 */
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { armWorkspaceDir, childEnv, preflightIsolation, runPd } from '../ab/ab-lib.mjs';

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
  const cliDistExists = (p: unknown) =>
    typeof p === 'string' && p.replace(/\\/g, '/').endsWith('/packages/pd-cli/dist/index.js');
  return {
    ...actual,
    default: Object.assign({}, actual.default, { existsSync: cliDistExists }),
    existsSync: cliDistExists,
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
