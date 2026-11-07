/**
 * PRI-1147 Phase 2 — real-LLM BDD over the Codex production chain.
 *
 * Per sample:
 *   1. isolated workspace + CODEX_HOME (bootstrapSampleEnv)
 *   2. processHookInvocation(UserPromptSubmit) — REAL ingestion + admission
 *   3. capture Stage-1 outcome + pending marker state (pre-Stage-2 evidence)
 *   4. runStage2CorrectionCycle with the REAL workspace-resolved classifier
 *      until terminal decision (correction → admitted / none → resolved_none /
 *      low-confidence or LLM error → retry up to STAGE2_MAX_ATTEMPTS)
 *   5. terminal state + per-call LLM measurements → results JSONL
 *
 * Usage:
 *   node scripts/dev/pain-real-llm-bdd/run-codex-chain.mjs \
 *     --provider zai --model glm-5.3-flash --apiKeyEnv ZAI_API_KEY \
 *     --reasoning low [--samples A1,A2] [--results-dir .tmp/pri-1147/results]
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

const here = path.dirname(fileURLToPath(import.meta.url));
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
const onlySamples = argValue('--samples', '') ? argValue('--samples', '').split(',').map((s) => s.trim()) : null;
const resultsDir = argValue('--results-dir', path.join('.tmp', 'pri-1147', 'results'));
const keepRoot = argFlag('--keep-root');
const runLabel = argValue('--label', 'codex');

if (!process.env[apiKeyEnv]) {
  console.error(JSON.stringify({ ok: false, reason: 'missing_api_key_env', nextAction: `export ${apiKeyEnv} before running the real-LLM experiment.` }));
  process.exit(1);
}

const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), `pri1147-${runLabel}-`));
fs.mkdirSync(resultsDir, { recursive: true });
const resultsFile = path.join(resultsDir, `codex-chain-${runLabel}.jsonl`);

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

const samples = dataset.samples.filter((s) => (onlySamples ? onlySamples.includes(s.sample_id) : true));
if (samples.length === 0) {
  console.error(JSON.stringify({ ok: false, reason: 'no_samples_matched', nextAction: 'Check --samples against golden-dataset.json sample ids.' }));
  process.exit(1);
}

const startedAt = new Date().toISOString();
let index = 0;
const failures = [];

for (const sample of samples) {
  index += 1;
  const ids = lib.sampleIds(sample.sample_id, index);
  const logicalKey = `codex|${'ROLLOUT'}|${ids.turnId}|user`;
  let record = {
    sample_id: sample.sample_id,
    category: sample.category,
    text: sample.text,
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
  try {
    const env = lib.bootstrapSampleEnv({
      runRoot,
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
    record.hook = { exitCode: hook.exitCode, stderr: hook.stderr };

    const preStage2 = lib.readAdmissionState(env.workspaceDir, key);
    record.stage1 = {
      observation_persisted: preStage2.observation !== null,
      marker_decision_pre: preStage2.marker?.decision ?? null,
      marker_reason_pre: preStage2.marker?.reason ?? null,
      rule_version: preStage2.marker?.ruleVersion ?? null,
    };
    record.pending_pre_stage2 = preStage2.marker?.decision === 'pending_llm_review';

    let postStage2 = preStage2;
    if (preStage2.marker?.decision === 'pending_llm_review') {
      const measured = lib.buildMeasuredClassifier(env.workspaceDir);
      if (!measured.ok) {
        record.classifier_resolution = { ok: false, readiness: measured.readiness, reason: measured.reason };
        record.stage2 = { error: 'classifier_unavailable', reason: measured.reason };
      } else {
        record.classifier_profile = { provider: measured.profile.provider, model: measured.profile.model, api_key_env: measured.profile.apiKeyEnv, timeout_ms: measured.profile.timeoutMs };
        record.stage2 = { cycles: await lib.runStage2UntilTerminal({ workspaceDir: env.workspaceDir, classifierWrap: measured }) };
        record.llm_calls = measured.calls.map((c) => ({ latency_ms: c.latencyMs, status: c.status, ...(c.verdict ? { verdict: c.verdict } : {}), ...(c.error ? { error: c.error } : {}) }));
        record.llm_summary = measured.summary();
        postStage2 = lib.readAdmissionState(env.workspaceDir, key);
      }
    }

    record.stage2_result = {
      marker_decision_post: postStage2.marker?.decision ?? null,
      marker_reason_post: postStage2.marker?.reason ?? null,
      attempts: postStage2.marker?.payloadPreview?.review?.attempts ?? null,
      verdict: postStage2.marker?.payloadPreview?.review?.reviewResult?.verdict ?? null,
      confidence: postStage2.marker?.payloadPreview?.review?.reviewResult?.confidence ?? null,
      verdict_reason: postStage2.marker?.payloadPreview?.review?.reviewResult?.reason ?? null,
    };
    record.pain_created = postStage2.pain !== null;
    record.pain = postStage2.pain;
    record.pain_count_in_workspace = postStage2.painCount;
    record.completed_at = new Date().toISOString();
  } catch (error) {
    record.error = lib.redactSecrets(String(error).slice(0, 400));
    record.completed_at = new Date().toISOString();
    failures.push(sample.sample_id);
  }
  fs.appendFileSync(resultsFile, JSON.stringify(record) + '\n');
  const decision = record.stage2_result?.marker_decision_post ?? record.stage1?.marker_decision_pre ?? '?';
  const label = record.pain_created === true ? 'pain' : record.pain_created === false ? 'no_pain' : 'error';
  console.log(`[${String(index).padStart(2, '0')}/${samples.length}] ${sample.sample_id} (${sample.category}) → ${decision} / ${label}`);
}

const summary = {
  ok: failures.length === 0,
  run_label: runLabel,
  started_at: startedAt,
  finished_at: new Date().toISOString(),
  provider,
  model,
  api_key_env: apiKeyEnv,
  sample_count: samples.length,
  failure_count: failures.length,
  failures,
  results_file: resultsFile,
  run_root: keepRoot ? runRoot : '(temp root kept for evidence; remove after report)',
};
fs.writeFileSync(path.join(resultsDir, `codex-chain-${runLabel}.summary.json`), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
if (!keepRoot) {
  console.log(`run_root=${runRoot} (kept; delete manually after evidence review)`);
}
