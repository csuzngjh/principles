import { describe, expect, it } from 'vitest';
import {
  containsAbsolutePath,
  humanizeRuntimeText,
  isTechnicalText,
  localizeKnownReason,
  looksLikeEnglishSentence,
  maskPath,
  summarizeCommand,
} from '../../src/ui/utils/technical-detail.js';

describe('maskPath', () => {
  it('masks the user segment of a Windows profile path', () => {
    expect(maskPath('C:\\Users\\张三\\AppData\\Local\\Temp\\work\\state.db'))
      .toBe('C:\\Users\\***\\AppData\\Local\\Temp\\***\\state.db');
  });

  it('masks POSIX home and temp segments', () => {
    expect(maskPath('/home/alice/workspace/.pd/state.db')).toBe('/home/***/workspace/.pd/state.db');
    expect(maskPath('/tmp/session-abc123/report.json')).toBe('/tmp/***/report.json');
  });

  it('leaves paths without a user or temp segment alone', () => {
    expect(maskPath('D:\\Code\\principles\\packages\\pd-console')).toBe('D:\\Code\\principles\\packages\\pd-console');
  });
});

describe('summarizeCommand', () => {
  it('recognises the internalization command and keeps the original', () => {
    const raw = 'Run: pd runtime internalization run-once --workspace "C:\\Users\\张三\\AppData\\Local\\Temp\\x"';
    expect(summarizeCommand(raw)).toEqual({
      summary: '继续处理这条候选（手动推进一次）',
      command: raw,
    });
  });

  it('returns null for ordinary prose', () => {
    expect(summarizeCommand('这条规则会在检测到风险时要求确认。')).toBeNull();
    expect(summarizeCommand('the update finished successfully')).toBeNull();
  });

  it('strips a leading label before matching', () => {
    expect(summarizeCommand('运行：pd update')?.summary).toBe('更新 PD');
  });

  // Regression (real browser walkthrough): the runtime prefixes the command with
  // an English sentence, so matching on the string start missed it and the whole
  // sentence plus a Windows absolute path leaked onto the pain page.
  it('recognises a command embedded after prose', () => {
    const raw = 'Candidate generated. Waiting for internalization pipeline. Run: pd runtime internalization run-once --workspace "C:\\Users\\***\\AppData\\Local\\Temp\\***"';
    const result = humanizeRuntimeText(raw);
    expect(result.text).toBe('继续处理这条候选（手动推进一次）');
    expect(result.technical).toBe(raw);
    expect(result.text).not.toMatch(/[A-Za-z]{3,}\s+[A-Za-z]{3,}/);
    expect(result.text).not.toMatch(/C:\\Users/);
  });
});

describe('isTechnicalText', () => {
  it('flags commands, absolute paths, stack frames and bare URLs', () => {
    expect(isTechnicalText('Run: pd update')).toBe(true);
    expect(isTechnicalText('C:\\Users\\张三\\AppData\\Local\\Temp\\x')).toBe(true);
    expect(isTechnicalText('    at foo (C:\\app\\main.js:10:2)')).toBe(true);
    expect(isTechnicalText('https://example.com/a/b')).toBe(true);
  });

  it('does not flag normal Chinese prose', () => {
    expect(isTechnicalText('这次变更会影响全部提示词渲染。')).toBe(false);
  });
});

describe('localizeKnownReason', () => {
  it('maps the runtime database message that used to leak', () => {
    expect(localizeKnownReason('Trajectory database not found')).toBe('行为轨迹库尚未建立，目前没有可展示的证据');
    expect(localizeKnownReason('A verified Owner identity is required to continue'))
      .toBe('需要先验证拥有者身份');
  });

  it('returns null for unknown text', () => {
    expect(localizeKnownReason('something entirely new')).toBeNull();
  });
});

describe('looksLikeEnglishSentence', () => {
  it('distinguishes a sentence from a label', () => {
    expect(looksLikeEnglishSentence('Trajectory database not found')).toBe(true);
    expect(looksLikeEnglishSentence('Pending')).toBe(false);
    expect(looksLikeEnglishSentence('这是一句中文。')).toBe(false);
  });
});

describe('humanizeRuntimeText — what the Owner actually sees', () => {
  it('turns a leaked command into a human sentence plus technical detail', () => {
    const raw = 'Run: pd runtime internalization run-once --workspace "C:\\Users\\张三\\AppData\\Local\\Temp\\x"';
    const result = humanizeRuntimeText(raw);
    expect(result.text).toBe('继续处理这条候选（手动推进一次）');
    expect(result.technical).toBe(raw);
    expect(result.text).not.toMatch(/pd runtime/);
    expect(result.text).not.toMatch(/C:\\Users/);
  });

  it('translates a known runtime reason', () => {
    expect(humanizeRuntimeText('Trajectory database not found').text)
      .toBe('行为轨迹库尚未建立，目前没有可展示的证据');
  });

  it('masks an absolute path that is not a command', () => {
    const result = humanizeRuntimeText('C:\\Users\\张三\\AppData\\Local\\Temp\\abc\\state.db');
    expect(result.text).toContain('C:\\Users\\***');
    expect(result.text).not.toContain('张三');
  });

  it('falls back to a neutral sentence for an untranslated English sentence', () => {
    const result = humanizeRuntimeText('Something unexpected happened while reading the artifact');
    expect(result.text).toBe('这条内容属于技术细节');
    expect(result.technical).toBe('Something unexpected happened while reading the artifact');
  });

  it('passes Chinese prose through unchanged', () => {
    expect(humanizeRuntimeText('材料已读取完毕。')).toEqual({ text: '材料已读取完毕。', technical: null });
  });

  it('detects absolute paths for the audit regex', () => {
    expect(containsAbsolutePath('见 /Users/alice/x')).toBe(true);
    expect(containsAbsolutePath('没有路径')).toBe(false);
  });
});
