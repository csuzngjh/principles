/**
 * ConsoleLifecycleDatasource Tests — PRI-CR8
 *
 * Tests for the lifecycle datasource:
 * - loadLedger returns empty tree when ledger file does not exist
 * - loadLedger returns valid ledger tree when file exists
 * - loadLedger returns empty tree for malformed ledger
 * - listReplayReports returns empty array when directory missing
 * - listReplayReports validates report structure
 * - listLineageRecords throws LineageSourceRetiredError
 *
 * ERR entries:
 * - ERR-002: Graceful degradation includes reason (note field)
 * - ERR-001/005: No `as` bypasses on untrusted data
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ConsoleLifecycleDatasource, LineageSourceRetiredError } from '../../src/server/models/ConsoleLifecycleDatasource.js';

// ── Test Setup ───────────────────────────────────────────────────────────────

let tempDir: string;
let workspaceDir: string;
let stateDir: string;
let datasource: ConsoleLifecycleDatasource;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-lifecycle-datasource-test-'));
  workspaceDir = path.join(tempDir, 'workspace');
  stateDir = path.join(workspaceDir, '.state');
  fs.mkdirSync(stateDir, { recursive: true });
  datasource = new ConsoleLifecycleDatasource(workspaceDir, stateDir);
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ── Ledger Loading ────────────────────────────────────────────────────────────

describe('ConsoleLifecycleDatasource — loadLedger', () => {
  it('returns empty tree when ledger file does not exist', () => {
    const result = datasource.loadLedger();
    
    // loadLedger returns empty tree when file doesn't exist
    expect(result).toBeDefined();
    expect(result.principles).toBeDefined();
    expect(Object.keys(result.principles)).toHaveLength(0);
  });

  it('returns valid ledger tree when file exists', () => {
    // The ledger file is principle_training_state.json
    const ledgerContent = {
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
    };
    
    fs.writeFileSync(
      path.join(stateDir, 'principle_training_state.json'),
      JSON.stringify(ledgerContent)
    );

    const result = datasource.loadLedger();
    
    expect(result).toBeDefined();
    expect(result.principles).toBeDefined();
    expect(result.principles['principle-001']).toBeDefined();
  });

  it('returns empty tree for malformed ledger (principles is null)', () => {
    // parsePrinciples will return {} for null principles
    const ledgerContent = {
      _tree: {
        principles: null,
        rules: {},
        implementations: {},
        metrics: {},
        lastUpdated: new Date().toISOString(),
      },
    };
    
    fs.writeFileSync(
      path.join(stateDir, 'principle_training_state.json'),
      JSON.stringify(ledgerContent)
    );

    const result = datasource.loadLedger();
    expect(result).toBeDefined();
    expect(result.principles).toBeDefined();
    expect(Object.keys(result.principles)).toHaveLength(0);
  });

  it('returns empty tree for malformed ledger (principles is array)', () => {
    // parsePrinciples will return {} for array principles
    const ledgerContent = {
      _tree: {
        principles: [],
        rules: {},
        implementations: {},
        metrics: {},
        lastUpdated: new Date().toISOString(),
      },
    };
    
    fs.writeFileSync(
      path.join(stateDir, 'principle_training_state.json'),
      JSON.stringify(ledgerContent)
    );

    const result = datasource.loadLedger();
    expect(result).toBeDefined();
    expect(result.principles).toBeDefined();
    expect(Object.keys(result.principles)).toHaveLength(0);
  });

  it('returns empty tree for malformed ledger (missing _tree)', () => {
    // Missing _tree key - loadLedger will return empty tree
    const ledgerContent = {
      invalid: true,
    };
    
    fs.writeFileSync(
      path.join(stateDir, 'principle_training_state.json'),
      JSON.stringify(ledgerContent)
    );

    const result = datasource.loadLedger();
    expect(result).toBeDefined();
    expect(result.principles).toBeDefined();
    expect(Object.keys(result.principles)).toHaveLength(0);
  });
});

// ── Replay Reports ────────────────────────────────────────────────────────────

describe('ConsoleLifecycleDatasource — listReplayReports', () => {
  it('returns empty array when replay directory does not exist', () => {
    const result = datasource.listReplayReports('impl-001');
    expect(result).toEqual([]);
  });

  it('returns empty array when replay directory is empty', () => {
    const replayDir = path.join(
      stateDir, 'principles', 'implementations', 'impl-001', 'replays'
    );
    fs.mkdirSync(replayDir, { recursive: true });

    const result = datasource.listReplayReports('impl-001');
    expect(result).toEqual([]);
  });

  it('returns valid replay reports sorted by date (most recent first)', () => {
    const replayDir = path.join(
      stateDir, 'principles', 'implementations', 'impl-001', 'replays'
    );
    fs.mkdirSync(replayDir, { recursive: true });
    
    // Create multiple replay reports
    const report1 = {
      implementationId: 'impl-001',
      overallDecision: 'pass',
      generatedAt: '2024-01-01T00:00:00Z',
    };
    const report2 = {
      implementationId: 'impl-001',
      overallDecision: 'fail',
      generatedAt: '2024-01-02T00:00:00Z',
    };
    
    fs.writeFileSync(
      path.join(replayDir, '2024-01-01T00-00-00.json'),
      JSON.stringify(report1)
    );
    fs.writeFileSync(
      path.join(replayDir, '2024-01-02T00-00-00.json'),
      JSON.stringify(report2)
    );

    const result = datasource.listReplayReports('impl-001');
    
    expect(result).toHaveLength(2);
    // Most recent first (sorted reverse)
    expect(result[0].generatedAt).toBe('2024-01-02T00:00:00Z');
    expect(result[1].generatedAt).toBe('2024-01-01T00:00:00Z');
  });

  it('filters out malformed replay reports', () => {
    const replayDir = path.join(
      stateDir, 'principles', 'implementations', 'impl-001', 'replays'
    );
    fs.mkdirSync(replayDir, { recursive: true });
    
    // Valid report
    const validReport = {
      implementationId: 'impl-001',
      overallDecision: 'pass',
      generatedAt: '2024-01-01T00:00:00Z',
    };
    
    // Malformed reports
    const missingImplId = {
      overallDecision: 'pass',
      generatedAt: '2024-01-01T00:00:00Z',
    };
    const missingDecision = {
      implementationId: 'impl-001',
      generatedAt: '2024-01-01T00:00:00Z',
    };
    const missingGeneratedAt = {
      implementationId: 'impl-001',
      overallDecision: 'pass',
    };
    
    fs.writeFileSync(
      path.join(replayDir, 'valid.json'),
      JSON.stringify(validReport)
    );
    fs.writeFileSync(
      path.join(replayDir, 'missing-impl.json'),
      JSON.stringify(missingImplId)
    );
    fs.writeFileSync(
      path.join(replayDir, 'missing-decision.json'),
      JSON.stringify(missingDecision)
    );
    fs.writeFileSync(
      path.join(replayDir, 'missing-date.json'),
      JSON.stringify(missingGeneratedAt)
    );

    const result = datasource.listReplayReports('impl-001');
    
    // Only the valid report should be returned
    expect(result).toHaveLength(1);
    expect(result[0].implementationId).toBe('impl-001');
  });

  it('handles non-JSON files gracefully', () => {
    const replayDir = path.join(
      stateDir, 'principles', 'implementations', 'impl-001', 'replays'
    );
    fs.mkdirSync(replayDir, { recursive: true });
    
    // Create a non-JSON file
    fs.writeFileSync(
      path.join(replayDir, 'not-json.json'),
      'this is not json'
    );

    // Should not throw, returns empty array (parse error caught)
    const result = datasource.listReplayReports('impl-001');
    expect(result).toEqual([]);
  });

  it('handles non-object JSON content', () => {
    const replayDir = path.join(
      stateDir, 'principles', 'implementations', 'impl-001', 'replays'
    );
    fs.mkdirSync(replayDir, { recursive: true });
    
    // Create JSON files with non-object content
    fs.writeFileSync(
      path.join(replayDir, 'array.json'),
      JSON.stringify([1, 2, 3])
    );
    fs.writeFileSync(
      path.join(replayDir, 'string.json'),
      JSON.stringify('just a string')
    );
    fs.writeFileSync(
      path.join(replayDir, 'null.json'),
      JSON.stringify(null)
    );

    const result = datasource.listReplayReports('impl-001');
    expect(result).toEqual([]);
  });
});

// ── Lineage Records ───────────────────────────────────────────────────────────

describe('ConsoleLifecycleDatasource — listLineageRecords', () => {
  it('throws LineageSourceRetiredError for behavioral-sample', () => {
    expect(() => datasource.listLineageRecords('behavioral-sample')).toThrow(LineageSourceRetiredError);
  });

  it('throws LineageSourceRetiredError for rule-implementation-candidate', () => {
    expect(() => datasource.listLineageRecords('rule-implementation-candidate')).toThrow(LineageSourceRetiredError);
  });

  it('LineageSourceRetiredError has correct message', () => {
    try {
      datasource.listLineageRecords('behavioral-sample');
    } catch (err) {
      expect(err).toBeInstanceOf(LineageSourceRetiredError);
      expect((err as Error).message).toContain('PRI-230');
      expect((err as Error).message).toContain('nocturnal-artifact-lineage');
    }
  });
});