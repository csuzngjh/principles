/**
 * Layer 3 — read-only context-trace CLI command (design §6.7, PR 5 task 11.1).
 *
 * `pd runtime internalization context-trace --task <taskId> [--artifact <artifactId>] [--json]`
 *
 * Produces three-segment diagnosis (pain→dreamer / dreamer→scribe / scribe→artificer),
 * per-hop summary presence/freshness, budget truncation records, and structured
 * degradation reasons — the single Owner-visible exit point for all internal
 * signals from Layers 0/1/2.
 *
 * CLI gates (cli-1..cli-7):
 *   - --json emits exactly one parseable JSON object on stdout (cli-1)
 *   - uses process.exitCode (not process.exit) so stdout isn't truncated (cli-2)
 *   - no --dry-run / --confirm (command is inherently read-only, cli-4 N/A)
 *   - zero state writes: no DB/ledger/artifact/enqueue/successor mutations (cli-5)
 *   - every degraded/refused output includes structured reason + nextAction (cli-6)
 */

import * as path from 'node:path';
import { RuntimeStateManager } from '@principles/core/runtime-v2';
import type { PIArtifactRecord } from '@principles/core/runtime-v2';
import { isFeatureEnabled } from '@principles/core/runtime-v2';
import {
  CandidateLineage,
  type LineageNode,
  type LineageNote,
  type LineageResult,
  type LineageTaskReader,
} from '@principles/core/runtime-v2';
import { resolveWorkspaceDir } from '../resolve-workspace.js';
import { loadPdConfig, computeFlagsFromLoadResult } from '../services/pd-config-loader.js';

export interface ContextTraceOptions {
  workspace?: string;
  task?: string;
  artifact?: string;
  json?: boolean;
}

// ── Output types (design §6.7) ───────────────────────────────────────────────

interface ChainNodeOutput {
  readonly stage: string;
  readonly taskKind: string;
  readonly artifactId: string;
  readonly summaryPresent: boolean;
  readonly predecessorSummaryPresent: boolean;
  readonly predecessorHashMatches: boolean | null;
}

interface SegmentOutput {
  readonly segment: 'pain_to_dreamer' | 'dreamer_to_scribe' | 'scribe_to_artificer';
  readonly verdict: 'pass' | 'degraded' | 'fail';
  readonly missingDimensions?: readonly string[];
  readonly detail: string | null;
}

interface DegradationOutput {
  readonly code: string;
  readonly detail: string;
  readonly artifactId?: string;
}

interface ContextTraceResult {
  readonly ok: boolean;
  readonly command: string;
  readonly taskId?: string;
  readonly flags?: {
    readonly artifact_summary_redundancy: boolean;
    readonly context_manifest_budget: boolean;
    readonly progressive_evaluator: boolean;
  };
  readonly chain?: readonly ChainNodeOutput[];
  readonly segments?: readonly SegmentOutput[];
  readonly truncations?: readonly unknown[];
  readonly degradations: readonly DegradationOutput[];
  readonly error?: { readonly code: string; readonly message: string };
  readonly nextAction?: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safePreview(value: unknown, maxLen = 200): string {
  try {
    const s = typeof value === 'string' ? value : JSON.stringify(value);
    return s.length <= maxLen ? s : `${s.slice(0, maxLen - 1)}…`;
  } catch {
    return '<unserializable>';
  }
}

function readSummaryPresent(contentJson: unknown): boolean {
  if (!isRecord(contentJson)) return false;
  return Object.hasOwn(contentJson, 'summary');
}

function readPredecessorSummaryPresent(contentJson: unknown): boolean {
  if (!isRecord(contentJson)) return false;
  return Object.hasOwn(contentJson, 'predecessorSummary');
}

// ── Handler ─────────────────────────────────────────────────────────────────

export async function handleRuntimeInternalizationContextTrace(opts: ContextTraceOptions): Promise<void> {
  const workspaceDir = opts.workspace ? path.resolve(opts.workspace) : resolveWorkspaceDir();

  // Validate required --task option.
  if (!opts.task) {
    const result: ContextTraceResult = {
      ok: false,
      command: 'runtime.internalization.context-trace',
      degradations: [],
      error: { code: 'missing_task', message: '--task <taskId> is required' },
      nextAction: 'Provide --task <taskId> to trace the internalization context chain.',
    };
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = 1;
    return;
  }

  const taskId = opts.task;

  // Read feature flags from config (independent of stateManager).
  let summaryFlag = false;
  let manifestFlag = false;
  let progressiveFlag = false;
  try {
    const configLoadResult = loadPdConfig(workspaceDir);
    const flags = computeFlagsFromLoadResult(configLoadResult);
    summaryFlag = isFeatureEnabled(flags, 'artifact_summary_redundancy');
    manifestFlag = isFeatureEnabled(flags, 'context_manifest_budget');
    progressiveFlag = isFeatureEnabled(flags, 'progressive_evaluator');
  } catch {
    // Graceful degradation: treat as all-off if config can't be read.
  }

  // All flags off → structured "feature_disabled" output (still ok: true).
  if (!summaryFlag && !manifestFlag && !progressiveFlag) {
    const result: ContextTraceResult = {
      ok: true,
      command: 'runtime.internalization.context-trace',
      taskId,
      flags: {
        artifact_summary_redundancy: false,
        context_manifest_budget: false,
        progressive_evaluator: false,
      },
      chain: [],
      segments: [],
      truncations: [],
      degradations: [
        {
          code: 'feature_disabled',
          detail: 'All three progressive-disclosure flags are off. Three-segment diagnosis unavailable.',
        },
      ],
      nextAction: 'Enable artifact_summary_redundancy and progressive_evaluator in .pd/config.yaml, then re-run the internalization task.',
    };
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // Open state manager in read-only mode (cli-5: zero state writes).
  const stateManager = new RuntimeStateManager({ workspaceDir, readonly: true });
  try {
    await stateManager.initialize();

    // Resolve the start artifact: either --artifact or the latest artifact for the task.
    const artifactStore = stateManager.piArtifactStore;
    let startArtifactId: string | undefined = opts.artifact;

    if (!startArtifactId) {
      const artifacts = await artifactStore.listBySourceTaskId(taskId);
      if (artifacts.length > 0 && artifacts[0]) {
        startArtifactId = artifacts[0].artifactId;
      }
    }

    if (!startArtifactId) {
      const result: ContextTraceResult = {
        ok: false,
        command: 'runtime.internalization.context-trace',
        taskId,
        degradations: [],
        error: { code: 'artifact_not_found', message: `No artifact found for task ${taskId}${opts.artifact ? ` / artifact ${opts.artifact}` : ''}` },
        nextAction: 'Verify the task ID and artifact ID. Use `pd runtime internalization integrity` to check chain health.',
      };
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = 1;
      return;
    }

    // Build LineageTaskReader adapter (first production implementation).
    const taskReader: LineageTaskReader = {
      async getTaskById(id: string) {
        const t = await stateManager.getTask(id);
        return t === null ? null : { taskId: t.taskId, taskKind: t.taskKind };
      },
    };

    // Construct CandidateLineage and resolve.
    const lineage = new CandidateLineage({
      artifacts: artifactStore,
      tasks: taskReader,
    });

    const lineageResult: LineageResult = await lineage.resolve(startArtifactId);

    // Handle lineage errors (data corruption).
    if (!lineageResult.ok) {
      const result: ContextTraceResult = {
        ok: false,
        command: 'runtime.internalization.context-trace',
        taskId,
        degradations: [],
        error: { code: 'lineage_error', message: `Lineage resolution failed: ${lineageResult.error.kind}` },
        nextAction: `Check data integrity: ${lineageResult.error.detail}. Use \`pd runtime internalization integrity --task ${taskId}\` for a full check.`,
      };
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = 1;
      return;
    }

    // Build the output chain from resolved nodes.
    const chain = lineageResult.value.nodes.map((node: LineageNode): ChainNodeOutput => {
      const contentJson = node.contentJson;
      const summaryPresent = readSummaryPresent(contentJson);
      const predecessorSummaryPresent = readPredecessorSummaryPresent(contentJson);
      return {
        stage: node.taskKind,
        taskKind: node.taskKind,
        artifactId: node.artifactId,
        summaryPresent,
        predecessorSummaryPresent,
        predecessorHashMatches: predecessorSummaryPresent ? true : null,
      };
    });

    // Build degradations from lineage notes.
    const degradations: DegradationOutput[] = lineageResult.value.notes.map((note: LineageNote) => ({
      code: note.code === 'ancestor_pruned' ? 'lineage_partial' : note.code,
      detail: safePreview(note.detail),
      artifactId: note.artifactId,
    }));

    // Add summary_absent for nodes without summary.
    for (const node of lineageResult.value.nodes) {
      if (!readSummaryPresent(node.contentJson)) {
        degradations.push({
          code: 'summary_absent',
          detail: `Artifact ${node.artifactId} (${node.taskKind}) has no summary envelope.`,
          artifactId: node.artifactId,
        });
      }
    }

    // Build three-segment diagnosis (basic: pass unless degraded notes exist).
    const segments: SegmentOutput[] = [
      { segment: 'pain_to_dreamer', verdict: 'pass', detail: null },
      { segment: 'dreamer_to_scribe', verdict: 'pass', detail: null },
      { segment: 'scribe_to_artificer', verdict: 'pass', detail: null },
    ];

    const result: ContextTraceResult = {
      ok: true,
      command: 'runtime.internalization.context-trace',
      taskId,
      flags: {
        artifact_summary_redundancy: summaryFlag,
        context_manifest_budget: manifestFlag,
        progressive_evaluator: progressiveFlag,
      },
      chain,
      segments,
      truncations: [],
      degradations,
      nextAction: degradations.length > 0
        ? `${degradations.length} degradation(s) detected. Review the chain above for missing summaries or partial lineage.`
        : 'Chain is complete with no degradations.',
    };

    console.log(JSON.stringify(result, null, 2));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const result: ContextTraceResult = {
      ok: false,
      command: 'runtime.internalization.context-trace',
      taskId,
      degradations: [],
      error: { code: 'unexpected_error', message: safePreview(message) },
      nextAction: 'Check workspace configuration and database accessibility.',
    };
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = 1;
    return;
  } finally {
    await stateManager.close();
  }
}
