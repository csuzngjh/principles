/**
 * PRI-361 Quality Scorecard — Main Orchestrator
 *
 * Orchestrates the dual-layer quality gate:
 * 1. Extract dogfood data (desensitized)
 * 2. Run local model evaluation on each episode
 * 3. Run strong model adjudication on flagged episodes
 * 4. Generate report
 */

import type {
  ScorecardOptions,
  EpisodeEvaluation,
  QualityScorecardReport,
  StrongModelAdjudication,
  LocalEvaluation,
} from './types.js';
import type { PainEpisode } from './types.js';
import { extractEpisodes, extractLogStats } from './data-extractor.js';
import { evaluateWithLocalModel, checkLmStudioAvailable } from './local-evaluator.js';
import { needsAdjudication, adjudicate, skippedAdjudication, determineFinalLabel } from './strong-model-gate.js';
import { generateMarkdownReport, generateHtmlReport, generateJsonReport } from './report-generator.js';
import { writeFileSync } from 'fs';

export type { ScorecardOptions } from './types.js';

async function resolveAdjudication(
  ep: PainEpisode,
  localEval: LocalEvaluation,
  options: ScorecardOptions
): Promise<StrongModelAdjudication> {
  if (options.skipStrongModel || !options.strongModelId) {
    return skippedAdjudication(
      options.skipStrongModel
        ? 'Strong model skipped by --skip-strong-model flag'
        : 'No strong model configured'
    );
  }
  const decision = needsAdjudication(ep, localEval);
  if (decision.shouldAdjudicate) {
    console.log(`     Adjudicating (${decision.priority}: ${decision.reason})...`);
    const adj = await adjudicate(ep, localEval, options.strongModelId);
    console.log(`     Adjudication: ${adj.adjudicationStatus}`);
    return adj;
  }
  console.log(`     Adjudication skipped: ${decision.reason}`);
  return skippedAdjudication(decision.reason);
}

// ── Summary computation (hoisted before use) ───────────────────────

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
    totalEpisodes,
    localPassCount,
    localFailCount,
    strongModelReviewedCount,
    finalPassCount,
    finalFailCount,
    needsReviewCount,
    skippedCount,
    averageLocalScore,
    mvpThresholdMetCount,
  };
}

// ── Main orchestrator ──────────────────────────────────────────────

export async function runScorecard(options: ScorecardOptions): Promise<QualityScorecardReport> {
  console.log('🔍 PD Quality Scorecard — Starting...');
  console.log(`   DB: ${options.dbPath}`);
  console.log(`   Local Model: ${options.localModelId} @ ${options.localModelBaseUrl}`);
  console.log(`   Strong Model: ${options.strongModelId ?? 'skipped'}`);

  // 1. Check local model availability
  const lmStatus = await checkLmStudioAvailable(options.localModelBaseUrl);
  if (!lmStatus.available) {
    throw new Error(`LM Studio not available at ${options.localModelBaseUrl}: ${lmStatus.error}`);
  }
  console.log(`   LM Studio models: ${lmStatus.models.join(', ')}`);

  if (!lmStatus.models.includes(options.localModelId)) {
    throw new Error(`Model "${options.localModelId}" not found. Available: ${lmStatus.models.join(', ')}`);
  }

  // 2. Extract data
  console.log('\n📊 Extracting dogfood data...');
  const { episodes, stats: extractStats } = await extractEpisodes(options.dbPath, {
    minScore: options.minPainScore,
    limit: options.limit,
  });
  console.log(`   Found ${episodes.length} unique episodes (total pain events: ${extractStats.total})`);

  const logStats = extractLogStats(options.logsDir);
  console.log(`   Event logs: ${logStats.totalEvents} events (${logStats.painSignalCount} pain signals)`);

  // 3. Evaluate each episode with local model
  console.log('\n🤖 Running local model evaluation...');
  const evaluations: EpisodeEvaluation[] = [];

  for (let i = 0; i < episodes.length; i++) {
    const ep = episodes[i];
    if (!ep) continue;
    console.log(`   [${i + 1}/${episodes.length}] ${ep.episodeId} (score=${ep.score})...`);

    const localEval = await evaluateWithLocalModel(ep, {
      baseUrl: options.localModelBaseUrl,
      model: options.localModelId,
    });
    console.log(`     Local: ${localEval.totalScore}/14 MVP=${localEval.mvpMet} flags=[${localEval.flags.join(',')}]`);

    // 4. Strong model adjudication
    const adjudication = await resolveAdjudication(ep, localEval, options);

    const finalLabel = determineFinalLabel(localEval, adjudication);
    evaluations.push({ episode: ep, localEvaluation: localEval, strongModelAdjudication: adjudication, finalLabel });
  }

  // 5. Build report
  console.log('\n📝 Generating report...');

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
      'Deduplication is based on reason text similarity — may miss distinct episodes with similar descriptions.',
      'Evolution task linking uses time proximity ±1h — may mislink in dense activity periods.',
      'Desensitization replaces paths, tokens, and session IDs but may miss other PII.',
      'Local model temperature=0.1 but output is still non-deterministic — scores may vary across runs.',
      'The rubric is designed for PD pain→diagnosis→principle chain quality; other use cases need adjustment.',
    ],
  };

  // 6. Write report
  let content: string;
  switch (options.format) {
    case 'html': content = generateHtmlReport(report); break;
    case 'json': content = generateJsonReport(report); break;
    case 'markdown':
    default: content = generateMarkdownReport(report); break;
  }

  writeFileSync(options.output, content, 'utf-8');
  console.log(`\n✅ Report written to: ${options.output}`);
  console.log(`   Format: ${options.format}`);
  console.log(`   Episodes: ${summary.totalEpisodes}`);
  console.log(`   Local Pass: ${summary.localPassCount} | Local Fail: ${summary.localFailCount}`);
  console.log(`   Strong Model Reviewed: ${summary.strongModelReviewedCount}`);
  console.log(`   Final Pass: ${summary.finalPassCount} | Final Fail: ${summary.finalFailCount} | Needs Review: ${summary.needsReviewCount}`);

  return report;
}
