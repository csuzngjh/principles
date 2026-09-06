export type TaskPriority = "needs_confirmation" | "suggested_attention" | "recent_activity";

export type TaskKind = "approval" | "cleanup" | "completed";

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
  status: "healthy" | "attention" | "problem";
  principleTotal: number;
  principleActive: number;
  principlePending: number;
  weeklyChange: number;
}

export interface ActivityEvent {
  id: string;
  type: "error" | "learned" | "approved";
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
  | { success: false; error: string; reason?: string; nextAction?: string; status?: number };
