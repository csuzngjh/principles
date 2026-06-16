/**
 * Core Axiom Block Builder — shared prompt section for CORE_PRINCIPLES injection.
 *
 * Provides a single, consistent way to inject the T-01..T-10 core axiom list
 * into any prompt builder. Used by both the diagnostician pipeline (rootcause,
 * distiller) and the internalization pipeline (dreamer, philosopher, scribe, etc.).
 *
 * ## Design
 *
 * - `formatCorePrinciplesList()` — low-level: just the formatted list lines
 * - `buildCoreAxiomBlock()` — high-level: conditional block with header + instruction
 *
 * Both support bilingual output via `outputLanguage`.
 */

import { CORE_PRINCIPLES } from './core-principle-registry.js';
import type { OutputLanguage } from '../language-directive.js';

// ── Options ──────────────────────────────────────────────────────────────────

export interface CoreAxiomBlockOptions {
  /** Whether to include the core axioms section (default: false). */
  coreGrounding?: boolean;
  /**
   * Section title. Defaults to 'CORE AXIOMS:'.
   * Override for context-specific headers (e.g. 'PHASE 3.5 — Core Axiom Grounding:').
   */
  sectionTitle?: string;
  /**
   * Instruction text after the title, before the list.
   * Defaults to a generic instruction about referencing axiom IDs.
   * Set to '' to omit.
   */
  instruction?: string;
  /** Output language for bilingual principle statements. */
  outputLanguage?: OutputLanguage;
  /** Fallback string when coreGrounding is false (default: ''). */
  fallback?: string;
}

// ── Low-level: formatted list ────────────────────────────────────────────────

/**
 * Format the CORE_PRINCIPLES list as a newline-separated string.
 *
 * Each line: `T-XX: <statement>`
 * When `outputLanguage` is 'zh-CN', uses `statementZh` instead of `statement`.
 *
 * @param outputLanguage - Optional language override for bilingual output.
 * @returns Formatted list string (e.g. "T-01: Understand the structure first...\nT-02: ...")
 */
export function formatCorePrinciplesList(outputLanguage?: OutputLanguage): string {
  const useZh = outputLanguage === 'zh-CN';
  return CORE_PRINCIPLES.map(p => {
    const statement = useZh && p.statementZh ? p.statementZh : p.statement;
    return `${p.id}: ${statement}`;
  }).join('\n');
}

// ── High-level: conditional block ────────────────────────────────────────────

/** Default instruction when none is provided. */
const DEFAULT_INSTRUCTION =
  'The following core axioms are the system\'s foundational behavioral principles.\n' +
  'You MUST only reference axiom IDs from this list. Fabricating IDs not in this\n' +
  'list will cause validation failure.';

/**
 * Build a conditional core axiom block for prompt injection.
 *
 * When `coreGrounding` is true, returns a formatted block containing:
 * - Section title
 * - Instruction text
 * - Formatted principle list
 *
 * When `coreGrounding` is false/undefined, returns `fallback` (default: empty string).
 *
 * ## Usage
 *
 * ```typescript
 * // In a prompt builder:
 * const axiomBlock = buildCoreAxiomBlock({ coreGrounding: true, outputLanguage: 'zh-CN' });
 * return `...existing prompt...\n${axiomBlock}\n...rest...`;
 * ```
 *
 * @param opts - Block options (see CoreAxiomBlockOptions).
 * @returns Formatted block string, or fallback when coreGrounding is off.
 */
export function buildCoreAxiomBlock(opts: CoreAxiomBlockOptions = {}): string {
  const {
    coreGrounding,
    sectionTitle = 'CORE AXIOMS:',
    instruction = DEFAULT_INSTRUCTION,
    outputLanguage,
    fallback = '',
  } = opts;

  if (!coreGrounding) {
    return fallback;
  }

  const principlesList = formatCorePrinciplesList(outputLanguage);

  const parts: string[] = [
    `\n${sectionTitle}`,
  ];

  if (instruction) {
    parts.push(instruction);
  }

  parts.push('');
  parts.push(principlesList);
  parts.push('');

  return parts.join('\n');
}
