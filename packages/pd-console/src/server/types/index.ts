export type TaskPriority = 'needs_confirmation' | 'suggested_attention' | 'recent_activity';

export type TaskKind = 'approval' | 'cleanup';

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
