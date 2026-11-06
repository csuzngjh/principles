/**
 * Tool Semantic Baseline — host-neutral alias table (PRI-634-F Phase 1)
 *
 * The baseline maps GENERIC, cross-host tool vocabulary names (the names LLMs
 * produce when no host catalog constrains them) to CanonicalKind. Host tool
 * names live in host declarations layered via buildToolSemanticRegistry —
 * never here (SPEC §5: core owns canonicalKind, hosts own rawToolName).
 *
 * Single source of truth for the table: rule-context-v2's canonicalizeToolKind
 * and tool-semantic-registry's baseline layer both read THIS module.
 *
 * Pure logic — zero I/O.
 */

import type { CanonicalKind } from './rule-context-v2.js';

export const CANONICAL_KIND_VALUES: ReadonlySet<string> = new Set<string>([
  'read',
  'search',
  'write',
  'execute',
  'agent',
  'other',
]);

/** Type guard for untrusted canonicalKind values (rc-2: guard, not `as`). */
export function isCanonicalKind(value: unknown): value is CanonicalKind {
  return typeof value === 'string' && CANONICAL_KIND_VALUES.has(value);
}

/**
 * Host-neutral baseline alias table. Originally the static TOOL_ALIAS table of
 * rule-context-v2 (spec §4.4); PRI-634-F adds the generic LLM vocabulary names
 * observed in Artificer output (execute_command / run_script / code_interpreter
 * — SPEC §1 Problem A) so the baseline resolves the names rules are actually
 * generated against.
 */
export const baselineToolAlias: Readonly<Record<string, CanonicalKind>> = Object.freeze({
  read: 'read',
  read_file: 'read',
  read_many_files: 'read',
  grep: 'search',
  grep_search: 'search',
  search_file_content: 'search',
  glob: 'search',
  write: 'write',
  write_file: 'write',
  edit: 'write',
  edit_file: 'write',
  replace: 'write',
  apply_patch: 'write',
  bash: 'execute',
  exec: 'execute',
  execute: 'execute',
  run_shell_command: 'execute',
  // PRI-634-F baseline additions — generic LLM vocabulary, not host tools:
  execute_command: 'execute',
  run_script: 'execute',
  code_interpreter: 'execute',
  sessions_spawn: 'agent',
});
