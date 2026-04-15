/**
 * Ledger Registrar (Task 4)
 *
 * Registers a compiled rule into the principle tree ledger:
 * 1. Creates a LedgerRule with type 'gate', enforcement 'block', status 'proposed'
 * 2. Creates an Implementation with type 'code', lifecycleState 'candidate'
 *
 * Uses createRule() and createImplementation() from principle-tree-ledger
 * so linking (ruleIds, implementationIds) is handled automatically.
 */

import { createRule, createImplementation, type LedgerRule } from '../principle-tree-ledger.js';

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
 * Creates:
 * - Rule `R_{principleId}_auto` with type='gate', enforcement='block', status='proposed'
 * - Implementation `IMPL_{principleId}_auto` with type='code', lifecycleState='candidate'
 *
 * Throws if the principle does not exist (enforced by createRule).
 */
export function registerCompiledRule(stateDir: string, input: RegisterInput): RegisterResult {
  const { principleId, codeContent, coversCondition } = input;

  const ruleId = `R_${principleId}_auto`;
  const implementationId = `IMPL_${principleId}_auto`;
  const codePath = `compiled-rules/${principleId}/rule.ts`;

  const now = new Date().toISOString();

  // Step 1: Create the rule in the ledger (links to principle via createRule)
  const rule: LedgerRule = {
    id: ruleId,
    version: 1,
    name: `Auto-compiled rule for ${principleId}`,
    description: `Automatically compiled gate rule generated from principle ${principleId}`,
    type: 'gate',
    triggerCondition: coversCondition,
    enforcement: 'block',
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

  // Step 2: Create the implementation (links to rule via createImplementation)
  const implementation = {
    id: implementationId,
    ruleId,
    type: 'code' as const,
    path: codePath,
    version: '1',
    coversCondition,
    coveragePercentage: 100,
    lifecycleState: 'candidate' as const,
    createdAt: now,
    updatedAt: now,
  };

  createImplementation(stateDir, implementation);

  return {
    success: true,
    ruleId,
    implementationId,
    codePath,
  };
}
