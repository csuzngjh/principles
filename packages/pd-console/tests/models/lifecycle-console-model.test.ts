/**
 * LifecycleConsoleModel Tests — PRI-CR7
 *
 * Tests for the lifecycle metrics data model:
 * - Returns null when principle not found
 * - Returns correct adherence metrics when principle exists
 * - Handles insufficient data (no rules) correctly
 * - Computes rule metrics from replay evidence
 *
 * ERR entries:
 * - ERR-002: Graceful degradation includes reason (note field)
 * - ERR-001/005: No `as` bypasses on untrusted data
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { LifecycleConsoleModel } from '../../src/server/models/LifecycleConsoleModel.js';

// ── Test Setup ───────────────────────────────────────────────────────────────

let tempDir: string;
let workspaceDir: string;
let stateDir: string;
let model: LifecycleConsoleModel;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-lifecycle-model-test-'));
  workspaceDir = path.join(tempDir, 'workspace');
  stateDir = path.join(workspaceDir, '.state');
  fs.mkdirSync(stateDir, { recursive: true });
  model = new LifecycleConsoleModel(workspaceDir);
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ── Helper to create ledger ───────────────────────────────────────────────────

function createLedger(content: object): void {
  fs.writeFileSync(
    path.join(stateDir, 'principle_training_state.json'),
    JSON.stringify(content)
  );
}

// ── Missing Principle Handling ────────────────────────────────────────────────

describe('LifecycleConsoleModel — missing principle handling', () => {
  it('returns null when ledger does not exist', () => {
    const result = model.getLifecycleMetrics('principle-001');
    expect(result).toBeNull();
  });

  it('returns null when principle not found in ledger', () => {
    // Create ledger with a different principle
    createLedger({
      _tree: {
        principles: {
          'principle-002': {
            id: 'principle-002',
            text: 'Test Principle',
            ruleIds: [],
          },
        },
        rules: {},
        implementations: {},
        metrics: {},
        lastUpdated: new Date().toISOString(),
      },
    });

    const result = model.getLifecycleMetrics('principle-001');
    expect(result).toBeNull();
  });

  it('returns null for empty principleId', () => {
    createLedger({
      _tree: {
        principles: {
          'principle-001': {
            id: 'principle-001',
            text: 'Test Principle',
            ruleIds: [],
          },
        },
        rules: {},
        implementations: {},
        metrics: {},
        lastUpdated: new Date().toISOString(),
      },
    });

    const result = model.getLifecycleMetrics('');
    expect(result).toBeNull();
  });
});

// ── Metrics Computation ──────────────────────────────────────────────────────

describe('LifecycleConsoleModel — metrics computation', () => {
  it('returns insufficientData when principle has no rules', () => {
    createLedger({
      _tree: {
        principles: {
          'principle-001': {
            id: 'principle-001',
            text: 'Test Principle',
            ruleIds: [], // Empty rules
          },
        },
        rules: {},
        implementations: {},
        metrics: {},
        lastUpdated: new Date().toISOString(),
      },
    });

    const result = model.getLifecycleMetrics('principle-001');
    
    expect(result).not.toBeNull();
    expect(result?.principleId).toBe('principle-001');
    expect(result?.adherence.insufficientData).toBe(true);
    expect(result?.adherence.rate).toBeNull();
    expect(result?.adherence.note).toContain('尚无规则');
    expect(result?.ruleMetrics).toEqual([]);
  });

  it('handles empty replay reports directory', () => {
    createLedger({
      _tree: {
        principles: {
          'principle-001': {
            id: 'principle-001',
            text: 'Test Principle',
            ruleIds: ['rule-001'],
          },
        },
        rules: {
          'rule-001': {
            id: 'rule-001',
            principleId: 'principle-001',
            implementationIds: ['impl-001'],
          },
        },
        implementations: {
          'impl-001': {
            id: 'impl-001',
            ruleId: 'rule-001',
            lifecycleState: 'active',
          },
        },
        metrics: {},
        lastUpdated: new Date().toISOString(),
      },
    });
    
    // Create empty replay reports directory
    const replayDir = path.join(
      stateDir, 'principles', 'implementations', 'impl-001', 'replays'
    );
    fs.mkdirSync(replayDir, { recursive: true });

    const result = model.getLifecycleMetrics('principle-001');
    
    expect(result).not.toBeNull();
    expect(result?.ruleMetrics).toHaveLength(1);
    expect(result?.ruleMetrics[0].triggered).toBe(0);
    expect(result?.ruleMetrics[0].lastTriggeredAt).toBeNull();
  });

  it('handles principle with multiple rules', () => {
    createLedger({
      _tree: {
        principles: {
          'principle-001': {
            id: 'principle-001',
            text: 'Test Principle',
            ruleIds: ['rule-001', 'rule-002'],
          },
        },
        rules: {
          'rule-001': {
            id: 'rule-001',
            principleId: 'principle-001',
            implementationIds: ['impl-001'],
          },
          'rule-002': {
            id: 'rule-002',
            principleId: 'principle-001',
            implementationIds: ['impl-002'],
          },
        },
        implementations: {
          'impl-001': {
            id: 'impl-001',
            ruleId: 'rule-001',
            lifecycleState: 'active',
          },
          'impl-002': {
            id: 'impl-002',
            ruleId: 'rule-002',
            lifecycleState: 'candidate',
          },
        },
        metrics: {},
        lastUpdated: new Date().toISOString(),
      },
    });

    const result = model.getLifecycleMetrics('principle-001');
    
    expect(result).not.toBeNull();
    expect(result?.ruleMetrics).toHaveLength(2);
    
    const rule1 = result?.ruleMetrics.find(r => r.ruleId === 'rule-001');
    expect(rule1).toBeDefined();
    
    const rule2 = result?.ruleMetrics.find(r => r.ruleId === 'rule-002');
    expect(rule2).toBeDefined();
  });

  it('returns null for malformed ledger (principles is null)', () => {
    // parsePrinciples will return {} for null principles
    createLedger({
      _tree: {
        principles: null,
        rules: {},
        implementations: {},
        metrics: {},
        lastUpdated: new Date().toISOString(),
      },
    });

    // Should return null because principle-001 won't be found
    const result = model.getLifecycleMetrics('principle-001');
    expect(result).toBeNull();
  });

  it('returns null for malformed ledger (missing _tree)', () => {
    // Missing _tree key - loadLedger will return empty tree
    createLedger({
      invalid: true,
    });

    const result = model.getLifecycleMetrics('principle-001');
    expect(result).toBeNull();
  });
});