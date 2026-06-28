/**
 * PRI-484 — Phase 5 Task 28 — BehaviorExamplePackAssembler tests (TDD)
 *
 * Tests the plugin I/O assembler that turns pain lineage + trajectory rows
 * into a validated BehaviorExamplePack for the Artificer.
 *
 * Err-prevention coverage:
 *   - ERR-001: every DB row validated as `unknown` (no `as` bypass in assembler).
 *   - ERR-069: Artificer shared schema — invalid pack must fail loud (no silent
 *     fallback to empty pack).
 *   - ERR-026: tests reuse production schema via real TrajectoryDatabase.
 *   - rc-2: no `as` casts on parsed rows.
 *   - rc-5: Object.hasOwn over `in`.
 *   - rc-9: no silent fallback — every failure path throws with a clear reason.
 *
 * Spec: docs/superpowers/specs/2026-06-27-rulecode-context-vision-design.md §7.2
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { validateBehaviorExamplePack } from '@principles/core/runtime-v2';
import { TrajectoryDatabase, TrajectoryRegistry } from '../../src/core/trajectory.js';
import { BehaviorExamplePackAssembler } from '../../src/core/behavior-example-pack-assembler.js';

describe('BehaviorExamplePackAssembler (PRI-484 Task 28)', () => {
  let workspaceDir: string | null = null;
  let projectDir: string | null = null;

  afterEach(() => {
    if (workspaceDir) {
      TrajectoryRegistry.dispose(workspaceDir);
      fs.rmSync(workspaceDir, { recursive: true, force: true });
      workspaceDir = null;
    }
    projectDir = null;
  });

  function setup(): {
    db: TrajectoryDatabase;
    assembler: BehaviorExamplePackAssembler;
    projectDir: string;
  } {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-bep-assembler-'));
    projectDir = path.join(workspaceDir, 'project');
    fs.mkdirSync(projectDir, { recursive: true });
    const db = new TrajectoryDatabase({ workspaceDir });
    const assembler = new BehaviorExamplePackAssembler({
      workspaceDir,
      stateDir: path.join(workspaceDir, '.state'),
    });
    return { db, assembler, projectDir };
  }

  // ── Happy path ────────────────────────────────────────────────────────────

  it('assembles a valid pack from a pain lineage with trajectory', () => {
    const { db, assembler, projectDir } = setup();
    const sessionId = 'sess-bep-happy';

    // Record a failing tool call (becomes the source negative case)
    db.recordToolCall({
      sessionId,
      toolName: 'edit_file',
      outcome: 'failure',
      errorType: 'EACCES',
      errorMessage: 'permission denied',
      paramsJson: { file_path: '/project/src/secret.ts' },
    });

    // Record a successful tool call (becomes a positive counterexample)
    db.recordToolCall({
      sessionId,
      toolName: 'edit_file',
      outcome: 'success',
      paramsJson: { file_path: '/project/src/safe.ts' },
    });

    // Record the pain event that anchors the lineage
    db.recordPainEvent({
      sessionId,
      source: 'tool_failure',
      score: 0.8,
      reason: 'permission denied on sensitive file',
      severity: 'high',
      canonicalPainId: 'pain-happy-001',
    });

    const pack = assembler.assemble({
      sourcePainId: 'pain-happy-001',
      ownerDesiredOutcome: 'Block edits to sensitive files outside the project tree.',
      projectDir,
    });

    // Validate via the pure validator (Task 23) — must pass
    const validation = validateBehaviorExamplePack(pack);
    expect(validation.valid).toBe(true);

    // sourceNegativeCase reflects the failing call
    expect(pack.sourceNegativeCase.kind).toBe('negative');
    expect(pack.sourceNegativeCase.toolName).toBe('edit_file');
    expect(pack.sourceNegativeCase.expectedDecision).toBe('block');

    // positiveCounterexamples reflect the successful call(s)
    expect(pack.positiveCounterexamples.length).toBeGreaterThanOrEqual(1);
    for (const positive of pack.positiveCounterexamples) {
      expect(positive.kind).toBe('positive');
      expect(positive.expectedDecision).toBe('allow');
    }

    // evidenceRefs reference the pain event and/or gate blocks
    expect(pack.evidenceRefs.length).toBeGreaterThanOrEqual(1);
    for (const ref of pack.evidenceRefs) {
      expect(typeof ref).toBe('string');
      expect(ref.length).toBeGreaterThan(0);
    }

    // ownerDesiredOutcome is preserved
    expect(pack.ownerDesiredOutcome).toBe('Block edits to sensitive files outside the project tree.');

    // redactionNotes is an array (may be empty if no redaction applied)
    expect(Array.isArray(pack.redactionNotes)).toBe(true);

    db.dispose();
  });

  // ── Fail-loud paths (ERR-069) ─────────────────────────────────────────────

  it('fails loud when pain record not found (ERR-069)', () => {
    const { db, assembler, projectDir } = setup();

    expect(() =>
      assembler.assemble({
        sourcePainId: 'pain-does-not-exist',
        ownerDesiredOutcome: 'Some outcome.',
        projectDir,
      }),
    ).toThrowError(/pain.*not found|not found.*pain/i);

    db.dispose();
  });

  it('fails loud when trajectory is empty (no tool calls)', () => {
    const { db, assembler, projectDir } = setup();
    const sessionId = 'sess-empty-traj';

    // Record pain event but no tool calls
    db.recordPainEvent({
      sessionId,
      source: 'manual',
      score: 0.5,
      canonicalPainId: 'pain-empty-traj-001',
    });

    expect(() =>
      assembler.assemble({
        sourcePainId: 'pain-empty-traj-001',
        ownerDesiredOutcome: 'Some outcome.',
        projectDir,
      }),
    ).toThrowError(/empty trajectory|no tool calls/i);

    db.dispose();
  });

  it('fails loud when no failing tool call exists (cannot build sourceNegativeCase)', () => {
    const { db, assembler, projectDir } = setup();
    const sessionId = 'sess-no-failure';

    // Only successful calls — no failure to anchor the negative case
    db.recordToolCall({
      sessionId,
      toolName: 'edit_file',
      outcome: 'success',
      paramsJson: { file_path: '/project/src/safe.ts' },
    });
    db.recordPainEvent({
      sessionId,
      source: 'manual',
      score: 0.5,
      canonicalPainId: 'pain-no-failure-001',
    });

    expect(() =>
      assembler.assemble({
        sourcePainId: 'pain-no-failure-001',
        ownerDesiredOutcome: 'Some outcome.',
        projectDir,
      }),
    ).toThrowError(/no failing|negative case|sourceNegativeCase/i);

    db.dispose();
  });

  it('fails loud when assembled pack fails validateBehaviorExamplePack (empty ownerDesiredOutcome)', () => {
    const { db, assembler, projectDir } = setup();
    const sessionId = 'sess-invalid-pack';

    db.recordToolCall({
      sessionId,
      toolName: 'edit_file',
      outcome: 'failure',
      paramsJson: { file_path: '/project/src/secret.ts' },
    });
    db.recordToolCall({
      sessionId,
      toolName: 'edit_file',
      outcome: 'success',
      paramsJson: { file_path: '/project/src/safe.ts' },
    });
    db.recordPainEvent({
      sessionId,
      source: 'tool_failure',
      score: 0.8,
      canonicalPainId: 'pain-invalid-pack-001',
    });

    // Empty ownerDesiredOutcome must fail validation (validateBehaviorExamplePack
    // requires non-empty string) — assembler must fail loud rather than silently
    // producing an invalid pack.
    expect(() =>
      assembler.assemble({
        sourcePainId: 'pain-invalid-pack-001',
        ownerDesiredOutcome: '',
        projectDir,
      }),
    ).toThrowError(/validation|invalid.*pack|ownerDesiredOutcome/i);

    db.dispose();
  });

  // ── Bounds (spec §7.2 first-version limits) ──────────────────────────────

  it('limits positiveCounterexamples to 3', () => {
    const { db, assembler, projectDir } = setup();
    const sessionId = 'sess-many-positives';

    // One failure (anchors the negative case)
    db.recordToolCall({
      sessionId,
      toolName: 'edit_file',
      outcome: 'failure',
      paramsJson: { file_path: '/project/src/secret.ts' },
    });

    // Five successes — only 3 should be picked
    for (let i = 0; i < 5; i++) {
      db.recordToolCall({
        sessionId,
        toolName: 'edit_file',
        outcome: 'success',
        paramsJson: { file_path: `/project/src/safe${i}.ts` },
      });
    }

    db.recordPainEvent({
      sessionId,
      source: 'tool_failure',
      score: 0.8,
      canonicalPainId: 'pain-many-positives-001',
    });

    const pack = assembler.assemble({
      sourcePainId: 'pain-many-positives-001',
      ownerDesiredOutcome: 'Block edits to sensitive files.',
      projectDir,
    });

    expect(pack.positiveCounterexamples.length).toBe(3);
    expect(validateBehaviorExamplePack(pack).valid).toBe(true);

    db.dispose();
  });

  it('limits evidenceRefs to 5', () => {
    const { db, assembler, projectDir } = setup();
    const sessionId = 'sess-many-evidence';

    db.recordToolCall({
      sessionId,
      toolName: 'edit_file',
      outcome: 'failure',
      paramsJson: { file_path: '/project/src/secret.ts' },
    });
    db.recordToolCall({
      sessionId,
      toolName: 'edit_file',
      outcome: 'success',
      paramsJson: { file_path: '/project/src/safe.ts' },
    });

    // Many pain events + gate blocks → many candidate evidenceRefs
    for (let i = 0; i < 4; i++) {
      db.recordPainEvent({
        sessionId,
        source: 'tool_failure',
        score: 0.5,
        canonicalPainId: `pain-evidence-${i}`,
      });
    }
    for (let i = 0; i < 4; i++) {
      db.recordGateBlock({
        sessionId,
        toolName: 'edit_file',
        filePath: `/project/src/blocked${i}.ts`,
        reason: `gate block ${i}`,
      });
    }

    db.recordPainEvent({
      sessionId,
      source: 'tool_failure',
      score: 0.9,
      canonicalPainId: 'pain-many-evidence-anchor',
    });

    const pack = assembler.assemble({
      sourcePainId: 'pain-many-evidence-anchor',
      ownerDesiredOutcome: 'Block edits to sensitive files.',
      projectDir,
    });

    expect(pack.evidenceRefs.length).toBeLessThanOrEqual(5);
    expect(pack.evidenceRefs.length).toBeGreaterThanOrEqual(1);
    expect(validateBehaviorExamplePack(pack).valid).toBe(true);

    db.dispose();
  });

  // ── Redaction (spec §7.2: "经过脱敏") ────────────────────────────────────

  it('redacts absolute paths in params and records redactionNotes', () => {
    const { db, assembler, projectDir } = setup();
    const sessionId = 'sess-redaction';

    // Sensitive absolute path that should be redacted
    db.recordToolCall({
      sessionId,
      toolName: 'edit_file',
      outcome: 'failure',
      paramsJson: {
        file_path: '/Users/secret/.ssh/credentials.json',
        content: 'AWS_KEY=AKIAIOSFODNN7EXAMPLE',
      },
    });
    db.recordToolCall({
      sessionId,
      toolName: 'edit_file',
      outcome: 'success',
      paramsJson: { file_path: '/project/src/safe.ts' },
    });
    db.recordPainEvent({
      sessionId,
      source: 'tool_failure',
      score: 0.9,
      canonicalPainId: 'pain-redaction-001',
    });

    const pack = assembler.assemble({
      sourcePainId: 'pain-redaction-001',
      ownerDesiredOutcome: 'Block edits outside the project tree.',
      projectDir,
    });

    // sourceNegativeCase must NOT carry the raw absolute path or secret content
    const negativeParams = pack.sourceNegativeCase.params as Record<string, unknown>;
    const negativePath = negativeParams.file_path;
    expect(typeof negativePath).toBe('string');
    expect(negativePath as string).not.toContain('/Users/secret/.ssh');
    expect(negativePath as string).not.toContain('AKIAIOSFODNN7EXAMPLE');

    // The original secret content must not appear anywhere in the params
    const paramsJson = JSON.stringify(pack.sourceNegativeCase.params);
    expect(paramsJson).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(paramsJson).not.toContain('/Users/secret/.ssh');

    // redactionNotes records what was redacted
    expect(pack.redactionNotes.length).toBeGreaterThanOrEqual(1);
    const notesJoined = pack.redactionNotes.join('\n');
    expect(notesJoined).toMatch(/path|redact|content|secret/i);

    // Validation still passes after redaction
    expect(validateBehaviorExamplePack(pack).valid).toBe(true);

    db.dispose();
  });

  // ── Multiple pain events in same session ─────────────────────────────────

  it('uses the correct pain event when multiple exist in the same session', () => {
    const { db, assembler, projectDir } = setup();
    const sessionId = 'sess-multi-pain';

    db.recordToolCall({
      sessionId,
      toolName: 'edit_file',
      outcome: 'failure',
      paramsJson: { file_path: '/project/src/secret1.ts' },
    });
    db.recordToolCall({
      sessionId,
      toolName: 'edit_file',
      outcome: 'success',
      paramsJson: { file_path: '/project/src/safe1.ts' },
    });

    // First pain event (different canonical id)
    db.recordPainEvent({
      sessionId,
      source: 'tool_failure',
      score: 0.5,
      canonicalPainId: 'pain-multi-001',
    });

    db.recordToolCall({
      sessionId,
      toolName: 'edit_file',
      outcome: 'failure',
      paramsJson: { file_path: '/project/src/secret2.ts' },
    });

    // Second pain event (the one we look up)
    db.recordPainEvent({
      sessionId,
      source: 'tool_failure',
      score: 0.9,
      canonicalPainId: 'pain-multi-002',
    });

    const pack = assembler.assemble({
      sourcePainId: 'pain-multi-002',
      ownerDesiredOutcome: 'Block edits to sensitive files.',
      projectDir,
    });

    expect(validateBehaviorExamplePack(pack).valid).toBe(true);
    // The negative case should reflect a failure in this session
    expect(pack.sourceNegativeCase.kind).toBe('negative');
    expect(pack.sourceNegativeCase.expectedDecision).toBe('block');

    db.dispose();
  });
});
