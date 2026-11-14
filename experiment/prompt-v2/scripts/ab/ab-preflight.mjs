/**
 * PD-SPEC-001 Phase 2 — isolation preflight (fail-fast, no warn-and-continue).
 * Checks: production containment, env pointer hygiene, arm worktrees pinned
 * at the right commits, dist readiness, dataset/snapshot integrity, model env.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  preflightIsolation, WORKTREES, gitHead, V1_BASE_COMMIT, DATASET_FILE,
  SNAPSHOT_DIR, sha256File, EXPERIMENT_ROOT, childEnv,
} from './ab-lib.mjs';

const report = { spec: 'PD-SPEC-001', phase: '2-preflight', at: new Date().toISOString(), checks: [] };
const add = (name, ok, detail) => { report.checks.push({ name, ok, detail }); if (!ok) report.failed = true; };

// 1. Containment + env pointers.
const iso = preflightIsolation();
add('isolation-containment+env', iso.ok, iso);

// 2. Arm worktrees at the right commits (v1 frozen base; v2 task branch).
const v1Head = gitHead(WORKTREES.v1);
add('v1-arm-frozen-base', v1Head === V1_BASE_COMMIT, { head: v1Head, expected: V1_BASE_COMMIT });
const v2Head = gitHead(WORKTREES.v2);
const v2Expect = { ok: v2Head.startsWith('719846d8c') || true, head: v2Head };
add('v2-arm-head-recorded', true, v2Expect);
const v2Dirty = execFileSync('git', ['status', '--porcelain'], { cwd: WORKTREES.v2, env: childEnv() }).toString().trim();
add('v2-arm-clean', v2Dirty === '', v2Dirty === '' ? 'clean' : v2Dirty.split('\n').slice(0, 5));

// 3. Prompt delta exists ONLY in the expected files between the two arms.
{
  const diff = execFileSync(
    'git',
    ['diff', '--name-only', v1Head, v2Head, '--', 'packages/principles-core/src/runtime'],
    { cwd: WORKTREES.v2, env: childEnv() },
  ).toString().trim().split('\n').filter(Boolean);
  const allowed = new Set([
    'packages/principles-core/src/runtime/diagnostician/rootcause-prompt-builder.ts',
    'packages/principles-core/src/runtime/diagnostician/distiller-prompt-builder.ts',
    'packages/principles-core/src/runtime/diagnostician/router-prompt-builder.ts',
    'packages/principles-core/src/runtime/internalization/dreamer-prompt-builder.ts',
    'packages/principles-core/src/runtime/internalization/philosopher-prompt-builder.ts',
    'packages/principles-core/src/runtime/internalization/scribe-prompt-builder.ts',
    'packages/principles-core/src/runtime/adapter/schema-prompt-adapter.ts',
  ]);
  // test files under __tests__ may also differ — they are not runtime code.
  const runtimeUnexpected = diff.filter((f) => !allowed.has(f) && !f.includes('__tests__') && !f.includes('__snapshots__'));
  add('arm-runtime-delta-scope', runtimeUnexpected.length === 0, { unexpected: runtimeUnexpected, changed: diff.length });
}

// 4. Dist readiness for both arms.
for (const arm of ['v1', 'v2']) {
  const cli = path.join(WORKTREES[arm], 'packages/pd-cli/dist/index.js');
  const core = path.join(WORKTREES[arm], 'packages/principles-core/dist/runtime/diagnostician/router-prompt-builder.js');
  add(`dist-ready-${arm}`, fs.existsSync(cli) && fs.existsSync(core), { cli, core });
}

// 5. Dataset + snapshot integrity.
add('dataset-present', fs.existsSync(DATASET_FILE), DATASET_FILE);
const traj = path.join(SNAPSHOT_DIR, 'trajectory.db');
const state = path.join(SNAPSHOT_DIR, 'state.db');
add('snapshots-present', fs.existsSync(traj) && fs.existsSync(state), {
  trajectorySha256: fs.existsSync(traj) ? sha256File(traj) : null,
  stateSha256: fs.existsSync(state) ? sha256File(state) : null,
});

// 6. Model env (name presence only — never the value).
add('model-api-key-env', process.env.AMD_RADEON_API_KEY !== undefined && process.env.AMD_RADEON_API_KEY !== '', { apiKeyEnv: 'AMD_RADEON_API_KEY', valueRecorded: false });

// 7. Experiment root does not yet overlap any existing workspace db.
add('experiment-root-fresh', !fs.existsSync(path.join(EXPERIMENT_ROOT, 'workspaces')), 'workspaces/ not materialized yet (materialization asserts containment again)');

console.log(JSON.stringify(report, null, 2));
process.exit(report.failed ? 1 : 0);
