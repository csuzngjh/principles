export type GfiSource =
  | 'tool_failure'
  | 'dispatch_error'
  | 'user_empathy'
  | 'manual_pain'
  | 'correction_cue'
  | 'llm_paralysis'
  | 'gate_block'
  | 'unknown';

export type GfiStage = 'stable' | 'elevated' | 'critical' | 'saturated';

export interface GfiState {
  currentGfi: number;
  gfiBySource: Record<string, number>;
  lastErrorHash?: string;
  lastErrorSource?: string;
  consecutiveErrors: number;
  lastGfiDecayAt?: number;
  dailyGfiPeak?: number;
}

export interface GfiPolicy {
  stageThresholds: { elevated: number; critical: number; saturated: number };
  repeatedFailureMultiplier: { base: number; max: number };
  decayRatesPerMinute: { stable: number; elevated: number; critical: number; saturated: number };
  relief: { toolSuccessRatio: number; minPruneBelow: number };
  sourceWeights: Partial<Record<GfiSource, number>>;
}

export interface GfiEvent {
  source: GfiSource;
  baseScore: number;
  hash?: string;
  at?: number;
  detail?: string;
}

export interface GfiSnapshot {
  currentGfi: number;
  stage: GfiStage;
  sources: Record<string, number>;
  dominantSource: string | null;
  consecutiveErrors: number;
  lastErrorSource?: string;
  lastDecayAt?: string;
  dailyGfiPeak?: number;
  policy: {
    elevatedThreshold: number;
    criticalThreshold: number;
    saturatedThreshold: number;
    repeatedFailureMultiplierMax: number;
  };
  consumers: {
    attitudeMode: 'efficient' | 'conciliatory' | 'humble_recovery';
    painDiagnosticReason: 'none' | 'high_gfi';
  };
}