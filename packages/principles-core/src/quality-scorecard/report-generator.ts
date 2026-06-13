/**
 * PRI-361 Quality Scorecard — Report Generator
 *
 * PURE LOGIC — generates report strings. ZERO I/O.
 * All external strings are escaped before rendering.
 */

import type {
  QualityScorecardReport,
  EpisodeEvaluation,
} from './types.js';
import { RUBRIC_LABELS, RUBRIC_DIMENSIONS as DIMS } from './types.js';
import { escapeHtml, escapeMarkdownTable } from './validation.js';

// ── Markdown Report ────────────────────────────────────────────────

function mdTable(eval_: EpisodeEvaluation): string {
  const local = eval_.localEvaluation;
  const strong = eval_.strongModelAdjudication;
  const header = '| Dimension | Label | Local | Strong | Local Rationale |';
  const sep = '|-----------|-------|-------|--------|-----------------|';
  const rows = DIMS.map(d => {
    const localScore = `${local.dimensionScores[d]}/2`;
    const strongScore = strong?.confirmedScores ? `${strong.confirmedScores[d]}/2` : '-';
    const rationale = escapeMarkdownTable(local.dimensionRationales[d]).substring(0, 60);
    return `| ${d} | ${RUBRIC_LABELS[d]} | ${localScore} | ${strongScore} | ${rationale} |`;
  });
  return [header, sep, ...rows].join('\n');
}

export function generateMarkdownReport(report: QualityScorecardReport): string {
  const lines: string[] = [];
  lines.push('# PD Quality Scorecard Report');
  lines.push('');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push('');

  // Data source
  const ds = report.dataSource;
  lines.push('## Data Source');
  lines.push('');
  lines.push(`- Pain Events: ${ds.painEventCount}`);
  lines.push(`- Evolution Tasks: ${ds.evolutionTaskCount}`);
  lines.push(`- Principle Events: ${ds.principleEventCount}`);
  lines.push(`- Gate Blocks: ${ds.gateBlockCount}`);
  lines.push(`- Date Range: ${ds.dateRange.from} — ${ds.dateRange.to}`);
  lines.push('');

  // Config
  lines.push('## Evaluation Config');
  lines.push('');
  lines.push(`- Local Model: ${report.localEvaluatorConfig.model} (${report.localEvaluatorConfig.baseUrl})`);
  lines.push(`- API Key: ${report.localEvaluatorConfig.apiKeyStatus}`);
  lines.push(`- Strong Model: ${report.strongModelConfig.model ?? 'not configured'} (${report.strongModelConfig.status})`);
  lines.push('');

  // Summary
  lines.push('## Summary');
  lines.push('');
  const s = report.summary;
  lines.push(`- Total Episodes: ${s.totalEpisodes}`);
  lines.push(`- Local Pass: ${s.localPassCount}`);
  lines.push(`- Local Fail: ${s.localFailCount}`);
  lines.push(`- Strong Model Reviewed: ${s.strongModelReviewedCount}`);
  lines.push(`- Final Pass: ${s.finalPassCount}`);
  lines.push(`- Final Fail: ${s.finalFailCount}`);
  lines.push(`- Needs Review: ${s.needsReviewCount}`);
  lines.push(`- Skipped (no strong model): ${s.skippedCount}`);
  lines.push(`- Average Local Score: ${s.averageLocalScore.toFixed(1)}/14`);
  lines.push(`- MVP Threshold Met: ${s.mvpThresholdMetCount}/${s.totalEpisodes}`);
  lines.push('');

  // Episode details
  lines.push('## Episode Evaluations');
  lines.push('');

  for (const ev of report.evaluations) {
    const summary = escapeMarkdownTable(ev.episode.summary);
    const flags = ev.localEvaluation.flags.map(escapeMarkdownTable).join(', ');
    const adjRationale = ev.strongModelAdjudication
      ? escapeMarkdownTable(ev.strongModelAdjudication.rationale ?? '')
      : '';

    lines.push(`### ${ev.episode.episodeId} — ${ev.finalLabel.toUpperCase()}`);
    lines.push('');
    lines.push(`- Source: ${escapeMarkdownTable(ev.episode.source)}`);
    lines.push(`- Pain Score: ${ev.episode.score}`);
    lines.push(`- Severity: ${escapeMarkdownTable(ev.episode.severity)}`);
    lines.push(`- Summary: ${summary}`);
    lines.push(`- Local Score: ${ev.localEvaluation.totalScore}/14 (MVP: ${ev.localEvaluation.mvpMet ? 'met' : 'not met'})`);
    if (ev.localEvaluation.flags.length > 0) {
      lines.push(`- Flags: ${flags}`);
    }
    if (ev.strongModelAdjudication) {
      const adj = ev.strongModelAdjudication;
      lines.push(`- Adjudication: ${adj.adjudicationStatus} (model: ${escapeMarkdownTable(adj.model)})`);
      if (adjRationale) lines.push(`- Adjudication Rationale: ${adjRationale}`);
      if (adj.confirmedMvpMet !== null) lines.push(`- Confirmed MVP: ${adj.confirmedMvpMet ? 'met' : 'not met'}`);
      if (adj.nextAction) lines.push(`- Next Action: ${escapeMarkdownTable(adj.nextAction)}`);
    }
    lines.push('');
    lines.push(mdTable(ev));
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  // Known limitations
  lines.push('## Known Limitations');
  lines.push('');
  for (const lim of report.knownLimitations) {
    lines.push(`- ${escapeMarkdownTable(lim)}`);
  }
  lines.push('');

  return lines.join('\n');
}

// ── HTML Report ────────────────────────────────────────────────────

export function generateHtmlReport(report: QualityScorecardReport): string {
  const s = report.summary;
  const localPassPct = s.totalEpisodes > 0 ? ((s.localPassCount / s.totalEpisodes) * 100).toFixed(0) : '0';

  const episodeCards = report.evaluations.map(ev => {
    const statusClass = ev.finalLabel === 'pass' ? 'pass' : ev.finalLabel === 'fail' ? 'fail' : 'review';
    const local = ev.localEvaluation;
    const adj = ev.strongModelAdjudication;
    const scoreBar = DIMS.map(d => {
      const pct = (local.dimensionScores[d] / 2) * 100;
      const color = local.dimensionScores[d] === 2 ? '#22c55e' : local.dimensionScores[d] === 1 ? '#eab308' : '#ef4444';
      return `<div class="dim-score"><span class="dim-label">${d}</span><div class="bar-bg"><div class="bar-fill" style="width:${pct}%;background:${color}"></div></div><span class="dim-val">${local.dimensionScores[d]}/2</span></div>`;
    }).join('');

    const safeSummary = escapeHtml(ev.episode.summary);
    const safeSource = escapeHtml(ev.episode.source);
    const safeFlags = local.flags.map(escapeHtml).join(', ');
    const safeAdjRationale = adj ? escapeHtml(adj.rationale ?? '') : '';
    const safeNextAction = adj?.nextAction ? escapeHtml(adj.nextAction) : '';

    return `
      <div class="card ${statusClass}">
        <div class="card-header">
          <span class="ep-id">${escapeHtml(ev.episode.episodeId)}</span>
          <span class="badge ${statusClass}">${escapeHtml(ev.finalLabel.toUpperCase())}</span>
        </div>
        <div class="card-body">
          <p><strong>Source:</strong> ${safeSource} | <strong>Score:</strong> ${ev.episode.score} | <strong>Local:</strong> ${local.totalScore}/14</p>
          <p class="summary">${safeSummary}</p>
          ${local.flags.length > 0 ? `<p class="flags">⚠️ ${safeFlags}</p>` : ''}
          ${adj ? `<p class="adj"><strong>Adjudication:</strong> ${escapeHtml(adj.adjudicationStatus)} — ${safeAdjRationale.substring(0, 100)}</p>` : '<p class="adj"><strong>Adjudication:</strong> skipped (local-only assessment)</p>'}
          ${safeNextAction ? `<p class="adj"><strong>Next Action:</strong> ${safeNextAction}</p>` : ''}
          <div class="score-bars">${scoreBar}</div>
        </div>
      </div>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>PD Quality Scorecard</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; max-width: 900px; margin: 2rem auto; padding: 0 1rem; background: #0f172a; color: #e2e8f0; }
  h1 { color: #f8fafc; }
  h2 { color: #94a3b8; border-bottom: 1px solid #334155; padding-bottom: 0.5rem; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 1rem; margin: 1rem 0; }
  .stat { background: #1e293b; padding: 1rem; border-radius: 8px; text-align: center; }
  .stat-val { font-size: 2rem; font-weight: bold; color: #38bdf8; }
  .stat-label { font-size: 0.8rem; color: #94a3b8; }
  .card { background: #1e293b; border-radius: 8px; margin: 1rem 0; border-left: 4px solid #64748b; overflow: hidden; }
  .card.pass { border-left-color: #22c55e; }
  .card.fail { border-left-color: #ef4444; }
  .card.review { border-left-color: #eab308; }
  .card-header { display: flex; justify-content: space-between; align-items: center; padding: 0.75rem 1rem; background: #334155; }
  .badge { padding: 0.2rem 0.6rem; border-radius: 4px; font-size: 0.75rem; font-weight: bold; }
  .badge.pass { background: #22c55e33; color: #22c55e; }
  .badge.fail { background: #ef444433; color: #ef4444; }
  .badge.review { background: #eab30833; color: #eab308; }
  .card-body { padding: 1rem; }
  .summary { color: #cbd5e1; font-size: 0.9rem; }
  .flags { color: #f97316; font-size: 0.85rem; }
  .adj { color: #94a3b8; font-size: 0.85rem; }
  .dim-score { display: flex; align-items: center; gap: 0.5rem; margin: 0.3rem 0; }
  .dim-label { width: 2rem; font-size: 0.8rem; color: #94a3b8; }
  .bar-bg { flex: 1; height: 8px; background: #334155; border-radius: 4px; }
  .bar-fill { height: 100%; border-radius: 4px; transition: width 0.3s; }
  .dim-val { width: 2.5rem; font-size: 0.8rem; color: #e2e8f0; }
  .limitations { background: #1e293b; padding: 1rem; border-radius: 8px; }
  .limitations li { color: #94a3b8; margin: 0.3rem 0; }
</style>
</head>
<body>
<h1>🧬 PD Quality Scorecard</h1>
<p>Generated: ${escapeHtml(report.generatedAt)}</p>

<h2>Summary</h2>
<div class="stats">
  <div class="stat"><div class="stat-val">${s.totalEpisodes}</div><div class="stat-label">Episodes</div></div>
  <div class="stat"><div class="stat-val">${localPassPct}%</div><div class="stat-label">Local Pass Rate</div></div>
  <div class="stat"><div class="stat-val">${s.strongModelReviewedCount}</div><div class="stat-label">Strong Model Reviewed</div></div>
  <div class="stat"><div class="stat-val">${s.averageLocalScore.toFixed(1)}</div><div class="stat-label">Avg Score /14</div></div>
  <div class="stat"><div class="stat-val">${s.mvpThresholdMetCount}</div><div class="stat-label">MVP Met</div></div>
</div>

<p><strong>Config:</strong> Local: ${escapeHtml(report.localEvaluatorConfig.model)} | Strong: ${escapeHtml(report.strongModelConfig.model ?? 'skipped')}</p>

<h2>Episode Evaluations</h2>
${episodeCards}

<h2>Known Limitations</h2>
<ul class="limitations">
${report.knownLimitations.map(l => `<li>${escapeHtml(l)}</li>`).join('\n')}
</ul>
</body>
</html>`;
}

// ── JSON Report (pass-through) ─────────────────────────────────────

export function generateJsonReport(report: QualityScorecardReport): string {
  return JSON.stringify(report, null, 2);
}
