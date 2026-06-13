/**
 * pd quality scorecard — CLI command (PRI-361)
 *
 * JSON contract: --json mode outputs EXACTLY one JSON object to stdout.
 * All progress/diagnostic output goes to stderr.
 * Errors produce structured JSON: { ok: false, error, nextAction }.
 */

import { mkdirSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import type {
  EpisodeEvaluation,
  QualityScorecardReport,
  StrongModelAdjudication,
} from '@principles/core/quality-scorecard';
import {
  validateCliOptions,
  needsAdjudication,
  generateMarkdownReport,
  generateHtmlReport,
  generateJsonReport,
} from '@principles/core/quality-scorecard';
import { extractEpisodes, extractLogStats } from '../services/quality-scorecard/data-extractor.js';
import { evaluateWithLocalModel, checkLmStudioAvailable } from '../services/quality-scorecard/local-evaluator.js';
import { adjudicate, skippedAdjudication, determineFinalLabel } from '../services/quality-scorecard/strong-model-gate.js';

// ── Logging: stderr only, silent in JSON mode ──────────────────────

let jsonMode = false;

function log(msg: string): void {
  if (!jsonMode) {
    process.stderr.write(msg + '\n');
  }
}

// ── Structured JSON output helpers ─────────────────────────────────

function writeJsonOutput(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + '\n');
}

function writeJsonError(error: string, nextAction: string): void {
  writeJsonOutput({ ok: false, error, nextAction });
}

// ── Summary computation ────────────────────────────────────────────

function computeSummary(evaluations: EpisodeEvaluation[]) {
  const totalEpisodes = evaluations.length;
  const localPassCount = evaluations.filter(e => e.finalLabel === 'local-pass' || e.finalLabel === 'pass').length;
  const localFailCount = evaluations.filter(e => e.finalLabel === 'local-fail' || e.finalLabel === 'fail').length;
  const strongModelReviewedCount = evaluations.filter(e =>
    e.strongModelAdjudication && e.strongModelAdjudication.adjudicationStatus !== 'skipped'
  ).length;
  const finalPassCount = evaluations.filter(e => e.finalLabel === 'pass').length;
  const finalFailCount = evaluations.filter(e => e.finalLabel === 'fail').length;
  const needsReviewCount = evaluations.filter(e => e.finalLabel === 'needs-review').length;
  const skippedCount = evaluations.filter(e => e.finalLabel === 'local-pass' || e.finalLabel === 'local-fail').length;
  const averageLocalScore = totalEpisodes > 0
    ? evaluations.reduce((s, e) => s + e.localEvaluation.totalScore, 0) / totalEpisodes
    : 0;
  const mvpThresholdMetCount = evaluations.filter(e => e.localEvaluation.mvpMet).length;

  return {
    totalEpisodes, localPassCount, localFailCount, strongModelReviewedCount,
    finalPassCount, finalFailCount, needsReviewCount, skippedCount,
    averageLocalScore, mvpThresholdMetCount,
  };
}

// ── Main handler ───────────────────────────────────────────────────

export async function handleQualityScorecard(opts: Record<string, unknown>): Promise<void> {
  const isJson = Boolean(opts.json);
  jsonMode = isJson;

  // Resolve workspace paths
  const { resolveWorkspaceDir } = await import('../resolve-workspace.js');
  const { join } = await import('path');
  const { existsSync } = await import('fs');
  const workspace = resolveWorkspaceDir(opts.workspace as string | undefined);
  const dbPath = join(workspace, '.state', 'trajectory.db');
  const logsDir = join(workspace, '.state', 'logs');

  // 1. Validate CLI options
  const { options, errors } = validateCliOptions({
    dbPath,
    logsDir,
    localModelBaseUrl: opts.localUrl ?? 'http://localhost:12341/v1',
    localModelId: opts.localModel ?? 'qwen3.6-27b-mtp',
    strongModelId: opts.strongModel ?? null,
    limit: opts.limit ?? '0',
    format: isJson ? 'json' : (opts.format ?? 'markdown'),
    output: opts.output,
    minPainScore: opts.minScore ?? '50',
    skipStrongModel: opts.skipStrongModel ?? false,
  });

  if (errors.length > 0) {
    const msg = errors.map(e => `${e.field}: ${e.message}`).join('; ');
    if (isJson) {
      writeJsonError(msg, 'Fix the invalid options and retry');
    } else {
      process.stderr.write(`❌ Invalid options:\n${errors.map(e => `  - ${e.field}: ${e.message}`).join('\n')}\n`);
    }
    process.exitCode = 1;
    return;
  }

  // 2. Check files exist
  if (!existsSync(options.dbPath)) {
    const msg = `trajectory.db not found at: ${options.dbPath}`;
    if (isJson) {
      writeJsonError(msg, 'Ensure the workspace has PD data (run PD first to generate trajectory.db)');
    } else {
      process.stderr.write(`❌ ${msg}\n`);
    }
    process.exitCode = 1;
    return;
  }

  // 3. Ensure output directory exists
  const outputDir = dirname(options.output);
  if (outputDir && !existsSync(outputDir)) {
    try {
      mkdirSync(outputDir, { recursive: true });
      log(`Created output directory: ${outputDir}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isJson) {
        writeJsonError(`Cannot create output directory: ${msg}`, 'Ensure the output path is writable');
      } else {
        process.stderr.write(`❌ Cannot create output directory: ${msg}\n`);
      }
      process.exitCode = 1;
      return;
    }
  }

  // 4. Check LM Studio
  log('🔍 PD Quality Scorecard — Starting...');
  log(`   DB: ${options.dbPath}`);
  log(`   Local Model: ${options.localModelId} @ ${options.localModelBaseUrl}`);
  log(`   Strong Model: ${options.strongModelId ?? 'skipped'}`);

  const lmStatus = await checkLmStudioAvailable(options.localModelBaseUrl);
  if (!lmStatus.available) {
    if (isJson) {
      writeJsonError(`LM Studio not available: ${lmStatus.error}`, 'Start LM Studio or check --local-url');
    } else {
      process.stderr.write(`❌ LM Studio not available at ${options.localModelBaseUrl}: ${lmStatus.error}\n`);
    }
    process.exitCode = 1;
    return;
  }

  if (!lmStatus.models.includes(options.localModelId)) {
    if (isJson) {
      writeJsonError(`Model "${options.localModelId}" not found. Available: ${lmStatus.models.join(', ')}`, 'Use --local-model with an available model');
    } else {
      process.stderr.write(`❌ Model "${options.localModelId}" not found. Available: ${lmStatus.models.join(', ')}\n`);
    }
    process.exitCode = 1;
    return;
  }

  // 5. Extract data
  log('\n📊 Extracting dogfood data...');
  const { episodes, stats: extractStats } = await extractEpisodes(options.dbPath, {
    minScore: options.minPainScore,
    limit: options.limit,
  });
  log(`   Found ${episodes.length} unique episodes (total pain events: ${extractStats.total})`);

  const logStats = extractLogStats(options.logsDir);
  log(`   Event logs: ${logStats.totalEvents} events (${logStats.painSignalCount} pain signals)`);

  // 6. Evaluate each episode
  log('\n🤖 Running local model evaluation...');
  const evaluations: EpisodeEvaluation[] = [];

  for (let i = 0; i < episodes.length; i++) {
    const ep = episodes[i];
    if (!ep) continue;
    log(`   [${i + 1}/${episodes.length}] ${ep.episodeId} (score=${ep.score})...`);

    const localEval = await evaluateWithLocalModel(ep, {
      baseUrl: options.localModelBaseUrl,
      model: options.localModelId,
    }, (msg: string) => log(`     ${msg}`));
    log(`     Local: ${localEval.totalScore}/14 MVP=${localEval.mvpMet} flags=[${localEval.flags.join(',')}]`);

    // 7. Strong model adjudication
    let adjudication: StrongModelAdjudication;
    if (options.skipStrongModel || !options.strongModelId) {
      adjudication = skippedAdjudication(
        options.skipStrongModel
          ? 'Strong model skipped by --skip-strong-model flag'
          : 'No strong model configured'
      );
    } else {
      const decision = needsAdjudication(ep, localEval);
      if (decision.shouldAdjudicate) {
        log(`     Adjudicating (${decision.priority}: ${decision.reason})...`);
        adjudication = await adjudicate(ep, localEval, { modelId: options.strongModelId, log: (msg: string) => log(`     ${msg}`) });
        log(`     Adjudication: ${adjudication.adjudicationStatus}`);
      } else {
        adjudication = skippedAdjudication(decision.reason);
        log(`     Adjudication skipped: ${decision.reason}`);
      }
    }

    const finalLabel = determineFinalLabel(localEval, adjudication);
    evaluations.push({ episode: ep, localEvaluation: localEval, strongModelAdjudication: adjudication, finalLabel });
  }

  // 8. Build and write report
  log('\n📝 Generating report...');
  const summary = computeSummary(evaluations);
  const report: QualityScorecardReport = {
    generatedAt: new Date().toISOString(),
    dataSource: {
      painEventCount: extractStats.total,
      evolutionTaskCount: 0,
      principleEventCount: 0,
      gateBlockCount: 0,
      dateRange: extractStats.dateRange,
    },
    localEvaluatorConfig: {
      model: options.localModelId,
      baseUrl: options.localModelBaseUrl.replace(/\/v\d+$/, '/...'),
      apiKeyStatus: 'not-required',
    },
    strongModelConfig: {
      model: options.strongModelId,
      status: options.skipStrongModel || !options.strongModelId ? 'skipped' : 'configured',
    },
    evaluations,
    summary,
    knownLimitations: [
      'Local model scores are advisory only — not final quality conclusions.',
      'Without strong-model adjudication, samples are marked local-pass/local-fail/needs-review.',
      'Deduplication is based on reason text similarity — may miss distinct episodes.',
      'Local model output is non-deterministic despite temperature=0.1.',
    ],
  };

  let content: string;
  switch (options.format) {
    case 'html': content = generateHtmlReport(report); break;
    case 'json': content = generateJsonReport(report); break;
    case 'markdown':
    default: content = generateMarkdownReport(report); break;
  }

  writeFileSync(options.output, content, 'utf-8');

  log(`\n✅ Report written to: ${options.output}`);
  log(`   Format: ${options.format}`);
  log(`   Episodes: ${summary.totalEpisodes}`);
  log(`   Local Pass: ${summary.localPassCount} | Local Fail: ${summary.localFailCount}`);
  log(`   Strong Model Reviewed: ${summary.strongModelReviewedCount}`);
  log(`   Final Pass: ${summary.finalPassCount} | Final Fail: ${summary.finalFailCount} | Needs Review: ${summary.needsReviewCount}`);

  // JSON mode: output exactly one JSON object to stdout
  if (isJson) {
    writeJsonOutput({ ok: true, report });
  }
}
