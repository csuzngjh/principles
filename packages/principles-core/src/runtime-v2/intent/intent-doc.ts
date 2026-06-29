export interface IntentDocSections { why?: string; desiredOutcome?: string; nonNegotiables?: string; stopEscalation?: string; currentStrategicFocus?: string; }
export type IntentDocWarningCode = 'missing_section' | 'empty_section' | 'too_vague' | 'oversized' | 'parse_failed';
export interface IntentDocWarning { code: IntentDocWarningCode; message: string; section?: string; }
export const INTENT_MAX_BYTES = 32 * 1024;
const MIN_SECTION_LENGTH = 10;
interface SectionDef { key: keyof IntentDocSections; headerRegex: RegExp; label: string; header: string; }
const SECTION_DEFS: SectionDef[] = [
  { key: 'why', headerRegex: /^##\s+1\.\s*Why\s*$/im, label: 'why', header: '## 1. Why' },
  { key: 'desiredOutcome', headerRegex: /^##\s+2\.\s*Desired Outcome\s*$/im, label: 'desiredOutcome', header: '## 2. Desired Outcome' },
  { key: 'nonNegotiables', headerRegex: /^##\s+3\.\s*Non-negotiables\s*$/im, label: 'nonNegotiables', header: '## 3. Non-negotiables' },
  { key: 'stopEscalation', headerRegex: /^##\s+4\.\s*Stop\s*\/\s*Escalation\s*$/im, label: 'stopEscalation', header: '## 4. Stop / Escalation' },
  { key: 'currentStrategicFocus', headerRegex: /^##\s+5\.\s*Current Strategic Focus\s*$/im, label: 'currentStrategicFocus', header: '## 5. Current Strategic Focus' },
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

/**
 * Assemble a complete INTENT.md document from individual sections.
 *
 * Symmetric to `parseIntentDocSections`: round-trip
 * `parseIntentDocSections(assembleIntentDoc(sections))` returns the same
 * sections (for non-empty content). Missing sections still emit their header
 * with empty content, so the assembled doc always has all 5 headers in order.
 *
 * Used by the wizard and the section editor to save user input without
 * hand-written string concatenation in the UI layer.
 */
export function assembleIntentDoc(sections: IntentDocSections): string {
  const parts: string[] = ['# INTENT.md', ''];
  for (const def of SECTION_DEFS) {
    const value = (sections as Record<string, unknown>)[def.key];
    const content = typeof value === 'string' ? value : '';
    parts.push(def.header, '', content, '');
  }
  return parts.join('\n');
}
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

export type IntentLang = 'zh-CN' | 'en';

export function getIntentFilename(lang: IntentLang): string {
  return `INTENT.${lang}.md`;
}

export const INTENT_DOC_TEMPLATE_ZH = `# INTENT.md

## 1. Why

这个项目 / 阶段为什么重要？
它服务于什么长期目标？
它不只是要完成什么任务，而是要解决什么真实问题？

## 2. Desired Outcome

完成后，世界应该发生什么可观察的变化？
什么结果能说明我们更接近目标？
避免写"让产品更好"这种不可比较描述。

## 3. Non-negotiables

为了达成目标，哪些东西不能被牺牲？
例如：Owner 注意力、用户信任、MVP 速度、安全边界、可维护性、品牌调性。

## 4. Stop / Escalation

什么情况下 Agent 必须停下、询问或升级给 Owner？

注意：这些是软升级条件；除非另行编码进 RuleHost，否则不构成硬拦截。

## 5. Current Strategic Focus

当前阶段最重要的战略取舍是什么？
例如：验证痛点优先于架构完美；发布 MVP 优先于功能完整；保护 Owner 注意力优先于自动化覆盖率。
`;

export const INTENT_DOC_TEMPLATE_EN = `# INTENT.md

## 1. Why

Why does this project matter?
What long-term goal does it serve?
What real problem does it solve — beyond just completing tasks?

## 2. Desired Outcome

After completion, what observable change should happen in the world?
What result would indicate we are closer to the goal?
Avoid non-comparable descriptions like "make the product better".

## 3. Non-negotiables

To achieve the goal, what cannot be sacrificed?
Examples: Owner attention, user trust, MVP speed, security boundaries, maintainability, brand voice.

## 4. Stop / Escalation

Under what circumstances must the Agent stop, ask, or escalate to Owner?

Note: These are soft escalation conditions; unless separately encoded into RuleHost, they do not constitute hard blocks.

## 5. Current Strategic Focus

What is the most important strategic trade-off for the current phase?
Examples: Validating pain points over architectural perfection; Shipping MVP over feature completeness; Protecting Owner attention over automation coverage.
`;

export function createIntentTemplate(lang: IntentLang): string {
  if (lang === 'zh-CN') return INTENT_DOC_TEMPLATE_ZH;
  return INTENT_DOC_TEMPLATE_EN;
}