// PRI-1163 round-key run — the PRE-START HARD CHECK derived from the
// 2026-11-10 production-write incident.
//
// Incident: the plugin prefers the EXPLICIT PD workspace declaration
// (PD_WORKSPACE_DIR env > OPENCLAW_WORKSPACE env > ~/.openclaw/principles-disciple.json)
// over the hook ctx.workspaceDir. A harness that only sets ctx.workspaceDir
// silently writes into the declared production workspace.
//
// This probe therefore asks the PUBLISHED CANDIDATE BUNDLE ITSELF what it
// resolves, under the EXACT environment the run will use, and REFUSES unless:
//   1. the plugin's own log line `PD explicit workspace (pd_env: <path>)`
//      resolves to a path INSIDE the pack root;
//   2. the derived trajectory DB path (<resolved>/.state/trajectory.db) is
//      inside the pack root;
//   3. NO resolved path intersects any production root (declared workspace,
//      real OpenClaw home, real ~/.pd);
//   4. the probe took the guaranteed no-write path (heartbeat trigger +
//      empty message => "no round" without any user_turns write).
//
// The negative self-test runs the same probe WITHOUT the env pins, so the
// plugin resolves the REAL declared production workspace — the gate MUST
// refuse. This proves the check would have caught the incident.

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildAllowlistedHostEnv } from './env-isolation.mjs';

const CHILD_SCRIPT = `
import { pathToFileURL } from 'node:url';
const [bundlePath, extRoot, outPath] = process.argv.slice(2);
const logs = [];
const logger = {
  info: (...a) => logs.push(['info', a.map(String).join(' ')]),
  warn: (...a) => logs.push(['warn', a.map(String).join(' ')]),
  error: (...a) => logs.push(['error', a.map(String).join(' ')]),
};
const hooks = {};
const entry = { enabled: true, hooks: { allowConversationAccess: true } };
const api = {
  id: 'principles-disciple',
  name: 'Principles Disciple',
  rootDir: extRoot,
  logger,
  config: { plugins: { entries: { 'principles-disciple': entry } } },
  pluginConfig: entry,
  registerService: () => {},
  registerCommand: () => {},
  on: (event, handler) => { hooks[event] = handler; },
};
const mod = await import(pathToFileURL(bundlePath).href);
if (!mod?.default || typeof mod.default.register !== 'function') {
  process.stdout.write(JSON.stringify({ ok: false, reason: 'bundle_default_register_missing', logs }));
  process.exit(0);
}
mod.default.register(api);
const handler = hooks['before_prompt_build'];
if (typeof handler !== 'function') {
  process.stdout.write(JSON.stringify({ ok: false, reason: 'before_prompt_build_not_captured', logs }));
  process.exit(0);
}
// heartbeat + empty message: the plugin's own P1-3 gate guarantees NO
// user_turns write for this invocation (documented no-write path).
try {
  await handler(
    { prompt: '', messages: [] },
    { workspaceDir: 'Z:\\\\__decoy__\\\\not-a-real-ws', sessionId: 'precheck-probe', agentId: 'main', trigger: 'heartbeat', runId: 'precheck-probe' },
  );
} catch (error) {
  logs.push(['error', 'probe hook threw: ' + String(error)]);
}
process.stdout.write(JSON.stringify({ ok: true, logs }));
`;

function normalizePath(value) {
  return process.platform === 'win32' ? String(value).replace(/\//g, '\\').toLowerCase() : String(value);
}

function isInsideRoot(child, root) {
  const c = normalizePath(child);
  const r = normalizePath(root);
  return c.startsWith(r.endsWith('\\') ? r : r + '\\');
}

/** Roots whose appearance in any resolved path REFUSES the run. */
export function productionRoots({ realHome = homedir(), declaredWorkspace } = {}) {
  const roots = [
    ...(typeof declaredWorkspace === 'string' && declaredWorkspace.trim() ? [declaredWorkspace] : []),
    join(realHome, '.openclaw'),           // real OpenClaw home (gateway live)
    join(realHome, '.pd'),                 // real canonical runtime state
  ];
  return roots.map(normalizePath);
}

export function findProductionHit(path, roots) {
  const list = Array.isArray(roots) && roots.length > 0 ? roots : productionRoots();
  const p = normalizePath(path);
  return list.find((root) => p === root || p.startsWith(root.endsWith('\\') ? root : root + '\\')) ?? null;
}

/**
 * Run the resolution probe in a child process with `probeEnv` and judge it.
 * Returns { ok, resolvedWorkspace, trajectoryPath, productionHit, reason, logsPath }.
 */
export async function runWorkspaceResolutionProbe({ packRoot, tmpDir, candidateBundlePath, probeEnv, declaredWorkspace }) {
  const probeExtRoot = join(tmpDir, 'probe-ext-root');
  mkdirSync(probeExtRoot, { recursive: true });
  const scriptPath = join(tmpDir, `probe-${Date.now()}.mjs`);
  const outPath = join(tmpDir, `probe-result-${Date.now()}.json`);
  writeFileSync(scriptPath, CHILD_SCRIPT, 'utf8');
  const result = await new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [scriptPath, candidateBundlePath, probeExtRoot, outPath], {
      env: probeEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += String(d); });
    child.stderr.on('data', (d) => { stderr += String(d); });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already dead */ } }, 60000);
    child.on('exit', () => {
      clearTimeout(timer);
      resolvePromise({ stdout, stderr });
    });
  });

  let parsed = null;
  try {
    const line = result.stdout.split('\n').find((l) => l.trim().startsWith('{'));
    parsed = JSON.parse(line ?? '');
  } catch {
    return { ok: false, reason: `probe_output_unparseable: ${result.stderr.slice(0, 200)}`, logsPath: null };
  }
  rmSync(scriptPath, { force: true });

  const logs = Array.isArray(parsed?.logs) ? parsed.logs : [];
  const logText = logs.map(([, text]) => text).join('\n');

  // 1. the plugin's OWN explicit-workspace resolution line. Source tags:
  //    pd_env (PD_WORKSPACE_DIR) / openclaw_env (OPENCLAW_WORKSPACE) /
  //    pd_config (~/.openclaw/principles-disciple.json) — match ANY of them.
  const explicit = logText.match(/PD explicit workspace \((\w+): ([^)]+)\)/);
  const registered = logText.match(/Principles Disciple Plugin registered\. \(Path: ([^)]+)\)/);
  if (!explicit) {
    return { ok: false, reason: 'plugin_did_not_report_explicit_workspace_resolution', logsPath: outPath, logText: logText.slice(0, 2000) };
  }
  const resolvedWorkspace = explicit[2];
  const trajectoryPath = join(resolvedWorkspace, '.state', 'trajectory.db');

  const findings = { resolvedWorkspace, trajectoryPath, registeredPath: registered ? registered[1] : null };
  const roots = productionRoots({ declaredWorkspace });
  const reasons = [];
  if (findings.registeredPath && !isInsideRoot(findings.registeredPath, packRoot)) {
    reasons.push(`registration root outside pack: ${findings.registeredPath}`);
  }
  // 2. trajectory DB inside pack
  if (!isInsideRoot(trajectoryPath, packRoot)) reasons.push(`trajectory path outside pack: ${trajectoryPath}`);
  // 3. no production root hit
  const wsHit = findProductionHit(resolvedWorkspace, roots);
  if (wsHit) reasons.push(`resolved workspace hits production root: ${wsHit}`);
  const trajHit = findProductionHit(trajectoryPath, roots);
  if (trajHit) reasons.push(`trajectory path hits production root: ${trajHit}`);
  // 4. probe took the documented no-write path
  if (!/non-interactive trigger \(heartbeat\) records no round/.test(logText)) {
    reasons.push('probe did not take the documented heartbeat no-write path');
  }
  if (reasons.length > 0) {
    return { ok: false, reason: reasons.join('; '), ...findings, logsPath: outPath };
  }
  return { ok: true, reason: 'resolution inside pack; no production hit; no-write path confirmed', ...findings, logsPath: outPath };
}

/**
 * The EXACT probe env = the strict allowlisted run env (same builder the host
 * rounds use), then optional workspace-pin stripping for the negative
 * self-test. `experimentRoot` keeps every allowlisted root inside the pack.
 */
export function buildProbeEnv({ baseEnv, packRoot, homeDir, tempDir, workspaceDir, stateDir, configPath }, { stripWorkspacePins = false } = {}) {
  const built = buildAllowlistedHostEnv({
    baseEnv,
    experimentRoot: packRoot,
    homeDir,
    tempDir,
    workspaceDir,
    stateDir,
    configPath,
  });
  const env = built.resolved?.env ?? built;
  if (stripWorkspacePins) {
    // Negative self-test: replay the INCIDENT harness faithfully — run the
    // child in the RAW AMBIENT environment (real home, real declaration file)
    // with the workspace pins removed, so the plugin resolves the REAL
    // declared production workspace and the gate must refuse on the
    // production-root rule (not on a missing-declaration technicality).
    const ambient = { ...baseEnv };
    delete ambient.PD_WORKSPACE_DIR;
    delete ambient.OPENCLAW_WORKSPACE;
    delete ambient.OPENCLAW_WORKSPACE_DIR;
    return ambient;
  }
  return env;
}
