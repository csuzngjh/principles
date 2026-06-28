import { parseIntentDocSections, type IntentLang } from './intent-doc.js';

export interface IntentDocVersion {
  id: string;
  lang: IntentLang;
  contentHash: string;
  contentSnapshot: string;
  reason: string | null;
  createdAt: string;
}

export interface IntentDocVersionStore {
  saveVersion(input: { lang: IntentLang; content: string; reason?: string }): Promise<IntentDocVersion>;
  listVersions(lang: IntentLang, limit?: number): Promise<IntentDocVersion[]>;
  getVersion(id: string): Promise<IntentDocVersion | null>;
  getLatest(lang: IntentLang): Promise<IntentDocVersion | null>;
}

const SECTION_KEYS = ['why', 'desiredOutcome', 'nonNegotiables', 'stopEscalation', 'currentStrategicFocus'] as const;

export function computeVersionDiff(
  oldContent: string,
  newContent: string,
): { section: string; changed: boolean }[] {
  const oldSections = parseIntentDocSections(oldContent);
  const newSections = parseIntentDocSections(newContent);
  return SECTION_KEYS.map(key => ({
    section: key,
    changed: (oldSections[key] ?? '') !== (newSections[key] ?? ''),
  }));
}

export function formatVersionSummary(
  version: IntentDocVersion,
  index: number,
): { label: string; preview: string } {
  const versionNumber = `v${index + 1}`;
  // Language-aware fallback for missing reason (CodeRabbit review):
  // English versions should not show Chinese default text.
  const reason = version.reason ?? (version.lang === 'en' ? '(no note)' : '无备注');
  const label = `${versionNumber} · ${reason}`;
  const previewText = version.contentSnapshot.replace(/##\s*\d+\.\s*[^\n]*/g, '').trim();
  const preview = previewText.length > 80 ? previewText.slice(0, 77) + '...' : previewText;
  return { label, preview };
}
