import * as path from 'path';
import * as fs from 'fs';
import {
  OperatorHealthReadModel,
  SchemaConformanceReadModel,
  PruningReadModel,
  createInternalizationQueueReadModel,
  InternalizationChainIntegrityReadModel,
  auditCandidateLedgerConsistency,
  buildGfiWorkspaceSnapshot,
} from '@principles/core/runtime-v2';
import { runCanaryChecks } from './runtime-canary.js';
import { resolveWorkspaceDir } from '../resolve-workspace.js';

export interface BundleManifestArtifact {
  name: string;
  path: string;
  status: 'ok' | 'failed';
  error?: string;
}

export interface BundleManifest {
  generatedAt: string;
  workspace: string;
  outputDir: string;
  artifacts: BundleManifestArtifact[];
}

export interface DiagnosticsExportOptions {
  workspace?: string;
  out?: string;
  json?: boolean;
}

function validateOutputPath(outDir: string, workspaceDir: string): string {
  const resolvedOut = path.resolve(outDir);
  const resolvedWs = path.resolve(workspaceDir);
  const relative = path.relative(resolvedWs, resolvedOut);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Output path must be within workspace directory');
  }
  return resolvedOut;
}

function sanitizeForExport(data: unknown): unknown {
  if (data === null || data === undefined) return data;
  if (typeof data === 'string') {
    return data.replace(/(?:api[_-]?key|secret|token|password|authorization|bearer)\s*[:=]\s*\S+/gi, '[REDACTED]');
  }
  if (Array.isArray(data)) return data.map(sanitizeForExport);
  if (typeof data === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      const lowerKey = key.toLowerCase();
      if (/key|secret|token|password|auth|bearer|credential/i.test(lowerKey)) {
        result[key] = '[REDACTED]';
      } else {
        result[key] = sanitizeForExport(value);
      }
    }
    return result;
  }
  return data;
}

interface CollectArtifactContext {
  name: string;
  fileName: string;
  outputDir: string;
  collector: () => Promise<unknown> | unknown;
  artifacts: BundleManifestArtifact[];
  errors: { artifact: string; error: string }[];
}

async function collectArtifact(ctx: CollectArtifactContext): Promise<void> {
  try {
    const data = await ctx.collector();
    const sanitized = sanitizeForExport(data);
    const filePath = path.join(ctx.outputDir, ctx.fileName);
    fs.writeFileSync(filePath, JSON.stringify(sanitized, null, 2), 'utf8');
    ctx.artifacts.push({ name: ctx.name, path: ctx.fileName, status: 'ok' });
  } catch (err) {
    ctx.artifacts.push({ name: ctx.name, path: ctx.fileName, status: 'failed', error: String(err) });
    ctx.errors.push({ artifact: ctx.name, error: String(err) });
  }
}

export async function exportDiagnosticsBundle(workspaceDir: string, outDir: string): Promise<BundleManifest> {
  const generatedAt = new Date().toISOString();
  const resolvedOut = validateOutputPath(outDir, workspaceDir);
  const artifacts: BundleManifestArtifact[] = [];
  const errors: { artifact: string; error: string }[] = [];

  fs.mkdirSync(resolvedOut, { recursive: true });

  const baseCtx = { outputDir: resolvedOut, artifacts, errors };

  await collectArtifact({ ...baseCtx, name: 'runtime-health', fileName: 'runtime-health.json', collector: async () => {
    const model = new OperatorHealthReadModel({ workspaceDir });
    try {
      return await model.getSnapshot();
    } finally {
      await model.close();
    }
  } });

  await collectArtifact({ ...baseCtx, name: 'canary', fileName: 'canary.json', collector: async () => {
    return await runCanaryChecks(workspaceDir);
  } });

  await collectArtifact({ ...baseCtx, name: 'schema-conformance', fileName: 'schema-conformance.json', collector: () => {
    const model = new SchemaConformanceReadModel({ workspaceDir });
    return model.check();
  } });

  await collectArtifact({ ...baseCtx, name: 'candidate-audit', fileName: 'candidate-audit.json', collector: async () => {
    return await auditCandidateLedgerConsistency(workspaceDir);
  } });

  await collectArtifact({ ...baseCtx, name: 'gfi-snapshot', fileName: 'gfi-snapshot.json', collector: () => {
    const sessionDir = path.join(workspaceDir, '.state', 'sessions');
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
    return buildGfiWorkspaceSnapshot({ sessions, nowMs: Date.now() });
  } });

  await collectArtifact({ ...baseCtx, name: 'pruning-orphans', fileName: 'pruning-orphans.json', collector: () => {
    const model = new PruningReadModel({ workspaceDir });
    return model.getOrphanDerivedCandidates();
  } });

  await collectArtifact({ ...baseCtx, name: 'internalization-queue', fileName: 'internalization-queue.json', collector: async () => {
    const { readModel, close } = await createInternalizationQueueReadModel({ workspaceDir, readonly: true });
    try {
      return await readModel.getSnapshot();
    } finally {
      await close();
    }
  } });

  await collectArtifact({ ...baseCtx, name: 'internalization-integrity', fileName: 'internalization-integrity.json', collector: () => {
    const model = new InternalizationChainIntegrityReadModel({ workspaceDir });
    return model.check();
  } });

  await collectArtifact({ ...baseCtx, name: 'recent-session-summary', fileName: 'recent-session-summary.json', collector: () => {
    const sessionDir = path.join(workspaceDir, '.state', 'sessions');
    const summaries: { sessionId: string; status: string; lastActivityAt: number }[] = [];
    if (fs.existsSync(sessionDir)) {
      for (const file of fs.readdirSync(sessionDir)) {
        if (!file.endsWith('.json')) continue;
        try {
          const raw = fs.readFileSync(path.join(sessionDir, file), 'utf8');
          const parsed = JSON.parse(raw);
          if (parsed?.sessionId) {
            summaries.push({
              sessionId: parsed.sessionId,
              status: parsed.status ?? 'unknown',
              lastActivityAt: parsed.lastActivityAt ?? parsed.lastControlActivityAt ?? 0,
            });
          }
        } catch { /* skip */ }
      }
    }
    return { sessionCount: summaries.length, sessions: summaries.slice(0, 20) };
  } });

  if (errors.length > 0) {
    await collectArtifact({ outputDir: resolvedOut, artifacts, errors: [], name: 'errors', fileName: 'errors.json', collector: () => errors });
  }

  const manifest: BundleManifest = {
    generatedAt,
    workspace: workspaceDir,
    outputDir: resolvedOut,
    artifacts,
  };

  fs.writeFileSync(
    path.join(resolvedOut, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
    'utf8',
  );

  return manifest;
}

export async function handleRuntimeDiagnosticsExport(opts: DiagnosticsExportOptions): Promise<void> {
  const workspaceDir = opts.workspace
    ? path.resolve(opts.workspace)
    : resolveWorkspaceDir();

  const outDir = opts.out
    ? path.resolve(workspaceDir, opts.out)
    : path.resolve(workspaceDir, '.state', 'control-plane-observation', 'snapshots');

  const manifest = await exportDiagnosticsBundle(workspaceDir, outDir);

  if (opts.json) {
    console.log(JSON.stringify(manifest, null, 2));
  } else {
    console.log(`Diagnostic bundle exported to: ${manifest.outputDir}`);
    console.log(`Artifacts: ${manifest.artifacts.length}`);
    for (const artifact of manifest.artifacts) {
      const icon = artifact.status === 'ok' ? '✓' : '✗';
      console.log(`  ${icon} ${artifact.name} (${artifact.path})`);
    }
    const failedCount = manifest.artifacts.filter(a => a.status === 'failed').length;
    if (failedCount > 0) {
      console.log(`\n${failedCount} artifact(s) failed to generate. See errors.json for details.`);
    }
  }
}
