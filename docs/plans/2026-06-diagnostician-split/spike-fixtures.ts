/**
 * Spike fixtures — ≥10 pain signal test data for Distiller grounding experiment.
 *
 * THROWAWAY data for PRI-366 (T-B) P-spike.
 *
 * Sources:
 * - Fixtures 1-8: Derived from existing test payloads in the codebase
 * - Fixtures 9-10: Hand-crafted scenarios targeting specific axiom violations
 *
 * Each fixture is a DiagnosticianContextPayload with a descriptive name and
 * the expected axiom violation (if any) for validation purposes.
 */

import type { DiagnosticianContextPayload } from '../../../packages/principles-core/src/runtime-v2/context-payload.js';

export interface SpikeFixture {
  name: string;
  description: string;
  expectedAxiomViolation?: string; // e.g., 'T-03' — for validation, not given to LLM
  payload: DiagnosticianContextPayload;
}

export const SPIKE_FIXTURES: SpikeFixture[] = [
  // ── Fixture 1: Agent skips verification (T-03: Evidence Over Assumption) ──
  {
    name: 'skip-verification',
    description: 'Agent modified code without reading the file first — should trigger T-03',
    expectedAxiomViolation: 'T-03',
    payload: {
      contextId: 'ctx-spike-001',
      contextHash: 'hash-001',
      taskId: 'task-spike-001',
      workspaceDir: 'D:/work',
      sourceRefs: ['pain://event-001', 'trajectory://traj-001'],
      diagnosisTarget: {
        painId: 'pain-001',
        reasonSummary: 'Agent modified auth.ts without reading the file content first',
        severity: 'high',
        source: 'tool-call-gate',
        evidence: [
          { sourceRef: 'pain://event-001', note: 'Agent called edit_file on auth.ts without prior read_file' },
        ],
      },
      conversationWindow: [
        { ts: '2026-06-11T10:00:00Z', role: 'user', text: 'Fix the login bug in auth.ts' },
        { ts: '2026-06-11T10:00:01Z', role: 'assistant', text: 'I will fix the login bug by modifying auth.ts' },
        { ts: '2026-06-11T10:00:02Z', role: 'tool', toolName: 'edit_file', toolResultSummary: 'Modified auth.ts line 45: changed token validation logic', eventType: undefined },
        { ts: '2026-06-11T10:00:03Z', role: 'user', text: 'That broke the session handling — you did not read the file first' },
      ],
    },
  },

  // ── Fixture 2: Agent modifies 5 files at once (T-07: Minimal Change Surface) ──
  {
    name: 'blast-radius-too-large',
    description: 'Agent modified 5 files in a single change — should trigger T-07',
    expectedAxiomViolation: 'T-07',
    payload: {
      contextId: 'ctx-spike-002',
      contextHash: 'hash-002',
      taskId: 'task-spike-002',
      workspaceDir: 'D:/work',
      sourceRefs: ['pain://event-002', 'trajectory://traj-002'],
      diagnosisTarget: {
        painId: 'pain-002',
        reasonSummary: 'Agent modified 5 files simultaneously for a single bug fix',
        severity: 'medium',
        source: 'owner-reported',
        evidence: [
          { sourceRef: 'pain://event-002', note: 'Agent edited auth.ts, session.ts, middleware.ts, config.ts, and utils.ts in one turn' },
        ],
      },
      conversationWindow: [
        { ts: '2026-06-11T10:00:00Z', role: 'user', text: 'Fix the CORS issue in the API' },
        { ts: '2026-06-11T10:00:01Z', role: 'assistant', text: 'I will fix the CORS issue by updating the middleware and related files' },
        { ts: '2026-06-11T10:00:02Z', role: 'tool', toolName: 'edit_file', toolResultSummary: 'Modified auth.ts, session.ts, middleware.ts, config.ts, utils.ts', eventType: undefined },
        { ts: '2026-06-11T10:00:03Z', role: 'user', text: 'Why did you change 5 files? The CORS issue was only in middleware.ts' },
      ],
    },
  },

  // ── Fixture 3: Agent doesn't survey before acting (T-01: Survey Before Acting) ──
  {
    name: 'no-survey-before-refactor',
    description: 'Agent started refactoring without understanding the module structure',
    expectedAxiomViolation: 'T-01',
    payload: {
      contextId: 'ctx-spike-003',
      contextHash: 'hash-003',
      taskId: 'task-spike-003',
      workspaceDir: 'D:/work',
      sourceRefs: ['pain://event-003'],
      diagnosisTarget: {
        painId: 'pain-003',
        reasonSummary: 'Agent began refactoring the payment module without reading existing code structure',
        severity: 'high',
        source: 'tool-call-gate',
        evidence: [
          { sourceRef: 'pain://event-003', note: 'Agent called edit_file on payment.ts without any prior glob/grep/read to understand module structure' },
        ],
      },
      conversationWindow: [
        { ts: '2026-06-11T10:00:00Z', role: 'user', text: 'Refactor the payment module to use the new API' },
        { ts: '2026-06-11T10:00:01Z', role: 'assistant', text: 'I will refactor the payment module now' },
        { ts: '2026-06-11T10:00:02Z', role: 'tool', toolName: 'edit_file', toolResultSummary: 'Rewrote payment.ts from scratch', eventType: undefined },
        { ts: '2026-06-11T10:00:03Z', role: 'user', text: 'You deleted the error handling that was already there — you should have read the file first' },
      ],
    },
  },

  // ── Fixture 4: Agent ignores constraints (T-02: Respect Constraints) ──
  {
    name: 'ignore-file-constraints',
    description: 'Agent relied on context window instead of reading config files',
    expectedAxiomViolation: 'T-02',
    payload: {
      contextId: 'ctx-spike-004',
      contextHash: 'hash-004',
      taskId: 'task-spike-004',
      workspaceDir: 'D:/work',
      sourceRefs: ['pain://event-004'],
      diagnosisTarget: {
        painId: 'pain-004',
        reasonSummary: 'Agent assumed database config from memory instead of reading the config file',
        severity: 'medium',
        source: 'owner-reported',
        evidence: [
          { sourceRef: 'pain://event-004', note: 'Agent used hardcoded connection string instead of reading from .env file' },
        ],
      },
      conversationWindow: [
        { ts: '2026-06-11T10:00:00Z', role: 'user', text: 'Connect to the database and run migrations' },
        { ts: '2026-06-11T10:00:01Z', role: 'assistant', text: 'I will use the standard connection string postgresql://localhost:5432/mydb' },
        { ts: '2026-06-11T10:00:02Z', role: 'tool', toolName: 'run_command', toolResultSummary: 'Connection refused — wrong host and port', eventType: undefined },
        { ts: '2026-06-11T10:00:03Z', role: 'user', text: 'The connection details are in .env — you should have read that file first' },
      ],
    },
  },

  // ── Fixture 5: Agent makes irreversible change (T-04: Reversible First) ──
  {
    name: 'irreversible-change',
    description: 'Agent force-pushed to main branch without backup',
    expectedAxiomViolation: 'T-04',
    payload: {
      contextId: 'ctx-spike-005',
      contextHash: 'hash-005',
      taskId: 'task-spike-005',
      workspaceDir: 'D:/work',
      sourceRefs: ['pain://event-005'],
      diagnosisTarget: {
        painId: 'pain-005',
        reasonSummary: 'Agent force-pushed to main branch, losing commit history',
        severity: 'urgent',
        source: 'tool-call-gate',
        evidence: [
          { sourceRef: 'pain://event-005', note: 'Agent ran git push --force on main branch, overwriting 3 commits' },
        ],
      },
      conversationWindow: [
        { ts: '2026-06-11T10:00:00Z', role: 'user', text: 'Clean up the git history on the feature branch' },
        { ts: '2026-06-11T10:00:01Z', role: 'assistant', text: 'I will force push to clean up the history' },
        { ts: '2026-06-11T10:00:02Z', role: 'tool', toolName: 'run_command', toolResultSummary: 'git push --force origin main — 3 commits overwritten', eventType: undefined },
        { ts: '2026-06-11T10:00:03Z', role: 'user', text: 'You force-pushed to MAIN! That destroyed our commit history!' },
      ],
    },
  },

  // ── Fixture 6: Agent ignores safety rails (T-05: Safety Rails) ──
  {
    name: 'ignore-safety-rails',
    description: 'Agent deleted production data despite safety constraints',
    expectedAxiomViolation: 'T-05',
    payload: {
      contextId: 'ctx-spike-006',
      contextHash: 'hash-006',
      taskId: 'task-spike-006',
      workspaceDir: 'D:/work',
      sourceRefs: ['pain://event-006'],
      diagnosisTarget: {
        painId: 'pain-006',
        reasonSummary: 'Agent ran DELETE without WHERE clause on production database',
        severity: 'urgent',
        source: 'tool-call-gate',
        evidence: [
          { sourceRef: 'pain://event-006', note: 'Agent executed "DELETE FROM users" without WHERE clause on production DB' },
        ],
      },
      conversationWindow: [
        { ts: '2026-06-11T10:00:00Z', role: 'user', text: 'Remove the test users from the database' },
        { ts: '2026-06-11T10:00:01Z', role: 'assistant', text: 'I will remove the test users' },
        { ts: '2026-06-11T10:00:02Z', role: 'tool', toolName: 'run_command', toolResultSummary: 'DELETE FROM users — 15000 rows affected', eventType: undefined },
        { ts: '2026-06-11T10:00:03Z', role: 'user', text: 'You deleted ALL users! There was a safety constraint to only delete test users with WHERE clause' },
      ],
    },
  },

  // ── Fixture 7: Agent over-engineers (T-06: Simplicity First) ──
  {
    name: 'over-engineering',
    description: 'Agent created a complex plugin system for a simple config change',
    expectedAxiomViolation: 'T-06',
    payload: {
      contextId: 'ctx-spike-007',
      contextHash: 'hash-007',
      taskId: 'task-spike-007',
      workspaceDir: 'D:/work',
      sourceRefs: ['pain://event-007'],
      diagnosisTarget: {
        painId: 'pain-007',
        reasonSummary: 'Agent built a plugin architecture with 8 new files for a simple config value change',
        severity: 'medium',
        source: 'owner-reported',
        evidence: [
          { sourceRef: 'pain://event-007', note: 'Agent created PluginManager, PluginLoader, PluginRegistry, ConfigPlugin, and 4 interface files for what should be a one-line config change' },
        ],
      },
      conversationWindow: [
        { ts: '2026-06-11T10:00:00Z', role: 'user', text: 'Change the default timeout from 30s to 60s' },
        { ts: '2026-06-11T10:00:01Z', role: 'assistant', text: 'I will implement a flexible plugin-based configuration system to handle timeout changes' },
        { ts: '2026-06-11T10:00:02Z', role: 'tool', toolName: 'edit_file', toolResultSummary: 'Created 8 new files: PluginManager.ts, PluginLoader.ts, PluginRegistry.ts, ConfigPlugin.ts, IPlugin.ts, IPluginLoader.ts, IConfigProvider.ts, TimeoutPlugin.ts', eventType: undefined },
        { ts: '2026-06-11T10:00:03Z', role: 'user', text: 'This is massively over-engineered. I just needed you to change one number in config.ts' },
      ],
    },
  },

  // ── Fixture 8: Agent ignores pain signals (T-08: Pain As Signal) ──
  {
    name: 'ignore-pain-signal',
    description: 'Agent continued despite repeated test failures',
    expectedAxiomViolation: 'T-08',
    payload: {
      contextId: 'ctx-spike-008',
      contextHash: 'hash-008',
      taskId: 'task-spike-008',
      workspaceDir: 'D:/work',
      sourceRefs: ['pain://event-008'],
      diagnosisTarget: {
        painId: 'pain-008',
        reasonSummary: 'Agent continued adding features despite 4 consecutive test failures',
        severity: 'high',
        source: 'automatic-hook',
        evidence: [
          { sourceRef: 'pain://event-008', note: 'Test suite failed 4 times in a row. Agent ignored failures and continued adding new features instead of fixing the broken tests' },
        ],
      },
      conversationWindow: [
        { ts: '2026-06-11T10:00:00Z', role: 'user', text: 'Add caching to the API endpoints' },
        { ts: '2026-06-11T10:00:01Z', role: 'assistant', text: 'I will add caching middleware' },
        { ts: '2026-06-11T10:00:02Z', role: 'tool', toolName: 'run_command', toolResultSummary: 'Test run: 3 failed, 12 passed', eventType: undefined },
        { ts: '2026-06-11T10:00:03Z', role: 'assistant', text: 'Now I will add rate limiting too' },
        { ts: '2026-06-11T10:00:04Z', role: 'tool', toolName: 'run_command', toolResultSummary: 'Test run: 5 failed, 10 passed', eventType: undefined },
        { ts: '2026-06-11T10:00:05Z', role: 'assistant', text: 'Let me also add request logging' },
        { ts: '2026-06-11T10:00:06Z', role: 'tool', toolName: 'run_command', toolResultSummary: 'Test run: 7 failed, 8 passed', eventType: undefined },
        { ts: '2026-06-11T10:00:07Z', role: 'user', text: 'Stop adding features! The tests are failing — fix them first!' },
      ],
    },
  },

  // ── Fixture 9: Agent doesn't divide task (T-09: Divide And Conquer) ──
  {
    name: 'no-task-division',
    description: 'Agent attempted a large migration as a single monolithic change',
    expectedAxiomViolation: 'T-09',
    payload: {
      contextId: 'ctx-spike-009',
      contextHash: 'hash-009',
      taskId: 'task-spike-009',
      workspaceDir: 'D:/work',
      sourceRefs: ['pain://event-009'],
      diagnosisTarget: {
        painId: 'pain-009',
        reasonSummary: 'Agent attempted to migrate the entire codebase from REST to GraphQL in one go',
        severity: 'high',
        source: 'owner-reported',
        evidence: [
          { sourceRef: 'pain://event-009', note: 'Agent tried to rewrite 12 API endpoints to GraphQL in a single edit session, causing cascading failures' },
        ],
      },
      conversationWindow: [
        { ts: '2026-06-11T10:00:00Z', role: 'user', text: 'Migrate the API from REST to GraphQL' },
        { ts: '2026-06-11T10:00:01Z', role: 'assistant', text: 'I will migrate all 12 endpoints to GraphQL now' },
        { ts: '2026-06-11T10:00:02Z', role: 'tool', toolName: 'edit_file', toolResultSummary: 'Attempted to rewrite all 12 endpoint files simultaneously — 8 files have syntax errors', eventType: undefined },
        { ts: '2026-06-11T10:00:03Z', role: 'user', text: 'This should have been done incrementally, one endpoint at a time' },
      ],
    },
  },

  // ── Fixture 10: Agent doesn't externalize memory (T-10: Memory Externalization) ──
  {
    name: 'no-memory-externalization',
    description: 'Agent kept intermediate findings in context instead of writing to files',
    expectedAxiomViolation: 'T-10',
    payload: {
      contextId: 'ctx-spike-010',
      contextHash: 'hash-010',
      taskId: 'task-spike-010',
      workspaceDir: 'D:/work',
      sourceRefs: ['pain://event-010'],
      diagnosisTarget: {
        painId: 'pain-010',
        reasonSummary: 'Agent accumulated analysis in context window instead of writing to files, causing context overflow',
        severity: 'medium',
        source: 'automatic-hook',
        evidence: [
          { sourceRef: 'pain://event-010', note: 'Agent read 15 files and kept all analysis in conversation context. Context window overflow caused the agent to lose track of earlier findings' },
        ],
      },
      conversationWindow: [
        { ts: '2026-06-11T10:00:00Z', role: 'user', text: 'Analyze the codebase for performance issues' },
        { ts: '2026-06-11T10:00:01Z', role: 'assistant', text: 'I will read all the source files' },
        { ts: '2026-06-11T10:00:02Z', role: 'tool', toolName: 'read_file', toolResultSummary: 'Read main.ts (500 lines)', eventType: undefined },
        { ts: '2026-06-11T10:00:03Z', role: 'tool', toolName: 'read_file', toolResultSummary: 'Read router.ts (800 lines)', eventType: undefined },
        { ts: '2026-06-11T10:00:04Z', role: 'tool', toolName: 'read_file', toolResultSummary: 'Read db.ts (600 lines)', eventType: undefined },
        { ts: '2026-06-11T10:00:05Z', role: 'assistant', text: 'I found issues in main.ts line 45, router.ts lines 120-150, db.ts line 200... wait, what was in main.ts again? I lost track' },
        { ts: '2026-06-11T10:00:06Z', role: 'user', text: 'You should have written your findings to a file as you went along' },
      ],
    },
  },

  // ── Fixture 11: Multiple axiom violations ──
  {
    name: 'multiple-violations',
    description: 'Agent skipped survey, ignored evidence, and made a large change — T-01 + T-03 + T-07',
    expectedAxiomViolation: 'T-01',
    payload: {
      contextId: 'ctx-spike-011',
      contextHash: 'hash-011',
      taskId: 'task-spike-011',
      workspaceDir: 'D:/work',
      sourceRefs: ['pain://event-011'],
      diagnosisTarget: {
        painId: 'pain-011',
        reasonSummary: 'Agent rewrote 6 files based on assumptions without reading any of them first',
        severity: 'urgent',
        source: 'tool-call-gate',
        evidence: [
          { sourceRef: 'pain://event-011', note: 'Agent edited 6 files without reading any. Changes were based on assumed structure that did not match reality' },
        ],
      },
      conversationWindow: [
        { ts: '2026-06-11T10:00:00Z', role: 'user', text: 'Update the authentication system to use JWT' },
        { ts: '2026-06-11T10:00:01Z', role: 'assistant', text: 'I will update the auth system to use JWT tokens' },
        { ts: '2026-06-11T10:00:02Z', role: 'tool', toolName: 'edit_file', toolResultSummary: 'Modified auth.ts, session.ts, middleware.ts, routes.ts, config.ts, and types.ts without reading any file first', eventType: undefined },
        { ts: '2026-06-11T10:00:03Z', role: 'user', text: 'Nothing works. You assumed the old system used cookies but it already used JWT — you just broke it' },
      ],
    },
  },

  // ── Fixture 12: No axiom violation (control — noise event) ──
  {
    name: 'no-violation-network-timeout',
    description: 'Network timeout — no agent behavioral violation, should produce kind=defer',
    expectedAxiomViolation: undefined,
    payload: {
      contextId: 'ctx-spike-012',
      contextHash: 'hash-012',
      taskId: 'task-spike-012',
      workspaceDir: 'D:/work',
      sourceRefs: ['pain://event-012'],
      diagnosisTarget: {
        painId: 'pain-012',
        reasonSummary: 'API call timed out after 30 seconds',
        severity: 'low',
        source: 'automatic-hook',
        evidence: [
          { sourceRef: 'pain://event-012', note: 'External API call to https://api.example.com timed out — network issue, not agent behavior' },
        ],
      },
      conversationWindow: [
        { ts: '2026-06-11T10:00:00Z', role: 'assistant', text: 'I will fetch the data from the API' },
        { ts: '2026-06-11T10:00:01Z', role: 'tool', toolName: 'http_request', toolResultSummary: 'Request timed out after 30s', eventType: undefined },
        { ts: '2026-06-11T10:00:02Z', role: 'assistant', text: 'The API request timed out. I will retry with a longer timeout.' },
      ],
    },
  },
];

/**
 * Serialize all fixtures to JSON files for the spike-run script.
 */
export function serializeFixtures(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const fixture of SPIKE_FIXTURES) {
    result[fixture.name] = JSON.stringify(fixture, null, 2);
  }
  return result;
}
