/**
 * IntentSnapshot — pure-shape tests (SPEC v1.2 §6.2 / §6.3, TECH v1.1 §3.3).
 *
 * These tests pin the CONTRACT, not the runner:
 *   - section text comes from the existing deterministic parser, never the model
 *   - absent/empty sections are recorded as `missing`, never back-filled
 *   - oversized sections are bounded and flagged `truncated`
 *   - the server-computed hash is carried verbatim
 *   - persisted snapshots are re-validated element-wise (rc-1 / rc-4)
 *   - the artifact narrowing keeps the declared sections only
 */
import { describe, it, expect } from 'vitest';
import {
  INTENT_SNAPSHOT_SCHEMA_VERSION,
  INTENT_SNAPSHOT_SECTION_KEYS,
  buildIntentSnapshot,
  filterIntentSnapshotSections,
  intentSnapshotSectionsToDoc,
  isValidIntentSnapshot,
  renderIntentSnapshotDoc,
  type IntentSnapshot,
} from '../intent-snapshot.js';

const RAW = `# INTENT.md

## 1. Why
Owner trust comes before feature speed.

## 2. Desired Outcome
Every principle is traceable to the strategic basis that produced it.

## 3. Non-negotiables
No unverified claims.

## 4. Stop / Escalation
Stop when a conflict is confirmed and unresolved.

## 5. Current Strategic Focus
Close the intent → principle → evidence loop.
`;

const HASH = 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function build(): IntentSnapshot {
  return buildIntentSnapshot({
    raw: RAW,
    contentHash: HASH,
    capturedAt: '2026-11-14T10:00:00.000Z',
    lang: 'zh-CN',
  });
}

describe('buildIntentSnapshot', () => {
  it('captures all five sections from the deterministic parser', () => {
    const snapshot = build();
    expect(snapshot.schemaVersion).toBe(INTENT_SNAPSHOT_SCHEMA_VERSION);
    expect(snapshot.contentHash).toBe(HASH);
    expect(snapshot.capturedAt).toBe('2026-11-14T10:00:00.000Z');
    expect(snapshot.lang).toBe('zh-CN');
    expect(snapshot.sections.map((s) => s.key)).toEqual([...INTENT_SNAPSHOT_SECTION_KEYS]);
    expect(snapshot.sections.find((s) => s.key === 'why')?.text)
      .toBe('Owner trust comes before feature speed.');
    expect(snapshot.sections.every((s) => s.missing !== true)).toBe(true);
  });

  it('records absent and empty sections as missing without inventing text', () => {
    const raw = `# INTENT.md

## 1. Why
Only why.

## 3. Non-negotiables
`;
    const snapshot = buildIntentSnapshot({
      raw,
      contentHash: HASH,
      capturedAt: '2026-11-14T10:00:00.000Z',
      lang: 'en',
    });
    const byKey = new Map(snapshot.sections.map((s) => [s.key, s]));
    expect(byKey.get('why')?.text).toBe('Only why.');
    expect(byKey.get('desired_outcome')).toEqual({ key: 'desired_outcome', text: '', missing: true });
    expect(byKey.get('non_negotiables')).toEqual({ key: 'non_negotiables', text: '', missing: true });
    expect(snapshot.lang).toBe('en');
  });

  it('bounds oversized sections and flags them as truncated', () => {
    const longBody = 'x'.repeat(200);
    const raw = `# INTENT.md\n\n## 1. Why\n${longBody}\n`;
    const snapshot = buildIntentSnapshot({
      raw,
      contentHash: HASH,
      capturedAt: '2026-11-14T10:00:00.000Z',
      lang: 'zh-CN',
      sectionMaxChars: 50,
    });
    const why = snapshot.sections.find((s) => s.key === 'why');
    expect(why?.text).toHaveLength(50);
    expect(why?.truncated).toBe(true);
    expect(why?.missing).toBeUndefined();
  });
});

describe('renderIntentSnapshotDoc / intentSnapshotSectionsToDoc', () => {
  it('rebuilds a document that re-parses to the same section bodies', () => {
    const snapshot = build();
    const doc = intentSnapshotSectionsToDoc(snapshot);
    expect(doc.why).toBe('Owner trust comes before feature speed.');
    expect(doc.currentStrategicFocus).toBe('Close the intent → principle → evidence loop.');

    const rendered = renderIntentSnapshotDoc(snapshot);
    expect(rendered).toContain('## 1. Why');
    expect(rendered).toContain('Owner trust comes before feature speed.');
    expect(rendered).toContain('## 5. Current Strategic Focus');
  });

  it('omits missing sections from the rebuilt document object', () => {
    const snapshot = buildIntentSnapshot({
      raw: '# INTENT.md\n\n## 1. Why\nOnly why.\n',
      contentHash: HASH,
      capturedAt: '2026-11-14T10:00:00.000Z',
      lang: 'zh-CN',
    });
    const doc = intentSnapshotSectionsToDoc(snapshot);
    expect(doc.why).toBe('Only why.');
    expect(doc.desiredOutcome).toBeUndefined();
  });
});

describe('filterIntentSnapshotSections', () => {
  it('keeps every captured section when the model declared none', () => {
    const snapshot = build();
    const filtered = filterIntentSnapshotSections(snapshot, []);
    expect(filtered.sections).toHaveLength(INTENT_SNAPSHOT_SECTION_KEYS.length);
  });

  it('narrows to the declared sections only', () => {
    const snapshot = build();
    const filtered = filterIntentSnapshotSections(snapshot, ['current_strategic_focus', 'non_negotiables']);
    expect(filtered.sections.map((s) => s.key)).toEqual(['non_negotiables', 'current_strategic_focus']);
    expect(filtered.contentHash).toBe(snapshot.contentHash);
  });

  it('ignores unknown keys instead of fabricating sections', () => {
    const filtered = filterIntentSnapshotSections(build(), ['not_a_section']);
    expect(filtered.sections).toEqual([]);
  });
});

describe('isValidIntentSnapshot', () => {
  it('accepts a freshly built snapshot', () => {
    expect(isValidIntentSnapshot(build())).toBe(true);
  });

  it('accepts an optional intentVersionId', () => {
    expect(isValidIntentSnapshot({ ...build(), intentVersionId: 'ver-1' })).toBe(true);
  });

  it.each([
    ['non-object', 'snapshot'],
    ['null', null],
    ['array', []],
    ['wrong schemaVersion', { ...build(), schemaVersion: 2 }],
    ['missing sha256 prefix', { ...build(), contentHash: 'md5:abc' }],
    ['empty hash body', { ...build(), contentHash: 'sha256:' }],
    ['missing capturedAt', { ...build(), capturedAt: '' }],
    ['unknown lang', { ...build(), lang: 'fr' }],
    ['non-array sections', { ...build(), sections: {} }],
    ['unknown section key', { ...build(), sections: [{ key: 'whatever', text: 'x' }] }],
    ['duplicate section key', {
      ...build(),
      sections: [{ key: 'why', text: 'a' }, { key: 'why', text: 'b' }],
    }],
    ['non-string text', { ...build(), sections: [{ key: 'why', text: 1 }] }],
    ['missing and truncated', {
      ...build(),
      sections: [{ key: 'why', text: '', missing: true, truncated: true }],
    }],
  ])('rejects %s', (_label, value) => {
    expect(isValidIntentSnapshot(value)).toBe(false);
  });
});
