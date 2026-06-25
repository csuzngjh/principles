import { createHash } from 'node:crypto';
export interface IntentDocSections { why?: string; desiredOutcome?: string; nonNegotiables?: string; stopEscalation?: string; currentStrategicFocus?: string; }
export type IntentDocWarningCode = 'missing_section' | 'empty_section' | 'too_vague' | 'oversized' | 'parse_failed';
export interface IntentDocWarning { code: IntentDocWarningCode; message: string; section?: string; }
export const INTENT_MAX_BYTES = 32 * 1024;
const MIN_SECTION_LENGTH = 10;
interface SectionDef { key: keyof IntentDocSections; headerRegex: RegExp; label: string; }
const SECTION_DEFS: SectionDef[] = [
  { key: 'why', headerRegex: /^##\s+1\.\s*Why\s*$/im, label: 'why' },
  { key: 'desiredOutcome', headerRegex: /^##\s+2\.\s*Desired Outcome\s*$/im, label: 'desiredOutcome' },
  { key: 'nonNegotiables', headerRegex: /^##\s+3\.\s*Non-negotiables\s*$/im, label: 'nonNegotiables' },
  { key: 'stopEscalation', headerRegex: /^##\s+4\.\s*Stop\s*\/\s*Escalation\s*$/im, label: 'stopEscalation' },
  { key: 'currentStrategicFocus', headerRegex: /^##\s+5\.\s*Current Strategic Focus\s*$/im, label: 'currentStrategicFocus' },
];
export function parseIntentDocSections(raw: string): IntentDocSections {
  const sections: IntentDocSections = {};
  for (const def of SECTION_DEFS) {
    const match = def.headerRegex.exec(raw);
    if (match === null) { continue; }
    const rest = raw.slice(match.index + match[0].length);
    const next = /^##\s+/m.exec(rest);
    (sections as Record<string, string>)[def.key] = rest.slice(0, next !== null ? next.index : rest.length).trim();
  }
  return sections;
}
export function computeIntentContentHash(raw: string): string { return `sha256:${createHash('sha256').update(raw, 'utf8').digest('hex')}`; }
export function validateIntentDocSections(sections: IntentDocSections): IntentDocWarning[] {
  const warnings: IntentDocWarning[] = [];
  for (const def of SECTION_DEFS) {
    const hasKey = Object.hasOwn(sections, def.key);
    const value = hasKey ? (sections as Record<string, unknown>)[def.key] : undefined;
    if (value === undefined) { warnings.push({ code: 'missing_section', message: `Section "${def.label}" is missing from INTENT.md.`, section: def.label }); continue; }
    if (typeof value !== 'string') { warnings.push({ code: 'parse_failed', message: `Section "${def.label}" has a non-string value.`, section: def.label }); continue; }
    if (value.trim().length === 0) { warnings.push({ code: 'empty_section', message: `Section "${def.label}" is empty.`, section: def.label }); continue; }
    if (value.length < MIN_SECTION_LENGTH) { warnings.push({ code: 'too_vague', message: `Section "${def.label}" is too short.`, section: def.label }); }
  }
  return warnings;
}
export const INTENT_DOC_TEMPLATE = `# INTENT.md

## 1. Why

Why does this project matter?

## 2. Desired Outcome

What observable change should happen?

## 3. Non-negotiables

What cannot be sacrificed?

## 4. Stop / Escalation

When must the Agent stop and ask?

## 5. Current Strategic Focus

What is the current strategic trade-off?
`;