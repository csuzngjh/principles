export interface IntentDocSections { why?: string; desiredOutcome?: string; nonNegotiables?: string; stopEscalation?: string; currentStrategicFocus?: string; }
export type IntentDocWarningCode = 'missing_section' | 'empty_section' | 'too_vague' | 'oversized' | 'parse_failed';
export interface IntentDocWarning { code: IntentDocWarningCode; message: string; section?: string; }
export const INTENT_MAX_BYTES = 32 * 1024;
const MIN_SECTION_LENGTH = 10;
interface SectionDef { key: keyof IntentDocSections; headerRegex: RegExp; label: string; header: string; }
// Suffix-tolerant section headings. The canonical wizard format is
// `## 1. Why` (exact, EOL-anchored). Owners writing a localized doc very
// naturally add a separator-introduced annotation to the SAME heading —
// `## 1. Why — 为什么存在` — and the strict anchor parsed every section of
// such a document as missing, silently degrading the whole Intent chain to
// not_configured (found 2026-11-22 in the ON arm of the intent ON/OFF pilot:
// all five sections len=0 while the file carried full Owner content). A
// heading therefore remains canonical when the title is followed by an
// em/en dash, colon or full-width colon and then non-space annotation text.
// Anything else after the title (e.g. `## 1. Why not`) is still NOT the
// canonical section, preserving the exact-title semantics for content that
// merely starts with the section title.
//
// Whitespace inside a heading must stay on the SAME physical line: `\s`
// matches `\n`, so `\\s*` after the title (and inside the annotation
// group) could cross the blank line under a heading and swallow a body
// line that happens to start with `—`, `–` or `:` (PR #2750 review P1-1:
// `## 3. Non-negotiables\n\n— 不得编造事实。` parsed the first real
// constraint INTO the heading match, and parseIntentDocSections then
// dropped it from the section body — a data-loss defect, not a style
// issue). `[^\\S\\n]` is "\s minus newline": same-line whitespace only,
// applied to EVERY gap inside the heading pattern for the same reason.
const HWS = '[^\\S\\n]';
const SUFFIX_ANNOTATION = `(?:${HWS}*[—–:：]${HWS}*\\S.*)?`;
const SECTION_DEFS: SectionDef[] = [
  { key: 'why', headerRegex: new RegExp(`^##${HWS}+1\\.${HWS}*Why${HWS}*${SUFFIX_ANNOTATION}$`, 'im'), label: 'why', header: '## 1. Why' },
  { key: 'desiredOutcome', headerRegex: new RegExp(`^##${HWS}+2\\.${HWS}*Desired Outcome${HWS}*${SUFFIX_ANNOTATION}$`, 'im'), label: 'desiredOutcome', header: '## 2. Desired Outcome' },
  { key: 'nonNegotiables', headerRegex: new RegExp(`^##${HWS}+3\\.${HWS}*Non-negotiables${HWS}*${SUFFIX_ANNOTATION}$`, 'im'), label: 'nonNegotiables', header: '## 3. Non-negotiables' },
  { key: 'stopEscalation', headerRegex: new RegExp(`^##${HWS}+4\\.${HWS}*Stop${HWS}*\\/${HWS}*Escalation${HWS}*${SUFFIX_ANNOTATION}$`, 'im'), label: 'stopEscalation', header: '## 4. Stop / Escalation' },
  { key: 'currentStrategicFocus', headerRegex: new RegExp(`^##${HWS}+5\\.${HWS}*Current Strategic Focus${HWS}*${SUFFIX_ANNOTATION}$`, 'im'), label: 'currentStrategicFocus', header: '## 5. Current Strategic Focus' },
];
export function parseIntentDocSections(raw: string): IntentDocSections {
  const sections: IntentDocSections = {};
  for (const def of SECTION_DEFS) {
    const match = def.headerRegex.exec(raw);
    if (match === null) { continue; }
    const rest = raw.slice(match.index + match[0].length);
    const next = /^##\s+/m.exec(rest);
    // Direct assignment is type-safe: def.key is keyof IntentDocSections,
    // all fields are `string | undefined`, and we assign a string.
    sections[def.key] = rest.slice(0, next !== null ? next.index : rest.length).trim();
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

// ── Deterministic section-state classification (SIA §7, SPEC §20.1) ──────────
//
// The Owner's strategic intent is ONLY what the Owner actually wrote. A section
// that keeps the shipped template question, or only carries TODO/TBD noise, is
// NOT Owner intent — feeding it to the model (or into the V2 contract) makes a
// template question look like a strategic basis.
//
// Classification is deterministic and pure: no I/O, no clock, no LLM. The rules
// are shared by the prompt hook, the Stage A snapshot and the V2 contract so
// "authored" means exactly one thing across the system.

export type IntentSectionState = 'authored' | 'placeholder' | 'missing';

export interface IntentSectionAnalysis {
  /** Existing document field name — no fourth section-key namespace. */
  readonly key: keyof IntentDocSections;
  readonly state: IntentSectionState;
  /** The original body (never rewritten by classification). */
  readonly content: string;
}

const ZERO_WIDTH = /[\u200b-\u200d\ufeff]/g;
const PLACEHOLDER_NOISE = [
  /^(todo|tbd|fixme)\b/i,
  /^(待填写|待补充|请填写|待定|待确认|补充说明)$/,
  /^(\.{3}|…)$/,
];

/** Whitespace-normalise one line so formatting differences cannot flip a state. */
function normalizeLine(line: string): string {
  return line
    .replace(ZERO_WIDTH, '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t\u3000]+/g, ' ')
    .trim();
}

/** Strip a markdown list/quote marker before comparing with a template line. */
function stripListMarker(line: string): string {
  return line.replace(/^(?:[-*+>]\s+|\d+[.)]\s+)/, '').trim();
}

function isPlaceholderNoiseLine(line: string): boolean {
  const bare = stripListMarker(line);
  return PLACEHOLDER_NOISE.some((pattern) => pattern.test(bare));
}

/**
 * Non-empty, normalised lines of the shipped template for ONE section.
 *
 * The legacy generic `INTENT_DOC_TEMPLATE` is included for every language: it
 * shipped in earlier releases, so documents created from it still exist and its
 * questions are just as much a placeholder as the current ones.
 */
function templateQuestionLines(
  key: keyof IntentDocSections,
  lang: IntentLang,
): ReadonlySet<string> {
  const lines = new Set<string>();
  for (const template of [createIntentTemplate(lang), INTENT_DOC_TEMPLATE]) {
    const body = parseIntentDocSections(template)[key];
    if (typeof body !== 'string') continue;
    for (const line of body.split('\n')) {
      const normalized = normalizeLine(line);
      if (normalized !== '') lines.add(stripListMarker(normalized));
    }
  }
  return lines;
}

/**
 * Classify ONE section body.
 *
 * Ordering is the contract (first match wins):
 *   1. absent              -> missing
 *   2. blank after normalisation -> missing
 *   3. only template lines / TODO noise left -> placeholder
 *   4. anything else       -> authored   (template + real answer is authored)
 */
export function classifyIntentSectionContent(
  key: keyof IntentDocSections,
  content: string | undefined,
  lang: IntentLang,
): IntentSectionAnalysis {
  if (typeof content !== 'string') return { key, state: 'missing', content: '' };

  const lines = content
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(normalizeLine)
    .filter((line) => line !== '');
  if (lines.length === 0) return { key, state: 'missing', content };

  const questions = templateQuestionLines(key, lang);
  const residual = lines.filter(
    (line) => !questions.has(stripListMarker(line)) && !isPlaceholderNoiseLine(line),
  );
  return residual.length === 0
    ? { key, state: 'placeholder', content }
    : { key, state: 'authored', content };
}

/** Classify all five sections of a parsed document, in document order. */
export function analyzeIntentDocSections(
  sections: IntentDocSections,
  lang: IntentLang,
): IntentSectionAnalysis[] {
  return SECTION_DEFS.map((def) => classifyIntentSectionContent(def.key, sections[def.key], lang));
}

/** Document-level availability derived from per-section states. */
export function deriveIntentDocState(
  analyses: readonly IntentSectionAnalysis[],
): 'not_configured' | 'partially_configured' | 'configured' {
  const authored = analyses.filter((analysis) => analysis.state === 'authored').length;
  if (authored === 0) return 'not_configured';
  return authored === SECTION_DEFS.length ? 'configured' : 'partially_configured';
}

// ── Structured degradation reason (PRI-1287, rc-9) ──────────────────────────
//
// `not_configured` is a VERDICT, not an explanation. Both ways to reach it look
// identical downstream (`intentSnapshot` absent → relevance `not_configured`),
// but they demand opposite Owner actions:
//
//   - no_parsed_section — the canonical headings were never recognised (wrong
//     title, localized title, or empty bodies). The Owner may have written a
//     full document that the whole chain still refuses to read. This is exactly
//     the shape that hid for weeks in the 2026-11-22 intent ON/OFF pilot before
//     the heading-suffix fix (PRI-1284).
//   - placeholder_only — the five sections parsed, but they still carry the
//     shipped template questions / TODO noise. Nothing is wrong with the file;
//     the Owner simply has not answered yet.
//
// Telling an Owner who already wrote five sections to "fill in a section" is a
// misleading nextAction, so the reason and the nextAction are derived together
// and carried on the same record (the Stage A telemetry event).

/** Canonical headings, in document order — the ONLY headings the parser accepts. */
export const INTENT_DOC_CANONICAL_HEADINGS =
  '## 1. Why / ## 2. Desired Outcome / ## 3. Non-negotiables / ## 4. Stop / Escalation / ## 5. Current Strategic Focus';

/**
 * Why a document carries no Owner-authored section.
 *
 * `no_authored_section` is a defensive fallback only: the classifier cannot
 * reach it while `analyzeIntentDocSections` stays total, but a caller that
 * already proved `hasAuthoredSnapshotSections=false` must never be handed
 * `null` and left to invent wording.
 */
export type IntentDocDegradationReason =
  | 'no_parsed_section'
  | 'placeholder_only'
  | 'no_authored_section';

export interface IntentDocDegradation {
  readonly reason: IntentDocDegradationReason;
  /** How many of the five canonical headings were recognised AND carry text. */
  readonly parsedSectionCount: number;
  /** Owner-facing recovery step; always present, never a bare restatement. */
  readonly nextAction: string;
}

/**
 * Explain why a parsed document has no Owner-authored section, or return `null`
 * when it has at least one (the normal path produces no degradation record).
 *
 * Deterministic and pure — same classification rules as
 * `analyzeIntentDocSections`, so this explanation can never disagree with the
 * trust boundary that dropped the snapshot.
 */
export function deriveIntentDocDegradation(
  sections: IntentDocSections,
  lang: IntentLang,
): IntentDocDegradation | null {
  const analyses = analyzeIntentDocSections(sections, lang);
  const parsed = analyses.filter((analysis) => analysis.state !== 'missing');
  if (analyses.some((analysis) => analysis.state === 'authored')) return null;

  const parsedSectionCount = parsed.length;
  if (parsedSectionCount === 0) {
    return {
      reason: 'no_parsed_section',
      parsedSectionCount,
      nextAction:
        `INTENT.md carries no readable section body. Use the canonical headings exactly (${INTENT_DOC_CANONICAL_HEADINGS}) and put content under at least one of them; content under any other heading is never read as Owner intent.`,
    };
  }
  return {
    reason: 'placeholder_only',
    parsedSectionCount,
    nextAction:
      'INTENT.md still carries only the shipped template questions or TODO noise. Replace at least one section with the Owner\'s own answer; template text is not treated as Owner intent.',
  };
}