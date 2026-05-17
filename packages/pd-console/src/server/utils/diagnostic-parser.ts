import type { TaskEvidence } from '../types/index.js';

const VALID_RECOMMENDATION_KINDS = new Set(['principle', 'rule', 'implementation', 'prompt', 'defer']);

function logParseError(context: string, raw: string): void {
  console.debug('[diagnostic-parser] Failed to parse ' + context + ': ' + raw.slice(0, 200));
}

export function parseDiagnosticianOutput(contentJson: string): TaskEvidence['diagnosis'] | undefined {
  try {
    const output = JSON.parse(contentJson) as {
      rootCause?: string;
      confidence?: number;
      violatedPrinciples?: { principleId?: string; title?: string; rationale: string }[];
      evidence?: { sourceRef: string; note: string }[];
      recommendations?: { kind: string; description: string; triggerPattern?: string; action?: string; abstractedPrinciple?: string }[];
      ambiguityNotes?: string[];
    };

    return {
      rootCause: output.rootCause ?? '',
      confidence: output.confidence ?? 0,
      violatedPrinciples: output.violatedPrinciples ?? [],
      evidenceChain: output.evidence ?? [],
      recommendations: (output.recommendations ?? []).map(r => ({
        kind: VALID_RECOMMENDATION_KINDS.has(r.kind) ? (r.kind as 'principle' | 'rule' | 'implementation' | 'prompt' | 'defer') : 'principle',
        description: r.description,
        triggerPattern: r.triggerPattern,
        action: r.action,
        abstractedPrinciple: r.abstractedPrinciple,
      })),
      ambiguityNotes: output.ambiguityNotes ?? [],
    };
  } catch {
    logParseError('diagnostician output', contentJson);
  }
  return undefined;
}

export function parseDiagnosticInput(diagnosticJson: string): TaskEvidence['input'] | undefined {
  try {
    const diag = JSON.parse(diagnosticJson) as {
      reasonSummary?: string;
      source?: string;
      severity?: string;
      painId?: string;
      sessionIdHint?: string;
    };

    return {
      reasonSummary: diag.reasonSummary ?? '',
      source: diag.source ?? '',
      severity: diag.severity ?? 'unknown',
      painId: diag.painId,
      sessionId: diag.sessionIdHint,
    };
  } catch {
    logParseError('diagnostic input', diagnosticJson);
  }
  return undefined;
}

export function parseSeverityFromDiagnostic(diagnosticJson: string | null | undefined): string | undefined {
  if (!diagnosticJson) return undefined;
  try {
    const diag = JSON.parse(diagnosticJson);
    return diag.severity ?? undefined;
  } catch {
    logParseError('severity', diagnosticJson);
    return undefined;
  }
}

export function parseReasonSummaryFromDiagnostic(diagnosticJson: string | null | undefined): string {
  if (!diagnosticJson) return '';
  try {
    const diag = JSON.parse(diagnosticJson);
    return diag.reasonSummary ?? '';
  } catch {
    logParseError('reason summary', diagnosticJson);
    return '';
  }
}

export function parseRecommendationKind(sourceRecommendationJson: string | null | undefined): string | undefined {
  if (!sourceRecommendationJson) return undefined;
  try {
    const rec = JSON.parse(sourceRecommendationJson);
    if (typeof rec !== 'object' || rec === null || Array.isArray(rec)) return undefined;
    return rec.kind ?? undefined;
  } catch {
    logParseError('recommendation kind', sourceRecommendationJson);
    return undefined;
  }
}