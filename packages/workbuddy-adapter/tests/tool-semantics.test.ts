/**
 * WorkBuddy tool semantic declaration tests (SPEC §4.5): every declared name
 * has in-repo evidence; unknown tools resolve to 'other' and are NEVER
 * fabricated into Write/Bash equivalences; the declaration is consistent
 * with the registry surface the shared gate consumes.
 */
import { describe, expect, it } from 'vitest';
import { WORKBUDDY_TOOL_SEMANTICS, WORKBUDDY_TOOL_SEMANTIC_MAPPINGS } from '../src/tool-semantics.js';

const DECLARED: Readonly<Record<string, 'read' | 'search' | 'write' | 'execute'>> = {
  Read: 'read',
  Glob: 'search',
  Grep: 'search',
  Write: 'write',
  Edit: 'write',
  Bash: 'execute',
  // OG-4 write tool, Owner-authorized for all three hosts on 2026-11-13. Evidence:
  // `SUBMIT_TOOL_NAME` in packages/pd-mcp-server/src/server.ts.
  pd_submit_pain: 'write',
};

describe('WORKBUDDY_TOOL_SEMANTICS', () => {
  it('maps every probe/doc-evidenced WorkBuddy tool name to its canonical kind', () => {
    for (const [raw, canonical] of Object.entries(DECLARED)) {
      expect(WORKBUDDY_TOOL_SEMANTICS.lookup(raw)).toBe(canonical);
      expect(WORKBUDDY_TOOL_SEMANTICS.hasHostTool(raw)).toBe(true);
    }
  });

  it('declares exactly the evidenced surface (no speculative additions)', () => {
    expect(WORKBUDDY_TOOL_SEMANTIC_MAPPINGS.map((mapping) => mapping.rawToolName).sort()).toEqual(Object.keys(DECLARED).sort());
    expect(WORKBUDDY_TOOL_SEMANTICS.hasHostLayer).toBe(true);
  });

  it('classifies the OG-4 write tool as a write so PreToolUse governance can see it', () => {
    expect(WORKBUDDY_TOOL_SEMANTICS.lookup('pd_submit_pain')).toBe('write');
    expect(WORKBUDDY_TOOL_SEMANTICS.hasHostTool('pd_submit_pain')).toBe(true);
    // A host-prefixed MCP name is deliberately NOT guessed: it resolves to
    // 'other', which the rule-context provider treats as an incomplete view.
    expect(WORKBUDDY_TOOL_SEMANTICS.resolve('mcp__pd-recall__pd_submit_pain')).toBe('other');
  });

  it('does NOT fabricate equivalences for unknown or other-host tool names', () => {
    // Unknown WorkBuddy tools: no lookup, graceful 'other' resolution.
    for (const unknown of ['TodoWrite', 'NotebookEdit', 'WebFetch']) {
      expect(WORKBUDDY_TOOL_SEMANTICS.lookup(unknown)).toBeNull();
      expect(WORKBUDDY_TOOL_SEMANTICS.resolve(unknown)).toBe('other');
      expect(WORKBUDDY_TOOL_SEMANTICS.hasHostTool(unknown)).toBe(false);
    }
    // Codex/OpenClaw vocabulary is NOT host-declared on WorkBuddy: a rule
    // generated against it must fail the reliability check rather than pass
    // replay while never firing on a real WorkBuddy event (PRI-634-F).
    for (const otherHost of ['write_file', 'apply_patch', 'shell', 'bash']) {
      expect(WORKBUDDY_TOOL_SEMANTICS.hasHostTool(otherHost)).toBe(false);
    }
  });

  it('exposes the host layer as a read-only projection matching the declaration', () => {
    const projection = WORKBUDDY_TOOL_SEMANTICS.hostMappings();
    expect(projection).toHaveLength(WORKBUDDY_TOOL_SEMANTIC_MAPPINGS.length);
    for (const mapping of WORKBUDDY_TOOL_SEMANTIC_MAPPINGS) {
      expect(projection).toContainEqual(mapping);
    }
  });
});
