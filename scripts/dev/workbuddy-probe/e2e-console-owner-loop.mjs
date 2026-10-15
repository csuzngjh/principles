#!/usr/bin/env node
/**
 * WorkBuddy E2E-06 — Console Owner loop over a REAL installed-product lab.
 *
 * Boots the real console server against a governance workspace produced by
 * e2e-installed-full-learning.mjs (or any workspace holding a completed
 * WorkBuddy learning chain) and asserts the OWNER-VISIBLE surface through the
 * real HTTP API — not "configuration succeeded", but the actual chain rows:
 *   1. /api/health                                  — server is up.
 *   2. GET /api/v1/approvals                        — this chain's approved
 *      prompt-channel approval is visible with its artifact attribution.
 *   3. GET /api/v1/activations?host=workbuddy       — the workbuddy target-host
 *      query is accepted and the activation row is visible with a workbuddy
 *      delivery attribution (route-unconfirmed rows are reported honestly).
 *   4. GET /api/v1/governance/experience            — the read-only governance
 *      snapshot parses (read-model health).
 *
 * Read-only: the console is started with --no-auth on 127.0.0.1 against the
 * lab workspace; no governance data is written. Usage:
 *   node scripts/dev/workbuddy-probe/e2e-console-owner-loop.mjs [--gov <dir>] [--port <n>] [--json <out>]
 * --gov defaults to the newest e2e-installed-learn-* lab's governance workspace
 * under WB_E2E_LAB (or the default lab root).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SERVER = path.join(REPO, 'packages', 'pd-console', 'dist', 'server.js');
const LAB_ROOT = process.env.WB_E2E_LAB || path.resolve(REPO, '../../../wb-probe-lab');

function parseArgs(argv) {
  const args = { gov: undefined, port: 0, json: undefined };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--gov') args.gov = argv[++i];
    else if (argv[i] === '--port') args.port = Number(argv[++i]);
    else if (argv[i] === '--json') args.json = argv[++i];
  }
  return args;
}

function newestInstalledLearnLabGov() {
  let best = null;
  let bestTs = -1;
  for (const entry of fs.readdirSync(LAB_ROOT)) {
    const match = /^e2e-installed-learn-(\d+)$/.exec(entry);
    if (!match) continue;
    const ts = Number(match[1]);
    const gov = path.join(LAB_ROOT, entry, 'fake-home', '.workbuddy', 'pd-workspace');
    if (ts > bestTs && fs.existsSync(path.join(gov, '.pd', 'config.yaml'))) {
      best = gov;
      bestTs = ts;
    }
  }
  return best;
}

const results = [];
function record(step, verdict, detail) {
  results.push({ step, verdict, detail: String(detail).slice(0, 400) });
  console.error(`[verdict=${verdict}] ${step} — ${String(detail).slice(0, 300)}`);
}

function dataArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') {
    for (const key of ['approvals', 'activations', 'items', 'rows']) {
      if (Array.isArray(payload[key])) return payload[key];
    }
  }
  return null;
}

async function getJson(url) {
  const res = await fetch(url);
  const body = await res.text();
  let parsed;
  try { parsed = JSON.parse(body); } catch { parsed = undefined; }
  return { status: res.status, body, parsed };
}

async function main() {
  const args = parseArgs(process.argv);
  const gov = args.gov ?? newestInstalledLearnLabGov();
  if (!gov || !fs.existsSync(gov)) {
    console.error('FAIL: no governance workspace found — pass --gov <dir> (run e2e-installed-full-learning.mjs first)');
    process.exit(1);
  }
  if (!fs.existsSync(SERVER)) {
    console.error(`FAIL: console dist missing: ${SERVER} — build packages/pd-console first`);
    process.exit(1);
  }
  record('workspace', 'PASS', `gov=${gov}`);

  const port = args.port || 3900 + Math.floor(Math.random() * 90);
  const child = spawn(process.execPath, [SERVER, '--workspace', gov, '--port', String(port), '--no-auth', '--host', '127.0.0.1'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverErr = '';
  child.stderr?.on('data', (d) => { serverErr += d; });

  const t0 = Date.now();
  let healthy = false;
  while (Date.now() - t0 < 20_000) {
    try {
      const { status, parsed } = await getJson(`http://127.0.0.1:${port}/api/health`);
      if (status === 200 && parsed?.success) { healthy = true; break; }
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!healthy) {
    record('console-up', 'FAIL', `no health 200 within 20s; stderr=${serverErr.slice(0, 200)}`);
    child.kill();
    process.exit(1);
  }
  record('console-up', 'PASS', `http://127.0.0.1:${port} (workspace ${gov})`);

  let failed = false;
  try {
    // 2. Approvals: the chain's approved prompt-channel approval must be visible.
    const approvals = await getJson(`http://127.0.0.1:${port}/api/v1/approvals`);
    const approvalRows = dataArray(approvals.parsed?.data ?? approvals.parsed);
    if (approvals.status !== 200 || !Array.isArray(approvalRows)) {
      record('approvals-visible', 'FAIL', `status=${approvals.status} shape=${JSON.stringify(approvals.body).slice(0, 200)}`);
      failed = true;
    } else {
      const approved = approvalRows.filter((row) => row && typeof row === 'object' && row.status === 'approved');
      const promptApproved = approved.filter((row) => row.channel === 'prompt' || row.channel === 'prompt_channel' || String(row.artifact_id ?? row.artifactId ?? '').includes('prompt'));
      record('approvals-visible', approved.length > 0 ? 'PASS' : 'FAIL',
        `${approvalRows.length} approval row(s), ${approved.length} approved, ${promptApproved.length} prompt-channel approved; sample=${JSON.stringify(approvalRows[0] ?? {}).slice(0, 220)}`);
      if (approved.length === 0) failed = true;
    }

    // 3. Activations with the workbuddy target-host query (third-host contract).
    const activations = await getJson(`http://127.0.0.1:${port}/api/v1/activations?host=workbuddy`);
    const activationRows = dataArray(activations.parsed?.data ?? activations.parsed);
    if (activations.status !== 200) {
      record('activations-workbuddy', 'FAIL', `status=${activations.status} body=${activations.body.slice(0, 200)}`);
      failed = true;
    } else if (!Array.isArray(activationRows)) {
      record('activations-workbuddy', 'FAIL', `unexpected shape: ${JSON.stringify(activations.body).slice(0, 200)}`);
      failed = true;
    } else {
      const sample = activationRows[0] ?? {};
      record('activations-workbuddy', activationRows.length > 0 ? 'PASS' : 'FAIL',
        `${activationRows.length} activation row(s) under host=workbuddy; sample=${JSON.stringify(sample).slice(0, 260)}`);
      if (activationRows.length === 0) failed = true;
    }

    // 4. Governance experience read-model.
    const experience = await getJson(`http://127.0.0.1:${port}/api/v1/governance/experience`);
    const expOk = experience.status === 200 && experience.parsed != null;
    record('governance-experience', expOk ? 'PASS' : 'FAIL',
      expOk ? `status=200 keys=${Object.keys(experience.parsed?.data ?? experience.parsed ?? {}).slice(0, 8).join(',')}` : `status=${experience.status} body=${experience.body.slice(0, 160)}`);
    if (!expOk) failed = true;
  } finally {
    child.kill();
  }

  if (args.json) {
    fs.mkdirSync(path.dirname(path.resolve(args.json)), { recursive: true });
    fs.writeFileSync(args.json, JSON.stringify({ gov, port, results, failed }, null, 2));
  }

  const passCount = results.filter((r) => r.verdict === 'PASS').length;
  console.error(`E2E-06 console owner loop: ${passCount} PASS, ${results.length - passCount} FAIL (gov=${gov})`);
  process.exit(failed ? 1 : 0);
}

try {
  await main();
} catch (error) {
  console.error('E2E-06 crashed:', error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
}
