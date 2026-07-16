import { describe, it, expect } from 'vitest';
import {
  generateMarkdownReport,
  generateHtmlReport,
  generateJsonReport,
} from '../report-generator.js';
import type {
  QualityScorecardReport,
  EpisodeEvaluation,
  PainEpisode,
  LocalEvaluation,
  StrongModelAdjudication,
  RubricDimension,
  RubricScore,
} from '../types.js';
import { RUBRIC_DIMENSIONS } from '../types.js';

// ── Helpers ─────────────────────────────────────────────────────────

function makeDimensionScores(
  override?: Partial<Record<RubricDimension, RubricScore>>
): Record<RubricDimension, RubricScore> {
  const scores = {} as Record<RubricDimension, RubricScore>;
  for (const d of RUBRIC_DIMENSIONS) {
    scores[d] = override?.[d] ?? 2;
  }
  return scores;
}

function makeDimensionRationales(
  override?: Partial<Record<RubricDimension, string>>
): Record<RubricDimension, string> {
  const rationales = {} as Record<RubricDimension, string>;
  for (const d of RUBRIC_DIMENSIONS) {
    rationales[d] = override?.[d] ?? `${d} rationale`;
  }
  return rationales;
}

function makePainEpisode(
  overrides?: Partial<PainEpisode>
): PainEpisode {
  return {
    episodeId: 'EP-001',
    summary: 'Agent fabricated evidence',
    source: 'gate-block',
    score: 80,
    severity: 'high',
    createdAt: '2026-07-10T12:00:00Z',
    evolutionTaskResolution: null,
    linkedPrinciples: [],
    gateBlockCount: 1,
    ...overrides,
  };
}

function makeLocalEvaluation(
  overrides?: Partial<LocalEvaluation>
): LocalEvaluation {
  return {
    model: 'test-model',
    dimensionScores: makeDimensionScores(),
    dimensionRationales: makeDimensionRationales(),
    totalScore: 14,
    maxScore: 14,
    mvpMet: true,
    flags: [],
    ...overrides,
  };
}

function makeStrongModelAdjudication(
  overrides?: Partial<StrongModelAdjudication>
): StrongModelAdjudication {
  return {
    model: 'strong-model',
    adjudicationStatus: 'pass',
    confirmedScores: makeDimensionScores(),
    confirmedMvpMet: true,
    rationale: 'All good',
    nextAction: null,
    ...overrides,
  };
}

function makeEpisodeEvaluation(
  overrides?: Partial<EpisodeEvaluation>
): EpisodeEvaluation {
  return {
    episode: makePainEpisode(),
    localEvaluation: makeLocalEvaluation(),
    strongModelAdjudication: null,
    finalLabel: 'local-pass',
    ...overrides,
  };
}

function makeReport(
  overrides?: Partial<QualityScorecardReport>
): QualityScorecardReport {
  return {
    generatedAt: '2026-07-14T00:00:00Z',
    dataSource: {
      painEventCount: 1,
      evolutionTaskCount: 0,
      principleEventCount: 0,
      gateBlockCount: 0,
      dateRange: { from: '2026-07-01', to: '2026-07-14' },
    },
    localEvaluatorConfig: {
      model: 'test-model',
      baseUrl: 'http://localhost:1234/v1',
      apiKeyStatus: 'set',
    },
    strongModelConfig: {
      model: null,
      status: 'skipped',
    },
    evaluations: [],
    summary: {
      totalEpisodes: 0,
      localPassCount: 0,
      localFailCount: 0,
      strongModelReviewedCount: 0,
      finalPassCount: 0,
      finalFailCount: 0,
      needsReviewCount: 0,
      localOnlyCount: 0,
      averageLocalScore: 0,
      mvpThresholdMetCount: 0,
    },
    knownLimitations: [],
    ...overrides,
  };
}

// ── generateMarkdownReport ──────────────────────────────────────────

describe('generateMarkdownReport', () => {
  it('includes header "PD Quality Scorecard Report"', () => {
    const md = generateMarkdownReport(makeReport());
    expect(md).toContain('# PD Quality Scorecard Report');
  });

  it('includes generated date', () => {
    const md = generateMarkdownReport(makeReport());
    expect(md).toContain('Generated: 2026-07-14T00:00:00Z');
  });

  it('includes data source section with counts', () => {
    const md = generateMarkdownReport(
      makeReport({
        dataSource: {
          painEventCount: 5,
          evolutionTaskCount: 3,
          principleEventCount: 2,
          gateBlockCount: 1,
          dateRange: { from: '2026-07-01', to: '2026-07-14' },
        },
      })
    );
    expect(md).toContain('## Data Source');
    expect(md).toContain('- Pain Events: 5');
    expect(md).toContain('- Evolution Tasks: 3');
    expect(md).toContain('- Principle Events: 2');
    expect(md).toContain('- Gate Blocks: 1');
    expect(md).toContain('- Date Range: 2026-07-01 — 2026-07-14');
  });

  it('includes evaluation config section', () => {
    const md = generateMarkdownReport(makeReport());
    expect(md).toContain('## Evaluation Config');
    expect(md).toContain('- Local Model: test-model (http://localhost:1234/v1)');
    expect(md).toContain('- API Key: set');
    expect(md).toContain('- Strong Model: not configured (skipped)');
  });

  it('includes summary section with all counts', () => {
    const md = generateMarkdownReport(
      makeReport({
        summary: {
          totalEpisodes: 3,
          localPassCount: 2,
          localFailCount: 1,
          strongModelReviewedCount: 1,
          finalPassCount: 2,
          finalFailCount: 1,
          needsReviewCount: 0,
          localOnlyCount: 2,
          averageLocalScore: 11.3,
          mvpThresholdMetCount: 2,
        },
      })
    );
    expect(md).toContain('## Summary');
    expect(md).toContain('- Total Episodes: 3');
    expect(md).toContain('- Local Pass: 2');
    expect(md).toContain('- Local Fail: 1');
    expect(md).toContain('- Strong Model Reviewed: 1');
    expect(md).toContain('- Final Pass: 2');
    expect(md).toContain('- Final Fail: 1');
    expect(md).toContain('- Needs Review: 0');
    expect(md).toContain('- Local-only evaluated (no strong model): 2');
    expect(md).toContain('- Average Local Score: 11.3/14');
    expect(md).toContain('- MVP Threshold Met: 2/3');
  });

  it('includes episode details with status badges', () => {
    const md = generateMarkdownReport(
      makeReport({
        evaluations: [
          makeEpisodeEvaluation({
            episode: makePainEpisode({ episodeId: 'EP-001' }),
            finalLabel: 'local-pass',
          }),
        ],
        summary: {
          totalEpisodes: 1,
          localPassCount: 1,
          localFailCount: 0,
          strongModelReviewedCount: 0,
          finalPassCount: 1,
          finalFailCount: 0,
          needsReviewCount: 0,
          localOnlyCount: 1,
          averageLocalScore: 14,
          mvpThresholdMetCount: 1,
        },
      })
    );
    expect(md).toContain('### EP-001 — LOCAL-PASS');
    expect(md).toContain('## Episode Evaluations');
  });

  it('escapes pipe characters in episode summaries', () => {
    const md = generateMarkdownReport(
      makeReport({
        evaluations: [
          makeEpisodeEvaluation({
            episode: makePainEpisode({ summary: 'has | pipes' }),
            finalLabel: 'local-pass',
          }),
        ],
        summary: {
          totalEpisodes: 1,
          localPassCount: 1,
          localFailCount: 0,
          strongModelReviewedCount: 0,
          finalPassCount: 1,
          finalFailCount: 0,
          needsReviewCount: 0,
          localOnlyCount: 1,
          averageLocalScore: 14,
          mvpThresholdMetCount: 1,
        },
      })
    );
    expect(md).toContain('has \\| pipes');
    expect(md).not.toMatch(/Summary: has \| pipes$/m);
  });

  it('escapes newlines in episode summaries', () => {
    const md = generateMarkdownReport(
      makeReport({
        evaluations: [
          makeEpisodeEvaluation({
            episode: makePainEpisode({ summary: 'line1\nline2' }),
            finalLabel: 'local-pass',
          }),
        ],
        summary: {
          totalEpisodes: 1,
          localPassCount: 1,
          localFailCount: 0,
          strongModelReviewedCount: 0,
          finalPassCount: 1,
          finalFailCount: 0,
          needsReviewCount: 0,
          localOnlyCount: 1,
          averageLocalScore: 14,
          mvpThresholdMetCount: 1,
        },
      })
    );
    expect(md).toContain('line1 line2');
  });

  it('includes rubric dimension table per episode', () => {
    const md = generateMarkdownReport(
      makeReport({
        evaluations: [makeEpisodeEvaluation()],
        summary: {
          totalEpisodes: 1,
          localPassCount: 1,
          localFailCount: 0,
          strongModelReviewedCount: 0,
          finalPassCount: 1,
          finalFailCount: 0,
          needsReviewCount: 0,
          localOnlyCount: 1,
          averageLocalScore: 14,
          mvpThresholdMetCount: 1,
        },
      })
    );
    expect(md).toContain('| Dimension | Label | Local | Strong | Local Rationale |');
    expect(md).toContain('| G1 | Evidence Grounding | 2/2 | - |');
  });

  it('includes strong model scores in dimension table when adjudication exists', () => {
    const adj = makeStrongModelAdjudication({
      confirmedScores: makeDimensionScores({ G1: 1 }),
    });
    const md = generateMarkdownReport(
      makeReport({
        evaluations: [
          makeEpisodeEvaluation({
            strongModelAdjudication: adj,
            finalLabel: 'pass',
          }),
        ],
        summary: {
          totalEpisodes: 1,
          localPassCount: 1,
          localFailCount: 0,
          strongModelReviewedCount: 1,
          finalPassCount: 1,
          finalFailCount: 0,
          needsReviewCount: 0,
          localOnlyCount: 0,
          averageLocalScore: 14,
          mvpThresholdMetCount: 1,
        },
      })
    );
    expect(md).toContain('| G1 | Evidence Grounding | 2/2 | 1/2 |');
  });

  it('includes known limitations section', () => {
    const md = generateMarkdownReport(
      makeReport({
        knownLimitations: ['Small sample size', 'No strong model configured'],
      })
    );
    expect(md).toContain('## Known Limitations');
    expect(md).toContain('- Small sample size');
    expect(md).toContain('- No strong model configured');
  });

  it('shows flags when present', () => {
    const md = generateMarkdownReport(
      makeReport({
        evaluations: [
          makeEpisodeEvaluation({
            localEvaluation: makeLocalEvaluation({ flags: ['fabricated_evidence'] }),
            finalLabel: 'local-fail',
          }),
        ],
        summary: {
          totalEpisodes: 1,
          localPassCount: 0,
          localFailCount: 1,
          strongModelReviewedCount: 0,
          finalPassCount: 0,
          finalFailCount: 1,
          needsReviewCount: 0,
          localOnlyCount: 1,
          averageLocalScore: 14,
          mvpThresholdMetCount: 1,
        },
      })
    );
    expect(md).toContain('- Flags: fabricated_evidence');
  });

  it('shows adjudication details when present', () => {
    const adj = makeStrongModelAdjudication({
      adjudicationStatus: 'needs-review',
      rationale: 'Borderline score',
      nextAction: 'Re-evaluate with more context',
      confirmedMvpMet: false,
    });
    const md = generateMarkdownReport(
      makeReport({
        evaluations: [
          makeEpisodeEvaluation({
            strongModelAdjudication: adj,
            finalLabel: 'needs-review',
          }),
        ],
        summary: {
          totalEpisodes: 1,
          localPassCount: 0,
          localFailCount: 0,
          strongModelReviewedCount: 1,
          finalPassCount: 0,
          finalFailCount: 0,
          needsReviewCount: 1,
          localOnlyCount: 0,
          averageLocalScore: 14,
          mvpThresholdMetCount: 1,
        },
      })
    );
    expect(md).toContain('- Adjudication: needs-review (model: strong-model)');
    expect(md).toContain('- Adjudication Rationale: Borderline score');
    expect(md).toContain('- Confirmed MVP: not met');
    expect(md).toContain('- Next Action: Re-evaluate with more context');
  });
});

// ── generateHtmlReport ──────────────────────────────────────────────

describe('generateHtmlReport', () => {
  it('returns a complete HTML document', () => {
    const html = generateHtmlReport(makeReport());
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('</html>');
  });

  it('includes DOCTYPE and html tags', () => {
    const html = generateHtmlReport(makeReport());
    expect(html).toMatch(/^<!DOCTYPE html>/);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('</html>');
  });

  it('includes CSS styles', () => {
    const html = generateHtmlReport(makeReport());
    expect(html).toContain('<style>');
    expect(html).toContain('font-family:');
    expect(html).toContain('.card');
    expect(html).toContain('.badge');
  });

  it('includes summary stats', () => {
    const html = generateHtmlReport(
      makeReport({
        summary: {
          totalEpisodes: 5,
          localPassCount: 3,
          localFailCount: 2,
          strongModelReviewedCount: 1,
          finalPassCount: 3,
          finalFailCount: 2,
          needsReviewCount: 0,
          localOnlyCount: 4,
          averageLocalScore: 10.5,
          mvpThresholdMetCount: 3,
        },
      })
    );
    expect(html).toContain('>5</div><div class="stat-label">Episodes</div>');
    expect(html).toContain('>1</div><div class="stat-label">Strong Model Reviewed</div>');
    expect(html).toContain('>10.5</div><div class="stat-label">Avg Score /14</div>');
    expect(html).toContain('>3</div><div class="stat-label">MVP Met</div>');
  });

  it('includes episode cards with correct status classes', () => {
    const html = generateHtmlReport(
      makeReport({
        evaluations: [
          makeEpisodeEvaluation({
            episode: makePainEpisode({ episodeId: 'EP-PASS' }),
            finalLabel: 'pass',
            strongModelAdjudication: makeStrongModelAdjudication(),
          }),
          makeEpisodeEvaluation({
            episode: makePainEpisode({ episodeId: 'EP-FAIL' }),
            localEvaluation: makeLocalEvaluation({
              dimensionScores: makeDimensionScores({ G1: 0, G2: 0, G3: 0, G4: 0, G5: 0, G6: 0, G7: 0 }),
              totalScore: 0,
              mvpMet: false,
            }),
            finalLabel: 'fail',
          }),
          makeEpisodeEvaluation({
            episode: makePainEpisode({ episodeId: 'EP-REVIEW' }),
            finalLabel: 'needs-review',
          }),
        ],
        summary: {
          totalEpisodes: 3,
          localPassCount: 1,
          localFailCount: 1,
          strongModelReviewedCount: 1,
          finalPassCount: 1,
          finalFailCount: 1,
          needsReviewCount: 1,
          localOnlyCount: 2,
          averageLocalScore: 9.3,
          mvpThresholdMetCount: 1,
        },
      })
    );
    expect(html).toContain('class="card pass"');
    expect(html).toContain('class="card fail"');
    expect(html).toContain('class="card review"');
    expect(html).toContain('class="badge pass"');
    expect(html).toContain('class="badge fail"');
    expect(html).toContain('class="badge review"');
  });

  it('escapes HTML in all user-supplied strings', () => {
    const html = generateHtmlReport(
      makeReport({
        evaluations: [
          makeEpisodeEvaluation({
            episode: makePainEpisode({
              episodeId: 'EP-XSS',
              summary: '<script>alert("xss")</script>',
              source: '<img onerror="hack">',
            }),
            localEvaluation: makeLocalEvaluation({
              flags: ['<b>flag</b>'],
            }),
            strongModelAdjudication: makeStrongModelAdjudication({
              rationale: '<em>rationale</em>',
              nextAction: '<a href="evil">click</a>',
            }),
            finalLabel: 'pass',
          }),
        ],
        knownLimitations: ['<script>evil</script>'],
        summary: {
          totalEpisodes: 1,
          localPassCount: 1,
          localFailCount: 0,
          strongModelReviewedCount: 1,
          finalPassCount: 1,
          finalFailCount: 0,
          needsReviewCount: 0,
          localOnlyCount: 0,
          averageLocalScore: 14,
          mvpThresholdMetCount: 1,
        },
      })
    );
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('<img onerror');
    expect(html).not.toContain('<b>flag</b>');
    expect(html).not.toContain('<em>rationale</em>');
    expect(html).not.toContain('<a href="evil">');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;img onerror');
  });

  it('renders score bars with correct colors for each dimension score', () => {
    const html = generateHtmlReport(
      makeReport({
        evaluations: [
          makeEpisodeEvaluation({
            localEvaluation: makeLocalEvaluation({
              dimensionScores: makeDimensionScores({
                G1: 2,
                G2: 1,
                G3: 0,
                G4: 2,
                G5: 2,
                G6: 1,
                G7: 2,
              }),
            }),
            finalLabel: 'local-pass',
          }),
        ],
        summary: {
          totalEpisodes: 1,
          localPassCount: 1,
          localFailCount: 0,
          strongModelReviewedCount: 0,
          finalPassCount: 1,
          finalFailCount: 0,
          needsReviewCount: 0,
          localOnlyCount: 1,
          averageLocalScore: 10,
          mvpThresholdMetCount: 1,
        },
      })
    );
    // Score 2 → green (#22c55e), score 1 → yellow (#eab308), score 0 → red (#ef4444)
    expect(html).toContain('background:#22c55e'); // G1=2
    expect(html).toContain('background:#eab308'); // G2=1
    expect(html).toContain('background:#ef4444'); // G3=0
    // Width percentages: score 2 → 100%, score 1 → 50%, score 0 → 0%
    expect(html).toContain('width:100%');
    expect(html).toContain('width:50%');
    expect(html).toContain('width:0%');
  });

  it('shows local-only assessment message when no adjudication', () => {
    const html = generateHtmlReport(
      makeReport({
        evaluations: [
          makeEpisodeEvaluation({
            strongModelAdjudication: null,
            finalLabel: 'local-pass',
          }),
        ],
        summary: {
          totalEpisodes: 1,
          localPassCount: 1,
          localFailCount: 0,
          strongModelReviewedCount: 0,
          finalPassCount: 1,
          finalFailCount: 0,
          needsReviewCount: 0,
          localOnlyCount: 1,
          averageLocalScore: 14,
          mvpThresholdMetCount: 1,
        },
      })
    );
    expect(html).toContain('skipped (local-only assessment)');
  });

  it('computes local pass rate percentage correctly', () => {
    const html = generateHtmlReport(
      makeReport({
        summary: {
          totalEpisodes: 4,
          localPassCount: 3,
          localFailCount: 1,
          strongModelReviewedCount: 0,
          finalPassCount: 3,
          finalFailCount: 1,
          needsReviewCount: 0,
          localOnlyCount: 4,
          averageLocalScore: 10,
          mvpThresholdMetCount: 3,
        },
      })
    );
    // 3/4 = 75%
    expect(html).toContain('>75%</div><div class="stat-label">Local Pass Rate</div>');
  });

  it('handles zero episodes without division by zero', () => {
    const html = generateHtmlReport(makeReport());
    expect(html).toContain('>0%</div><div class="stat-label">Local Pass Rate</div>');
  });
});

// ── generateJsonReport ──────────────────────────────────────────────

describe('generateJsonReport', () => {
  it('returns valid JSON', () => {
    const report = makeReport();
    const json = generateJsonReport(report);
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it('round-trips the report data', () => {
    const report = makeReport({
      evaluations: [
        makeEpisodeEvaluation({
          episode: makePainEpisode({
            episodeId: 'EP-RT',
            summary: 'Round trip test',
            source: 'gate-block',
            score: 90,
            severity: 'critical',
          }),
          localEvaluation: makeLocalEvaluation({
            dimensionScores: makeDimensionScores({ G1: 1, G3: 0 }),
            totalScore: 12,
            flags: ['low_confidence'],
          }),
          strongModelAdjudication: makeStrongModelAdjudication({
            adjudicationStatus: 'pass',
            rationale: 'Confirmed',
          }),
          finalLabel: 'pass',
        }),
      ],
      knownLimitations: ['Test limitation'],
      summary: {
        totalEpisodes: 1,
        localPassCount: 1,
        localFailCount: 0,
        strongModelReviewedCount: 1,
        finalPassCount: 1,
        finalFailCount: 0,
        needsReviewCount: 0,
        localOnlyCount: 0,
        averageLocalScore: 12,
        mvpThresholdMetCount: 1,
      },
    });
    const json = generateJsonReport(report);
    const parsed = JSON.parse(json);
    expect(parsed).toEqual(report);
  });

  it('preserves all rubric dimension scores', () => {
    const scores = makeDimensionScores({ G1: 0, G2: 1, G3: 2, G4: 0, G5: 1, G6: 2, G7: 0 });
    const report = makeReport({
      evaluations: [
        makeEpisodeEvaluation({
          localEvaluation: makeLocalEvaluation({ dimensionScores: scores }),
          finalLabel: 'local-fail',
        }),
      ],
    });
    const parsed = JSON.parse(generateJsonReport(report));
    expect(parsed.evaluations[0].localEvaluation.dimensionScores).toEqual(scores);
  });

  it('handles empty evaluations array', () => {
    const report = makeReport();
    const parsed = JSON.parse(generateJsonReport(report));
    expect(parsed.evaluations).toEqual([]);
    expect(parsed.summary.totalEpisodes).toBe(0);
  });

  it('preserves knownLimitations array', () => {
    const report = makeReport({
      knownLimitations: ['A', 'B', 'C'],
    });
    const parsed = JSON.parse(generateJsonReport(report));
    expect(parsed.knownLimitations).toEqual(['A', 'B', 'C']);
  });
});
