// @vitest-environment node
/**
 * Ingestion presentation layer — the reading path must never render the CLI's
 * operator-pitched English prose or raw snake_case where a localized phrase
 * exists, and raw values must never be DROPPED (rc-9: they ride back as
 * `technical` for the disclosure). Driven against the REAL dictionaries so a
 * missing/renamed key in either locale fails here, not on screen.
 */
import { describe, expect, it } from 'vitest';
import {
  INGESTION_REASON_CODES,
  presentConsentNextAction,
  presentDegradedSection,
  presentIngestionNextAction,
  presentIngestionReason,
  presentNotWired,
  shortIdentifier,
  type TranslateFn,
} from '../../src/ui/pages/ingestion-status/ingestion-presentation.js';
import zhCN from '../../src/ui/i18n/zh-CN.json';
import en from '../../src/ui/i18n/en.json';

type Dict = Record<string, unknown>;

function makeT(dict: Dict): TranslateFn {
  const resolve = (key: string): unknown =>
    key.split('.').reduce<unknown>((node, part) => (node !== null && typeof node === 'object' ? (node as Dict)[part] : undefined), dict);
  return (key, opts) => {
    const value = resolve(key);
    const text = typeof value === 'string' ? value : `<missing:${key}>`;
    return text.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => String(opts?.[name] ?? ''));
  };
}

const tZh = makeT(zhCN as unknown as Dict);
const tEn = makeT(en as unknown as Dict);

const I18N_KEY_PATTERN = /^<missing:/;
const ENGLISH_SENTENCE = /[A-Za-z][A-Za-z'-]*(?:\s+[A-Za-z'-]+){3,}/;

describe('ingestion-presentation — dictionary coverage', () => {
  it('every known reason code resolves in BOTH locales (no i18n key leaks)', () => {
    expect(INGESTION_REASON_CODES.length).toBeGreaterThanOrEqual(12);
    for (const code of INGESTION_REASON_CODES) {
      const zh = presentIngestionReason(code, tZh);
      const enText = presentIngestionReason(code, tEn);
      expect(zh.text, `zh reason for ${code}`).not.toMatch(I18N_KEY_PATTERN);
      expect(zh.text, `zh reason for ${code} must stay a code only when intended`).not.toBe(code);
      expect(enText.text, `en reason for ${code}`).not.toMatch(I18N_KEY_PATTERN);
      expect(zh.technical).toBeNull();
      // Owner-facing sentences must not carry the CLI's English prose back in.
      expect(zh.text).not.toMatch(ENGLISH_SENTENCE);
    }
  });

  it('every code has a paired next-action sentence in BOTH locales', () => {
    const section = { reason: '', nextAction: '' };
    for (const code of INGESTION_REASON_CODES) {
      const result = presentDegradedSection({ ...section, reason: code, nextAction: 'raw guidance' }, tZh);
      expect(result.nextAction.text, `zh next action for ${code}`).not.toMatch(I18N_KEY_PATTERN);
      const enResult = presentDegradedSection({ ...section, reason: code, nextAction: 'raw guidance' }, tEn);
      expect(enResult.nextAction.text, `en next action for ${code}`).not.toMatch(I18N_KEY_PATTERN);
      // The raw guidance survives in the technical disclosure (rc-9).
      expect(result.nextAction.technical).toBe('raw guidance');
    }
  });
});

describe('ingestion-presentation — fallback ladder', () => {
  it('exact code → localized phrase, nothing extra in the fold', () => {
    const result = presentIngestionReason('transcript_record_too_large', tZh);
    expect(result.text).toBe('单条对话记录超出有界读取窗口的大小上限');
    expect(result.technical).toBeNull();
  });

  it('code family (code:detail) → localized family label, raw detail kept', () => {
    const result = presentIngestionReason('transcript_read_failed:EACCES: permission denied', tZh);
    expect(result.text).toBe('读取转录文件失败');
    expect(result.technical).toBe('transcript_read_failed:EACCES: permission denied');
  });

  it('adapter family carries the localized repair guidance', () => {
    const result = presentDegradedSection(
      { reason: 'host_adapter_unavailable:@principles/codex-adapter', nextAction: 'The host adapter package failed to resolve…' },
      tZh,
    );
    expect(result.reason.text).toBe('宿主适配器组件缺失或未能加载');
    expect(result.reason.technical).toBe('host_adapter_unavailable:@principles/codex-adapter');
    expect(result.nextAction.text).toBe('重新运行安装器修复安装（不要手工改运行时文件），然后刷新本页。');
    expect(result.nextAction.technical).toBe('The host adapter package failed to resolve…');
  });

  it('unknown English prose → neutral sentence, raw preserved', () => {
    const raw = 'Record a consent decision for codex (setup flow or Owner directive) before transcript ingestion runs.';
    const reason = presentIngestionReason(raw, tZh);
    expect(reason.text).toBe('采集组件返回了一条技术性原因');
    expect(reason.technical).toBe(raw);
    const action = presentIngestionNextAction('Run `pd health --workspace <dir> --json` manually to see the structured ingestion section.', tZh);
    expect(action.text).toBe('展开技术详情查看原始处理建议');
    expect(action.technical).toContain('pd health');
  });

  it('unknown short code → fail-visible raw passthrough', () => {
    const raw = 'some_future_reason_code';
    const result = presentIngestionReason(raw, tZh);
    expect(result.text).toBe(raw);
    expect(result.technical).toBeNull();
  });

  it('consent next action keys off the consent STATE, not the prose', () => {
    const flagOn = presentConsentNextAction('flag_on_without_grant', 'Record a consent decision…', tZh);
    expect(flagOn?.text).toBe('在安装流程中做出同意决定（或由您明确指示）后，读取才会开始。');
    expect(flagOn?.technical).toBe('Record a consent decision…');
    const unreadable = presentConsentNextAction('unreadable', undefined, tEn);
    expect(unreadable?.text).toContain('.pd');
    // A consent state with no mapped sentence and no raw value renders nothing.
    expect(presentConsentNextAction('granted', undefined, tEn)).toBeNull();
  });

  it('not_wired row is fully localized with the raw prose in the fold', () => {
    const result = presentNotWired(tZh, {
      reason: 'openclaw live observation bypass lands in PRI-1171 P3 ticket; …',
      nextAction: 'No action — this row becomes monitored when P3 ticket wires the unified live bypass.',
    });
    expect(result.reason.text).not.toMatch(/PRI-|ticket|bypass/);
    expect(result.nextAction.text).not.toMatch(/PRI-|ticket|bypass/);
    expect(result.reason.technical).toContain('PRI-1171');
  });

  it('shortIdentifier truncates UUIDs by code points and keeps short ids', () => {
    expect(shortIdentifier('aaaaaaaa-0000-4000-8000-0000000000f1')).toBe('aaaaaaaa…');
    expect(shortIdentifier('short-id')).toBe('short-id');
  });
});
