import type { TaskEvidence } from '../types/index.js';
/**
 * Parses diagnostician output JSON from artifact content
 */
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
    
    if (output.rootCause || output.recommendations?.length) {
      return {
        rootCause: output.rootCause ?? '',
        confidence: output.confidence ?? 0,
        violatedPrinciples: output.violatedPrinciples ?? [],
        evidenceChain: output.evidence ?? [],
        recommendations: (output.recommendations ?? []).map(r => ({
          kind: r.kind as 'principle' | 'rule' | 'implementation' | 'prompt' | 'defer',
          description: r.description,
          triggerPattern: r.triggerPattern,
          action: r.action,
          abstractedPrinciple: r.abstractedPrinciple,
        })),
        ambiguityNotes: output.ambiguityNotes ?? [],
      };
    }
  } catch {
    // Ignore parse errors
  }
  return undefined;
}

/**
 * Parses diagnostic input JSON from task
 */
export function parseDiagnosticInput(diagnosticJson: string): TaskEvidence['input'] | undefined {
  try {
    const diag = JSON.parse(diagnosticJson) as {
      reasonSummary?: string;
      source?: string;
      severity?: string;
      painId?: string;
      sessionIdHint?: string;
    };
    
    if (diag.reasonSummary || diag.source) {
      return {
        reasonSummary: diag.reasonSummary ?? '',
        source: diag.source ?? '',
        severity: diag.severity ?? 'unknown',
        painId: diag.painId,
        sessionId: diag.sessionIdHint,
      };
    }
  } catch {
    // Ignore parse errors
  }
  return undefined;
}

/**
 * Parses severity from diagnostic JSON
 */
export function parseSeverityFromDiagnostic(diagnosticJson: string | null | undefined): string | undefined {
  if (!diagnosticJson) return undefined;
  try {
    const diag = JSON.parse(diagnosticJson);
    return diag.severity ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Parses reason summary from diagnostic JSON
 */
export function parseReasonSummaryFromDiagnostic(diagnosticJson: string | null | undefined): string {
  if (!diagnosticJson) return '';
  try {
    const diag = JSON.parse(diagnosticJson);
    return diag.reasonSummary ?? '';
  } catch {
    return '';
  }
}

/**
 * Parses recommendation kind from source recommendation JSON
 */
export function parseRecommendationKind(sourceRecommendationJson: string | null | undefined): string | undefined {
  if (!sourceRecommendationJson) return undefined;
  try {
    const rec = JSON.parse(sourceRecommendationJson) as { kind?: string };
    return rec.kind ?? undefined;
  } catch {
    return undefined;
  }
}
