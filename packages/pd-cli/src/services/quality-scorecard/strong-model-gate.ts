/**
 * PRI-361 — Strong Model Adjudication Gate (I/O layer in pd-cli)
 *
 * Calls cloud model for adjudication. Uses core validation
 * to parse responses — no unsafe casts.
 */

import type {
  PainEpisode,
  LocalEvaluation,
  StrongModelAdjudication,
  AdjudicationStatus,
} from '@principles/core/quality-scorecard';
import {
  RUBRIC_LABELS,
  RUBRIC_DIMENSIONS as DIMS,
  meetsMvpThreshold,
  validateAdjudicationResponse,
  extractJsonFromLlmResponse,
} from '@principles/core/quality-scorecard';

function buildAdjudicationPrompt(
  episode: PainEpisode,
  localEval: LocalEvaluation
): string {
  const localScores = DIMS.map(d =>
    `- ${d} (${RUBRIC_LABELS[d]}): ${localEval.dimensionScores[d]}/2 — ${localEval.dimensionRationales[d]}`
  ).join('\n');

  return `You are a senior quality adjudicator for an AI agent evolution pipeline.
Your job is to independently re-evaluate a pain episode that was first scored by a local (smaller) model.
You must provide your own scores — do NOT simply copy the local model's scores.

## Pain Episode
- ID: ${episode.episodeId}
- Source: ${episode.source}
- Pain Score: ${episode.score}
- Severity: ${episode.severity}
- Summary: ${episode.summary}
- Evolution Task Resolution: ${episode.evolutionTaskResolution ?? 'none'}
- Linked Principles: ${episode.linkedPrinciples.length > 0 ? episode.linkedPrinciples.join(', ') : 'none'}

## Local Model Scores (${localEval.model})
${localScores}
Flags: ${localEval.flags.length > 0 ? localEval.flags.join(', ') : 'none'}

## Your Task
1. Independently score each dimension (0/1/2) based on the evidence.
2. Check for: language inconsistency, over-abstraction, fabricated evidence.
3. If your scores differ from the local model by >=2 points on any dimension, explain why.
4. Give a final verdict: pass, fail, or needs-review.

## Output Format (STRICT JSON)
{
  "scores": { "G1": 0-2, "G2": 0-2, "G3": 0-2, "G4": 0-2, "G5": 0-2, "G6": 0-2, "G7": 0-2 },
  "rationale": "Overall assessment...",
  "verdict": "pass" | "fail" | "needs-review"
}

Do NOT output anything other than this JSON object.`;
}

export async function adjudicate(
  episode: PainEpisode,
  localEval: LocalEvaluation,
  config: { modelId: string; log: (msg: string) => void }
): Promise<StrongModelAdjudication> {
  const { modelId: strongModelId, log } = config;
  const prompt = buildAdjudicationPrompt(episode, localEval);
  const baseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return {
      model: strongModelId,
      adjudicationStatus: 'needs-review',
      confirmedScores: null,
      confirmedMvpMet: null,
      rationale: 'OPENAI_API_KEY not set — cannot run strong-model adjudication',
      nextAction: 'Set OPENAI_API_KEY and re-run with --strong-model',
    };
  }

  try {
    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: strongModelId,
        messages: [
          { role: 'system', content: 'You are a precise JSON-output quality adjudicator. Output only valid JSON.' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.1,
        max_tokens: 2000,
      }),
      signal: AbortSignal.timeout(120_000),
    });

    if (!resp.ok) {
      throw new Error(`Strong model request failed: ${resp.status}`);
    }

    const data = (await resp.json()) as { choices: { message: { content: string } }[] };
    const content = data.choices?.[0]?.message?.content ?? '';
    const parsed = extractJsonFromLlmResponse(content);
    if (parsed === null) {
      throw new Error('Strong model returned non-JSON');
    }

    const validated = validateAdjudicationResponse(parsed);
    const { scores, verdict } = validated;

    return {
      model: strongModelId,
      adjudicationStatus: verdict,
      confirmedScores: scores,
      confirmedMvpMet: meetsMvpThreshold(scores),
      rationale: validated.rationale,
      nextAction: null,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Adjudication error: ${msg}`);
    return {
      model: strongModelId,
      adjudicationStatus: 'needs-review',
      confirmedScores: null,
      confirmedMvpMet: null,
      rationale: `Adjudication failed: ${msg}`,
      nextAction: 'Retry with strong model or manually review',
    };
  }
}

export function skippedAdjudication(reason: string): StrongModelAdjudication {
  return {
    model: 'none',
    adjudicationStatus: 'skipped',
    confirmedScores: null,
    confirmedMvpMet: null,
    rationale: reason,
    nextAction: 'Configure and run strong-model adjudication for final quality verdict',
  };
}

export function determineFinalLabel(
  localEval: LocalEvaluation,
  adjudication: StrongModelAdjudication | null
): AdjudicationStatus {
  if (!adjudication || adjudication.adjudicationStatus === 'skipped') {
    if (localEval.mvpMet && localEval.totalScore >= 12) return 'local-pass';
    if (localEval.totalScore <= 6) return 'local-fail';
    return 'needs-review';
  }
  return adjudication.adjudicationStatus;
}
