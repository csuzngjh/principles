import { beforeEach, describe, expect, it } from 'vitest';
import { handlePdReflect } from '../../src/commands/pd-reflect.js';

describe('pd-reflect command (retired per ADR-0012)', () => {
  it('returns retirement message instead of enqueuing sleep_reflection', async () => {
    const result = await handlePdReflect.handler({} as any);
    expect(result.text).toContain('retired');
    expect(result.text).toContain('ADR-0012');
    expect(result.text).toContain('Next action');
    expect(result.text).toContain('pd runtime internalization');
  });

  it('does not enqueue tasks — returns retirement message', async () => {
    const result = await handlePdReflect.handler({} as any);
    expect(result.text).not.toContain('Nocturnal reflection task enqueued');
    // The message mentions sleep_reflection in context of retirement, which is correct
    expect(result.isError).toBeUndefined();
  });
});
