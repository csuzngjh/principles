/**
 * pd quality scorecard command — PRI-361
 *
 * Generates a quality scorecard report for PD pain → diagnosis → principle chain.
 *
 * Usage:
 *   pd quality scorecard [options]
 *
 * Options:
 *   --workspace <path>      Workspace directory (default: auto-detect)
 *   --local-model <id>      LM Studio model ID (default: qwen3.6-27b-mtp)
 *   --local-url <url>       LM Studio base URL (default: http://localhost:12341/v1)
 *   --strong-model <id>     Strong model for adjudication (provider/model format)
 *   --skip-strong-model     Skip strong model adjudication
 *   --min-score <n>         Minimum pain score to evaluate (default: 50)
 *   --limit <n>             Max episodes to evaluate (default: 0 = all)
 *   --format <fmt>          Output format: json, markdown, html (default: markdown)
 *   --output <path>         Output file path (default: ./quality-scorecard-report.md)
 *   --json                  Output as JSON (shorthand for --format json)
 */

import { runScorecard } from '@principles/core/quality-scorecard';
import type { ScorecardOptions } from '@principles/core/quality-scorecard';
import { resolveWorkspaceDir } from '../resolve-workspace.js';

export async function handleQualityScorecard(opts: Record<string, unknown>): Promise<void> {
  const fsActual = await import('fs');
  const pathActual = await import('path');

  const workspace = resolveWorkspaceDir(opts.workspace as string | undefined);
  const dbPath = pathActual.join(workspace, '.state', 'trajectory.db');
  const logsDir = pathActual.join(workspace, '.state', 'logs');

  if (!fsActual.existsSync(dbPath)) {
    console.error(`❌ trajectory.db not found at: ${dbPath}`);
    console.error('   Ensure the workspace has PD data.');
    process.exit(1);
  }

  const format = opts.json ? 'json' : (opts.format as string) ?? 'markdown';
  const defaultExt = format === 'html' ? '.html' : format === 'json' ? '.json' : '.md';
  const outputPath = (opts.output as string) ?? `./quality-scorecard-report${defaultExt}`;

  const options: ScorecardOptions = {
    dbPath,
    logsDir,
    localModelBaseUrl: (opts.localUrl as string) ?? 'http://localhost:12341/v1',
    localModelId: (opts.localModel as string) ?? 'qwen3.6-27b-mtp',
    strongModelId: (opts.strongModel as string) ?? null,
    limit: parseInt((opts.limit as string) ?? '0', 10),
    format: format as 'json' | 'markdown' | 'html',
    output: outputPath,
    minPainScore: parseInt((opts.minScore as string) ?? '50', 10),
    skipStrongModel: (opts.skipStrongModel as boolean) ?? false,
  };

  await runScorecard(options);
}
