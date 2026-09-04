/**
 * Codex Tool Semantic Declaration tests — PRI-634-F R3 (SPEC P1-3)
 *
 * The declaration must cover every name the installer's hook matcher
 * actually routes to PD (`Bash|apply_patch`,
 * create-principles-disciple/src/installers/codex-host-installer.ts:203).
 * A rule generated against an undeclared-but-real Codex tool would fail
 * reliability validation with tool_not_host_dispatchable — correct behavior
 * ONLY if the name truly is undeclared; a REAL tool must be declared.
 */

import { describe, expect, it } from 'vitest';
import { CODEX_TOOL_SEMANTICS, CODEX_TOOL_SEMANTIC_MAPPINGS } from '../src/tool-semantics.js';

describe('CODEX_TOOL_SEMANTICS — SPEC Test 4 (apply_patch reachable)', () => {
  it('apply_patch is host-declared and resolves to write (SPEC Test 4)', () => {
    expect(CODEX_TOOL_SEMANTICS.hasHostTool('apply_patch')).toBe(true);
    expect(CODEX_TOOL_SEMANTICS.resolve('apply_patch')).toBe('write');
  });

  it('Bash (capitalized) is host-declared; baseline lowercase bash is NOT Codex dispatchable', () => {
    expect(CODEX_TOOL_SEMANTICS.hasHostTool('Bash')).toBe(true);
    expect(CODEX_TOOL_SEMANTICS.hasHostTool('bash')).toBe(false);
    // Classification still works through the baseline for facts…
    expect(CODEX_TOOL_SEMANTICS.resolve('bash')).toBe('execute');
  });

  it('every declared mapping names a tool the installer matcher routes', () => {
    const routed = new Set(['Bash', 'apply_patch']);
    for (const m of CODEX_TOOL_SEMANTIC_MAPPINGS) {
      expect(routed.has(m.rawToolName), `'${m.rawToolName}' must be routed by the installer matcher`).toBe(true);
    }
  });
});
