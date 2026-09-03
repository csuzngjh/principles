/**
 * OpenClaw Tool Semantic Declaration tests — PRI-634-F Phase 1
 *
 * Pins the host-layer closure of the vocabulary drift documented in
 * docs/pri-634-f-baseline-report.md §2: shell/cmd/insert/patch/delete_file/
 * move_file are real OpenClaw gate tools that previously degraded to
 * canonicalKind 'other' while the gate classified them as bash/write.
 */

import { describe, expect, it } from 'vitest';
import { OPENCLAW_TOOL_SEMANTICS, OPENCLAW_TOOL_SEMANTIC_MAPPINGS } from '../../src/constants/tool-semantics.js';
import { BASH_TOOL_NAMES, LOW_RISK_WRITE_TOOL_NAMES, AGENT_TOOL_NAMES } from '../../src/constants/tools.js';

describe('OPENCLAW_TOOL_SEMANTICS — host declaration', () => {
  it('resolves every bash alias the gate dispatches (shell/cmd included)', () => {
    for (const toolName of BASH_TOOL_NAMES) {
      expect(OPENCLAW_TOOL_SEMANTICS.resolve(toolName), `bash alias '${toolName}'`).toBe('execute');
    }
    expect(OPENCLAW_TOOL_SEMANTICS.resolve('shell')).toBe('execute');
    expect(OPENCLAW_TOOL_SEMANTICS.resolve('cmd')).toBe('execute');
  });

  it('resolves every write-family tool the gate dispatches', () => {
    for (const toolName of LOW_RISK_WRITE_TOOL_NAMES) {
      expect(OPENCLAW_TOOL_SEMANTICS.resolve(toolName), `write tool '${toolName}'`).toBe('write');
    }
    expect(OPENCLAW_TOOL_SEMANTICS.resolve('delete_file')).toBe('write');
    expect(OPENCLAW_TOOL_SEMANTICS.resolve('move_file')).toBe('write');
  });

  it('resolves agent tools', () => {
    for (const toolName of AGENT_TOOL_NAMES) {
      expect(OPENCLAW_TOOL_SEMANTICS.resolve(toolName), `agent tool '${toolName}'`).toBe('agent');
    }
  });

  it('keeps core-baseline generic names resolvable (execute_command → execute)', () => {
    // SPEC Phase 1 acceptance #1: the same execute_command resolves to execute
    // on both the baseline (replay without host layer) and the host registry.
    expect(OPENCLAW_TOOL_SEMANTICS.resolve('execute_command')).toBe('execute');
    expect(OPENCLAW_TOOL_SEMANTICS.resolve('exec')).toBe('execute');
  });

  it('unknown tools stay unknown for validation (lookup null) and other at runtime', () => {
    expect(OPENCLAW_TOOL_SEMANTICS.lookup('pd-status')).toBeNull();
    expect(OPENCLAW_TOOL_SEMANTICS.resolve('pd-status')).toBe('other');
  });

  it('the declaration is derived from constants/tools.ts (one name list, two axes)', () => {
    const declared = new Set(OPENCLAW_TOOL_SEMANTIC_MAPPINGS.map((m) => m.rawToolName));
    // Every dispatch-relevant name in the constants file must appear in the
    // semantic declaration — a new tool added to constants/tools.ts without a
    // semantic mapping fails here (anti-drift).
    for (const toolName of [...BASH_TOOL_NAMES, ...LOW_RISK_WRITE_TOOL_NAMES, ...AGENT_TOOL_NAMES]) {
      expect(declared.has(toolName), `'${toolName}' in constants/tools.ts is missing a semantic mapping`).toBe(true);
    }
  });
});
