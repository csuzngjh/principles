import * as path from 'path';
import { OperatorHealthReadModel, SchemaConformanceReadModel, PruningReadModel, createInternalizationQueueReadModel, auditCandidateLedgerConsistency, buildGfiWorkspaceSnapshot, classifyGfiWorkspaceHealth } from '@principles/core/runtime-v2';
import type { OperatorHealthSnapshot, SchemaConformanceResult, OrphanDetectionResult, InternalizationQueueSnapshot, GfiWorkspaceSnapshot, CandidateAuditResult } from '@principles/core/runtime-v2';
import { resolveWorkspaceDir } from '../resolve-workspace.js';
import { loadEffectiveFeatureFlags } from '../services/feature-flag-loader.js';

export interface CanaryCheck {
  name: string;
  status: 'healthy' | 'degraded' | 'error';
  summary: string;
  details?: unknown;
  error?: string;
}

export interface CanaryOutput {
  overallStatus: 'healthy' | 'degraded' | 'error';
  checks: CanaryCheck[];
  recommendedNextActions: string[];
  generatedAt: string;
  internalizationQueueSummary?: InternalizationQueueSummary;
}

export interface InternalizationQueueSummary {
  readyCount: number;
  retryWaitCount: number;
  pendingCount: number;
  nextReadyTaskKind: string | null;
  nextReadyTaskId: string | null;
  noReadyReason: string | null;
}

interface CanaryOptions {
  workspace?: string;
  json?: boolean;
}

function computeOverallStatus(checks: CanaryCheck[]): 'healthy' | 'degraded' | 'error' {
  let hasError = false;
  let hasDegraded = false;
  for (const check of checks) {
    if (check.status === 'error') hasError = true;
    if (check.status === 'degraded') hasDegraded = true;
  }
  if (hasError) return 'error';
  if (hasDegraded) return 'degraded';
  return 'healthy';
}

function buildRecommendedActions(checks: CanaryCheck[]): string[] {
  const actions: string[] = [];
  for (const check of checks) {
    if (check.status === 'healthy') continue;
    switch (check.name) {
      case 'schema_conformance':
        actions.push('Run workspace initialization to migrate schema: open DB with writable SqliteConnection.');
        break;
      case 'candidate_audit':
        actions.push('Run `pd candidate audit --workspace <path> --json` for details.');
        break;
      case 'gfi_snapshot':
        actions.push('Investigate GFI sessions — consider cleanup or session lifecycle review.');
        break;
      case 'pruning_orphans':
        actions.push('Run `pd runtime pruning orphans --workspace <path> --dry-run` to inspect orphan candidates.');
        break;
      case 'internalization_queue': {
        const queueDetails = check.details as InternalizationQueueSnapshot | undefined;
        if (queueDetails && queueDetails.noReadyTasks?.reason === 'no_candidates' && queueDetails.noReadyTasks.inspectedCount === 0) {
          actions.push('No internalization tasks found. If candidates exist, run `pd candidate internalization backfill --dry-run` to check, then `--confirm` to create dreamer tasks.');
        } else {
          actions.push('Check internalization queue for blocked or dependency-failed tasks.');
        }
        break;
      }
      case 'runtime_health': {
        const details = check.details as OperatorHealthSnapshot | undefined;
        if (details && details.totalTaskCount === 0) {
          actions.push('Runtime V2 pipeline has never been exercised. Run `pd pain record --reason "test" --workspace <path>` to trigger the pain-to-principle chain.');
        } else if (details && details.painChain.lastSuccessfulChain === null) {
          actions.push('Run `pd runtime uat --workspace <path> --count 3` to establish baseline.');
        } else {
          actions.push('Review runtime health snapshot for specific failure categories.');
        }
        break;
      }
      case 'pd_shim_info':
        actions.push('Verify pd CLI installation and sync-plugin configuration.');
        break;
    }
  }
  return actions;
}

export async function runCanaryChecks(workspaceDir: string): Promise<CanaryOutput> {
  const generatedAt = new Date().toISOString();

  const checkPromises: Promise<CanaryCheck>[] = [
    (async (): Promise<CanaryCheck> => {
      try {
        const model = new SchemaConformanceReadModel({ workspaceDir });
        const result: SchemaConformanceResult = model.check();
        const status = result.overallStatus === 'ok' ? 'healthy' : result.overallStatus === 'degraded' ? 'degraded' : 'error';
        const missingCount = Object.values(result.tables).filter(t => !t.exists || t.missingColumns.length > 0).length;
        return {
          name: 'schema_conformance',
          status,
          summary: status === 'healthy'
            ? 'All tables and columns conform to expected schema.'
            : `${missingCount} table(s) have missing columns or do not exist. Migrations needed: ${result.migrationsNeeded.join(', ')}`,
          details: result,
        };
      } catch (err) {
        return { name: 'schema_conformance', status: 'error', summary: 'Schema conformance check failed.', error: String(err) };
      }
    })(),
    (async (): Promise<CanaryCheck> => {
      try {
        const result: CandidateAuditResult = await auditCandidateLedgerConsistency(workspaceDir);
        const status = result.status === 'ok' ? 'healthy' : result.status === 'degraded' ? 'degraded' : 'error';
        return {
          name: 'candidate_audit',
          status,
          summary: status === 'healthy'
            ? 'Candidate/ledger consistency OK.'
            : `Audit status: ${result.status}. Orphan candidates: ${result.orphanCandidateCount}, Missing ledger: ${result.missingLedgerCount}`,
          details: result,
        };
      } catch (err) {
        return { name: 'candidate_audit', status: 'error', summary: 'Candidate audit check failed.', error: String(err) };
      }
    })(),
    (async (): Promise<CanaryCheck> => {
      try {
        const featureFlags = loadEffectiveFeatureFlags(workspaceDir);
        const gfiFlag = featureFlags.flags.gfi;
        if (!gfiFlag || !gfiFlag.enabled) {
          const warningSuffix = featureFlags.warnings.length > 0
            ? ` (warnings: ${featureFlags.warnings.join('; ')})`
            : '';
          return {
            name: 'gfi_snapshot',
            status: 'healthy',
            summary: `GFI feature flag disabled — skipping snapshot.${warningSuffix}`,
          };
        }
        const sessionDir = path.join(workspaceDir, '.state', 'sessions');
        const fs = await import('fs');
        const sessions: { sessionId: string; currentGfi: number; lastActivityAt: number; consecutiveErrors: number }[] = [];
        if (fs.existsSync(sessionDir)) {
          for (const file of fs.readdirSync(sessionDir)) {
            if (!file.endsWith('.json')) continue;
            try {
              const raw = fs.readFileSync(path.join(sessionDir, file), 'utf8');
              const parsed = JSON.parse(raw);
              if (parsed?.sessionId) {
                sessions.push({
                  sessionId: parsed.sessionId,
                  currentGfi: parsed.currentGfi ?? 0,
                  lastActivityAt: parsed.lastActivityAt ?? parsed.lastControlActivityAt ?? 0,
                  consecutiveErrors: parsed.consecutiveErrors ?? 0,
                });
              }
            } catch { /* skip malformed */ }
          }
        }
        const snapshot: GfiWorkspaceSnapshot = buildGfiWorkspaceSnapshot({ sessions, nowMs: Date.now() });
        const health = classifyGfiWorkspaceHealth(snapshot);
        const {status} = health;
        return {
          name: 'gfi_snapshot',
          status,
          summary: status === 'healthy'
            ? `GFI snapshot OK. ${snapshot.activeSessionCount} active, ${snapshot.staleSessionCount} stale sessions.`
            : `GFI degraded: ${health.reason}`,
          details: { ...snapshot, healthAssessment: health },
        };
      } catch (err) {
        return { name: 'gfi_snapshot', status: 'error', summary: 'GFI snapshot check failed.', error: String(err) };
      }
    })(),
    (async (): Promise<CanaryCheck> => {
      try {
        const model = new PruningReadModel({ workspaceDir });
        const result: OrphanDetectionResult = model.getOrphanDerivedCandidates();
        const status = result.candidates.length > 0 ? 'degraded' : 'healthy';
        return {
          name: 'pruning_orphans',
          status,
          summary: status === 'healthy'
            ? 'No orphan derived candidates found.'
            : `${result.candidates.length} orphan derived candidate(s) found. dbReadable: ${result.dbReadable}`,
          details: { orphanDerivedCandidateCount: result.candidates.length, dbReadable: result.dbReadable, samples: result.candidates.slice(0, 5) },
        };
      } catch (err) {
        return { name: 'pruning_orphans', status: 'error', summary: 'Pruning orphan check failed.', error: String(err) };
      }
    })(),
    (async (): Promise<CanaryCheck> => {
      try {
        const { readModel, close } = await createInternalizationQueueReadModel({ workspaceDir, readonly: true });
        try {
          const snapshot: InternalizationQueueSnapshot = await readModel.getSnapshot();
          const hasBlocked = snapshot.blockedSummary.count > 0;
          const hasDepFailed = snapshot.dependencyFailedSummary.count > 0;
          const hasInvalid = snapshot.invalidMetadataCount > 0;
          const hasLeaseConflicts = snapshot.leaseConflictSummary.count > 0;
          const status = (hasBlocked || hasDepFailed || hasInvalid || hasLeaseConflicts) ? 'degraded' : 'healthy';
          return {
            name: 'internalization_queue',
            status,
            summary: status === 'healthy'
              ? `Queue OK. ${snapshot.readyTasks.length} ready, ${snapshot.pendingCount} pending, ${snapshot.retryWaitCount} retry_wait.`
              : `Queue degraded: ${snapshot.blockedSummary.count} blocked, ${snapshot.dependencyFailedSummary.count} dep-failed, ${snapshot.invalidMetadataCount} invalid metadata, ${snapshot.leaseConflictSummary.count} lease conflicts.`,
            details: snapshot,
          };
        } finally {
          await close();
        }
      } catch (err) {
        return { name: 'internalization_queue', status: 'error', summary: 'Internalization queue check failed.', error: String(err) };
      }
    })(),
    (async (): Promise<CanaryCheck> => {
      try {
        const model = new OperatorHealthReadModel({ workspaceDir });
        try {
          const snapshot: OperatorHealthSnapshot = await model.getSnapshot();
          const status = snapshot.overallStatus === 'healthy' ? 'healthy' : snapshot.overallStatus === 'degraded' ? 'degraded' : 'error';
          return {
            name: 'runtime_health',
            status,
            summary: status === 'healthy'
              ? 'Runtime health OK.'
              : `Runtime health: ${snapshot.overallStatus}. Actions: ${snapshot.recommendedActions.join('; ')}`,
            details: snapshot,
          };
        } finally {
          await model.close();
        }
      } catch (err) {
        return { name: 'runtime_health', status: 'error', summary: 'Runtime health check failed.', error: String(err) };
      }
    })(),
    (async (): Promise<CanaryCheck> => {
      try {
        const fs = await import('fs');
        const cliPath = path.resolve(process.argv[1] ?? '');
        const cliExists = fs.existsSync(cliPath);
        const status = cliExists ? 'healthy' : 'degraded';
        return {
          name: 'pd_shim_info',
          status,
          summary: status === 'healthy'
            ? `PD CLI accessible at ${cliPath}`
            : 'PD CLI entrypoint not found — verify installation.',
          details: { cliPath, exists: cliExists, version: '0.1.0' },
        };
      } catch (err) {
        return { name: 'pd_shim_info', status: 'error', summary: 'PD shim check failed.', error: String(err) };
      }
    })(),
  ];

  const checkResults = await Promise.allSettled(checkPromises);
  const checks: CanaryCheck[] = checkResults.map((result, index) => {
    if (result.status === 'fulfilled') return result.value;
    return {
      name: `check_${index}`,
      status: 'error' as const,
      summary: 'Check failed unexpectedly.',
      error: result.reason ? String(result.reason) : 'Unknown error',
    };
  });

  const overallStatus = computeOverallStatus(checks);
  const recommendedNextActions = buildRecommendedActions(checks);

  const internalizationQueueCheck = checks.find(c => c.name === 'internalization_queue');
  const internalizationQueueSummary: InternalizationQueueSummary | undefined =
    internalizationQueueCheck && internalizationQueueCheck.details
      ? (() => {
          const snapshot = internalizationQueueCheck.details as InternalizationQueueSnapshot;
          const firstReady = snapshot.readyTasks[0] ?? null;
          return {
            readyCount: snapshot.readyTasks.length,
            retryWaitCount: snapshot.retryWaitCount,
            pendingCount: snapshot.pendingCount,
            nextReadyTaskKind: firstReady ? firstReady.taskKind : null,
            nextReadyTaskId: firstReady ? firstReady.taskId : null,
            noReadyReason: snapshot.noReadyTasks?.reason ?? null,
          };
        })()
      : undefined;

  return {
    overallStatus,
    checks,
    recommendedNextActions,
    generatedAt,
    ...(internalizationQueueSummary ? { internalizationQueueSummary } : {}),
  };
}

function formatTextOutput(output: CanaryOutput): string {
  const lines: string[] = [];
  const icon = output.overallStatus === 'healthy' ? '✓' : '✗';

  lines.push('PD Control Plane Canary');
  lines.push(`generatedAt: ${output.generatedAt}`);
  lines.push(`OVERALL: ${icon} ${output.overallStatus.toUpperCase()}`);
  lines.push('');

  for (const check of output.checks) {
    const checkIcon = check.status === 'healthy' ? '✓' : check.status === 'degraded' ? '⚠' : '✗';
    lines.push(`  ${checkIcon} ${check.name}: ${check.summary}`);
    if (check.error) {
      lines.push(`    error: ${check.error}`);
    }
  }

  if (output.recommendedNextActions.length > 0) {
    lines.push('');
    lines.push('Recommended next actions:');
    for (const action of output.recommendedNextActions) {
      lines.push(`  [!] ${action}`);
    }
  }

  return lines.join('\n');
}

export async function handleRuntimeCanary(opts: CanaryOptions): Promise<void> {
  const workspaceDir = opts.workspace
    ? path.resolve(opts.workspace)
    : resolveWorkspaceDir();

  const output = await runCanaryChecks(workspaceDir);

  if (opts.json) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(formatTextOutput(output));
  }

  if (output.overallStatus !== 'healthy') {
    console.error('');
    console.error(`FAIL: overallStatus=${output.overallStatus}`);
    process.exitCode = 1;
  }
}
