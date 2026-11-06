// render-markdown.ts
// Renders a FeedbackReport to a stable Markdown representation.
// ERR-014/016/017: bounded output, correct '\n' newlines, BigInt-safe via safeStringifyPreview.

import type { FeedbackReport } from './feedback-types.js';
import { redactAbsolutePaths, redactTokenLikeValues, redactEnvLikeValues } from './redact-sensitive.js';
import { safeStringifyPreview } from './safe-stringify.js';

export const MAX_MARKDOWN_LENGTH = 10240;

const MAX_DESCRIPTION_IN_MD = 1500;
const MAX_STEPS_IN_MD = 1500;
const MAX_FIELD_IN_MD = 1500;
const MAX_EVENTS_IN_MD = 3;
const MAX_CONTEXT_REFS_IN_MD = 12;
const MAX_REDACTION_NOTES_IN_MD = 12;

type SafeOpts = { notes?: string[]; fieldLabel?: string };

function safe(
  s: string | undefined,
  max: number,
  opts: SafeOpts = {},
): { text: string; truncated: boolean } {
  if (typeof s !== 'string') return { text: '', truncated: false };
  if (s.length <= max) return { text: s, truncated: false };
  const { notes, fieldLabel } = opts;
  if (notes && fieldLabel) {
    if (!notes.some((n) => n.includes(fieldLabel) && n.includes('truncat'))) {
      notes.push(`${fieldLabel} was truncated to ${max} characters`);
    }
  }
  return { text: s.slice(0, max) + '…', truncated: true };
}

/**
 * Render a FeedbackReport to a Markdown string.
 * Uses real `\n` newlines (not the broken `'\\n'` literal).
 * Output is bounded to MAX_MARKDOWN_LENGTH characters.
 *
 * Mutates `report.privacy.redactionNotes` to record field-level truncation
 * events (ERR-014). The renderer never throws.
 */
export function renderReportMarkdown(report: FeedbackReport): string {
  const parts: string[] = [];
  parts.push(`# Feedback Report: ${redactAbsolutePaths(report.title)}`);
  parts.push('');
  parts.push(`- ID: \`${report.id}\``);
  parts.push(`- Created: \`${report.createdAt}\``);
  parts.push(`- Type: \`${report.type}\``);
  const severity = report.userText.userSeverity;
  parts.push(`- User severity: ${severity ? `\`${severity}\`` : '_(not provided)_'}`);
  parts.push('');

  // Agent draft (if provided) — preserves caller-attached evidence summary.
  if (report.agentDraft) {
    parts.push('## Agent draft');
    const summary = safe(report.agentDraft.summary, MAX_FIELD_IN_MD, { notes: report.privacy.redactionNotes, fieldLabel: 'agentDraft.summary' });
    parts.push(summary.text);
    if (report.agentDraft.observedFailure) {
      const obs = safe(report.agentDraft.observedFailure, MAX_FIELD_IN_MD, { notes: report.privacy.redactionNotes, fieldLabel: 'agentDraft.observedFailure' });
      parts.push('');
      parts.push(`**Observed failure:** ${obs.text}`);
    }
    if (report.agentDraft.commandSummary) {
      const cmd = safe(report.agentDraft.commandSummary, MAX_FIELD_IN_MD, { notes: report.privacy.redactionNotes, fieldLabel: 'agentDraft.commandSummary' });
      parts.push('');
      parts.push(`**Command:** ${cmd.text}`);
    }
    parts.push('');
  }

  parts.push('## Description');
  const desc = safe(report.userText.description, MAX_DESCRIPTION_IN_MD, { notes: report.privacy.redactionNotes, fieldLabel: 'description' });
  parts.push(desc.text);
  parts.push('');

  if (report.userText.stepsToReproduce) {
    const steps = safe(report.userText.stepsToReproduce, MAX_STEPS_IN_MD, { notes: report.privacy.redactionNotes, fieldLabel: 'stepsToReproduce' });
    parts.push('## Steps to reproduce');
    parts.push('```');
    parts.push(steps.text);
    parts.push('```');
    parts.push('');
  }
  if (report.userText.expectedBehavior) {
    const exp = safe(report.userText.expectedBehavior, MAX_FIELD_IN_MD, { notes: report.privacy.redactionNotes, fieldLabel: 'expectedBehavior' });
    parts.push('## Expected behavior');
    parts.push(exp.text);
    parts.push('');
  }
  if (report.userText.actualBehavior) {
    const act = safe(report.userText.actualBehavior, MAX_FIELD_IN_MD, { notes: report.privacy.redactionNotes, fieldLabel: 'actualBehavior' });
    parts.push('## Actual behavior');
    parts.push(act.text);
    parts.push('');
  }

  // ── 类型化新字段(Slice 1, PRI-543):按 type 条件渲染,减少噪声 ──
  const typedSection = (title: string, raw: string | undefined) => {
    if (!raw) return;
    const t = safe(raw, MAX_FIELD_IN_MD, { notes: report.privacy.redactionNotes, fieldLabel: title });
    parts.push(`## ${title}`);
    parts.push(t.text);
    parts.push('');
  };
  if (report.type === 'confusing') {
    typedSection('What I wanted to do', report.userText.goal);
    typedSection('Where I got stuck', report.userText.stuckAt);
  } else if (report.type === 'feature_request') {
    typedSection('Goal', report.userText.job);
    typedSection('Current workaround', report.userText.currentWorkaround);
  } else if (report.type === 'privacy_concern') {
    typedSection('What I saw', report.userText.sawWhat);
    typedSection('Where I saw it', report.userText.whereSeen);
  }
  if (report.userText.frequency) {
    parts.push(`- Frequency: \`${report.userText.frequency}\``);
    parts.push('');
  }
  if (report.userText.blockingLevel) {
    parts.push(`- Blocking level: \`${report.userText.blockingLevel}\``);
    parts.push('');
  }
  if (report.area) {
    parts.push(`- Area: \`${report.area}\``);
    parts.push('');
  }

  parts.push('## Diagnostic summary');
  parts.push('');
  parts.push('### Versions');
  parts.push('```json');
  parts.push(safeStringifyPreview(report.diagnosticSummary.versions));
  parts.push('```');
  parts.push('');
  parts.push('### Platform');
  parts.push('```json');
  parts.push(safeStringifyPreview(report.diagnosticSummary.platform));
  parts.push('```');
  parts.push('');
  parts.push('### Feature flags');
  parts.push('```json');
  parts.push(safeStringifyPreview(report.diagnosticSummary.featureFlags));
  parts.push('```');
  parts.push('');
  parts.push('### Canary');
  if (report.diagnosticSummary.canary.status === 'available') {
    parts.push(`- status: available`);
    if (report.diagnosticSummary.canary.summary) {
      parts.push(`- summary: ${report.diagnosticSummary.canary.summary}`);
    }
  } else {
    parts.push(`- status: unavailable`);
    if (report.diagnosticSummary.canary.unavailableReason) {
      parts.push(`- reason: ${report.diagnosticSummary.canary.unavailableReason}`);
    }
  }
  parts.push('');

  if (report.diagnosticSummary.recentEvents.length > 0) {
    parts.push('### Recent events');
    const evs = report.diagnosticSummary.recentEvents.slice(0, MAX_EVENTS_IN_MD);
    for (const ev of evs) {
      const sevPart = ev.severity ? ` [${ev.severity}]` : '';
      parts.push(`- \`${ev.type}\`${sevPart} @ ${ev.at} — ${ev.summary}`);
    }
    if (report.diagnosticSummary.recentEvents.length > MAX_EVENTS_IN_MD) {
      parts.push(`- …(${report.diagnosticSummary.recentEvents.length - MAX_EVENTS_IN_MD} more events omitted)`);
    }
    parts.push('');
  }

  if (report.contextRefs.length > 0) {
    parts.push('## Context references');
    const refs = report.contextRefs.slice(0, MAX_CONTEXT_REFS_IN_MD);
    for (const r of refs) {
      const labelPart = r.label ? ` — ${r.label}` : '';
      parts.push(`- \`${r.kind}\`: \`${r.id}\`${labelPart}`);
    }
    parts.push('');
  }

  parts.push('## Privacy');
  parts.push('');
  parts.push('### Included by default');
  parts.push(report.privacy.includedSections.map((s) => `- ${s}`).join('\n'));
  parts.push('');
  parts.push('### Excluded by default');
  parts.push(report.privacy.excludedByDefault.map((s) => `- ${s}`).join('\n'));
  parts.push('');
  if (report.privacy.redactionNotes.length > 0) {
    parts.push('### Redaction notes');
    const notes = report.privacy.redactionNotes.slice(0, MAX_REDACTION_NOTES_IN_MD);
    for (const n of notes) parts.push(`- ${n}`);
    parts.push('');
  }

  let md = parts.join('\n');
  // Also run the redactors over the whole document as a defense-in-depth pass
  // (paths/tokens/env values that slipped through specific fields are still scrubbed here).
  md = redactAbsolutePaths(md);
  md = redactTokenLikeValues(md);
  md = redactEnvLikeValues(md);
  if (md.length > MAX_MARKDOWN_LENGTH) {
    md = md.slice(0, MAX_MARKDOWN_LENGTH) + '\n\n_…(truncated to ' + MAX_MARKDOWN_LENGTH + ' chars)_';
    if (!report.privacy.redactionNotes.some((n) => n.includes('Markdown'))) {
      report.privacy.redactionNotes.push('Markdown output was truncated to MAX_MARKDOWN_LENGTH characters');
    }
  }
  return md;
}
