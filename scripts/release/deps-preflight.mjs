#!/usr/bin/env node
/**
 * Dependency preflight for the exact-version publish train (PRI-886).
 *
 * Replaces the old inline `npm view >/dev/null 2>&1` gate in the shared
 * publish action. That gate (a) hid every diagnostic, (b) waited a flat
 * 5×15s, and (c) misread "published moments ago, not yet propagated" as
 * "the committed range excludes the dependency" — production evidence:
 * run 35596275911 failed at 4/7 because @principles/core@1.287.1 was not
 * yet visible minutes after 1/7 published it, while the range ^1.287.1
 * was exactly right.
 *
 * Two phases, both reading the PRODUCT manifests at the cohort checkout
 * while this script itself runs from the TOOLS checkout:
 *
 *   Static (no registry, runs before the FIRST upload of the train):
 *     - every internal dependency range must admit the dependency's
 *       committed cohort version (a range that excludes it is a
 *       deterministic error — waiting can never fix it);
 *     - the train order must be a dependency topological order.
 *
 *   Dynamic (per package, gated on ABSENT, before its npm publish):
 *     - each internal dependency range must resolve on the registry;
 *     - a dependency whose cohort version publishes earlier in the train
 *       but is not yet visible gets a BOUNDED backoff wait
 *       (5s/10s/20s/40s, then ≤60s) inside a total window (default 10min)
 *       with a per-request timeout;
 *     - failures are CLASSIFIED and reported (never hidden):
 *         NOT_VISIBLE_WITHIN_WINDOW — waited out the window; this is NOT
 *                              interpreted as a range error (the static
 *                              phase already proved the range admits the
 *                              cohort version)
 *         RATE_LIMITED / SERVER_ERROR / NETWORK_ERROR / NETWORK_TIMEOUT
 *                              — registry-side, retryable within the
 *                              window, reported with the HTTP class
 *         AUTH                  — fatal immediately, never waited out
 *         STATIC_PLAN_ERROR     — deterministic range/order problem
 *
 * Exit codes: 0 ok · 2 usage · 10 static plan error · 11 not visible
 * within window · 12 registry/auth error (class in JSON). All timings are
 * env-overridable for tests; tests additionally inject sleep/fetch so no
 * test ever waits the real window.
 *
 * Usage:
 *   node deps-preflight.mjs --workspace-root <dir> \
 *        --order principles-core,install-layout,host-runtime,codex-adapter,openclaw-plugin,pd-cli,create-principles-disciple \
 *        [--package <dir>] [--static-only] [--json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fetchPackument, RegistryError } from './lib/registry-client.mjs';
import { rangeHasRegistryMatch } from './lib/pending-window.mjs';

// ---- CLI (runs only when executed as a script, never when imported by tests) ----
function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const invokedAsScript =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;
const asJson = process.argv.includes('--json');

if (invokedAsScript) {
  const workspaceRoot = argValue('--workspace-root');
  const orderCsv = argValue('--order');
  const packageDir = argValue('--package');
  const staticOnly = process.argv.includes('--static-only');
  if (!workspaceRoot || !orderCsv) usage();

  const plan = buildTrainPlan({
    workspaceRoot: path.resolve(workspaceRoot),
    order: orderCsv.split(',').map((s) => s.trim()).filter(Boolean),
  });
  const staticResult = validatePlanStatic(plan);
  if (!staticResult.ok) {
    emitExit({ phase: 'static', errors: staticResult.errors }, 10);
  }
  if (staticOnly) {
    emitExit({ phase: 'static', ok: true, plan: plan.map((p) => `${p.name}@${p.version}`) }, 0);
  }
  if (!packageDir) usage();

  const result = await waitForPackageDependencies({ plan, packageDir });
  if (result.ok) {
    emitExit({ phase: 'dynamic', ok: true, package: result.package, checked: result.checked }, 0);
  }
  const kind = result.failed.kind;
  emitExit(
    { phase: 'dynamic', ok: false, package: result.package, failed: result.failed },
    kind === 'NOT_VISIBLE_WITHIN_WINDOW' ? 11 : 12,
  );
}

export function defaultBackoffScheduleMs() {
  const raw = process.env.PD_RELEASE_DEPS_BACKOFF_MS;
  if (raw) {
    const parsed = raw
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (parsed.length > 0) return parsed;
  }
  return [5000, 10000, 20000, 40000];
}

export function defaultMaxBackoffMs() {
  const n = Number(process.env.PD_RELEASE_DEPS_MAX_BACKOFF_MS);
  return Number.isFinite(n) && n > 0 ? n : 60000;
}

export function defaultTotalWindowMs() {
  const n = Number(process.env.PD_RELEASE_DEPS_TOTAL_WINDOW_MS);
  return Number.isFinite(n) && n > 0 ? n : 600000;
}

export function defaultRequestTimeoutMs() {
  const n = Number(process.env.PD_RELEASE_REQUEST_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 15000;
}

/**
 * Read the train plan from the PRODUCT workspace at the cohort checkout.
 * `order` is the publish order of package directories — the workflow is
 * the single source of that order and passes it in explicitly.
 */
export function buildTrainPlan({ workspaceRoot, order }) {
  if (!Array.isArray(order) || order.length === 0) {
    throw new Error('order must be a non-empty array of package directories');
  }
  const seen = new Set();
  return order.map((dir) => {
    if (typeof dir !== 'string' || !/^[a-z0-9-]+$/i.test(dir)) {
      throw new Error(`invalid package directory in train order: ${JSON.stringify(dir)}`);
    }
    if (seen.has(dir)) throw new Error(`duplicate package directory in train order: ${dir}`);
    seen.add(dir);
    const manifestPath = path.join(workspaceRoot, 'packages', dir, 'package.json');
    if (!fs.existsSync(manifestPath)) {
      throw new Error(`manifest not found for train entry packages/${dir}/package.json (workspace root: ${workspaceRoot})`);
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') {
      throw new Error(`manifest packages/${dir}/package.json lacks name/version`);
    }
    const deps = {
      ...(manifest.dependencies ?? {}),
      ...(manifest.peerDependencies ?? {}),
      ...(manifest.optionalDependencies ?? {}),
    };
    const internalDeps = {};
    for (const [name, range] of Object.entries(deps)) {
      if (name.startsWith('@principles/') || name === 'principles-disciple') {
        if (typeof range !== 'string' || range.trim() === '') {
          throw new Error(`packages/${dir} declares internal dependency ${name} with a non-string range`);
        }
        internalDeps[name] = range;
      }
    }
    return { dir, name: manifest.name, version: manifest.version, internalDeps };
  });
}

/**
 * Static validation: deterministic errors that no amount of waiting can
 * fix. Runs before the train's FIRST upload.
 */
export function validatePlanStatic(plan) {
  const errors = [];
  const byName = new Map(plan.map((p) => [p.name, p]));
  const position = new Map(plan.map((p, i) => [p.name, i]));
  for (const pkg of plan) {
    for (const [depName, range] of Object.entries(pkg.internalDeps)) {
      const dep = byName.get(depName);
      if (!dep) {
        errors.push({
          kind: 'UNKNOWN_INTERNAL_DEP',
          package: pkg.name,
          dep: depName,
          message: `${pkg.name} declares internal dependency ${depName}@${range}, but that package is not in the train order.`,
        });
        continue;
      }
      if (!rangeHasRegistryMatch(range, [dep.version])) {
        errors.push({
          kind: 'RANGE_EXCLUDES_COHORT_VERSION',
          package: pkg.name,
          dep: depName,
          range,
          depCohortVersion: dep.version,
          message: `${pkg.name} declares ${depName}@${range}, but the cohort commits ${depName}@${dep.version} — the range excludes the very version this train publishes. Fix the manifest range; waiting cannot fix this.`,
        });
      }
      if (position.get(depName) >= position.get(pkg.name)) {
        errors.push({
          kind: 'ORDER_VIOLATION',
          package: pkg.name,
          dep: depName,
          message: `${pkg.name} depends on ${depName}, but publishes at position ${position.get(pkg.name)} — not after ${depName} at position ${position.get(depName)}. The train order must be a dependency topological order.`,
        });
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Classify a registry client failure into the PRI-861-style sanitized
 * classes. Never echoes URLs, tokens or auth configuration — only the
 * HTTP status or the error family.
 */
export function classifyRegistryError(err) {
  if (err instanceof RegistryError) {
    if (err.status === 429) return { kind: 'RATE_LIMITED', retryable: true, detail: 'HTTP 429 (rate limited)' };
    if (err.status === 401 || err.status === 403) {
      return { kind: 'AUTH', retryable: false, detail: `HTTP ${err.status} (authentication/authorization)` };
    }
    if (typeof err.status === 'number' && err.status >= 500) {
      return { kind: 'SERVER_ERROR', retryable: true, detail: `HTTP ${err.status} (server error)` };
    }
    if (typeof err.status === 'number') {
      return { kind: 'HTTP_ERROR', retryable: true, detail: `HTTP ${err.status}` };
    }
    const message = String(err?.message ?? err);
    if (/abort|timed? ?out/i.test(message)) {
      return { kind: 'NETWORK_TIMEOUT', retryable: true, detail: 'request timed out' };
    }
    return { kind: 'NETWORK_ERROR', retryable: true, detail: 'network failure reaching the registry' };
  }
  if (err?.name === 'AbortError' || /abort|timed? ?out/i.test(String(err?.message ?? err))) {
    return { kind: 'NETWORK_TIMEOUT', retryable: true, detail: 'request timed out' };
  }
  return { kind: 'NETWORK_ERROR', retryable: true, detail: 'network failure reaching the registry' };
}

function versionListFromPackument(packument) {
  if (!packument || typeof packument !== 'object' || !Object.hasOwn(packument, 'versions')) return [];
  const versions = packument.versions;
  if (versions === null || typeof versions !== 'object' || Array.isArray(versions)) return [];
  return Object.keys(versions).filter((v) => typeof v === 'string' && /^\d+\.\d+\./.test(v));
}

async function waitOneDependency({
  depName,
  range,
  depCohortVersion,
  fetchImpl,
  sleepImpl,
  backoffSchedule,
  maxBackoffMs,
  totalWindowMs,
  requestTimeoutMs,
  onEvent,
}) {
  let waitedMs = 0;
  let attempt = 0;
  let lastAnswer;
  while (true) {
    attempt += 1;
    try {
      const packument = await fetchPackument(depName, {
        fetchImpl,
        timeoutMs: requestTimeoutMs,
        attempts: 1,
        delayMs: 0,
      });
      const versions = versionListFromPackument(packument);
      if (rangeHasRegistryMatch(range, versions)) {
        onEvent?.({ dep: depName, range, attempt, waitedMs, visible: true, versionCount: versions.length });
        return { ok: true, dep: depName, range, attempts: attempt, waitedMs };
      }
      lastAnswer = packument
        ? { kind: 'NOT_YET_VISIBLE', detail: `registry serves ${versions.length} version(s) of ${depName}; none satisfies ${range}` }
        : { kind: 'NOT_YET_VISIBLE', detail: `${depName} packument absent from the registry (package 404)` };
      onEvent?.({ dep: depName, range, attempt, waitedMs, answer: lastAnswer });
    } catch (err) {
      const classified = classifyRegistryError(err);
      lastAnswer = classified;
      onEvent?.({ dep: depName, range, attempt, waitedMs, answer: classified });
      if (!classified.retryable) {
        return { ok: false, dep: depName, range, kind: classified.kind, detail: classified.detail, attempts: attempt, waitedMs };
      }
    }
    const delay = attempt <= backoffSchedule.length ? backoffSchedule[attempt - 1] : maxBackoffMs;
    if (waitedMs + delay > totalWindowMs) {
      return {
        ok: false,
        dep: depName,
        range,
        depCohortVersion,
        kind: 'NOT_VISIBLE_WITHIN_WINDOW',
        windowMs: totalWindowMs,
        waitedMs,
        attempts: attempt,
        lastAnswerKind: lastAnswer.kind,
        lastAnswerDetail: lastAnswer.detail,
        message:
          `${depName}@${range} (declared by this train leg) did not become resolvable within the bounded ` +
          `window of ${Math.round(totalWindowMs / 1000)}s (last answer: ${lastAnswer.kind} — ${lastAnswer.detail}). ` +
          `The static plan already proves the range admits the cohort version ${depName}@${depCohortVersion}, ` +
          `so this is a registry visibility/health condition, NOT a dependency-range error. ` +
          `Check registry.npmjs.org status and propagation; retrying the train re-enters this check idempotently.`,
      };
    }
    onEvent?.({ dep: depName, range, waiting: true, delayMs: delay, waitedMs });
    await sleepImpl(delay);
    waitedMs += delay;
  }
}

/**
 * Dynamic phase for one package: wait (bounded) until every internal
 * dependency range resolves on the registry.
 */
export async function waitForPackageDependencies({
  plan,
  packageDir,
  fetchImpl,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  backoffSchedule = defaultBackoffScheduleMs(),
  maxBackoffMs = defaultMaxBackoffMs(),
  totalWindowMs = defaultTotalWindowMs(),
  requestTimeoutMs = defaultRequestTimeoutMs(),
  onEvent,
}) {
  const pkg = plan.find((p) => p.dir === packageDir);
  if (!pkg) throw new Error(`package directory ${packageDir} is not in the train plan`);
  const byName = new Map(plan.map((p) => [p.name, p]));
  const checked = [];
  for (const [depName, range] of Object.entries(pkg.internalDeps)) {
    const dep = byName.get(depName);
    const result = await waitOneDependency({
      depName,
      range,
      depCohortVersion: dep ? dep.version : '(not in train)',
      fetchImpl,
      sleepImpl,
      backoffSchedule,
      maxBackoffMs,
      totalWindowMs,
      requestTimeoutMs,
      onEvent,
    });
    checked.push(result);
    if (!result.ok) {
      return { ok: false, package: pkg.name, packageDir, failed: result, checked };
    }
  }
  return { ok: true, package: pkg.name, packageDir, checked };
}

function emitExit(payload, code) {
  if (asJson) console.log(JSON.stringify(payload, null, 2));
  const failed = payload.ok === false || payload.errors || payload.failed;
  const messages = payload.errors
    ? payload.errors.map((e) => `[${e.kind}] ${e.message}`)
    : payload.failed
      ? [`[${payload.failed.kind ?? 'STATIC_PLAN_ERROR'}] ${payload.failed.message ?? JSON.stringify(payload.failed)}`]
      : [];
  for (const m of messages) console.error(`::error::${m}`);
  if (!asJson) {
    console.error(
      failed
        ? `deps-preflight FAILED (${
            payload.failed?.kind ?? payload.errors?.[0]?.kind ?? 'STATIC_PLAN_ERROR'
          }) — exit ${code}`
        : `deps-preflight OK${payload.checked ? ` (${payload.checked.length} dependency range(s) resolvable)` : ' (static plan)'}`,
    );
  }
  process.exit(code);
}

function usage() {
  console.error(
    'usage: deps-preflight.mjs --workspace-root <dir> --order <csv-of-package-dirs> [--package <dir>] [--static-only] [--json]',
  );
  process.exit(2);
}
