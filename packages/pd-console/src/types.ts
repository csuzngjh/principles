export type TaskPriority = "needs_confirmation" | "suggested_attention" | "recent_activity";

export type TaskKind = "approval" | "cleanup";

export interface TaskItem {
  id: string;
  title: string;
  sourceSummary: string;
  priority: TaskPriority;
  kind: TaskKind;
  createdAt: string;
  lastTriggeredAt?: string;
  triggerCount?: number;
}

export interface EvidenceItem {
  timestamp: string;
  operation: string;
  problem: string;
}

export interface TaskEvidence {
  taskId: string;
  summary: string;
  why: string;
  whatHappensIf: string;
  evidence: EvidenceItem[];
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

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}
