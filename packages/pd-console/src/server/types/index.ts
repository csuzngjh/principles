export type TaskPriority = 'needs_confirmation' | 'suggested_attention' | 'recent_activity';

export type TaskKind = 'approval' | 'cleanup' | 'completed';

export interface TaskItem {
  id: string;
  title: string;
  sourceSummary: string;
  priority: TaskPriority;
  kind: TaskKind;
  createdAt: string;
  lastTriggeredAt?: string;
  triggerCount?: number;
  confidence?: number;
  severity?: string;
  recommendationKind?: string;
  status?: string;
  attemptCount?: number;
  maxAttempts?: number;
}

export interface EvidenceItem {
  timestamp: string;
  operation: string;
  problem: string;
}

export interface DiagnosisOutput {
  rootCause: string;
  confidence: number;
  violatedPrinciples: { principleId?: string; title?: string; rationale: string }[];
  evidenceChain: { sourceRef: string; note: string }[];
  recommendations: { kind: string; description: string; triggerPattern?: string; action?: string; abstractedPrinciple?: string }[];
  ambiguityNotes: string[];
}

export interface DiagnosisInput {
  reasonSummary: string;
  source: string;
  severity: string;
  painId?: string;
  sessionId?: string;
}

export interface TaskEvidence {
  taskId: string;
  summary: string;
  why: string;
  whatHappensIf: string;
  evidence: EvidenceItem[];
  diagnosis?: DiagnosisOutput;
  input?: DiagnosisInput;
}

export interface SystemStatus {
  status: 'healthy' | 'attention' | 'problem';
  principleTotal: number;
  principleActive: number;
  principlePending: number;
  weeklyChange: number;
}

export interface ActivityEvent {
  id: string;
  type: 'error' | 'learned' | 'approved';
  description: string;
  timestamp: string;
}

export interface TaskZones {
  needsConfirmation: TaskItem[];
  suggestedAttention: TaskItem[];
  recentActivity: TaskItem[];
}

export type ApiResponse<T> =
  | { success: true; data: T }
  | { success: false; error: string };

export interface WorkspaceEntry {
  name: string;
  path: string;
  lastSync: string | null;
  config: WorkspaceConfig | null;
}

export interface WorkspaceConfig {
  workspaceName: string;
  enabled: boolean;
  displayName: string | null;
  syncEnabled: boolean;
}

export interface SyncResult {
  success: boolean;
  syncedAt: string;
  items: Record<string, number>;
}

export interface GateBlockItem {
  timestamp: string;
  toolName: string;
  filePath: string | null;
  reason: string;
  gateType: 'gfi' | 'stage' | 'p03' | 'other';
  gfi: number;
  trustStage: number;
}

export interface EmpathyEvent {
  timestamp: string;
  severity: 'low' | 'medium' | 'high';
  score: number;
  reason: string;
  origin: string;
  gfiAfter: number;
}

export interface SamplePreview {
  sampleId: string;
  sessionId: string;
  qualityScore: number;
  reviewStatus: string;
  createdAt: string;
}

export interface SampleListItem {
  sampleId: string;
  taskId: string;
  title: string;
  description: string;
  reviewStatus: 'pending' | 'approved' | 'rejected';
  confidence: number | null;
  createdAt: string;
}

export interface SampleDetail {
  sampleId: string;
  taskId: string;
  title: string;
  description: string;
  reviewStatus: 'pending' | 'approved' | 'rejected';
  confidence: number | null;
  createdAt: string;
  artifactContent: unknown;
  recommendation: {
    title?: string;
    text?: string;
    triggerPattern?: string;
    action?: string;
    abstractedPrinciple?: string;
  } | null;
}

export interface SamplesListOutput {
  counters: Record<string, number>;
  items: SampleListItem[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
}

export interface SampleReviewInput {
  decision: 'approved' | 'rejected';
  note?: string;
}

export interface EventLogEntry {
  id?: string;
  ts: string;
  date: string;
  type: string;
  category: string;
  sessionId?: string;
  data: Record<string, unknown>;
}

export interface GateBlockEvent extends EventLogEntry {
  type: 'gate_block';
  data: {
    toolName: string;
    filePath: string;
    reason: string;
    blockSource?: string;
  };
}

export interface EmpathyEventLogEntry extends EventLogEntry {
  type: 'empathy_rollback' | 'user_empathy';
  data: {
    score?: number;
    reason?: string;
    origin?: string;
  };
}

export interface OverviewHealthOutput {
  status: 'healthy' | 'degraded' | 'error';
  gfi: {
    current: number;
    stage: string;
    peakToday: number;
    threshold: number;
  };
  trust: {
    stage: number;
    score: number;
  };
  principles: {
    candidate: number;
    probation: number;
    active: number;
    deprecated: number;
  };
  queue: {
    pending: number;
    inProgress: number;
    completed: number;
  };
}

export interface OverviewOutput {
  workspaceDir: string;
  generatedAt: string;
  dataFreshness: 'fresh' | 'stale' | 'error';

  summary: {
    repeatErrorRate: number;
    userCorrectionRate: number;
    pendingSamples: number;
    approvedSamples: number;
    painEvents: number;
    principleEventCount: number;
    gateBlocks: number;
    taskOutcomes: number;
  };

  health: OverviewHealthOutput;

  dailyTrend: {
    day: string;
    toolCalls: number;
    failures: number;
    userCorrections: number;
    painEvents: number;
  }[];

  topRegressions: {
    toolName: string;
    errorType: string;
    occurrences: number;
  }[];

  sampleQueue: {
    counters: Record<string, number>;
    preview: SamplePreview[];
  };
}
