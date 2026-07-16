import { describe, expect, it } from 'vitest';
import { isUserInteractionTrigger } from '../../src/core/signal-collector-host.js';

describe('prompt user interaction trigger classification', () => {
  it.each(['user', 'api', undefined])('accepts user entry trigger %s', (trigger) => {
    expect(isUserInteractionTrigger(trigger)).toBe(true);
  });

  it.each(['heartbeat', 'cron', 'subagent'])('rejects non-user trigger %s', (trigger) => {
    expect(isUserInteractionTrigger(trigger)).toBe(false);
  });
});
