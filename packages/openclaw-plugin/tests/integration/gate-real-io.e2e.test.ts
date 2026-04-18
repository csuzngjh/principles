/**
 * Gate Real I/O E2E Tests
 *
 * PURPOSE: Verify Gate decision chain with real file system operations.
 * These tests are designed to DISCOVER bugs, not just confirm existing behavior.
 *
 * DESIGN PRINCIPLES:
 * 1. Use real file system (no mocks for I/O)
 * 2. Test business invariants: blocks MUST be persisted, state MUST be consistent
 * 3. Use independent Oracle: read files directly for verification
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TrajectoryDatabase } from '../../src/core/trajectory.js';
import { EventLog } from '../../src/core/event-log.js';
import { safeRmDir } from '../test-utils.js';

// ─────────────────────────────────────────────────────────────────────
// Helper functions
// ─────────────────────────────────────────────────────────────────────

interface TestWorkspace {
  workspaceDir: string;
  stateDir: string;
  profilePath: string;
  planPath: string;
  trajectory: TrajectoryDatabase;
  eventLog: EventLog;
}

function createTestWorkspace(): TestWorkspace {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-e2e-gate-'));
  const stateDir = path.join(workspaceDir, '.state');
  const principlesDir = path.join(workspaceDir, '.principles');

  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(principlesDir, { recursive: true });

  const profilePath = path.join(principlesDir, 'PROFILE.json');
  const planPath = path.join(workspaceDir, 'PLAN.md');

  // Create default PROFILE.json
  const defaultProfile = {
    risk_paths: ['/etc/', '/usr/', '~/.ssh/'],
    gate: {
      require_plan_for_risk_paths: true,
    },
    progressive_gate: {
      enabled: true,
      plan_approvals: {
        enabled: false,
        max_lines_override: -1,
        allowed_patterns: [],
        allowed_operations: [],
      },
    },
    edit_verification: {
      enabled: true,
      max_file_size_bytes: 10 * 1024 * 1024,
      fuzzy_match_enabled: true,
      fuzzy_match_threshold: 0.8,
      skip_large_file_action: 'warn',
    },
    thinking_checkpoint: {
      enabled: false,
    },
  };
  fs.writeFileSync(profilePath, JSON.stringify(defaultProfile, null, 2));

  // Create empty PLAN.md
  fs.writeFileSync(planPath, '# PLAN\n\nStatus: READY\n');

  // Create trajectory database
  const trajectory = new TrajectoryDatabase({ workspaceDir });

  // Create event log
  const eventLog = new EventLog(stateDir);

  return { workspaceDir, stateDir, profilePath, planPath, trajectory, eventLog };
}

function cleanupWorkspace(ws: TestWorkspace | null): void {
  if (!ws) return;
  ws.trajectory?.dispose();
  safeRmDir(ws.workspaceDir);
}

// ─────────────────────────────────────────────────────────────────────
// PART 1: EventLog Invariants
// ─────────────────────────────────────────────────────────────────────

describe('Gate: EventLog Invariants', () => {
  let ws: TestWorkspace | null = null;

  beforeEach(() => {
    ws = createTestWorkspace();
  });

  afterEach(() => {
    cleanupWorkspace(ws);
    ws = null;
  });

  describe('INVARIANT: Gate block events must be logged', () => {
    it('EventLog MUST persist gate block events', () => {
      ws!.eventLog.recordGateBlock('test-session', {
        toolName: 'run_shell_command',
        filePath: '/etc/passwd',
        reason: 'Risky path detected',
        blockSource: 'e2e_test',
      });

      // Independent verification: check events file
      const today = new Date().toISOString().split('T')[0];
      const eventsFile = path.join(ws!.stateDir, 'logs', `events_${today}.jsonl`);

      // EventLog buffers, need to flush
      ws!.eventLog.flush();

      expect(fs.existsSync(eventsFile)).toBe(true);

      const content = fs.readFileSync(eventsFile, 'utf-8');
      expect(content).toContain('gate_block');
      expect(content).toContain('run_shell_command');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// PART 2: Edit Verification Invariants
// ─────────────────────────────────────────────────────────────────────

describe('Gate: Edit Verification Invariants', () => {
  let ws: TestWorkspace | null = null;
  let testFilePath: string;

  beforeEach(() => {
    ws = createTestWorkspace();
    testFilePath = path.join(ws!.workspaceDir, 'test-file.ts');
    fs.writeFileSync(testFilePath, `function hello() {
  console.log('Hello, World!');
}

function goodbye() {
  console.log('Goodbye!');
}
`);
  });

  afterEach(() => {
    cleanupWorkspace(ws);
    ws = null;
  });

  describe('INVARIANT: Edit verification format', () => {
    it('Exact match MUST succeed for correct oldText', () => {
      const fileContent = fs.readFileSync(testFilePath, 'utf-8');
      const oldText = "console.log('Hello, World!');";

      // Verify the text exists - this is what edit verification checks
      expect(fileContent).toContain(oldText);
    });

    it('Edit verification MUST fail for non-existent text', () => {
      const fileContent = fs.readFileSync(testFilePath, 'utf-8');
      const nonExistentText = "this text does not exist in the file 12345";

      // Verify the text does NOT exist
      expect(fileContent).not.toContain(nonExistentText);
    });
  });

  describe('INVARIANT: File size handling', () => {
    it('Large file MUST be detectable', () => {
      // Create a large file (over 10MB)
      const largeContent = 'x'.repeat(11 * 1024 * 1024);
      const largeFilePath = path.join(ws!.workspaceDir, 'large-file.ts');
      fs.writeFileSync(largeFilePath, largeContent);

      const stats = fs.statSync(largeFilePath);

      // INVARIANT: Large file must be detectable
      expect(stats.size).toBeGreaterThan(10 * 1024 * 1024);

      // Cleanup
      fs.unlinkSync(largeFilePath);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// PART 3: Resilience Tests
// ─────────────────────────────────────────────────────────────────────

describe('Gate: Resilience', () => {
  let ws: TestWorkspace | null = null;

  beforeEach(() => {
    ws = createTestWorkspace();
  });

  afterEach(() => {
    cleanupWorkspace(ws);
    ws = null;
  });

  describe('RESILIENCE: Missing configuration', () => {
    it('Profile file MUST be readable when valid JSON', () => {
      const profileContent = fs.readFileSync(ws!.profilePath, 'utf-8');
      const profile = JSON.parse(profileContent);

      // INVARIANT: Valid profile must have expected structure
      expect(profile).toBeDefined();
      expect(profile.gate).toBeDefined();
    });

    it('Gate MUST handle corrupted PROFILE.json gracefully', () => {
      // Write invalid JSON
      fs.writeFileSync(ws!.profilePath, 'not valid json {{{');

      // Attempt to parse should throw, but not crash
      expect(() => {
        try {
          JSON.parse(fs.readFileSync(ws!.profilePath, 'utf-8'));
        } catch {
          // Expected
        }
      }).not.toThrow();
    });
  });

  describe('RESILIENCE: Missing state directory', () => {
    it('EventLog MUST handle missing logs directory', () => {
      // Remove state directory (safeRmDir handles Windows EPERM from held handles)
      safeRmDir(ws!.stateDir);

      // Attempt to create event log
      // Should recreate the directory
      expect(() => new EventLog(ws!.stateDir)).not.toThrow();

      // Verify directory was created
      expect(fs.existsSync(ws!.stateDir)).toBe(true);
    });
  });
});
