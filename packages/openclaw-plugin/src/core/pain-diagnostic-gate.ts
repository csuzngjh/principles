import { SystemLogger } from './system-logger.js';

export type PainDiagnosticSource =
  | 'manual'
  | 'tool_failure'
  | 'gate_blocked'
  | 'user_empathy'
  | 'llm_paralysis'
  | 'semantic'
  | 'subagent_error';

export type PainDiagnosticGateReason =
  | 'manual'
  | 'high_gfi'
  | 'repeated_failure'
  | 'semantic_pain'
  | 'llm_paralysis'
  | 'risky_high_score'
  | 'subagent_error'
  | 'cooldown'
  | 'below_gate';

export interface PainDiagnosticGateInput {
  source: PainDiagnosticSource | string;
  score: number;
  currentGfi: number;
  consecutiveErrors?: number;
  isRisky?: boolean;
  errorHash?: string;
  sessionId?: string;
  nowMs?: number;
  cooldownMs?: number;
  thresholds?: {
    painTrigger?: number;
    highSeverity?: number;
    highGfi?: number;
    repeatedFailure?: number;
    semanticPain?: number;
  };
}

export interface PainDiagnosticGateDecision {
  shouldDiagnose: boolean;
  reason: PainDiagnosticGateReason;
  episodeKey: string;
  detail: string;
}

const DEFAULT_COOLDOWN_MS = 15 * 60 * 1000;
const lastDiagnosedAtByEpisode = new Map<string, number>();

function normalizedSource(source: string): PainDiagnosticSource | string {
  if (source.startsWith('llm_') && source !== 'llm_paralysis') {
    return 'semantic';
  }
  if (!['manual', 'tool_failure', 'gate_blocked', 'user_empathy', 'llm_paralysis', 'semantic', 'subagent_error'].includes(source)) {
    SystemLogger.log('', 'GATE_UNKNOWN_SOURCE', `Unknown pain source: "${source}"`);
  }
  return source;
}

function buildEpisodeKey(input: PainDiagnosticGateInput): string {
  const source = normalizedSource(input.source);
  const sessionId = input.sessionId || 'unknown';
  const hash = input.errorHash || 'no-hash';
  return `${sessionId}:${source}:${hash}`;
}

function withinCooldown(input: PainDiagnosticGateInput, episodeKey: string): boolean {
  const cooldownMs = input.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  if (cooldownMs <= 0) return false;

  const nowMs = input.nowMs ?? Date.now();
  const last = lastDiagnosedAtByEpisode.get(episodeKey);
  return last !== undefined && nowMs - last < cooldownMs;
}

function markDiagnosed(input: PainDiagnosticGateInput, episodeKey: string): void {
  lastDiagnosedAtByEpisode.set(episodeKey, input.nowMs ?? Date.now());
}

export function resetPainDiagnosticGateForTest(): void {
  lastDiagnosedAtByEpisode.clear();
}

export function evaluatePainDiagnosticGate(input: PainDiagnosticGateInput): PainDiagnosticGateDecision {
  const source = normalizedSource(input.source);
  const episodeKey = buildEpisodeKey(input);
  const painTrigger = input.thresholds?.painTrigger ?? 40;
  const highSeverity = input.thresholds?.highSeverity ?? 70;
  const highGfi = input.thresholds?.highGfi ?? Math.max(highSeverity, painTrigger + 30);
  const repeatedFailure = input.thresholds?.repeatedFailure ?? 4;
  const semanticPain = input.thresholds?.semanticPain ?? Math.max(painTrigger, 60);
  const score = Number.isFinite(input.score) ? input.score : 0;
  const currentGfi = Number.isFinite(input.currentGfi) ? input.currentGfi : 0;
  const consecutiveErrors: number = Number.isFinite(input.consecutiveErrors) ? (input.consecutiveErrors as number) : 0;

  const approve = (reason: PainDiagnosticGateReason, detail: string): PainDiagnosticGateDecision => {
    if (withinCooldown(input, episodeKey)) {
      return {
        shouldDiagnose: false,
        reason: 'cooldown',
        episodeKey,
        detail: `recently diagnosed; ${detail}`,
      };
    }
    markDiagnosed(input, episodeKey);
    return { shouldDiagnose: true, reason, episodeKey, detail };
  };

  if (source === 'manual') {
    return approve('manual', 'manual pain signal bypasses automatic gate');
  }

  if (source === 'subagent_error' && score >= painTrigger) {
    return approve('subagent_error', `subagent error score ${score} >= ${painTrigger}`);
  }

  if (source === 'llm_paralysis' && score >= painTrigger) {
    return approve('llm_paralysis', `llm paralysis score ${score} >= ${painTrigger}`);
  }

  if ((source === 'user_empathy' || source === 'semantic') && score >= semanticPain) {
    return approve('semantic_pain', `semantic pain score ${score} >= ${semanticPain}`);
  }

  if (input.isRisky === true && score >= highSeverity) {
    return approve('risky_high_score', `risky operation score ${score} >= ${highSeverity}`);
  }

  if (consecutiveErrors >= repeatedFailure) {
    return approve('repeated_failure', `consecutive errors ${consecutiveErrors} >= ${repeatedFailure}`);
  }

  if (currentGfi >= highGfi) {
    return approve('high_gfi', `GFI ${currentGfi.toFixed(1)} >= ${highGfi}`);
  }

  return {
    shouldDiagnose: false,
    reason: 'below_gate',
    episodeKey,
    detail: `score=${score}; gfi=${currentGfi.toFixed(1)}; consecutive=${consecutiveErrors}`,
  };
}
