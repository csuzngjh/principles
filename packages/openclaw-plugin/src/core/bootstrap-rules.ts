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

import { loadLedger, createRule, updatePrinciple, addPrincipleToLedger } from './principle-tree-ledger.js';
import type { LedgerPrinciple } from './principle-tree-ledger.js';
import { loadStore, saveStore } from './principle-training-state.js';
import { CORE_THINKING_MODELS } from './init.js';

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
    const err = new Error('No deterministic principles found in training store');
    (err as Error & { code?: string }).code = 'NO_DETERMINISTIC_PRINCIPLES';
    throw err;
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

  // Phase 7.2 P2-02 — deduplicate by CANONICAL principleId BEFORE the limit:
  // several legacy T-NN training entries may legitimately converge on one
  // ledger survivor, and one canonical principle bootstraps at most one stub.
  const distinct: string[] = [];
  const seen = new Set<string>();
  for (const entry of sorted) {
    if (seen.has(entry.principleId)) continue;
    seen.add(entry.principleId);
    distinct.push(entry.principleId);
  }

  // Return top N
  return distinct.slice(0, limit);
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
  // Migration: if registry core axiom ids (T-NN) exist in Training Store but
  // not in Ledger Tree, backfill. This handles workspaces initialized before
  // Ledger Tree was added.
  //
  // Phase 7.2 P2-02 — the migration now uses the SURVIVOR each
  // addPrincipleToLedger call returns. When the ledger already contains a
  // principle with IDENTICAL text under a different id (a pre-dedup
  // workspace, or a candidate that reached the same axiom text), the T-NN
  // entry is NOT registered and the survivor wins: the training store entry
  // keeps its stable T-NN KEY (compatibility — evaluation data, lifecycle
  // state and every consumer keyed on T-NN survive untouched) while its
  // `principleId` points at the CANONICAL survivor id, so
  // selectPrinciplesForBootstrap can never again resolve a stale id
  // ("Principle T-01 not found in ledger tree"). Multiple old ids converging
  // on one survivor keep their own keys/rows — nothing is dropped — and the
  // selection below deduplicates by canonical principleId.
  const store = loadStore(stateDir);
  let ledger = loadLedger(stateDir);
  const tEntries = Object.entries(store).filter(([id]) => id.startsWith('T-'));
  const needsMigration = tEntries.some(([id, entry]) => {
    const canonical = entry.principleId || id;
    return !Object.hasOwn(ledger.tree.principles, canonical);
  });
  if (tEntries.length > 0 && needsMigration) {
    console.warn('[bootstrap] Migrating core axiom ids from Training Store to Ledger Tree (survivor-aware)');
    const now = new Date().toISOString();
    const nextStore = { ...store };
    for (const [id, entry] of tEntries) {
      const model = CORE_THINKING_MODELS.find((m) => m.id === id);
      if (!model) continue;
      const lp: LedgerPrinciple = {
        id,
        version: 1,
        text: model.description,
        coreAxiomId: id,
        triggerPattern: '',
        action: '',
        status: 'active',
        priority: 'P1',
        scope: 'general',
        evaluability: entry.evaluability,
        valueScore: 0,
        adherenceRate: 0,
        painPreventedCount: 0,
        derivedFromPainIds: [],
        ruleIds: [],
        conflictsWithPrincipleIds: [],
        createdAt: now,
        updatedAt: now,
        suggestedRules: [],
      };
      const survivor = addPrincipleToLedger(stateDir, lp);
      if (survivor.id !== id) {
        // Exact-duplicate guard resolved this T-NN onto the EXISTING
        // principle. The training store's LEGACY shape (ledger-codec
        // parseLegacyTrainingStore) requires entry key === principleId — a
        // key-stable redirect would be silently DROPPED on the next load — so
        // the entry is RE-KEYED onto the canonical survivor id with all of its
        // training data. The losing T-NN identity stays traceable through the
        // migration warning (and the survivor's own coreAxiomId when the
        // survivor is itself a T-NN). When several T-NN rows converge on ONE
        // survivor, the rows MERGE (counts sum, run/checkpoint lists union —
        // the selection-relevant facts) with an explicit warning: no row is
        // ever dropped silently (directive P2-02).
        const redirected = { ...entry, principleId: survivor.id };
        const existing = nextStore[survivor.id];
        if (existing !== undefined && existing !== entry) {
          console.warn(`[bootstrap] training rows ${Object.keys(nextStore).find((k) => nextStore[k] === existing)} and ${id} both converge on ${survivor.id}; merging (counts sum, lists union)`);
          nextStore[survivor.id] = {
            ...existing,
            applicableOpportunityCount: existing.applicableOpportunityCount + redirected.applicableOpportunityCount,
            observedViolationCount: existing.observedViolationCount + redirected.observedViolationCount,
            generatedSampleCount: existing.generatedSampleCount + redirected.generatedSampleCount,
            approvedSampleCount: existing.approvedSampleCount + redirected.approvedSampleCount,
            includedTrainRunIds: [...new Set([...existing.includedTrainRunIds, ...redirected.includedTrainRunIds])],
            deployedCheckpointIds: [...new Set([...existing.deployedCheckpointIds, ...redirected.deployedCheckpointIds])],
          };
        } else {
          nextStore[survivor.id] = redirected;
        }
        delete nextStore[id];
        console.warn(`[bootstrap] T-NN ${id} matched existing principle ${survivor.id} (identical text); training store entry re-keyed onto the canonical id (all training data preserved)`);
      } else if (!Object.hasOwn(nextStore, id)) {
        nextStore[id] = entry;
      }
    }
    saveStore(stateDir, nextStore);
    // Reload BOTH stores after migration so subsequent reads see the new data.
    ledger = loadLedger(stateDir);
  }

  // Select principles for bootstrap (internally deduplicated by canonical
  // principleId — see selectPrinciplesForBootstrap).
  const selectedPrincipleIds = selectPrinciplesForBootstrap(stateDir, limit);

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
    createRule(stateDir, {
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
