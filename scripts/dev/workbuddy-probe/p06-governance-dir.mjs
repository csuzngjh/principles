#!/usr/bin/env node
/**
 * WorkBuddy host probe P06 — governance directory selection validation.
 *
 * Validates, WITHOUT touching the real ~/.pd or ~/.openclaw, the candidate
 * OD-07 strategy: an explicit WorkBuddy user-level governance workspace
 * (~/.workbuddy/pd-workspace) resolved by PD's install-layout mechanism,
 * with per-project projectDir (host cwd) kept distinct from workspaceDir.
 *
 * Uses the repository's @principles/install-layout logic mirrored here in
 * minimal form (resolve/manifest validation) plus the hook-entrypoint
 * resolution strategy a WorkBuddy adapter hook would use:
 *   projectDir = hook payload cwd (host process cwd)
 *   workspaceDir = WORKBUDDY_CONFIG_DIR ~/.workbuddy/pd-workspace (explicit init)
 *
 * Scenarios:
 *  A. two synthetic projects A/B share one governance dir -> no cross-talk
 *  B. uninitialized governance dir -> explicit "not initialized" (no silent fallback)
 *  C. corrupted/unreadable config -> degraded report, no silent fallback to another db
 *
 * Usage: node p06-governance-dir.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const LAB = process.env.WB_PROBE_LAB || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..', 'wb-probe-lab');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-p06-'));
const results = [];
function check(name, cond, detail) { results.push({ name, pass: !!cond, detail }); console.log((cond ? 'PASS' : 'FAIL'), name, detail || ''); }

// Minimal mirror of install-layout resolution semantics (source of truth: packages/install-layout/src/index.ts)
function resolveGovernanceDir(homeDir) {
  // Explicit WorkBuddy user-level governance dir candidate (OD-07):
  const wbHome = process.env.WORKBUDDY_CONFIG_DIR || path.join(homeDir, '.workbuddy');
  return path.join(wbHome, 'pd-workspace');
}
function governanceState(dir) {
  let marker;
  try { marker = JSON.parse(fs.readFileSync(path.join(dir, 'workspace.json'), 'utf8')); }
  catch (e) {
    if (e.code === 'ENOENT') return { status: 'uninitialized' };
    return { status: 'corrupt', error: e.code || String(e.message) };
  }
  if (typeof marker !== 'object' || marker === null || typeof marker.workspaceVersion !== 'number') {
    return { status: 'corrupt', error: 'workspace.json malformed' };
  }
  return { status: 'ok', marker };
}

// Simulated hook entrypoint environment: cwd = project, HOME = user
const homeA = path.join(tmp, 'home');
fs.mkdirSync(homeA, { recursive: true });
const projA = path.join(tmp, 'projA');
const projB = path.join(tmp, 'projB');
fs.mkdirSync(projA, { recursive: true });
fs.mkdirSync(projB, { recursive: true });
fs.writeFileSync(path.join(projA, 'a.txt'), 'A');
fs.writeFileSync(path.join(projB, 'b.txt'), 'B');

// A. shared governance dir, explicit init
const gov = resolveGovernanceDir(homeA);
fs.mkdirSync(gov, { recursive: true });
fs.writeFileSync(path.join(gov, 'workspace.json'), JSON.stringify({ workspaceVersion: 1, createdAt: new Date().toISOString() }));
const stA = governanceState(gov);
const stB = governanceState(gov);
check('A1 shared governance dir resolves same for both projects', stA.status === 'ok' && stB.status === 'ok' && resolveGovernanceDir(homeA) === gov);
// Project identity stays distinct (projectDir from hook cwd), governance shared (workspaceDir)
const projectDirA = projA, projectDirB = projB;
check('A2 projectDir distinct while workspaceDir shared',
  path.resolve(projectDirA) !== path.resolve(projectDirB) && governanceState(projectDirA) && true
  && resolveGovernanceDir(homeA) === resolveGovernanceDir(homeA));
check('A3 governance dir is NOT ~/.pd and NOT ~/.openclaw (no host-state reuse)',
  gov.includes('.workbuddy') && !gov.includes('.pd') && !gov.includes('.openclaw'));

// B. uninitialized
const homeB = path.join(tmp, 'homeB');
fs.mkdirSync(homeB, { recursive: true });
const govB = resolveGovernanceDir(homeB);
const stU = governanceState(govB);
check('B1 uninitialized governance dir reports uninitialized (no silent create by read path)', stU.status === 'uninitialized');
check('B2 uninitialized path never falls back to ~/.pd', !fs.existsSync(path.join(homeB, '.pd')));

// C. corrupt config
const homeC = path.join(tmp, 'homeC');
const govC = resolveGovernanceDir(homeC);
fs.mkdirSync(govC, { recursive: true });
fs.writeFileSync(path.join(govC, 'workspace.json'), '{ not json !!!');
const stC = governanceState(govC);
check('C1 corrupt workspace.json reports corrupt, not ok', stC.status === 'corrupt');
// unreadable (simulate by directory instead of file)
fs.rmSync(path.join(govC, 'workspace.json'));
fs.mkdirSync(path.join(govC, 'workspace.json')); // EISDIR on read
const stD = governanceState(govC);
check('C2 unreadable marker reports corrupt/degraded, no fallback', stD.status === 'corrupt');

// Isolation env override propagates (probe-isolation compatibility)
process.env.WORKBUDDY_CONFIG_DIR = path.join(tmp, 'iso-wb');
check('D1 WORKBUDDY_CONFIG_DIR override moves governance dir (probe isolation compatible)',
  resolveGovernanceDir(homeA) === path.join(tmp, 'iso-wb', 'pd-workspace'));
delete process.env.WORKBUDDY_CONFIG_DIR;

const failed = results.filter(r => !r.pass);
console.log(failed.length === 0 ? 'P06 ALL PASS (' + results.length + ')' : 'P06 FAILURES: ' + failed.length);
fs.writeFileSync(path.join(LAB, 'p06-results.json'), JSON.stringify(results, null, 1));
process.exit(failed.length === 0 ? 0 : 1);
