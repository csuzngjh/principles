import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { authorizeGovernanceAction, writeGovernanceAction } from '../../src/governance-audit.js';

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe('writeGovernanceAction', () => {
  it('durably flushes one event before returning', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-governance-audit-'));

    writeGovernanceAction(tempDir, {
      action: 'global_pause',
      subject: 'all_live_rulecode',
      actor: 'owner',
      reasonCode: 'incident_containment',
      outcome: 'authorized',
    });

    const eventsPath = path.join(tempDir, 'logs', `events_${new Date().toISOString().slice(0, 10)}.jsonl`);
    const lines = fs.readFileSync(eventsPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
      type: 'governance_action',
      data: {
        action: 'global_pause',
        subject: 'all_live_rulecode',
        actor: 'owner',
        reasonCode: 'incident_containment',
        outcome: 'authorized',
      },
    });
  });

  it('runs the mutation only after the audit writer returns', async () => {
    const order: string[] = [];
    const result = await authorizeGovernanceAction(
      '/state',
      {
        action: 'promote',
        activationId: 'act-promote',
        actor: 'owner',
        reasonCode: 'owner_approved_live',
        outcome: 'authorized',
      },
      async () => { order.push('mutation'); return 'done'; },
      () => { order.push('audit'); },
    );

    expect(result).toBe('done');
    expect(order).toEqual(['audit', 'mutation']);
  });

  it('does not run the mutation when the audit writer throws', async () => {
    let mutationCalled = false;
    const mutation = async () => { mutationCalled = true; return 'must-not-run'; };

    await expect(authorizeGovernanceAction(
      '/state',
      {
        action: 'global_pause',
        subject: 'all_live_rulecode',
        actor: 'owner',
        reasonCode: 'incident_containment',
        outcome: 'authorized',
      },
      mutation,
      () => { throw new Error('disk full'); },
    )).rejects.toThrow('disk full');
    expect(mutationCalled).toBe(false);
  });
});
