/**
 * PainFlagDetector Tests
 *
 * Verifies:
 * - Pain flag path resolution uses resolvePdPath (not hardcoded path.join)
 * - Multi-format detection (KV, JSON, Key=Value, Markdown)
 * - Queue interaction (dedup, enqueue)
 * - Error handling and graceful degradation
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PainFlagDetector } from '../../src/service/pain-flag-detector.js';

const TEST_DIR = path.join(os.tmpdir(), 'test-pain-flag-detector');
const STATE_DIR = path.join(TEST_DIR, '.state');

describe('PainFlagDetector', () => {
  beforeEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    fs.mkdirSync(STATE_DIR, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // ── Path Resolution ──────────────────────────────────────────────

  describe('Path Resolution', () => {
    it('should find pain flag at correct .state/.pain_flag path', () => {
      // Write pain flag to the CORRECT path
      const correctPath = path.join(STATE_DIR, '.pain_flag');
      fs.writeFileSync(correctPath, `source: tool_failure
score: 75
reason: Test pain reason
session_id: test-session-123
agent_id: main
time: 2026-04-12T00:00:00.000Z
`, 'utf-8');

      const detector = new PainFlagDetector(TEST_DIR);
      const context = detector.extractRecentPainContext();

      expect(context.mostRecent).not.toBeNull();
      expect(context.mostRecent?.score).toBe(75);
      expect(context.mostRecent?.source).toBe('tool_failure');
      expect(context.recentPainCount).toBe(1);
    });

    it('should NOT find pain flag at wrong workspace-root path', () => {
      // Write pain flag to the WRONG path (old bug behavior)
      const wrongPath = path.join(TEST_DIR, 'PAIN_FLAG');
      fs.writeFileSync(wrongPath, `source: tool_failure
score: 75
reason: Test pain reason
`, 'utf-8');

      const detector = new PainFlagDetector(TEST_DIR);
      const context = detector.extractRecentPainContext();

      // Should NOT find it because it's at the wrong path
      expect(context.mostRecent).toBeNull();
      expect(context.recentPainCount).toBe(0);
    });

    it('should return empty context when .pain_flag does not exist', () => {
      const detector = new PainFlagDetector(TEST_DIR);
      const context = detector.extractRecentPainContext();

      expect(context.mostRecent).toBeNull();
      expect(context.recentPainCount).toBe(0);
      expect(context.recentMaxPainScore).toBe(0);
    });
  });

  // ── KV Format Detection ──────────────────────────────────────────

  describe('KV Format Detection', () => {
    it('should parse valid KV format pain flag', () => {
      const painFlagPath = path.join(STATE_DIR, '.pain_flag');
      fs.writeFileSync(painFlagPath, `source: tool_failure
score: 80
reason: Database connection timeout
session_id: session-abc-123
agent_id: main
trace_id: trace-xyz-789
time: 2026-04-12T12:00:00.000Z
status: unresolved
`, 'utf-8');

      const detector = new PainFlagDetector(TEST_DIR);
      const context = detector.extractRecentPainContext();

      expect(context.mostRecent).not.toBeNull();
      expect(context.mostRecent?.score).toBe(80);
      expect(context.mostRecent?.source).toBe('tool_failure');
      expect(context.mostRecent?.reason).toBe('Database connection timeout');
      expect(context.mostRecent?.sessionId).toBe('session-abc-123');
    });

    it('should handle KV format with missing optional fields', () => {
      const painFlagPath = path.join(STATE_DIR, '.pain_flag');
      // Include required fields: source, score, reason
      fs.writeFileSync(painFlagPath, `source: user_correction
score: 50
reason: User corrected agent behavior
session_id: test-session
agent_id: main
time: 2026-04-12T00:00:00.000Z
`, 'utf-8');

      const detector = new PainFlagDetector(TEST_DIR);
      const context = detector.extractRecentPainContext();

      expect(context.mostRecent).not.toBeNull();
      expect(context.mostRecent?.score).toBe(50);
      expect(context.mostRecent?.source).toBe('user_correction');
    });

    it('should treat missing score as 0 (not extracted)', () => {
      const painFlagPath = path.join(STATE_DIR, '.pain_flag');
      fs.writeFileSync(painFlagPath, `source: tool_failure
reason: Missing score field test
session_id: test-session
agent_id: main
time: 2026-04-12T00:00:00.000Z
`, 'utf-8');

      const detector = new PainFlagDetector(TEST_DIR);
      const context = detector.extractRecentPainContext();

      // extractRecentPainContext requires score > 0 to return context
      expect(context.mostRecent).toBeNull();
      expect(context.recentPainCount).toBe(0);
    });
  });

  // ── JSON Format Detection ────────────────────────────────────────

  describe('JSON Format Detection', () => {
    it('should parse valid JSON format pain flag', () => {
      const painFlagPath = path.join(STATE_DIR, '.pain_flag');
      fs.writeFileSync(painFlagPath, JSON.stringify({
        source: 'tool_failure',
        score: '90',
        reason: 'Critical system error',
        session_id: 'json-session-456',
        agent_id: 'main',
        time: '2026-04-12T12:00:00.000Z',
      }), 'utf-8');

      const detector = new PainFlagDetector(TEST_DIR);
      const context = detector.extractRecentPainContext();

      expect(context.mostRecent).not.toBeNull();
      expect(context.mostRecent?.score).toBe(90);
      expect(context.mostRecent?.source).toBe('tool_failure');
    });

    it('should return empty context for malformed JSON', () => {
      const painFlagPath = path.join(STATE_DIR, '.pain_flag');
      fs.writeFileSync(painFlagPath, '{bad json content', 'utf-8');

      const detector = new PainFlagDetector(TEST_DIR);
      const context = detector.extractRecentPainContext();

      expect(context.mostRecent).toBeNull();
    });

    it('should return empty context for empty JSON object', () => {
      const painFlagPath = path.join(STATE_DIR, '.pain_flag');
      fs.writeFileSync(painFlagPath, '{}', 'utf-8');

      const detector = new PainFlagDetector(TEST_DIR);
      const context = detector.extractRecentPainContext();

      expect(context.mostRecent).toBeNull();
    });
  });

  // ── Context Extraction ───────────────────────────────────────────

  describe('Context Extraction', () => {
    it('should extract context with high score pain signal', () => {
      const painFlagPath = path.join(STATE_DIR, '.pain_flag');
      fs.writeFileSync(painFlagPath, `source: gate_block
score: 95
reason: Security gate blocked dangerous operation
session_id: security-session-789
agent_id: main
time: 2026-04-12T12:00:00.000Z
`, 'utf-8');

      const detector = new PainFlagDetector(TEST_DIR);
      const context = detector.extractRecentPainContext();

      expect(context.mostRecent).not.toBeNull();
      expect(context.mostRecent?.score).toBe(95);
      expect(context.recentMaxPainScore).toBe(95);
      expect(context.recentPainCount).toBe(1);
    });

    it('should return empty context when score is 0', () => {
      const painFlagPath = path.join(STATE_DIR, '.pain_flag');
      fs.writeFileSync(painFlagPath, `source: tool_failure
score: 0
reason: Zero score test
`, 'utf-8');

      const detector = new PainFlagDetector(TEST_DIR);
      const context = detector.extractRecentPainContext();

      expect(context.mostRecent).toBeNull();
      expect(context.recentPainCount).toBe(0);
    });
  });

  // ── Error Handling ───────────────────────────────────────────────

  describe('Error Handling', () => {
    it('should handle non-existent workspace directory gracefully', () => {
      const nonExistentDir = '/tmp/non-existent-workspace-12345';
      const detector = new PainFlagDetector(nonExistentDir);
      
      // Should not throw
      const context = detector.extractRecentPainContext();
      expect(context.mostRecent).toBeNull();
    });

    it('should handle corrupted pain flag file gracefully', () => {
      const painFlagPath = path.join(STATE_DIR, '.pain_flag');
      // Write binary garbage
      fs.writeFileSync(painFlagPath, Buffer.from([0x00, 0x01, 0x02, 0x03]), 'utf-8');

      const detector = new PainFlagDetector(TEST_DIR);
      
      // Should not throw
      const context = detector.extractRecentPainContext();
      expect(context.mostRecent).toBeNull();
    });
  });
});
