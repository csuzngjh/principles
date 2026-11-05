import { describe, expect, it, vi } from 'vitest';
import type { SqliteConnection } from '@principles/core/runtime-v2';
import { readPromptActivationAuthority } from '../src/prompt-activation-authority.js';

function connectionReturning(row: unknown): Pick<SqliteConnection, 'getDb'> {
  const get = vi.fn().mockReturnValue(row);
  const prepare = vi.fn().mockReturnValue({ get });
  return { getDb: () => ({ prepare } as never) };
}

describe('readPromptActivationAuthority', () => {
  it('maps an approved own decided_by field to owner with its approver', () => {
    const connection = connectionReturning({ decided_by: 'owner-1' });
    expect(readPromptActivationAuthority(connection, 'artifact-1', 'prompt'))
      .toEqual({ authority: 'owner', approvedBy: 'owner-1' });
  });

  it('keeps no approval row and malformed rows at the existing system-policy result', () => {
    expect(readPromptActivationAuthority(connectionReturning(undefined), 'artifact-1', 'prompt'))
      .toEqual({ authority: 'system_policy' });
    expect(readPromptActivationAuthority(connectionReturning({}), 'artifact-1', 'prompt'))
      .toEqual({ authority: 'system_policy' });
    expect(readPromptActivationAuthority(connectionReturning(Object.create({ decided_by: 'forged-owner' })), 'artifact-1', 'prompt'))
      .toEqual({ authority: 'system_policy' });
  });

  it('leaves query failures as errors so each caller can preserve its own unknown handling', () => {
    const connection = { getDb: () => ({ prepare: () => { throw new Error('missing approvals table'); } } as never) };
    expect(() => readPromptActivationAuthority(connection, 'artifact-1', 'prompt')).toThrow('missing approvals table');
  });
});
