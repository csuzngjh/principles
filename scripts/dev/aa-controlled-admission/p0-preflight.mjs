// PRI-1118 controlled-admission P0 preflight (design v1.2 §3.4 / §6).
//
// Read-only except for a transient loopback probe. It MUST NOT start a host
// turn or a model request. Every check reports PASS / FAIL / NOT_RUN with
// structured evidence; stdout is strict JSON (cli-1), diagnostics go to stderr,
// exit code 0 only when every check is PASS.
//
// P0 resolves the host from the ISOLATED install prefix supplied by the caller
// (Owner decision option B). It never guesses a global install path, and it
// records the host identity that the run launcher must match exactly.
//
// Tool-whitelist evidence is structural: the frozen config's `tools.allow` is
// exactly one entry, the plugin registers no tools, and the definitive
// model-visible surface is captured from the endpoint request body by the
// run gate. "stdout contains read" is not evidence and is never used.

import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { hostCommand, hostIdentity, isRegularFile, resolveHostProfile, sha256File, verifyHostIdentity } from './lib/host-profile.mjs';
import { hostConfigSha256, readHostConfig, validateHostConfigWiring, PLUGIN_ID } from './lib/host-config.mjs';
import { readControlledWorkspaceTarget } from './lib/workspace-seed.mjs';

const PLUGIN_BUNDLE_RELATIVE = join('packages', 'openclaw-plugin', 'dist', 'bundle.js');

function runCapture(command, args, { cwd, timeout = 25_000, env = undefined } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    timeout,
    windowsHide: true,
    encoding: 'utf8',
    shell: false,
    env,
  });
  return {
    status: result.status,
    error: result.error ? String(result.error.message ?? result.error) : null,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
  };
}

function check(id, status, detail, evidence = {}) {
  return { id, status, detail, evidence };
}

function readJson(path) {
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, 'utf8')) };
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error) };
  }
}

function inside(path, root) {
  if (typeof path !== 'string' || typeof root !== 'string') return false;
  const normalizedPath = resolve(path).toLowerCase();
  const normalizedRoot = resolve(root).toLowerCase();
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}${process.platform === 'win32' ? '\\' : '/'}`);
}

/** Bind the FROZEN port briefly to prove the endpoint destination is available. */
async function probeBoundPort(port) {
  const server = createServer((req, res) => {
    res.writeHead(204);
    res.end();
  });
  try {
    await new Promise((resolvePromise, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        resolvePromise();
      });
    });
    const address = server.address();
    if (!address || typeof address !== 'object' || address.address !== '127.0.0.1') {
      return { ok: false, reason: `unexpected bind address ${JSON.stringify(address)}` };
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { ok: false, reason: `frozen port is not a valid TCP port: ${String(port)}` };
    }
    const reachable = await new Promise((resolvePromise) => {
      // A raw TCP connect proves the bound loopback endpoint is reachable. It
      // deliberately avoids any HTTP request so this preflight cannot carry
      // file-derived data to a network sink (CodeQL js/file-access-to-http).
      const socket = connect({ host: '127.0.0.1', port }, () => {
        socket.destroy();
        resolvePromise(true);
      });
      socket.setTimeout(5000, () => {
        socket.destroy();
        resolvePromise(false);
      });
      socket.on('error', () => resolvePromise(false));
    });
    return { ok: reachable, port, address: address.address };
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error), port };
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolvePromise) => server.close(() => resolvePromise()));
  }
}

/**
 * Run the preflight against a frozen plan. Returns the report object; the CLI
 * wrapper prints it.
 */
export async function runP0Preflight({
  repoRoot,
  hostRoot = null,
  planPath = null,
  experimentRoot = null,
  expectedToolName = null,
} = {}) {
  const checks = [];
  const report = {
    schemaVersion: 'pd-aa-p0-preflight/v1',
    generatedAt: new Date().toISOString(),
    repoRoot: repoRoot ? resolve(repoRoot) : null,
    hostRoot: hostRoot ? resolve(hostRoot) : null,
    planPath: planPath ? resolve(planPath) : null,
    ready: false,
    checks,
  };
  if (!repoRoot) {
    checks.push(check('repo-root', 'FAIL', 'repoRoot is required'));
    report.ready = false;
    return report;
  }
  const rootDir = resolve(repoRoot);

  // 0. Frozen plan.
  let plan = null;
  if (!planPath) {
    checks.push(check('plan', 'FAIL', '--plan is required; run the launcher --dry-run first'));
  } else {
    const parsed = readJson(planPath);
    if (!parsed.ok) {
      checks.push(check('plan', 'FAIL', `plan unreadable: ${parsed.reason}`, { planPath }));
    } else {
      plan = parsed.value;
      const required = ['schemaVersion', 'configPath', 'configSha256', 'endpoint', 'host', 'plugin', 'stateRoot', 'toolName', 'mapping', 'manifestPath', 'fixtureFile', 'fixtureSha256', 'inputFile', 'inputSha256', 'admissionPath', 'workspaceDir', 'controlWorkspaceDir', 'workspaceTarget', 'fixtureRef'];
      const missing = required.filter((key) => plan?.[key] === undefined || plan?.[key] === null);
      checks.push(check('plan', missing.length === 0 && plan.schemaVersion === 'pd-aa-plan/v1' ? 'PASS' : 'FAIL',
        'frozen plan present with every field the run needs', { planPath: resolve(planPath), missing, schemaVersion: plan?.schemaVersion ?? null }));
    }
  }
  const root = experimentRoot ? resolve(experimentRoot) : planPath ? dirname(resolve(planPath)) : null;
  report.experimentRoot = root;

  // 1. Plugin artifact from THIS repository.
  const bundlePath = join(rootDir, PLUGIN_BUNDLE_RELATIVE);
  let bundleSha256 = null;
  if (!isRegularFile(bundlePath)) {
    checks.push(check('plugin-bundle', 'FAIL', 'built plugin bundle missing (run npm run build:bundle)', { bundlePath }));
  } else {
    bundleSha256 = sha256File(bundlePath);
    const head = runCapture('git', ['rev-parse', 'HEAD'], { cwd: rootDir, timeout: 10_000 });
    const matchesPlan = plan?.plugin?.bundleSha256 === bundleSha256 && plan?.plugin?.bundlePath === bundlePath;
    checks.push(check('plugin-bundle', matchesPlan ? 'PASS' : 'FAIL',
      'the repository build artifact matches the frozen plan', {
        bundlePath, bundleSha256,
        plannedBundlePath: plan?.plugin?.bundlePath ?? null,
        plannedBundleSha256: plan?.plugin?.bundleSha256 ?? null,
        sizeBytes: statSync(bundlePath).size,
        gitHead: head.status === 0 ? head.stdout.trim() : null,
      }));
  }
  report.bundle = { bundlePath, bundleSha256 };

  // 2. Isolated host executable (NO host turn, NO model request).
  const profile = resolveHostProfile({ hostRoot });
  report.hostRootResolved = profile.ok ? profile.hostRoot : null;
  if (!profile.ok) {
    checks.push(check('host-isolated', 'FAIL', `isolated host cannot be resolved: ${profile.reason}`, { hostRoot }));
    report.host = null;
  } else {
    const { command, prefixArgs } = hostCommand(profile);
    const version = runCapture(command, [...prefixArgs, '--version'], { timeout: 20_000 });
    const versionOk = version.status === 0 && version.stdout.includes(profile.version);
    checks.push(check('host-isolated', versionOk ? 'PASS' : 'FAIL',
      'the isolated host executable runs and reports the required version', {
        hostRoot: profile.hostRoot,
        nodePath: profile.nodePath,
        cliPath: profile.cliPath,
        cliSha256: profile.cliSha256,
        version: profile.version,
        versionExitCode: version.status,
        versionStdout: version.stdout.trim().slice(0, 200),
        stderr: version.stderr.trim().slice(0, 300),
      }));
    report.host = { ...hostIdentity(profile), hostRoot: profile.hostRoot, packageDir: profile.packageDir, fsSafePath: profile.fsSafePath };
  }

  // 3. Isolated package health (read-only observation, never repaired here).
  if (!profile.ok) {
    checks.push(check('host-package-health', 'NOT_RUN', 'blocked: isolated host could not be resolved'));
  } else {
    checks.push(check('host-package-health', profile.healthy ? 'PASS' : 'FAIL',
      'the isolated package has no pending lifecycle marker and resolves its required peer', {
        hostRoot: profile.hostRoot,
        version: profile.version,
        lifecyclePending: profile.lifecyclePending,
        lifecyclePendingPaths: profile.lifecyclePendingPaths,
        fsSafePath: profile.fsSafePath,
      }));
  }

  // 4. P0 / run agreement: same executable, config, state root, plugin artifact.
  if (!plan || !profile.ok) {
    checks.push(check('host-consistency', 'NOT_RUN', 'blocked: plan or isolated host unavailable'));
  } else {
    const violations = verifyHostIdentity(plan.host, hostIdentity(profile));
    if (plan.configSha256 !== hostConfigSha256(plan.configPath)) violations.push('config changed since the plan was frozen');
    if (plan.plugin?.bundleSha256 !== bundleSha256) violations.push('plugin bundle changed since the plan was frozen');
    if (!inside(plan.configPath, root)) violations.push('config escapes the experiment root');
    if (!inside(plan.stateRoot, root)) violations.push('state root escapes the experiment root');
    if (!inside(plan.plugin?.rootDir, rootDir)) violations.push('plugin root escapes the repository');
    checks.push(check('host-consistency', violations.length === 0 ? 'PASS' : 'FAIL',
      'P0 and the run launcher resolve the same host, config, state root and plugin artifact',
      { violations }));
  }

  // 5. Runtime hook registration — structured inspect JSON, not stdout text.
  const inspectPath = profile.ok && plan ? join(root, 'p0-inspect.json') : null;
  if (!profile.ok || !plan) {
    checks.push(check('hook-registration', 'NOT_RUN', 'blocked: isolated host or plan unavailable'));
  } else {
    const { command, prefixArgs } = hostCommand(profile);
    const env = {
      ...process.env,
      OPENCLAW_CONFIG_PATH: plan.configPath,
      OPENCLAW_STATE_DIR: plan.stateRoot,
      OPENCLAW_PROFILE: 'aa-p0',
    };
    const inspect = runCapture(command, [...prefixArgs, 'plugins', 'inspect', PLUGIN_ID, '--runtime', '--json'], {
      cwd: rootDir,
      timeout: 45_000,
      env,
    });
    let parsedInspect = null;
    try {
      parsedInspect = JSON.parse(inspect.stdout);
    } catch { /* reported as a failure below */ }
    if (inspectPath && parsedInspect) writeFileSync(inspectPath, `${JSON.stringify(parsedInspect, null, 2)}\n`, 'utf8');
    const typedHooks = Array.isArray(parsedInspect?.typedHooks)
      ? parsedInspect.typedHooks.map((row) => (typeof row?.name === 'string' ? row.name : null)).filter(Boolean)
      : [];
    const requiredHooks = ['before_prompt_build', 'before_tool_call'];
    const missingHooks = requiredHooks.filter((name) => !typedHooks.includes(name));
    const pluginStatus = parsedInspect?.plugin?.status ?? null;
    const pluginSource = parsedInspect?.plugin?.source ?? null;
    const registeredToolNames = Array.isArray(parsedInspect?.plugin?.toolNames) ? parsedInspect.plugin.toolNames : [];
    const sourceMatches = typeof pluginSource === 'string' && resolve(pluginSource).toLowerCase() === resolve(bundlePath).toLowerCase();
    const hookOk = inspect.status === 0 && parsedInspect !== null && pluginStatus === 'loaded'
      && missingHooks.length === 0 && sourceMatches;
    checks.push(check('hook-registration', hookOk ? 'PASS' : 'FAIL',
      'the isolated runtime loads the plugin bundle and registers the required hooks', {
        exitCode: inspect.status,
        inspectPath,
        pluginStatus,
        pluginSource,
        typedHooks,
        missingHooks,
        registeredToolNames,
        stderr: inspect.stderr.trim().slice(0, 400),
      }));
    report.hookRegistration = { typedHooks, pluginStatus, pluginSource, registeredToolNames };
  }

  // 5b. Frozen workspace target — the positive arm can only prove an
  // intervention if the plugin's own production stores resolve the same
  // artifact/activation and the same principleId. Nothing is seeded here.
  if (!plan) {
    checks.push(check('workspace-target', 'NOT_RUN', 'blocked: plan unavailable'));
  } else {
    const expected = plan.workspaceTarget;
    const violations = [];
    const target = await readControlledWorkspaceTarget({
      workspaceDir: plan.workspaceDir,
      artifactId: plan.mapping?.artifactId,
      activationId: plan.mapping?.activationId,
    });
    if (!target.ok) violations.push(`workspace target unreadable: ${target.reason ?? 'unknown'}`);
    if (expected?.artifactId !== plan.mapping?.artifactId || expected?.activationId !== plan.mapping?.activationId) {
      violations.push('plan workspace target differs from the mapping');
    }
    if (target.ok) {
      if (target.principleId !== expected?.principleId) violations.push('resolved principleId differs from the frozen plan');
      if (target.stateDbSha256 !== expected?.stateDbSha256) violations.push('workspace state.db differs from the frozen plan');
      if (target.promptActivationCount !== 1) violations.push(`workspace has ${target.promptActivationCount} prompt activations, expected exactly 1`);
    }
    const controlStateDb = join(plan.controlWorkspaceDir ?? '', '.pd', 'state.db');
    if (existsSync(controlStateDb)) violations.push('the control workspace contains a state.db; it must stay empty');
    checks.push(check('workspace-target', violations.length === 0 ? 'PASS' : 'FAIL',
      'the frozen positive workspace resolves exactly one target through the production stores; the control workspace stays empty', {
        violations,
        stateDbPath: expected?.stateDbPath ?? target.stateDbPath ?? null,
        stateDbSha256: target.ok ? target.stateDbSha256 : null,
        principleId: target.ok ? target.principleId : null,
        artifactId: plan.mapping?.artifactId ?? null,
        activationId: plan.mapping?.activationId ?? null,
      }));
    report.workspace = {
      principleId: target.ok ? target.principleId : null,
      stateDbSha256: target.ok ? target.stateDbSha256 : null,
      stateDbPath: expected?.stateDbPath ?? target.stateDbPath ?? null,
      artifactId: plan.mapping?.artifactId ?? null,
      activationId: plan.mapping?.activationId ?? null,
    };
  }

  // 6. Isolated configuration wiring (structural JSON, not textual patterns).
  if (!plan) {
    checks.push(check('isolated-config', 'NOT_RUN', 'blocked: plan unavailable'));
  } else if (!existsSync(plan.configPath)) {
    checks.push(check('isolated-config', 'FAIL', 'frozen config file is missing', { configPath: plan.configPath }));
  } else {
    const config = readHostConfig(plan.configPath);
    const violations = validateHostConfigWiring(config, {
      pluginRoot: plan.plugin.rootDir,
      workspaceDir: plan.workspaceDir,
      mapping: plan.mapping,
      toolName: plan.toolName,
      endpointPort: plan.endpoint.port,
    });
    if (!inside(plan.configPath, root)) violations.push('config escapes the experiment root');
    if (!inside(plan.workspaceDir, root)) violations.push('workspace escapes the experiment root');
    const sha = hostConfigSha256(plan.configPath);
    if (sha !== plan.configSha256) violations.push('config sha256 differs from the frozen plan');
    checks.push(check('isolated-config', violations.length === 0 ? 'PASS' : 'FAIL',
      'the frozen config routes the fake provider, plugin and single tool exactly as planned', {
        configPath: plan.configPath, configSha256: sha, violations,
      }));
    report.config = { configPath: plan.configPath, configSha256: sha };
    report.endpoint = { host: plan.endpoint.host, port: plan.endpoint.port, baseUrl: config?.models?.providers?.['aa-fake']?.baseUrl ?? null };
  }

  // 7. Frozen fixture / input / manifest / admission.
  if (!plan) {
    checks.push(check('frozen-files', 'NOT_RUN', 'blocked: plan unavailable'));
  } else {
    const violations = [];
    if (!existsSync(plan.manifestPath)) violations.push('manifest missing');
    if (!existsSync(plan.fixtureFile)) violations.push('fixture missing');
    else if (sha256File(plan.fixtureFile) !== plan.fixtureSha256) violations.push('fixture bytes changed');
    if (!existsSync(plan.inputFile)) violations.push('input missing');
    else if (sha256File(plan.inputFile) !== plan.inputSha256) violations.push('input bytes changed');
    if (!existsSync(plan.admissionPath)) violations.push('admission missing');
    else {
      const manifest = readJson(plan.manifestPath);
      const admission = readJson(plan.admissionPath);
      if (!manifest.ok) violations.push(`manifest unreadable: ${manifest.reason}`);
      else if (admission.ok) {
        const manifestSha256 = sha256File(plan.manifestPath);
        if (admission.value?.manifestSha256 !== manifestSha256) violations.push('admission.manifestSha256 differs from the frozen manifest');
        if (admission.value?.inputSha256 !== plan.inputSha256) violations.push('admission.inputSha256 differs from the frozen input');
        if (admission.value?.fixtureRef !== plan.fixtureRef) violations.push('admission.fixtureRef differs from the frozen fixture');
        if (manifest.value?.fixtureRef !== plan.fixtureRef) violations.push('manifest.fixtureRef differs from the frozen fixture');
        if (manifest.value?.targetArtifactId !== plan.mapping.artifactId) violations.push('manifest target artifact differs from the mapping');
      } else {
        violations.push(`admission unreadable: ${admission.reason}`);
      }
    }
    checks.push(check('frozen-files', violations.length === 0 ? 'PASS' : 'FAIL',
      'fixture, input, manifest and admission agree with the frozen plan', { violations }));
    report.fixtureRef = plan.fixtureRef;
  }

  // 8. Loopback reachability at the FROZEN port (the endpoint the host will call).
  if (!plan?.endpoint?.port) {
    checks.push(check('endpoint-loopback', 'FAIL', 'no frozen endpoint port in the plan'));
  } else {
    const probe = await probeBoundPort(plan.endpoint.port);
    checks.push(check('endpoint-loopback', probe.ok ? 'PASS' : 'FAIL',
      'the frozen 127.0.0.1 endpoint port is bindable and reachable', { ...probe, plannedPort: plan.endpoint.port }));
  }

  // 9. Process-tree termination capability.
  const taskkill = process.platform === 'win32' ? runCapture('where.exe', ['taskkill'], { timeout: 10_000 }) : { status: 0, stdout: 'n/a' };
  checks.push(check('termination', taskkill.status === 0 ? 'PASS' : 'FAIL',
    'taskkill is available for process-tree termination', {
      platform: process.platform,
      taskkillPath: taskkill.status === 0 ? taskkill.stdout.trim().split(/\r?\n/)[0] : null,
    }));

  // 10. Single-tool whitelist — structural, not a stdout substring.
  const toolName = expectedToolName ?? plan?.toolName ?? null;
  if (!plan) {
    checks.push(check('tool-whitelist', 'NOT_RUN', 'blocked: plan unavailable'));
  } else if (!toolName) {
    checks.push(check('tool-whitelist', 'FAIL', 'no tool name supplied by the plan or --tool-name'));
  } else {
    const config = readHostConfig(plan.configPath);
    const allow = Array.isArray(config?.tools?.allow) ? config.tools.allow : null;
    const exactAllowlist = allow !== null && allow.length === 1 && allow[0] === toolName;
    const pluginToolNames = Array.isArray(report.hookRegistration?.registeredToolNames) ? report.hookRegistration.registeredToolNames : null;
    const noPluginTools = pluginToolNames !== null && pluginToolNames.length === 0;
    checks.push(check('tool-whitelist', exactAllowlist && noPluginTools && toolName === plan.toolName ? 'PASS' : 'FAIL',
      'the declared allowlist is exactly one tool and the plugin registers none; the runtime tool surface is proven from the endpoint request body at execute', {
        toolName,
        declaredAllowlist: allow,
        pluginToolNames,
        definitiveEvidence: 'endpoint request body (gate tool-surface)',
      }));
  }

  report.ready = checks.every((row) => row.status === 'PASS');
  report.summary = {
    passed: checks.filter((row) => row.status === 'PASS').length,
    failed: checks.filter((row) => row.status === 'FAIL').length,
    notRun: checks.filter((row) => row.status === 'NOT_RUN').length,
    total: checks.length,
  };
  if (plan) {
    report.stateRoot = plan.stateRoot;
    report.fixtureRef = plan.fixtureRef;
  }
  return report;
}

function argValue(argv, name) {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : null;
}

async function main() {
  const argv = process.argv.slice(2);
  const report = await runP0Preflight({
    repoRoot: argValue(argv, 'repo') ?? process.env.PD_AA_REPO_ROOT ?? process.cwd(),
    hostRoot: argValue(argv, 'host-root') ?? process.env.PD_AA_HOST_ROOT ?? null,
    planPath: argValue(argv, 'plan'),
    experimentRoot: argValue(argv, 'experiment-root'),
    expectedToolName: argValue(argv, 'tool-name'),
  });
  const text = `${JSON.stringify(report, null, 2)}\n`;
  const out = argValue(argv, 'out');
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, text, 'utf8');
  }
  process.stdout.write(text);
  process.exitCode = report.ready ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${String(error?.stack ?? error)}\n`);
    process.exitCode = 2;
  });
}

export { main as runP0PreflightCli };
