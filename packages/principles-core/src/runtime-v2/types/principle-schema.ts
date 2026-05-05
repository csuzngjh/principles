/**
 * Principle tree schema — rich domain model interfaces.
 * Extracted from openclaw-plugin principle-tree-schema.ts (PRI-51).
 * These are the full-featured versions matching the plugin's schema,
 * used by lifecycle computation modules (PRI-52/53/54).
 */
import type {
  PrincipleStatus,
  PrinciplePriority,
  PrincipleScope,
  PrincipleEvaluability,
  RuleStatus,
  RuleType,
  ImplementationLifecycleState,
  ImplementationType,
} from './principle-enums.js';

export interface Principle {
  id: string;
  version: number;
  text: string;
  coreAxiomId?: string;
  triggerPattern: string;
  action: string;
  status: PrincipleStatus;
  priority: PrinciplePriority;
  scope: PrincipleScope;
  domain?: string;
  evaluability: PrincipleEvaluability;
  valueScore: number;
  adherenceRate: number;
  painPreventedCount: number;
  lastPainPreventedAt?: string;
  derivedFromPainIds: string[];
  ruleIds: string[];
  conflictsWithPrincipleIds: string[];
  supersedesPrincipleId?: string;
  createdAt: string;
  updatedAt: string;
  deprecatedAt?: string;
  deprecatedReason?: string;
  compilationRetryCount?: number;
}

export interface Rule {
  id: string;
  version: number;
  name: string;
  description: string;
  type: RuleType;
  triggerCondition: string;
  enforcement: 'block' | 'warn' | 'log';
  action: string;
  principleId: string;
  parentRuleId?: string;
  status: RuleStatus;
  coverageRate: number;
  falsePositiveRate: number;
  implementationPath?: string;
  testPath?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Implementation {
  id: string;
  ruleId: string;
  type: ImplementationType;
  path: string;
  version: string;
  coversCondition: string;
  coveragePercentage: number;
  lifecycleState: ImplementationLifecycleState;
  previousActive?: string;
  disabledAt?: string;
  disabledBy?: string;
  disabledReason?: string;
  archivedAt?: string;
  createdAt: string;
  updatedAt: string;
}
