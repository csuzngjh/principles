import { describe, expect, it } from 'vitest';
import {
  boundCorrectionEvidenceText,
  MAX_CORRECTION_EVIDENCE_TEXT_CHARS,
} from '../pain-signal-bridge.js';

describe('boundCorrectionEvidenceText (PRI-844)', () => {
  it('preserves short corrections verbatim — no 200-char generic evidence cap', () => {
    const text = '部署脚本漏改了，别只改眼前这一个文件。';
    const out = boundCorrectionEvidenceText({ text, sessionId: 's1' });
    expect(out.text).toBe(text);
  });

  it('keeps a 300-char correction complete (between the 200 evidence cap and the 2000 bound)', () => {
    const text = '改'.repeat(300);
    const out = boundCorrectionEvidenceText({ text });
    expect(out.text.length).toBe(300);
  });

  it('applies the 2000 defensive storage bound (storage safety, not semantics)', () => {
    const text = '改'.repeat(3000);
    const out = boundCorrectionEvidenceText({ text });
    expect(out.text.length).toBe(MAX_CORRECTION_EVIDENCE_TEXT_CHARS);
    expect(out.text.startsWith('改')).toBe(true);
  });

  it('keeps optional provenance fields intact', () => {
    const out = boundCorrectionEvidenceText({
      text: 'ok',
      sessionId: 's',
      turnIndex: 3,
      referencesAssistantTurnId: 2,
      occurredAt: '2026-09-19T00:37:54.000Z',
    });
    expect(out).toEqual({
      text: 'ok',
      sessionId: 's',
      turnIndex: 3,
      referencesAssistantTurnId: 2,
      occurredAt: '2026-09-19T00:37:54.000Z',
    });
  });
});
