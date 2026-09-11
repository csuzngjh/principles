/**
 * OpenClaw Tool Semantic Declaration tests — PRI-634-F Phase 1, corrected in
 * PRI-741.
 *
 * The original header pinned the belief that shell/cmd/insert/patch/
 * delete_file/move_file are real OpenClaw gate tools (pri-634-f-baseline-report
 * §2). The 2026-09-11 OpenClaw source ground truth overturns that: the file
 * mutation family is exactly write/edit/apply_patch (tool-mutation-names.ts),
 * the shell tool is `exec` (bash etc. are config aliases that never reach the
 * hook payload), and no delete_file/move_file tools exist. Declaring those
 * phantom names in the HOST layer made `hasHostTool` pass for rules that can
 * never fire — the exact silent-no-trigger failure class PRI-741 removes.
 */

import { describe, expect, it } from 'vitest';
import { OPENCLAW_TOOL_SEMANTICS, OPENCLAW_TOOL_SEMANTIC_MAPPINGS } from '../../src/constants/tool-semantics.js';
import { BASH_TOOL_NAMES, LOW_RISK_WRITE_TOOL_NAMES, AGENT_TOOL_NAMES } from '../../src/constants/tools.js';

describe('OPENCLAW_TOOL_SEMANTICS — host declaration', () => {
  it('resolves the real shell tool (exec) the gate dispatches', () => {
    for (const toolName of BASH_TOOL_NAMES) {
      expect(OPENCLAW_TOOL_SEMANTICS.resolve(toolName), `shell tool '${toolName}'`).toBe('execute');
    }
    expect(BASH_TOOL_NAMES).toEqual(['exec']);
  });

  it('resolves the real write family (write/edit/apply_patch) the gate dispatches', () => {
    for (const toolName of LOW_RISK_WRITE_TOOL_NAMES) {
      expect(OPENCLAW_TOOL_SEMANTICS.resolve(toolName), `write tool '${toolName}'`).toBe('write');
    }
    expect([...LOW_RISK_WRITE_TOOL_NAMES].sort()).toEqual(['apply_patch', 'edit', 'write']);
  });

  it('resolves agent tools', () => {
    for (const toolName of AGENT_TOOL_NAMES) {
      expect(OPENCLAW_TOOL_SEMANTICS.resolve(toolName), `agent tool '${toolName}'`).toBe('agent');
    }
  });

  it('PRI-741: phantom names are gone from the host layer — semantic classification survives via the baseline, dispatchability is denied', () => {
    // Semantic resolvability (classification) and host dispatchability
    // (existence) are SEPARATE axes (review P1): write_file/bash/delete_file
    // classify fine via the core baseline — and rules declared against them
    // must be REJECTED at activation because OpenClaw never dispatches them.
    for (const phantom of ['write_file', 'edit_file', 'replace', 'insert', 'patch', 'bash', 'shell', 'cmd', 'delete_file', 'move_file']) {
      expect(OPENCLAW_TOOL_SEMANTICS.hasHostTool(phantom), `phantom '${phantom}'`).toBe(false);
    }
    expect(OPENCLAW_TOOL_SEMANTICS.resolve('write_file')).toBe('write');
    expect(OPENCLAW_TOOL_SEMANTICS.resolve('bash')).toBe('execute');
    expect(OPENCLAW_TOOL_SEMANTICS.resolve('execute_command')).toBe('execute');
    expect(OPENCLAW_TOOL_SEMANTICS.resolve('read_file')).toBe('read');
    expect(OPENCLAW_TOOL_SEMANTICS.hasHostTool('execute_command')).toBe(false);
    expect(OPENCLAW_TOOL_SEMANTICS.hasHostTool('read_file')).toBe(false);
    expect(OPENCLAW_TOOL_SEMANTICS.hasHostTool('grep')).toBe(false);
  });

  it('every gate-routed tool family is host-declared (a rule on them can really fire)', () => {
    expect(OPENCLAW_TOOL_SEMANTICS.hasHostTool('exec')).toBe(true);
    expect(OPENCLAW_TOOL_SEMANTICS.hasHostTool('write')).toBe(true);
    expect(OPENCLAW_TOOL_SEMANTICS.hasHostTool('edit')).toBe(true);
    expect(OPENCLAW_TOOL_SEMANTICS.hasHostTool('apply_patch')).toBe(true);
    expect(OPENCLAW_TOOL_SEMANTICS.hasHostTool('sessions_spawn')).toBe(true);
    expect(OPENCLAW_TOOL_SEMANTICS.hasHostLayer).toBe(true);
  });

  it('unknown tools stay unknown for validation (lookup null) and other at runtime', () => {
    expect(OPENCLAW_TOOL_SEMANTICS.lookup('pd-status')).toBeNull();
    expect(OPENCLAW_TOOL_SEMANTICS.resolve('pd-status')).toBe('other');
    expect(OPENCLAW_TOOL_SEMANTICS.hasHostTool('pd-status')).toBe(false);
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

  it('PRI-741: hostMappings() projects exactly the real host dispatch surface', () => {
    const byName = new Map(OPENCLAW_TOOL_SEMANTICS.hostMappings().map((m) => [m.rawToolName, m.canonicalKind]));
    expect([...byName.keys()].sort()).toEqual(['apply_patch', 'edit', 'exec', 'sessions_spawn', 'write']);
    expect(byName.get('write')).toBe('write');
    expect(byName.get('exec')).toBe('execute');
    expect(byName.get('sessions_spawn')).toBe('agent');
    expect(byName.has('write_file')).toBe(false);
  });
});
