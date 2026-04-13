/**
 * Minimal Rule Bootstrap (Phase 17)
 *
 * Bootstraps 1-3 stub Rule entities for high-value deterministic principles.
 * Selected by: observedViolationCount (descending) + evaluability=deterministic.
 * Falls back to all deterministic principles if violation data is sparse.
 *
 * Rule ID format: {principleId}_stub_bootstrap
 * Scope: BOOT-03 — bounded, no mass migration, no implementations.
 *
 * Usage:
 *   npx vitest run tests/core/bootstrap-rules.test.ts   (tests)
 *   npm run bootstrap-rules                               (production)
 */

import { loadLedger, createRule, updatePrinciple } from './principle-tree-ledger.js';
import { loadStore } from './principle-training-state.js';

export interface BootstrapResult {
  principleId: string;
  ruleId: string;
  status: 'created' | 'skipped';
}

/**
 * Select principles for bootstrap based on violation count and evaluability.
 *
 * @param stateDir - State directory path
 * @param limit - Maximum number of principles to select (default: 3)
 * @returns Array of principle IDs sorted by observedViolationCount (descending)
 * @throws Error if no deterministic principles found
 */
export function selectPrinciplesForBootstrap(stateDir: string, limit = 3): string[] {
  // Load training store to get evaluability and violation data
  const store = loadStore(stateDir);

  // Filter for deterministic principles only
  const deterministicEntries = Object.values(store).filter(
    (entry) => entry.evaluability === 'deterministic'
  );

  if (deterministicEntries.length === 0) {
    throw new Error('No deterministic principles found in training store');
  }

  // Sort by observedViolationCount descending, then by principleId for tiebreaker
  const sorted = deterministicEntries.sort((a, b) => {
    const violationDiff = b.observedViolationCount - a.observedViolationCount;
    if (violationDiff !== 0) {
      return violationDiff;
    }
    // Alphabetical tiebreaker
    return a.principleId.localeCompare(b.principleId);
  });

  // Check if we have sparse violation data (all zeros or very low)
  const hasViolations = sorted.some((entry) => entry.observedViolationCount > 0);
  if (!hasViolations) {
    // Log warning and use all deterministic principles
    console.warn('[bootstrap] No violation data found, using all deterministic principles');
  }

  // Return top N
  return sorted.slice(0, limit).map((entry) => entry.principleId);
}

/**
 * Bootstrap stub rules for selected principles.
 *
 * Creates stub Rule entities with format {principleId}_stub_bootstrap.
 * Links rules to principles via suggestedRules array.
 * Idempotent: skips existing rules.
 *
 * @param stateDir - State directory path
 * @param limit - Maximum number of principles to bootstrap (default: 3)
 * @returns Array of results indicating created or skipped status
 * @throws Error if no deterministic principles found
 */
export function bootstrapRules(stateDir: string, limit = 3): BootstrapResult[] {
  // Select principles for bootstrap
  const selectedPrincipleIds = selectPrinciplesForBootstrap(stateDir, limit);

  // Load current ledger state
  const ledger = loadLedger(stateDir);

  const results: BootstrapResult[] = [];

  for (const principleId of selectedPrincipleIds) {
    // Verify principle exists in ledger
    const principle = ledger.tree.principles[principleId];
    if (!principle) {
      throw new Error(`Principle ${principleId} not found in ledger tree`);
    }

    // Compute rule ID
    const ruleId = `${principleId}_stub_bootstrap`;

    // Check if rule already exists
    if (ledger.tree.rules[ruleId]) {
      results.push({
        principleId,
        ruleId,
        status: 'skipped',
      });
      continue;
    }

    // Create stub rule
    const now = new Date().toISOString();
    const rule = createRule(stateDir, {
      id: ruleId,
      version: 1,
      name: `Stub bootstrap rule for ${principleId}`,
      description: `Placeholder rule for principle-internalization bootstrap`,
      type: 'hook',
      triggerCondition: 'stub: bootstrap placeholder',
      enforcement: 'warn',
      action: 'allow (stub)',
      principleId,
      status: 'proposed',
      coverageRate: 0,
      falsePositiveRate: 0,
      implementationIds: [],
      createdAt: now,
      updatedAt: now,
    });

    // Link rule to principle via suggestedRules
    const existingSuggested = principle.suggestedRules || [];
    updatePrinciple(stateDir, principleId, {
      suggestedRules: [...existingSuggested, ruleId],
    });

    results.push({
      principleId,
      ruleId,
      status: 'created',
    });
  }

  return results;
}

/**
 * Validate that bootstrapped state is correct.
 *
 * @param stateDir - State directory path
 * @param expectedPrincipleIds - Principle IDs that should be bootstrapped
 * @returns true if validation passes
 * @throws Error if validation fails
 */
export function validateBootstrap(stateDir: string, expectedPrincipleIds: string[]): boolean {
  const ledger = loadLedger(stateDir);

  for (const principleId of expectedPrincipleIds) {
    // Verify principle exists
    const principle = ledger.tree.principles[principleId];
    if (!principle) {
      throw new Error(`Principle ${principleId} not found in ledger tree`);
    }

    // Verify suggestedRules exists and is not empty
    if (!principle.suggestedRules || principle.suggestedRules.length === 0) {
      throw new Error(`Principle ${principleId} has empty or missing suggestedRules`);
    }

    // Verify each suggested rule exists in ledger
    for (const ruleId of principle.suggestedRules) {
      const rule = ledger.tree.rules[ruleId];
      if (!rule) {
        throw new Error(`Rule ${ruleId} referenced by principle ${principleId} not found in ledger`);
      }
    }
  }

  return true;
}
