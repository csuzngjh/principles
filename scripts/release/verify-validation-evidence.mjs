#!/usr/bin/env node
/**
 * Validation-evidence reuse verifier for the publish train (PRI-886).
 *
 * A re-dispatched recovery train must not pay for the ~1h full release
 * matrix again when a prior run already validated the SAME cohort. But
 * reuse must be EARNED programmatically — there is no boolean bypass:
 *
 *   node verify-validation-evidence.mjs --run-id <id> \
 *        --expect-cohort <sha> --trust-sha <sha> \
 *        --matrix-file .github/workflows/release-reproducibility-full.yml \
 *        [--repo owner/name] [--json]
 *
 * Verified properties (a rejection reason is produced for each failure):
 *   1. same repository   — the run is fetched from this repo's API scope;
 *   2. trusted workflow  — run.path is publish-npm.yml (our dispatcher)
 *                          or release-reproducibility-full.yml (the gate
 *                          itself); every workflow-file revision the run
 *                          used (head_sha + referenced_workflows) must be
 *                          an ANCESTOR of the trusted tools SHA, i.e.
 *                          reviewed main history, never a fork PR;
 *   3. validated cohort  — one matrix job's logs must show BOTH the
 *                          checkout input echo (`ref: <cohort>`) and the
 *                          real `git fetch ... <cohort>` command line, so
 *                          the evidence cannot be claimed for a different
 *                          ref than the jobs actually built;
 *   4. explicit attempt  — jobs are filtered to run.run_attempt and the
 *                          attempt is recorded in the verdict;
 *   5. complete checks   — EVERY matrix leg of the CURRENT baseline
 *                          (parsed from the trusted workflow file: 5
 *                          runners × 3 nodes) plus the Windows N-1→N
 *                          upgrade gate must be present with conclusion
 *                          success. The run's OVERALL conclusion is
 *                          deliberately ignored: a publish train run that
 *                          failed at the publish job is still valid
 *                          validation evidence for its matrix legs.
 *
 * Evidence that cannot be verified (e.g. logs expired) is REJECTED —
 * fail loud, never silently reuse. Exit 0 = reusable, 1 = rejected.
 *
 * NOTE for operators: passing a run id is only legitimate when the fix
 * between the evidence run and this dispatch changed NO build, packaging
 * or product-payload inputs (control-path-only recovery). A rerun of an
 * old failed run keeps the OLD workflow revision — adopting new tools
 * requires a fresh dispatch, which is exactly this entry point.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const TRUSTED_WORKFLOW_PATHS = new Set([
  '.github/workflows/publish-npm.yml',
  '.github/workflows/release-reproducibility-full.yml',
]);

const MATRIX_JOB_PATTERN = /^.*\/\s*native-release-matrix \((.+), (.+)\)$/;
const UPGRADE_GATE_PATTERN = /N-1 to N real upgrade gate/;

/**
 * Parse the matrix baseline (runner×node legs + windows gate presence)
 * from the trusted copy of release-reproducibility-full.yml. `load` is
 * injected so tests can stub YAML parsing; the CLI passes the js-yaml
 * interop shim (named `load` or `default.load`).
 */
export function parseMatrixBaseline(workflowText, load) {
  const doc = load(workflowText);
  if (typeof doc !== 'object' || doc === null || !Object.hasOwn(doc, 'jobs')) {
    throw new Error('matrix workflow did not parse to a mapping with jobs');
  }
  const jobs = doc.jobs;
  const matrixJob = jobs['native-release-matrix'];
  const matrix = matrixJob?.strategy?.matrix;
  if (!Array.isArray(matrix?.runner) || !Array.isArray(matrix?.node)) {
    throw new Error('release-reproducibility-full.yml has no native-release-matrix runner×node matrix');
  }
  const legs = [];
  for (const runner of matrix.runner) {
    for (const node of matrix.node) {
      legs.push({ runner: String(runner), node: String(node) });
    }
  }
  const hasWindowsGate = Object.keys(jobs).some((key) => UPGRADE_GATE_PATTERN.test(jobs[key]?.name ?? key));
  return { legs, hasWindowsGate };
}

async function defaultFetchImpl(url, init) {
  const headers = { accept: 'application/vnd.github+json', ...(init?.headers ?? {}) };
  return fetch(url, { ...init, headers, redirect: 'follow' });
}

function defaultGitIsAncestor(sha, trustSha, cwd) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', sha, trustSha], { cwd, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function parseLinkNext(linkHeader) {
  if (typeof linkHeader !== 'string') return null;
  for (const part of linkHeader.split(',')) {
    const m = /^\s*<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (m) return m[1];
  }
  return null;
}

/**
 * Verify one candidate validation run. All IO is injectable for tests
 * (fetchImpl / gitIsAncestor); the CLI wires real implementations.
 * fetchImpl receives ABSOLUTE urls (apiBase-derived) and must follow
 * redirects (log downloads 302 to a signed blob URL).
 */
export async function verifyValidationEvidence({
  runId,
  repo,
  expectCohort,
  trustSha,
  expectedLegs,
  expectWindowsGate = true,
  apiBase = 'https://api.github.com',
  token,
  fetchImpl = defaultFetchImpl,
  gitIsAncestor = defaultGitIsAncestor,
  gitCwd = process.cwd(),
  log = () => {},
}) {
  const reasons = [];
  const facts = { runId: null, attempt: null, workflowPath: null, workflowShas: [], validatedRef: null, legsChecked: [] };
  if (!Number.isInteger(runId) || runId <= 0) return { ok: false, reasons: ['run id must be a positive integer'], facts };
  if (!/^[a-f0-9]{40}$/.test(expectCohort ?? '')) return { ok: false, reasons: ['expect-cohort must be a 40-char git sha'], facts };
  if (!/^[a-f0-9]{40}$/.test(trustSha ?? '')) return { ok: false, reasons: ['trust-sha must be a 40-char git sha'], facts };
  if (!Array.isArray(expectedLegs) || expectedLegs.length === 0) {
    return { ok: false, reasons: ['expectedLegs must be a non-empty array of {runner,node}'], facts };
  }

  const api = (p) => `${apiBase.replace(/\/+$/, '')}/repos/${repo}${p}`;
  const authHeaders = token ? { authorization: `Bearer ${token}` } : {};

  async function getJson(url) {
    const res = await fetchImpl(url, { headers: { ...authHeaders } });
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      const label = url.includes('/actions/runs/') && url.endsWith('/jobs?per_page=100') ? 'jobs' : 'run';
      throw Object.assign(
        new Error(`GitHub API ${res.status} for ${label}${bodyText ? `: ${bodyText.slice(0, 200)}` : ''}`),
        { status: res.status },
      );
    }
    return res;
  }

  // 1–2. same repo (scoped endpoint) + trusted workflow + completed.
  let run;
  try {
    run = await (await getJson(api(`/actions/runs/${runId}`))).json();
  } catch (err) {
    return { ok: false, reasons: [`cannot read run ${runId} in ${repo}: ${err.message}`], facts };
  }
  facts.runId = run.id;
  facts.attempt = run.run_attempt ?? 1;
  facts.workflowPath = run.path ?? null;
  log(`run ${runId}: path=${run.path} event=${run.event} attempt=${facts.attempt} status=${run.status}`);
  if (!TRUSTED_WORKFLOW_PATHS.has(run.path)) {
    reasons.push(`untrusted workflow: run.path=${run.path}; expected one of ${[...TRUSTED_WORKFLOW_PATHS].join(', ')}`);
  }
  if (run.status !== 'completed') {
    reasons.push(`run is not completed (status=${run.status}) — evidence must come from a settled run`);
  }
  const workflowShas = [run.head_sha, ...((run.referenced_workflows ?? [])).map((w) => w?.sha)].filter(
    (s) => typeof s === 'string' && /^[a-f0-9]{40}$/.test(s),
  );
  facts.workflowShas = [...new Set(workflowShas)];
  for (const sha of facts.workflowShas) {
    if (!gitIsAncestor(sha, trustSha, gitCwd)) {
      reasons.push(`workflow revision ${sha} used by run ${runId} is not an ancestor of the trusted tools SHA ${trustSha}`);
    }
  }

  // 5. enumerate jobs (Link-header pagination), filtered to the recorded attempt.
  let jobs = [];
  try {
    let url = api(`/actions/runs/${runId}/jobs?per_page=100`);
    while (url) {
      const res = await getJson(url);
      const page = await res.json();
      if (!Array.isArray(page.jobs)) throw new Error('jobs payload has no jobs array');
      jobs = jobs.concat(page.jobs.filter((j) => (j.run_attempt ?? 1) === facts.attempt));
      url = parseLinkNext(typeof res.headers?.get === 'function' ? res.headers.get('link') : null);
    }
  } catch (err) {
    reasons.push(`cannot enumerate jobs for run ${runId}: ${err.message}`);
    jobs = [];
  }

  const legJobs = jobs.filter((j) => MATRIX_JOB_PATTERN.test(j.name ?? ''));
  const gateJobs = jobs.filter((j) => UPGRADE_GATE_PATTERN.test(j.name ?? '') && !MATRIX_JOB_PATTERN.test(j.name ?? ''));

  const expectedPairs = new Set(expectedLegs.map((l) => `${l.runner}|${l.node}`));
  const seenPairs = new Set();
  for (const job of legJobs) {
    const m = MATRIX_JOB_PATTERN.exec(job.name ?? '');
    if (m) seenPairs.add(`${m[1]}|${m[2]}`);
    facts.legsChecked.push({ name: job.name, conclusion: job.conclusion });
  }
  for (const expected of expectedPairs) {
    if (!seenPairs.has(expected)) {
      reasons.push(`required matrix leg missing from run ${runId} attempt ${facts.attempt}: ${expected.split('|').join(' / ')}`);
    }
  }
  for (const seen of seenPairs) {
    if (!expectedPairs.has(seen)) {
      reasons.push(`run ${runId} carries a matrix leg the current baseline does not define: ${seen.split('|').join(' / ')} (incompatible validation definition)`);
    }
  }
  for (const job of legJobs.filter((j) => j.conclusion !== 'success')) {
    reasons.push(`matrix leg did not succeed: ${job.name} (conclusion=${job.conclusion})`);
  }
  if (expectWindowsGate) {
    if (gateJobs.length === 0) {
      reasons.push(`the Windows N-1 to N real upgrade gate is absent from run ${runId} attempt ${facts.attempt}`);
    }
    for (const job of gateJobs.filter((j) => j.conclusion !== 'success')) {
      reasons.push(`upgrade gate did not succeed: ${job.name} (conclusion=${job.conclusion})`);
    }
  }

  // 3. actual validated ref, proven from one matrix job's logs.
  if (legJobs.length > 0) {
    const probe = legJobs[0];
    try {
      const res = await fetchImpl(api(`/actions/jobs/${probe.id}/logs`), { headers: { ...authHeaders } });
      if (!res.ok) {
        reasons.push(`cannot download logs of matrix leg "${probe.name}" (HTTP ${res.status}) — the validated ref is unverifiable, refusing to reuse`);
      } else {
        const text = await res.text();
        // Pure string matching — no RegExp is constructed from the input
        // (CodeQL regex-injection surface). The input echo is a line of the
        // exact form `ref: <cohort>`; the checkout proof is a git fetch
        // COMMAND line containing the cohort SHA.
        const lines = text.split('\n');
        // GitHub job-log lines carry a timestamp prefix (`2026-…Z   ref: <sha>`),
        // so the echo is proven by the line ENDING in `ref: <cohort>`.
        const refEcho = lines.some((line) => line.replace(/\r$/, '').trim().endsWith(`ref: ${expectCohort}`));
        const fetchCmd = lines.some((line) => {
          const t = line.trim();
          return t.includes('git') && t.includes('fetch') && t.includes(expectCohort);
        });
        if (!refEcho || !fetchCmd) {
          reasons.push(
            `matrix leg "${probe.name}" logs do not prove the validated ref is ${expectCohort} ` +
              `(input echo ${refEcho ? 'found' : 'MISSING'}, fetch command ${fetchCmd ? 'found' : 'MISSING'})`,
          );
        } else {
          facts.validatedRef = expectCohort;
          log(`validated-ref proof found in logs of "${probe.name}"`);
        }
      }
    } catch (err) {
      reasons.push(`cannot download logs of matrix leg "${probe.name}": ${err.message} — the validated ref is unverifiable, refusing to reuse`);
    }
  }

  const ok = reasons.length === 0;
  return { ok, reasons, facts };
}

// ---- CLI (runs only when executed as a script, never when imported by tests) ----
function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const invokedAsScript =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedAsScript) {
  const asJson = process.argv.includes('--json');
  const runIdRaw = argValue('--run-id');
  const expectCohort = argValue('--expect-cohort');
  const trustSha = argValue('--trust-sha');
  const matrixFile = argValue('--matrix-file');
  const repo = argValue('--repo');
  if (!runIdRaw || !expectCohort || !trustSha || !matrixFile) {
    console.error(
      'usage: verify-validation-evidence.mjs --run-id <id> --expect-cohort <sha> --trust-sha <sha> --matrix-file <path> [--repo owner/name] [--json]',
    );
    process.exit(2);
  }

  // The matrix baseline is parsed from the TRUSTED tools checkout's copy of
  // the validation workflow (the CLI's cwd — the evidence job checks the
  // tools checkout out at the workspace root), never the cohort's copy.
  const ns = await import('js-yaml');
  const load = typeof ns.load === 'function' ? ns.load : ns.default?.load;
  if (typeof load !== 'function') {
    console.error('::error::js-yaml load export not found in the tools workspace');
    process.exit(2);
  }
  const { legs, hasWindowsGate } = parseMatrixBaseline(fs.readFileSync(path.resolve(matrixFile), 'utf8'), load);

  const verdict = await verifyValidationEvidence({
    runId: Number(runIdRaw),
    repo: repo ?? 'csuzngjh/principles',
    expectCohort,
    trustSha,
    expectedLegs: legs,
    expectWindowsGate: hasWindowsGate,
    token: process.env.GITHUB_TOKEN,
    gitCwd: process.cwd(),
    log: (m) => console.error(`[evidence] ${m}`),
  });

  if (asJson) console.log(JSON.stringify(verdict, null, 2));
  if (verdict.ok) {
    if (!asJson) {
      console.error(
        `validation evidence REUSABLE: run ${verdict.facts.runId} (attempt ${verdict.facts.attempt}) validated cohort ` +
          `${verdict.facts.validatedRef} across ${verdict.facts.legsChecked.length} matrix legs + upgrade gate.`,
      );
    }
    process.exit(0);
  }
  for (const r of verdict.reasons) console.error(`::error::evidence rejected: ${r}`);
  if (!asJson) console.error(`validation evidence REJECTED for run ${runIdRaw} — the train will fall back to full validation or stop.`);
  process.exit(1);
}
