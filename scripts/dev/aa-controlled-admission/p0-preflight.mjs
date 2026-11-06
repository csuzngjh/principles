// PRI-1118 controlled-admission P0 preflight (design v1.2 §3.4 / §6).
//
// Read-only except for a transient loopback endpoint used to prove 127.0.0.1
// reachability. It MUST NOT start a host turn or a model request. Every check
// is reported as PASS / FAIL / NOT_RUN with evidence; stdout is strict JSON
// (cli-1), diagnostics go to stderr, exit code is 0 only when all checks PASS.
//
// A NOT_RUN means the check could not be attempted because an earlier,
// environment-level check (usually the host binary) failed. It is never
// reported as a pass.

import { spawnSync } from 'node:child_process';
import { createServer, get as httpGet } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function runCapture(command, args, { cwd, timeout = 25_000 } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    timeout,
    windowsHide: true,
    encoding: 'utf8',
    shell: false,
  });
  return {
    status: result.status,
    error: result.error ? String(result.error.message ?? result.error) : null,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
  };
}

function resolveOnWindows(bin) {
  if (isAbsolute(bin) || bin.includes('/') || bin.includes('\\')) {
    return existsSync(bin) ? { status: 0, stdout: bin } : { status: 1, stdout: '', stderr: 'not found' };
  }
  return runCapture('where.exe', [bin], { timeout: 10_000 });
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

async function probeLoopback() {
  const server = createServer((req, res) => {
    res.writeHead(204);
    res.end();
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address !== 'object' || address.address !== '127.0.0.1') {
      return { ok: false, reason: `unexpected bind address ${JSON.stringify(address)}` };
    }
    const reachable = await new Promise((resolve) => {
      const req = httpGet({ hostname: '127.0.0.1', port: address.port, path: '/', timeout: 5000 }, (res) => {
        res.resume();
        resolve(res.statusCode === 204);
      });
      req.on('timeout', () => req.destroy());
      req.on('error', () => resolve(false));
    });
    return { ok: reachable, port: address.port };
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error) };
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve()));
  }
}

function verifyFrozenFiles(manifestPath, experimentRoot) {
  const manifestResult = readJson(manifestPath);
  if (!manifestResult.ok) return { ok: false, reason: `manifest unreadable: ${manifestResult.reason}` };
  const manifest = manifestResult.value;
  if (!manifest || typeof manifest !== 'object') return { ok: false, reason: 'manifest is not an object' };
  const root = resolve(experimentRoot);
  if (!isAbsolute(root)) return { ok: false, reason: 'experiment root must be absolute' };

  const fixtureFile = manifest.fixtureFile;
  if (typeof fixtureFile !== 'string' || !isAbsolute(fixtureFile)) {
    return { ok: false, reason: 'manifest.fixtureFile must be an absolute path' };
  }
  if (!resolve(fixtureFile).startsWith(root)) {
    return { ok: false, reason: 'manifest.fixtureFile escapes the experiment root' };
  }
  if (!existsSync(fixtureFile)) return { ok: false, reason: 'fixture file missing' };

  const fixtureSha256 = sha256File(fixtureFile);
  if (fixtureSha256 !== manifest.fixtureSha256) {
    return { ok: false, reason: 'fixture sha256 does not match manifest', fixtureSha256 };
  }
  const inputFile = manifest.inputFile;
  if (typeof inputFile !== 'string' || !isAbsolute(inputFile) || !existsSync(inputFile)) {
    return { ok: false, reason: 'manifest.inputFile missing or not absolute' };
  }
  if (!resolve(inputFile).startsWith(root)) return { ok: false, reason: 'manifest.inputFile escapes the experiment root' };
  const inputBytes = readFileSync(inputFile);
  const inputSha256 = createHash('sha256').update(inputBytes).digest('hex');
  if (manifest.inputSha256 !== inputSha256) return { ok: false, reason: 'input sha256 does not match manifest' };

  const manifestSha256 = sha256File(manifestPath);
  const admissionPath = join(dirname(manifestPath), 'admission.json');
  if (existsSync(admissionPath)) {
    const admissionResult = readJson(admissionPath);
    if (!admissionResult.ok) return { ok: false, reason: `admission unreadable: ${admissionResult.reason}` };
    const admission = admissionResult.value;
    if (admission?.manifestSha256 !== manifestSha256) {
      return { ok: false, reason: 'admission.manifestSha256 does not match the frozen manifest' };
    }
    if (admission?.inputSha256 !== inputSha256) {
      return { ok: false, reason: 'admission.inputSha256 does not match the frozen input' };
    }
    if (admission?.fixtureRef !== manifest.fixtureRef) {
      return { ok: false, reason: 'admission.fixtureRef does not match the frozen manifest' };
    }
  }
  return {
    ok: true,
    fixtureSha256,
    inputSha256,
    manifestSha256,
    fixtureRef: manifest.fixtureRef ?? null,
    admissionPresent: existsSync(admissionPath),
  };
}

/**
 * Run the preflight. Returns the report object; the CLI wrapper prints it.
 * No host process is started when the host binary cannot be resolved.
 */
export async function runP0Preflight({
  repoRoot,
  openclawBin = 'openclaw',
  configPath = null,
  manifestPath = null,
  experimentRoot = null,
  expectedToolName = null,
} = {}) {
  const checks = [];
  const report = {
    schemaVersion: 'pd-aa-p0-preflight/v1',
    generatedAt: new Date().toISOString(),
    repoRoot: repoRoot ? resolve(repoRoot) : null,
    openclawBin,
    ready: false,
    checks,
  };
  if (!repoRoot) {
    checks.push(check('repo-root', 'FAIL', 'repoRoot is required'));
    return report;
  }

  // 1. Plugin bundle from THIS repository (official dev entry, not installed dir).
  const bundlePath = join(resolve(repoRoot), 'packages', 'openclaw-plugin', 'dist', 'index.js');
  let bundleSha256 = null;
  if (!existsSync(bundlePath)) {
    checks.push(check('plugin-bundle', 'FAIL', 'built plugin bundle missing', { bundlePath }));
  } else {
    bundleSha256 = sha256File(bundlePath);
    const head = runCapture('git', ['rev-parse', 'HEAD'], { cwd: resolve(repoRoot), timeout: 10_000 });
    checks.push(check('plugin-bundle', 'PASS', 'repository build artifact present', {
      bundlePath,
      bundleSha256,
      sizeBytes: statSync(bundlePath).size,
      gitHead: head.status === 0 ? head.stdout.trim() : null,
      gitHeadError: head.status === 0 ? null : head.stderr.trim(),
    }));
  }
  report.bundle = { bundlePath, bundleSha256 };

  // 2. Host binary resolution (NO host turn, NO model request).
  const resolved = resolveOnWindows(openclawBin);
  let hostAvailable = false;
  let inspectResult = null;
  if (resolved.status === 0 && resolved.stdout.trim().length > 0) {
    hostAvailable = true;
    const resolvedPath = resolved.stdout.trim().split(/\r?\n/)[0];
    const version = runCapture(resolvedPath, ['--version'], { timeout: 20_000 });
    checks.push(check('host-binary', version.status === 0 ? 'PASS' : 'FAIL', 'host CLI resolved and --version ran', {
      resolvedPath,
      versionExitCode: version.status,
      version: version.stdout.trim().slice(0, 200),
      stderr: version.stderr.trim().slice(0, 400),
    }));
    hostAvailable = version.status === 0;
    report.host = { resolvedPath, version: version.stdout.trim().slice(0, 200) };
    if (hostAvailable) {
      inspectResult = runCapture(resolvedPath, ['plugins', 'inspect', '--runtime'], {
        cwd: resolve(repoRoot),
        timeout: 25_000,
      });
    }
  } else {
    checks.push(check('host-binary', 'FAIL', 'host CLI not resolvable; cannot run a host turn', {
      whereStdout: resolved.stdout.trim().slice(0, 400),
      whereStderr: (resolved.stderr ?? '').trim().slice(0, 400),
    }));
    report.host = { resolvedPath: null, version: null };
  }

  // 3. Installed package health (read-only observation, never repaired here).
  const installedPackageJson = process.env.APPDATA
    ? join(process.env.APPDATA, 'npm', 'node_modules', 'openclaw', 'package.json')
    : null;
  if (installedPackageJson && existsSync(installedPackageJson)) {
    const parsed = readJson(installedPackageJson);
    const packageDir = dirname(installedPackageJson);
    const lifecyclePendingInPackage = existsSync(join(packageDir, '.openclaw-lifecycle-pending'));
    const lifecyclePendingInNpm = existsSync(join(dirname(packageDir), '.openclaw-lifecycle-pending'));
    const lifecyclePending = lifecyclePendingInPackage || lifecyclePendingInNpm;
    const fsSafePath = join(packageDir, 'node_modules', '@openclaw', 'fs-safe');
    const fsSafePresent = existsSync(fsSafePath) && existsSync(join(fsSafePath, 'package.json'));
    checks.push(check('host-package-health', parsed.ok && !lifecyclePending && fsSafePresent ? 'PASS' : 'FAIL',
      'installed package version and lifecycle completeness', {
        packageJson: installedPackageJson,
        version: parsed.ok ? parsed.value?.version ?? null : null,
        parseError: parsed.ok ? null : parsed.reason,
        lifecyclePending,
        lifecyclePendingInPackage,
        lifecyclePendingInNpm,
        fsSafePresent,
      }));
  } else {
    checks.push(check('host-package-health', 'NOT_RUN', 'no installed openclaw package found under APPDATA', {
      expected: installedPackageJson,
    }));
  }

  // 4. Runtime hook registration — only meaningful with a working host.
  if (!hostAvailable) {
    checks.push(check('hook-registration', 'NOT_RUN', 'blocked: host binary unavailable; before_prompt_build unproven'));
  } else {
    const inspect = inspectResult;
    const out = `${inspect.stdout}\n${inspect.stderr}`;
    const hookRegistered = out.includes('before_prompt_build');
    checks.push(check('hook-registration', inspect.status === 0 && hookRegistered ? 'PASS' : 'FAIL',
      'plugins inspect --runtime must show before_prompt_build', {
        exitCode: inspect.status,
        stdoutSha256: createHash('sha256').update(inspect.stdout).digest('hex'),
        stdoutPreview: inspect.stdout.slice(0, 1200),
        stderrPreview: inspect.stderr.slice(0, 600),
        hookRegistered,
      }));
  }

  // 5. Isolated configuration.
  if (!configPath) {
    checks.push(check('isolated-config', 'NOT_RUN', 'no --config supplied; isolation unproven'));
  } else if (!existsSync(configPath)) {
    checks.push(check('isolated-config', 'FAIL', 'config file missing', { configPath }));
  } else {
    const content = readFileSync(configPath, 'utf8');
    const loopbackEndpoint = /127\.0\.0\.1/.test(content);
    const conversationAccess = /allowConversationAccess\s*:\s*true/.test(content);
    const insideExperimentRoot = experimentRoot ? resolve(configPath).startsWith(resolve(experimentRoot)) : false;
    checks.push(check('isolated-config', loopbackEndpoint && conversationAccess && insideExperimentRoot ? 'PASS' : 'FAIL',
      'config must live under the experiment root, point at 127.0.0.1 and allow tool access', {
        configPath,
        configSha256: createHash('sha256').update(content).digest('hex'),
        loopbackEndpoint,
        conversationAccess,
        insideExperimentRoot,
      }));
  }

  // 6. Frozen input/manifest/admission consistency + fixture id.
  if (!manifestPath) {
    checks.push(check('frozen-files', 'NOT_RUN', 'no --manifest supplied (run the launcher --dry-run first)'));
  } else if (!experimentRoot) {
    checks.push(check('frozen-files', 'FAIL', 'manifest verification requires --experiment-root'));
  } else {
    const frozen = verifyFrozenFiles(manifestPath, experimentRoot);
    checks.push(check('frozen-files', frozen.ok ? 'PASS' : 'FAIL',
      'fixture/input/manifest/admission hashes and fixtureRef agree',
      frozen));
    report.fixtureRef = frozen.ok ? frozen.fixtureRef : null;
    report.frozen = frozen;
  }

  // 7. Loopback endpoint reachability.
  const loopback = await probeLoopback();
  checks.push(check('endpoint-loopback', loopback.ok ? 'PASS' : 'FAIL', 'temporary 127.0.0.1 endpoint reachable', loopback));

  // 8. Process-tree termination capability.
  const taskkill = process.platform === 'win32' ? resolveOnWindows('taskkill') : { status: 0, stdout: 'n/a' };
  checks.push(check('termination', taskkill.status === 0 ? 'PASS' : 'FAIL',
    'taskkill available for process-tree termination', {
      platform: process.platform,
      taskkillPath: taskkill.status === 0 ? taskkill.stdout.trim().split(/\r?\n/)[0] : null,
    }));

  // 9. Tool name (whitelist entry actually reachable at runtime).
  if (!expectedToolName) {
    checks.push(check('tool-whitelist', 'FAIL', 'no --tool-name supplied; the single read-only tool is unproven'));
  } else if (!hostAvailable) {
    checks.push(check('tool-whitelist', 'NOT_RUN', 'blocked: host binary unavailable; tool registration unproven', {
      expectedToolName,
    }));
  } else {
    const inspect = inspectResult;
    const out = `${inspect.stdout}\n${inspect.stderr}`;
    const toolPresent = out.includes(expectedToolName);
    checks.push(check('tool-whitelist', inspect.status === 0 && toolPresent ? 'PASS' : 'FAIL',
      'expected read-only tool must appear in runtime inspect output', {
        expectedToolName,
        toolPresent,
        exitCode: inspect.status,
      }));
  }

  report.ready = checks.every((row) => row.status === 'PASS');
  report.summary = {
    passed: checks.filter((row) => row.status === 'PASS').length,
    failed: checks.filter((row) => row.status === 'FAIL').length,
    notRun: checks.filter((row) => row.status === 'NOT_RUN').length,
    total: checks.length,
  };
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
    openclawBin: argValue(argv, 'openclaw-bin') ?? 'openclaw',
    configPath: argValue(argv, 'config'),
    manifestPath: argValue(argv, 'manifest'),
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
