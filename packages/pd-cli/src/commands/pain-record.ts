/**
 * pd pain record command — Runtime v2 pain signal entry point.
 *
 * Uses PainToPrincipleService as the single write-side orchestration API.
 * PRI-642 (review blocker 1): the ingress semantic interpretation — origin,
 * bound/unbound correlation, provenance derivation, sentinel handling,
 * submit/degrade/refuse semantics and painIngress.v1 construction — comes
 * from the SHARED evaluator `evaluatePainIngress` in @principles/core
 * (the same authority the OpenClaw funnel uses). This adapter only does
 * host-specific ACQUISITION: read --session, validate it against this
 * workspace's trajectory.db, and collect raw evidence entries.
 *
 * Usage:
 *   pd pain record --reason <text> [--score N] [--source manual] [--workspace <path>] [--session <id>] [--json]
 */
import {
  PainToPrincipleService,
  PrincipleTreeLedgerAdapter,
  resolveRuntimeConfig,
  isRuntimeConfigError,
  isFeatureEnabled,
  isBuiltinPiAiProvider,
  evaluatePainIngress,
} from '@principles/core/runtime-v2';
import type { PainIngressDecision, PainEvidenceBundle, IngressEvidenceEntry, PainEvidenceEntry } from '@principles/core/runtime-v2';
import { resolveWorkspaceDir } from '../resolve-workspace.js';
import { loadPdConfig, computeFlagsFromLoadResult } from '../services/pd-config-loader.js';
import { acquireTrajectoryEvidenceFromDb } from './build-trajectory-evidence.js';

interface RecordOptions {
  reason?: string;
  score?: number;
  source?: string;
  workspace?: string;
  json?: boolean;
  session?: string;
  wait?: boolean;
}

function emitSessionBindingFailure(
  opts: RecordOptions,
  failure: { reason: string; message: string; nextAction: string },
): void {
  if (opts.json) {
    console.log(JSON.stringify({
      status: 'failed',
      reason: failure.reason,
      message: failure.message,
      nextAction: failure.nextAction,
    }, null, 2));
  } else {
    console.error(`Error: ${failure.message}`);
    console.error(`Reason: ${failure.reason}`);
    console.error(`Next action: ${failure.nextAction}`);
  }
  process.exit(1);
}

function toIngressEntry(entry: PainEvidenceEntry): IngressEvidenceEntry {
  // Trajectory evidence references observed behavior (owner messages,
  // assistant turns, tool-call failures) — behavior traces.
  return { kind: 'behavior_trace', sourceRef: entry.sourceRef, note: entry.note };
}

/**
 * PRI-642 (SPEC §7.3/§7.4, review blocker 1): build the report from this
 * adapter's host-specific facts and let the SHARED evaluator decide.
 *
 * - explicit `--session` → acquisition against the workspace trajectory.db:
 *   · session_not_found  → the claimed binding does not exist → the shared
 *     evaluator refuses it (matrix row 5, reason origin_correlation_mismatch;
 *     the CLI labels the failure with the SPEC §7.3 reason session_not_found);
 *   · other unavailable evidence (empty / unreadable / missing trajectory)
 *     → bound + unavailable → the evaluator DEGRADES (submit with honest
 *     empty evidence + warning), identical to the OpenClaw funnel;
 *   · available → bound submit with the real evidence entries.
 * - no `--session` → unbound Owner report (matrix row 6) → submit with
 *   disclosure; no sentinel session, no placeholder evidence, no trajectory
 *   projection (the CLI skips observability when the ingress yields no
 *   bound session — SPEC §7.4).
 */
function resolveIngressDecision(
  input: { opts: RecordOptions; stateDir: string; workspaceDir: string; painId: string },
): { decision: PainIngressDecision; acquisitionDetail: string | null } {
  const { opts, stateDir, workspaceDir, painId } = input;
  const score = opts.score ?? 80;
  const base = {
    identity: { kind: 'manual_pain_id' as const, painId },
    painType: 'user_frustration' as const,
    source: opts.source ?? 'manual',
    reason: opts.reason ?? '',
    score,
  };

  if (!opts.session) {
    const decision = evaluatePainIngress({
      ...base,
      origin: { kind: 'owner_manual', channel: 'external_cli_unbound' },
      correlation: { status: 'unbound', reason: 'external_cli' },
      evidence: { status: 'unavailable', reason: 'not_applicable_unbound' },
    });
    return { decision, acquisitionDetail: null };
  }

  const acquisition = acquireTrajectoryEvidenceFromDb(stateDir, opts.session, workspaceDir);
  // Host-specific acquisition result → shared report shape.
  const evidenceBundle: PainEvidenceBundle = acquisition.status === 'available'
    ? { status: 'available', entries: acquisition.entries.map(toIngressEntry) as [IngressEvidenceEntry, ...IngressEvidenceEntry[]] }
    : { status: 'unavailable', reason: acquisition.reasonCode };
  // SPEC §7.3: a nonexistent session means the CLI-explicit-session channel
  // cannot claim a binding — expressed as the row-5 combination so the
  // SHARED evaluator refuses it (never a locally-decided refusal).
  const correlation = acquisition.status === 'unavailable' && acquisition.reasonCode === 'session_not_found'
    ? { status: 'unbound' as const, reason: 'external_cli' as const }
    : { status: 'bound' as const, hostKind: 'openclaw' as const, sessionId: opts.session };

  const decision = evaluatePainIngress({
    ...base,
    origin: { kind: 'owner_manual', channel: 'cli_explicit_session' },
    correlation,
    evidence: evidenceBundle,
  });
  return { decision, acquisitionDetail: acquisition.status === 'unavailable' ? acquisition.detail : null };
}

export async function handlePainRecord(opts: RecordOptions): Promise<void> {
  if (!opts.reason) {
    console.error('Error: --reason <text> is required');
    console.error('Usage: pd pain record --reason <text> [--score N] [--source manual] [--workspace <path>] [--session <id>] [--json]');
    process.exit(1);
    return;
  }

  // Bug-P fix: enforce reason length limit to prevent oversized data entering the pipeline.
  // Consistent with pain-flood-simulation.ts (MAX_REASON_LENGTH = 500) and synthetic-baseline.ts.
  // CodeRabbit review fix: emit JSON on --json and stop execution after exit (cli-1, cli-2, cli-5).
  const MAX_REASON_LENGTH = 500;
  if (opts.reason.length > MAX_REASON_LENGTH) {
    if (opts.json) {
      console.log(JSON.stringify({
        status: 'failed',
        reason: 'reason_too_long',
        message: `--reason must be at most ${MAX_REASON_LENGTH} characters (got ${opts.reason.length})`,
        nextAction: 'Shorten the reason text or split it into multiple pain records.',
      }, null, 2));
    } else {
      console.error(`Error: --reason must be at most ${MAX_REASON_LENGTH} characters (got ${opts.reason.length})`);
      console.error('Next action: shorten the reason text or split it into multiple pain records.');
    }
    process.exit(1);
    return;
  }

  if (opts.score !== undefined && (isNaN(opts.score) || opts.score < 0 || opts.score > 100)) {
    if (opts.json) {
      console.log(JSON.stringify({
        status: 'failed',
        reason: 'score_invalid',
        message: '--score must be a number between 0 and 100',
        nextAction: 'Provide --score as an integer from 0 to 100, or omit it for the default (80).',
      }, null, 2));
    } else {
      console.error('Error: --score must be a number between 0 and 100');
      console.error('Next action: provide --score as an integer from 0 to 100, or omit it for the default (80).');
    }
    process.exit(1);
    return;
  }

  const workspaceDir = resolveWorkspaceDir(opts.workspace);
  const stateDir = `${workspaceDir}/.state`;
  const painId = `manual_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

  // PRI-642: run the SHARED ingress evaluator before any service/LLM/task
  // mutation; the decision (submit/degrade/refuse) is not made here.
  const { decision, acquisitionDetail } = resolveIngressDecision({ opts, stateDir, workspaceDir, painId });

  if (decision.action === 'refuse') {
    // SPEC §7.3: a nonexistent --session keeps its specific reason code;
    // the refusal itself came from the shared evaluator (row 5).
    const reason = acquisitionDetail !== null && opts.session !== undefined && decision.reasonCode === 'origin_correlation_mismatch'
      ? 'session_not_found'
      : decision.reasonCode;
    emitSessionBindingFailure(opts, {
      reason,
      message: decision.warning,
      nextAction: decision.nextAction,
    });
    return;
  }

  const binding = decision.legacy;
  // SPEC §7.4: without a bound session the trajectory projection is skipped
  // (disclosed below) instead of fabricating the sentinel session 'cli'.
  const recordObservability = binding.sessionId !== undefined;

  const ledgerAdapter = new PrincipleTreeLedgerAdapter({ stateDir });
  // PRI-306: Load .pd/config.yaml for config-driven runtime binding
  const configResult = loadPdConfig(workspaceDir);
  if (!configResult.ok) {
    // ERR-009 / Runtime Contract Rule 9: fail loud with reason, don't silently swallow
    console.error(`Warning: .pd/config.yaml has errors — using defaults:`);
    for (const e of configResult.errors) {
      console.error(`  ${e.path}: ${e.reason}`);
      if (e.nextAction) console.error(`    nextAction: ${e.nextAction}`);
    }
  }
  const effectiveConfig = configResult.ok ? configResult.effective : configResult.defaults;

  // PRI-369: Determine async mode from feature flag + --wait override
  const featureFlags = computeFlagsFromLoadResult(configResult);
  const asyncFlagEnabled = isFeatureEnabled(featureFlags, 'diagnostician_async_cli');
  const asyncMode = asyncFlagEnabled && !opts.wait; // --wait overrides flag to force sync

  const service = new PainToPrincipleService({
    workspaceDir,
    stateDir,
    ledgerAdapter,
    owner: 'pd-cli',
    autoIntakeEnabled: true,
    effectiveConfig,
    getEnvVar: (name: string) => process.env[name],
    asyncMode,
  });

  const result = await service.recordPain({
    painId,
    painType: 'user_frustration',
    source: opts.source ?? 'manual',
    reason: opts.reason,
    score: opts.score ?? 80,
    sessionId: binding.sessionId,
    agentId: 'pd-cli',
    provenance: binding.provenance,
    hostKind: binding.hostKind,
    evidence: binding.evidence,
    recordObservability,
    painIngress: binding.painIngress,
  });

  // Show diagnostic info for config failures
  if (result.failureCategory === 'config_missing') {
    const legacyConfig = resolveRuntimeConfig(stateDir);
    if (isRuntimeConfigError(legacyConfig)) {
      if (opts.json) {
        console.log(JSON.stringify({
          status: 'failed',
          painId: result.painId,
          taskId: result.taskId,
          failureCategory: result.failureCategory,
          message: result.message,
          configError: {
            reason: legacyConfig.reason,
            message: legacyConfig.message,
            nextAction: legacyConfig.nextAction,
          },
        }, null, 2));
      } else {
        console.error(`  Config resolution failed: ${legacyConfig.reason}`);
        console.error(`  ${legacyConfig.message}`);
        console.error(`  nextAction: ${legacyConfig.nextAction}`);
      }
      process.exit(1);
      return;
    }
    const config = legacyConfig;
    const missing: string[] = [];
    if (!config.provider) missing.push('provider');
    if (!config.model) missing.push('model');
    if (!config.apiKeyEnv) missing.push('apiKeyEnv');
    if (config.provider) {
      // PRI-621 PR2 review: the pi-ai catalog lookup is a core capability —
      // the CLI queries it through @principles/core and must not depend on
      // pi-ai directly (EP-06).
      if (!isBuiltinPiAiProvider(config.provider) && !config.baseUrl) {
        missing.push('baseUrl');
      }
    }

    if (missing.length > 0 || config.provider || config.apiKeyEnv) {
      console.error('Error: Pain signal failed\n');

      if (missing.length > 0) {
        console.error('  Missing configuration:');
        for (const m of missing) {
          console.error(`    - ${m}`);
        }
        console.error('');
      }

      if (config.provider || config.model || config.apiKeyEnv || config.baseUrl) {
        console.error('  Current workflow policy (pd-runtime-v2-diagnosis):');
        console.error(`    runtimeKind: ${config.runtimeKind}`);
        if (config.provider) console.error(`    provider:    ${config.provider}`);
        if (config.model) console.error(`    model:       ${config.model}`);
        if (config.apiKeyEnv) console.error(`    apiKeyEnv:   ${config.apiKeyEnv}`);
        if (config.baseUrl) console.error(`    baseUrl:     ${config.baseUrl}`);
        console.error('');
      }

      console.error('  To diagnose and configure your runtime, run:');
      console.error('    pd runtime probe --runtime pi-ai --provider <name> --model <id> --apiKeyEnv <name>');
      console.error('');

      if (result.message) console.error(`  Details: ${result.message}`);
      process.exit(1);
      return;
    }
  }

  // PRI-642 (SPEC §12.1.6): generated-but-unadmitted candidates must never
  // read as completed internalization — surface the admission disposition.
  const admissionDecisions = result.admissionResults?.map(r => r.admission.decision) ?? [];
  const admittedCount = admissionDecisions.filter(d => d === 'admitted').length;
  const gatedWarning = result.status === 'succeeded'
    && result.candidateIds.length > 0
    && admittedCount === 0
    ? `admitted: 0 of ${result.candidateIds.length} candidates (all gated — needs_evidence/deferred); `
      + 'nothing was internalized. See admissionResults for per-candidate reasons; add --session evidence or Owner context to raise confidence above the admission threshold.'
    : null;
  // PRI-642: the ingress decision's own disclosures (degrade warning /
  // unbound context_unbound warning) are surfaced to the operator.
  const decisionWarnings = decision.action === 'degrade'
    ? [`${decision.warning} Next action: ${decision.nextAction}`]
    : decision.action === 'submit'
      ? decision.warnings
      : [];
  const cliWarnings = [...decisionWarnings, gatedWarning].filter((w): w is string => w !== null && w !== undefined);

  if (opts.json) {
    const out: Record<string, unknown> = { ...result };
    // Ensure nextAction is present for actionable states
    if (out.status === 'submitted') {
      if (!out.nextAction) {
        out.nextAction = `pd diagnose run --task-id ${out.taskId} --workspace "${workspaceDir}" --runtime pi-ai --json`;
      }
      if (!out.reason) {
        out.reason = out.message;
      }
    }
    // PRI-570: async submission has NO automatic consumer — the
    // internalization auto-consumer's runner kinds (dreamer..rollout_reviewer)
    // do not include 'diagnostician', so a submitted task stays pending until
    // the owner runs the diagnose command. Never let that stay implicit (rc-9).
    // PRI-642: unbound/gated disclosures join the same warnings channel.
    const submittedWarning = out.status === 'submitted'
      ? 'Async mode: no background consumer picks up diagnostician tasks. '
        + `Run ${out.nextAction} or the pain signal will remain pending indefinitely. `
        + 'Use --wait to diagnose synchronously instead.'
      : null;
    const allWarnings = [...cliWarnings];
    if (submittedWarning !== null) allWarnings.unshift(submittedWarning);
    if (allWarnings.length > 0) {
      out.warning = allWarnings.join(' ');
      out.warnings = allWarnings;
    }
    console.log(JSON.stringify(out, null, 2));
    if (result.status !== 'succeeded' && result.status !== 'skipped' && result.status !== 'retried' && result.status !== 'submitted') {
      process.exit(1);
      return;
    }
  } else {
    if (result.status === 'succeeded') {
      console.log('[OK] Pain signal recorded via PainToPrincipleService');
      console.log(`   Pain ID: ${result.painId}`);
      console.log(`   Task ID: ${result.taskId}`);
      if (result.runId) console.log(`   Run ID: ${result.runId}`);
      if (result.artifactId) console.log(`   Artifact ID: ${result.artifactId}`);
      if (result.candidateIds.length > 0) console.log(`   Candidate IDs: ${result.candidateIds.join(', ')}`);
      if (result.ledgerEntryIds.length > 0) console.log(`   Ledger Entry IDs: ${result.ledgerEntryIds.join(', ')}`);
      if (result.progress && result.progress.seededTaskIds.length > 0) {
        console.log(`   Seeded Task IDs: ${result.progress.seededTaskIds.join(', ')}`);
      }
      console.log(`   Reason: ${opts.reason}`);
      console.log(`   Score: ${opts.score ?? 80}`);
      console.log(`   Source: ${opts.source ?? 'manual'}`);
      console.log(`   Workspace: ${workspaceDir}`);
      if (binding.sessionId) {
        console.log(`   Session: ${binding.sessionId} (bound, ${binding.evidence.length} evidence entries)`);
      } else {
        console.log('   Session: unbound (Owner report; no trajectory evidence)');
      }
      if (result.admissionResults && result.admissionResults.length > 0) {
        console.log(`   Admission: ${admittedCount} of ${result.admissionResults.length} candidates admitted`);
        for (const r of result.admissionResults) {
          console.log(`     - ${r.candidateId}: ${r.admission.decision} (${r.admission.reason})`);
        }
      }
      if (result.latencyMs !== undefined) console.log(`   Latency: ${result.latencyMs}ms`);
      for (const w of cliWarnings) {
        console.warn(`   ⚠️  ${w}`);
      }
      console.log(`\nDiagnostician pipeline running. Check progress with:`);
      console.log(`   pd task show ${result.taskId} --workspace "${workspaceDir}"`);
    } else if (result.status === 'submitted') {
      console.log('[SUBMITTED] Pain signal submitted for async diagnosis');
      console.log(`   Pain ID: ${result.painId}`);
      console.log(`   Task ID: ${result.taskId}`);
      console.log(`   Status: submitted`);
      // PRI-570: no background consumer picks up diagnostician tasks — say so
      // explicitly instead of implying async diagnosis happens on its own (rc-9).
      console.error('   WARNING: async mode has no automatic consumer for diagnostician tasks.');
      console.error(`   Run: pd diagnose run --task-id ${result.taskId} --workspace "${workspaceDir}" --runtime pi-ai`);
      console.error('   Or re-record with --wait to diagnose synchronously. Without this, the task stays pending indefinitely.');
    } else if (result.status === 'skipped') {
      console.log(`[SKIP] Task already in progress: ${result.message ?? 'unknown'}`);
      console.log(`   Pain ID: ${result.painId}`);
      console.log(`   Task ID: ${result.taskId}`);
    } else if (result.status === 'retried') {
      console.log(`[RETRY] Task retried: ${result.message ?? 'unknown'}`);
      console.log(`   Pain ID: ${result.painId}`);
      console.log(`   Task ID: ${result.taskId}`);
    } else {
      console.error('[FAIL] Pain signal failed:', result.message);
      process.exit(1);
      return;
    }
  }
}
