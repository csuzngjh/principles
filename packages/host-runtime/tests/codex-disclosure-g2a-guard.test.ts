import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CODEX_INGESTION_DISCLOSURE_EN,
  CODEX_INGESTION_DISCLOSURE_ZH,
  CODEX_INGESTION_DISCLOSURE_VERSION,
  getCodexIngestionDisclosureText,
} from '../src/codex-disclosure.js';

/**
 * G2A anti-weakening guard (SPEC rev 2 §17 / G0+G2A decision package).
 *
 * The frozen disclosure in the decision package is the language SSoT: the
 * text "remains frozen and must not be weakened during implementation without
 * a new Owner decision". This test re-extracts the frozen section from the
 * document itself and asserts the shipped constant matches byte-for-byte, so
 * any editing of the disclosure constant (or doc drift) fails CI.
 */
const DECISION_PACKAGE_RELATIVE = '../../../docs/superpowers/specs/2026-08-28-codex-governance-closure-g0-g2a-decision.md';
const FROZEN_HEADING = '## Frozen consent disclosure text (setup will show this verbatim)';
const FROZEN_SECTION_END_MARKER = '*(English rendering';

function extractFrozenDisclosureFromDoc(): string {
  const raw = readFileSync(new URL(DECISION_PACKAGE_RELATIVE, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const lines = raw.split('\n');
  const start = lines.findIndex((line) => line.trim() === FROZEN_HEADING);
  expect(start, 'frozen disclosure heading missing from the G2A decision package').toBeGreaterThan(-1);
  const collected: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith(FROZEN_SECTION_END_MARKER)) break;
    collected.push(lines[i]);
  }
  const stripped = collected.map((line) => (line.startsWith('> ') ? line.slice(2) : line === '>' ? '' : line));
  while (stripped.length > 0 && stripped[0] === '') stripped.shift();
  while (stripped.length > 0 && stripped[stripped.length - 1] === '') stripped.pop();
  return stripped.join('\n');
}

describe('codex ingestion disclosure — G2A frozen text guard', () => {
  it('matches the Owner-approved frozen Chinese text byte-for-byte', () => {
    expect(CODEX_INGESTION_DISCLOSURE_ZH).toBe(extractFrozenDisclosureFromDoc());
  });

  it('pins the disclosure version to the approved decision package', () => {
    expect(CODEX_INGESTION_DISCLOSURE_VERSION).toBe('g2a-2026-08-28');
  });

  it('English rendering states the same bounded facts (32 turns / 7 days / 12 promoted / default off / never-on-upgrade)', () => {
    for (const fact of ['32', '7 days', '12 messages', 'Off by default', 'never enables it for you', 'only egress path', 'never opened']) {
      expect(CODEX_INGESTION_DISCLOSURE_EN).toContain(fact);
    }
  });

  it('getCodexIngestionDisclosureText returns the requested language', () => {
    expect(getCodexIngestionDisclosureText('zh')).toBe(CODEX_INGESTION_DISCLOSURE_ZH);
    expect(getCodexIngestionDisclosureText('en')).toBe(CODEX_INGESTION_DISCLOSURE_EN);
  });
});
