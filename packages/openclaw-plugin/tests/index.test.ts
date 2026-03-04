import { describe, it, expect } from 'vitest';
import * as plugin from '../src/index';

describe('OpenClaw Plugin Scaffolding', () => {
  it('should export a valid register function', () => {
    expect(plugin).toBeDefined();
    expect(typeof plugin.register).toBe('function');
  });
});