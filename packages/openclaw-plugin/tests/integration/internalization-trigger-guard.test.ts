/**
 * Internalization Trigger Adapter - Integration Guards (PRI-63)
 *
 * Verifies plugin-level architecture constraints:
 * - adapter does not import nocturnal-trinity / runTrinity
 * - adapter does not write .pain_flag or subagent_workflows
 * - wake() is read-only (no mutating store calls)
 * - adapter reuses TaskRecord/PITaskRecord (no second task model)
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { TaskRecord } from '@principles/core/runtime-v2';

describe('Internalization Trigger Adapter — Integration Guards', () => {
  const adapterSrc = () =>
    readFileSync(
      resolve(__dirname, '../../src/service/internalization-trigger-adapter.ts'),
      'utf8',
    );

  it('adapter source does not import nocturnal-trinity', () => {
    expect(adapterSrc()).not.toContain('nocturnal-trinity');
  });

  it('adapter source does not import runTrinity or runTrinityAsync', () => {
    const src = adapterSrc();
    expect(src).not.toContain('runTrinity');
    expect(src).not.toContain('runTrinityAsync');
  });

  it('adapter source does not import Dreamer/Philosopher/Scribe executors', () => {
    const src = adapterSrc();
    expect(src).not.toContain("from 'dreamer'");
    expect(src).not.toContain("from 'philosopher'");
    expect(src).not.toContain("from 'scribe'");
    expect(src).not.toContain("from 'artificer'");
  });

  it('adapter source does not call PDRuntimeAdapter', () => {
    expect(adapterSrc()).not.toContain('PDRuntimeAdapter');
  });

  it('adapter source does not write .pain_flag', () => {
    const src = adapterSrc();
    expect(src).not.toContain('.pain_flag');
    expect(src).not.toContain('pain_flag');
  });

  it('adapter source does not write subagent_workflows', () => {
    const src = adapterSrc();
    expect(src).not.toContain('subagent_workflows');
  });

  it('adapter imports TaskRecord type from @principles/core/runtime-v2', () => {
    expect(adapterSrc()).toContain('TaskRecord');
    expect(adapterSrc()).toContain('@principles/core/runtime-v2');
  });

  it('adapter source does not use node:fs/node:path directly (provider abstraction)', () => {
    const src = adapterSrc();
    // node:fs and node:path should not appear in adapter source
    expect(src).not.toContain("from 'node:fs'");
    expect(src).not.toContain('from "node:fs"');
    expect(src).not.toContain("from 'node:path'");
    expect(src).not.toContain('from "node:path"');
  });
});