/**
 * PRI-1147 Phase 2 — real-LLM BDD over the Codex production chain.
 *
 * Per sample:
 *   1. isolated workspace + CODEX_HOME (bootstrapSampleEnv)
 *   2. processHookInvocation(UserPromptSubmit) — REAL ingestion + admission;
 *      a failed/throwing hook or a missing observation is an EXECUTION ERROR,
 *      never a semantic result (P1-1)
 *   3. capture Stage-1 outcome + pending marker state (pre-Stage-2 evidence)
 *   4. runStage2CorrectionCycle with the REAL workspace-resolved classifier
 *      under PRODUCTION DEFAULT budgets (P1-3), up to maxCycles; a marker
 *      still pending after the cycle budget is pending_unresolved, never NONE
 *   5. terminal state + per-call LLM measurements → results JSONL, with one
 *      final_outcome per sample from the frozen taxonomy (lib/outcomes.mjs)
 *
 * Result isolation (P1-2): every run writes ONLY inside
 * .tmp/pri-1147/runs/<run_id>/; existing outputs refuse to run unless
 * --append is passed explicitly. Partial runs (--samples) are recorded as
 * partial_run and are never a full acceptance.
 *
 * Usage:
 *   node scripts/dev/pain-real-llm-bdd/run-codex-chain.mjs \
 *     --provider zai --model glm-5.3-flash --apiKeyEnv ZAI_API_KEY \
 *     --reasoning low [--run-id run-...] [--samples A1,A2] [--append]
 *
 * Expected labels come ONLY from scripts/dev/pain-real-llm-bdd/golden-dataset.json
 * (frozen before the first model call). This script never modifies them.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import * as lib from './lib/chain-harness.mjs';
import { classifySampleOutcome } from './lib/outcomes.mjs';
import { openRunContext, acquireRunLock, assertFreshOutputs, recordPhase, PHASES } from './lib/run-context.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const datasetPath = path.join(here, 'golden-dataset.json');
const dataset = JSON.parse(fs.readFileSync(datasetPath, 'utf8'));

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
}
function argFlag(name) {
  return args.includes(name);
}

const provider = argValue('--provider', 'zai');
const model = argValue('--model', 'glm-5.3-flash');
const apiKeyEnv = argValue('--apiKeyEnv', 'ZAI_API_KEY');
const reasoning = argValue('--reasoning', 'low');
const baseUrl = argValue('--base-url', '');
const timeoutMs = Number(argValue('--timeout-ms', '60000'));
const maxTokens = Number(argValue('--max-tokens', '4096'));
const runIdArg = argValue('--run-id', null);
const appendAuthorized = argFlag('--append');
const resultsRoot = argValue('--results-root', path.join('.tmp', 'pri-1147'));
const onlySamples = argValue('--samples', '') ? argValue('--samples', '').split(',').map((s) => s.trim()).filter((s) => s.length > 0) : null;
const isPartialRun = onlySamples !== null;

if (!process.env[apiKeyEnv]) {
  console.error(JSON.stringify({ ok: false, reason: 'missing_api_key_env', nextAction: `export ${apiKeyEnv} before running the real-LLM experiment.` }));
  process.exit(1);
}

const requestedSamples = onlySamples ?? dataset.samples.map((s) => s.sample_id);
const unknownSamples = requestedSamples.filter((id) => !dataset.samples.some((s) => s.sample_id === id));
if (unknownSamples.length > 0) {
  console.error(JSON.stringify({ ok: false, reason: 'unknown_sample_ids', details: unknownSamples, nextAction: 'Check --samples against golden-dataset.json sample ids.' }));
  process.exit(1);
}

let runContext;
try {
  runContext = openRunContext({ runIdArg, resultsRoot, repoRoot, datasetPath, phaseInfo: { provider, model, apiKeyEnv } });
  acquireRunLock({ runDir: runContext.runDir, runId: runContext.runId, phase: PHASES.codexChain });
} catch (error) {
  console.error(JSON.stringify({ ok: false, reason: error.code ?? 'run_context_failed', details: String(error.message), nextAction: error.nextAction ?? 'inspect the run directory' }));
  process.exit(1);
}
const { runId, runDir, meta, metaPath } = runContext;
const resultsFile = path.join(runDir, 'codex-chain.jsonl');
const summaryFile = path.join(runDir, 'codex-chain.summary.json');
try {
  assertFreshOutputs({ runDir, outputs: [resultsFile, summaryFile], appendAuthorized });
} catch (error) {
  console.error(JSON.stringify({ ok: false, reason: error.code, details: String(error.message), nextAction: error.nextAction }));
  process.exit(1);
}

const config = lib.buildWorkspaceConfig({
  provider,
  model,
  apiKeyEnv,
  timeoutMs,
  maxTokens,
  reasoning: reasoning === 'false' ? false : reasoning,
  ...(baseUrl ? { baseUrl } : {}),
});
const learnedSamples = new Set(dataset.samples.filter((s) => s.category === 'G').map((s) => s.sample_id));
const samplesById = new Map(dataset.samples.map((s) => [s.sample_id, s]));
const samples = requestedSamples.map((id) => samplesById.get(id));

const startedAt = new Date().toISOString();
recordPhase(metaPath, meta, PHASES.codexChain, { started_at: startedAt, partial_run: isPartialRun, requested_samples: requestedSamples.length, provider, model });

const outcomes = {};
const executionFailures = [];
let index = 0;

for (const sample of samples) {
  index += 1;
  const ids = lib.sampleIds(sample.sample_id, index);
  const record = {
    run_id: runId,
    sample_id: sample.sample_id,
    category: sample.category,
    input_hash: lib.sha256(sample.text),
    provider,
    model,
    api_key_env: apiKeyEnv,
    expected: {
      label: sample.expected_label,
      stage: sample.expected_stage,
      final: sample.expected_final,
    },
    started_at: new Date().toISOString(),
  };
  let observed = null;
  try {
    const env = lib.bootstrapSampleEnv({
      runRoot: fs.mkdtempSync(path.join(os.tmpdir(), `pri1147-sample-`)),
      sampleId: `${sample.category}-${sample.sample_id}`,
      config,
      learnedKeywords: learnedSamples.has(sample.sample_id) ? dataset.learnedKeywordsSeed : null,
    });
    const payload = lib.buildUserPromptSubmitPayload({
      workspaceDir: env.workspaceDir,
      transcriptPath: env.transcriptPath,
      sessionId: ids.sessionId,
      turnId: ids.turnId,
      text: sample.text,
    });
    const hook = await lib.driveHook({ payload, workspaceDir: env.workspaceDir, codexHome: env.codexHome });
    const key = `codex|${env.rolloutIdentity}|${ids.turnId}|user`;
    record.logical_observation_key = key;
    record.hook = { exitCode: hook.exitCode, failed: hook.failed === true, stderr: hook.stderr };

    const preStage2 = lib.readAdmissionState(env.workspaceDir, key);
    record.stage1 = {
      observation_persisted: preStage2.observation !== null,
      marker_decision_pre: preStage2.marker?.decision ?? null,
      marker_reason_pre: preStage2.marker?.reason ?? null,
      rule_version: preStage2.marker?.ruleVersion ?? null,
    };
    const pendingExisted = preStage2.marker?.decision === 'pending_llm_review';
    record.pending_pre_stage2 = pendingExisted;

    let postStage2 = preStage2;
    let classifierUnavailable = false;
    let stage2Unfinished = false;
    if (pendingExisted) {
      const measured = lib.buildMeasuredClassifier(env.workspaceDir);
      if (!measured.ok) {
        classifierUnavailable = true;
        record.classifier_resolution = { ok: false, readiness: measured.readiness, reason: measured.reason };
      } else {
        record.classifier_profile = { provider: measured.profile.provider, model: measured.profile.model, api_key_env: measured.profile.apiKeyEnv, timeout_ms: measured.profile.timeoutMs };
        record.stage2 = { cycles: await lib.runStage2UntilTerminal({ workspaceDir: env.workspaceDir, classifierWrap: measured }) };
        record.llm_calls = measured.calls.map((c) => ({ latency_ms: c.latencyMs, status: c.status, ...(c.verdict ? { verdict: c.verdict } : {}), ...(c.error ? { error: c.error } : {}) }));
        record.llm_summary = measured.summary();
        postStage2 = lib.readAdmissionState(env.workspaceDir, key);
        stage2Unfinished = postStage2.marker?.decision === 'pending_llm_review';
      }
    }

    // PRI-1150 review P1-B: read marker facts through the STRUCTURED payload
    // (both pending and D6-minimized terminal shapes), not the preview string
    // whose property reads always produced undefined → null.
    const markerFacts = lib.readMarkerFacts(postStage2.marker?.payloadParsed);
    record.stage2_result = {
      marker_decision_post: postStage2.marker?.decision ?? null,
      marker_reason_post: postStage2.marker?.reason ?? null,
      attempts: markerFacts.attempts,
      confidence: markerFacts.confidence,
      // Verdict TYPE only exists on the pending payload shape; terminal
      // payloads are D6-minimized — the decision on the marker row carries
      // the semantic, so this stays null (honest) for terminal markers.
      verdict: markerFacts.verdict,
      verdict_reason: markerFacts.reason,
    };
    record.pain_created = postStage2.pain !== null;
    record.pain = postStage2.pain;
    record.pain_count_in_workspace = postStage2.painCount;

    observed = classifySampleOutcome({
      hookFailed: hook.failed === true,
      observationPersisted: preStage2.observation !== null,
      pendingExisted,
      classifierUnavailable,
      stage2Unfinished,
      markerDecision: postStage2.marker?.decision ?? null,
      markerReason: postStage2.marker?.reason ?? null,
    });
    record.completed_at = new Date().toISOString();
  } catch (error) {
    record.error = lib.redactSecrets(String(error).slice(0, 400));
    record.completed_at = new Date().toISOString();
    observed = { outcome: 'execution_error', reason: lib.redactSecrets(String(error).slice(0, 200)) };
  }

  record.final_outcome = observed.outcome;
  record.final_outcome_reason = observed.reason;
  record.provider_status = record.final_outcome === 'classifier_unavailable'
    ? 'unavailable'
    : (record.llm_calls ?? []).every((c) => c.status === 'ok') && (record.llm_calls ?? []).length > 0
      ? 'ok'
      : (record.llm_calls ?? []).some((c) => c.status !== 'ok')
        ? 'degraded'
        : 'not_called';
  record.latency_ms = (record.llm_calls ?? []).length > 0
    ? (record.llm_calls ?? []).reduce((s, c) => s + c.latency_ms, 0)
    : null;

  outcomes[record.final_outcome] = (outcomes[record.final_outcome] ?? 0) + 1;
  if (record.final_outcome === 'execution_error' || record.final_outcome === 'classifier_unavailable' || record.final_outcome === 'pending_unresolved') {
    executionFailures.push({ sample_id: record.sample_id, outcome: record.final_outcome, reason: record.final_outcome_reason });
  }
  fs.appendFileSync(resultsFile, JSON.stringify(record) + '\n');
  console.log(`[${String(index).padStart(2, '0')}/${samples.length}] ${sample.sample_id} (${sample.category}) → ${record.final_outcome} / pain=${record.pain_created}`);
}

const finishedAt = new Date().toISOString();
const runOk = executionFailures.length === 0;
const summary = {
  ok: runOk,
  run_id: runId,
  partial_run: isPartialRun,
  started_at: startedAt,
  finished_at: finishedAt,
  provider,
  model,
  api_key_env: apiKeyEnv,
  git_commit_sha: meta.git_commit_sha,
  dataset_sha256: meta.dataset_sha256,
  sample_count: samples.length,
  expected_sample_count: isPartialRun ? samples.length : dataset.samples.length,
  outcome_counts: outcomes,
  execution_failures: executionFailures,
  results_file: resultsFile,
};
fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2));
recordPhase(metaPath, meta, PHASES.codexChain, {
  finished_at: finishedAt,
  ok: runOk,
  sample_count: samples.length,
  partial_run: isPartialRun,
  outcome_counts: outcomes,
  execution_failures: executionFailures,
});
console.log(JSON.stringify(summary, null, 2));
process.exitCode = runOk ? 0 : 1;
