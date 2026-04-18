/**
 * Ledger Registrar (Task 4)
 *
 * Registers a compiled rule into the principle tree ledger:
 * 1. Creates a LedgerRule with type 'gate', enforcement 'block', status 'proposed'
 * 2. Creates an Implementation with type 'code', lifecycleState 'active'
 *
 * IDEMPOTENCY: If the rule already exists, returns existing registration.
 * ROLLBACK: If implementation creation fails after rule creation, attempts cleanup.
 */

import { createRule, createImplementation, loadLedger, deleteRule, type LedgerRule } from '../principle-tree-ledger.js';

export interface RegisterInput {
  principleId: string;
  codeContent: string;
  coversCondition: string;
}

export interface RegisterResult {
  success: boolean;
  ruleId: string;
  implementationId: string;
  codePath: string;
}

/**
 * Register a compiled rule for a principle in the ledger.
 *
 * Idempotent: if rule already exists, returns existing registration.
 * Atomic: if implementation creation fails, rolls back the rule.
 */
export function registerCompiledRule(stateDir: string, input: RegisterInput): RegisterResult {
  const { principleId, codeContent, coversCondition } = input;

  const ruleId = `R_${principleId}_auto`;
  const implementationId = `IMPL_${principleId}_auto`;
  const codePath = `compiled-rules/${principleId}/rule.ts`;

  // Idempotency: skip if rule already exists
  const existingLedger = loadLedger(stateDir);
  if (existingLedger.tree.rules[ruleId]) {
    const existingRule = existingLedger.tree.rules[ruleId];
    return {
      success: true,
      ruleId,
      implementationId: existingRule.implementationIds[0] ?? implementationId,
      codePath,
    };
  }

  const now = new Date().toISOString();

  // Step 1: Create the rule
  // FIX: Auto-generated rules default to 'warn' enforcement (not 'block') until:
  // - replay evaluation passes
  // - coverage confirmation
  // - human approval
  // This prevents P_001-style false positives from blocking normal edits.
  const rule: LedgerRule = {
    id: ruleId,
    version: 1,
    name: `Auto-compiled rule for ${principleId}`,
    description: `Automatically compiled gate rule generated from principle ${principleId}`,
    type: 'gate',
    triggerCondition: coversCondition,
    enforcement: 'warn',
    action: codeContent,
    principleId,
    status: 'proposed',
    coverageRate: 0,
    falsePositiveRate: 0,
    implementationIds: [],
    createdAt: now,
    updatedAt: now,
  };

  createRule(stateDir, rule);

  // Step 2: Create the implementation (with rollback on failure)
  try {
    const implementation = {
      id: implementationId,
      ruleId,
      type: 'code' as const,
      path: codePath,
      version: '1',
      coversCondition,
      coveragePercentage: 100,
      // FIX: Start as 'candidate' instead of 'active'.
      // RuleHost only loads lifecycleState='active' implementations.
      // This means auto-generated rules will NOT block until explicitly
      // promoted to 'active' after replay evaluation + human approval.
      lifecycleState: 'candidate' as const,
      createdAt: now,
      updatedAt: now,
    };

    createImplementation(stateDir, implementation);
  } catch (implError) {
    // Rollback: remove the orphaned rule
    try {
      deleteRule(stateDir, ruleId);
    } catch {
      // Best-effort rollback — log but don't mask the original error
    }
    throw implError;
  }

  return {
    success: true,
    ruleId,
    implementationId,
    codePath,
  };
}
