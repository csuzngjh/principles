import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateBehaviorExamplePack } from '@principles/core/runtime-v2';
import { TrajectoryDatabase, TrajectoryRegistry } from '../../src/core/trajectory.js';
import { BehaviorExamplePackAssembler } from '../../src/core/behavior-example-pack-assembler.js';

describe('BehaviorExamplePackAssembler — Owner-labelled examples', () => {
  let workspaceDir: string | undefined;

  afterEach(() => {
    if (!workspaceDir) return;
    TrajectoryRegistry.dispose(workspaceDir);
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    workspaceDir = undefined;
  });

  function setup(): { db: TrajectoryDatabase; assembler: BehaviorExamplePackAssembler; projectDir: string } {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-owner-examples-'));
    const projectDir = path.join(workspaceDir, 'project');
    fs.mkdirSync(projectDir, { recursive: true });
    const db = TrajectoryRegistry.get(workspaceDir);
    return {
      db,
      projectDir,
      assembler: new BehaviorExamplePackAssembler({ workspaceDir, stateDir: path.join(workspaceDir, '.state') }),
    };
  }

  function seedPain(db: TrajectoryDatabase, sessionId: string, painId = 'pain-owner-1'): void {
    db.recordPainEvent({ sessionId, source: 'owner', score: 0.9, canonicalPainId: painId });
  }

  it('uses Owner labels instead of treating tool outcome as desired behaviour', () => {
    const { db, assembler, projectDir } = setup();
    const sessionId = 'session-owner-labels';
    const negativeId = db.recordToolCall({
      sessionId,
      toolName: 'write_file',
      outcome: 'success',
      paramsJson: { path: path.join(projectDir, 'unread.txt') },
    });
    const positiveId = db.recordToolCall({
      sessionId,
      toolName: 'write_file',
      outcome: 'failure',
      paramsJson: { path: path.join(projectDir, 'read-first.txt') },
    });
    seedPain(db, sessionId);

    const pack = assembler.assemble({
      sourcePainId: 'pain-owner-1',
      ownerDesiredOutcome: 'Block a write only when the target was not read first.',
      sourceNegativeToolCallId: negativeId,
      positiveToolCallIds: [positiveId],
      projectDir,
    });

    expect(validateBehaviorExamplePack(pack).valid).toBe(true);
    expect(pack.sourceNegativeCase.caseId).toBe(`case-negative-${negativeId}`);
    expect(pack.sourceNegativeCase.expectedDecision).toBe('block');
    expect(pack.positiveCounterexamples[0]?.caseId).toBe(`case-positive-${positiveId}`);
    expect(pack.positiveCounterexamples[0]?.expectedDecision).toBe('allow');
  });

  it('attaches only history that occurred before each selected call', () => {
    const { db, assembler, projectDir } = setup();
    const sessionId = 'session-prior-history';
    const target = path.join(projectDir, 'target.txt');
    const readId = db.recordToolCall({ sessionId, toolName: 'read_file', outcome: 'success', paramsJson: { path: target } });
    const positiveId = db.recordToolCall({ sessionId, toolName: 'write_file', outcome: 'success', paramsJson: { path: target } });
    const negativeId = db.recordToolCall({ sessionId, toolName: 'write_file', outcome: 'success', paramsJson: { path: path.join(projectDir, 'other.txt') } });
    seedPain(db, sessionId);

    const pack = assembler.assemble({
      sourcePainId: 'pain-owner-1',
      ownerDesiredOutcome: 'Require a prior read.',
      sourceNegativeToolCallId: negativeId,
      positiveToolCallIds: [positiveId],
      projectDir,
    });

    const positiveContext = pack.positiveCounterexamples[0]?.ruleContext;
    expect(positiveContext?.history.calls.map((call) => call.sequenceId)).toEqual([readId]);
    expect(positiveContext?.facts.priorReadOfTarget).toBe('yes');
    expect(pack.sourceNegativeCase.ruleContext?.history.calls.map((call) => call.sequenceId)).toEqual([readId, positiveId]);
  });

  it('fails loud when a selected call belongs to another session', () => {
    const { db, assembler, projectDir } = setup();
    const negativeId = db.recordToolCall({ sessionId: 'pain-session', toolName: 'write_file', outcome: 'success', paramsJson: { path: 'a' } });
    const positiveId = db.recordToolCall({ sessionId: 'other-session', toolName: 'write_file', outcome: 'success', paramsJson: { path: 'b' } });
    seedPain(db, 'pain-session');

    expect(() => assembler.assemble({
      sourcePainId: 'pain-owner-1', ownerDesiredOutcome: 'Owner outcome', sourceNegativeToolCallId: negativeId,
      positiveToolCallIds: [positiveId], projectDir,
    })).toThrow(/same session|session mismatch/i);
  });

  it('fails loud for missing selected calls and for more than three positives', () => {
    const { db, assembler, projectDir } = setup();
    seedPain(db, 'session-missing');
    expect(() => assembler.assemble({
      sourcePainId: 'pain-owner-1', ownerDesiredOutcome: 'Owner outcome', sourceNegativeToolCallId: 999,
      positiveToolCallIds: [1000], projectDir,
    })).toThrow(/tool call.*not found/i);
    expect(() => assembler.assemble({
      sourcePainId: 'pain-owner-1', ownerDesiredOutcome: 'Owner outcome', sourceNegativeToolCallId: 1,
      positiveToolCallIds: [2, 3, 4, 5], projectDir,
    })).toThrow(/at most 3/i);
  });
});
