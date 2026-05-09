import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { autoCompressFocus, cleanupStaleInfo } from '../focus-history.js';

function makeFocusContent(artifactRows: string[], extraLines = 0): string {
  const lines: string[] = [
    '# CURRENT_FOCUS',
    '',
    '**版本**: v1',
    '**更新**: 2026-05-09',
    '',
    '## 📍 状态快照',
    '',
    '当前聚焦于核心功能开发。',
    '',
    '## 🔄 当前任务',
    '',
    '- [ ] 实现新功能',
    '- [ ] 修复已知问题',
    '- [ ] 完善测试覆盖',
    '',
    '## ➡️ 下一步',
    '',
    '1. 完成 PRI-82 E2E 测试',
    '2. 提交代码审查',
    '',
    '## 🧠 Working Memory',
    '',
    '> Last updated: 2026-05-09T12:00:00Z',
    '',
    '### 📁 文件输出记录',
    '',
    '| 文件路径 | 操作 | 描述 |',
    '|----------|------|------|',
  ];

  for (const row of artifactRows) {
    lines.push(row);
  }

  lines.push('');
  lines.push('### ⚠️ 活动问题');
  lines.push('- 测试覆盖不足 → 增加E2E测试');
  lines.push('');
  lines.push('### ➡️ 下一步行动');
  lines.push('1. 完成回归测试');
  lines.push('2. 提交PR');
  lines.push('');

  for (let i = 0; i < extraLines; i++) {
    lines.push(`<!-- padding line ${i} -->`);
  }

  return lines.join('\n');
}

describe('autoCompressFocus E2E regression (PRI-82)', () => {
  let tmpDir: string;
  let workspaceDir: string;
  let stateDir: string;
  let focusPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-focus-e2e-'));
    workspaceDir = tmpDir;
    stateDir = path.join(tmpDir, '.state');
    fs.mkdirSync(stateDir, { recursive: true });

    const focusDir = path.join(tmpDir, 'okr');
    fs.mkdirSync(focusDir, { recursive: true });
    focusPath = path.join(focusDir, 'CURRENT_FOCUS.md');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('removes missing-file artifact rows via filesystem filtering before core compression', () => {
    const existingFile = path.join(workspaceDir, 'src', 'existing-module.ts');

    fs.mkdirSync(path.join(workspaceDir, 'src'), { recursive: true });
    fs.writeFileSync(existingFile, 'export const x = 1;');

    const existingRow = '| `src/existing-module.ts` | modified | 核心模块 |';
    const missingRow = '| `src/deleted-module.ts` | modified | 已删除模块 |';

    const content = makeFocusContent([existingRow, missingRow], 90);

    fs.writeFileSync(focusPath, content);

    const result = autoCompressFocus(focusPath, workspaceDir, stateDir);

    expect(result.compressed).toBe(true);
    expect(result.newContent).toBeDefined();

    expect(result.newContent!).not.toContain('deleted-module.ts');

    expect(result.newLines).toBeLessThan(result.oldLines);

    expect(result.reason).toContain('Auto-compressed');
  });

  it('goes through core compressFocusContent path when threshold is exceeded', () => {
    const content = makeFocusContent([
      '| `src/utils.ts` | created | 工具函数 |',
    ], 90);

    fs.writeFileSync(focusPath, content);

    const result = autoCompressFocus(focusPath, workspaceDir, stateDir);

    expect(result.compressed).toBe(true);

    expect(result.reason).toContain('Auto-compressed');

    const writtenContent = fs.readFileSync(focusPath, 'utf-8');
    expect(writtenContent).not.toBe(content);
    expect(writtenContent.split('\n').length).toBeLessThan(content.split('\n').length);
  });

  it('does not compress when below threshold', () => {
    const content = makeFocusContent([
      '| `src/utils.ts` | created | 工具函数 |',
    ], 0);

    fs.writeFileSync(focusPath, content);

    const result = autoCompressFocus(focusPath, workspaceDir, stateDir);

    expect(result.compressed).toBe(false);
    expect(result.reason).toBe('Below threshold');
  });

  it('creates backup in history when compressing', () => {
    const content = makeFocusContent([
      '| `src/utils.ts` | created | 工具函数 |',
    ], 90);

    fs.writeFileSync(focusPath, content);

    const result = autoCompressFocus(focusPath, workspaceDir, stateDir);

    expect(result.compressed).toBe(true);
    expect(result.backupPath).not.toBeNull();

    const historyDir = path.join(path.dirname(focusPath), '.history');
    expect(fs.existsSync(historyDir)).toBe(true);

    const historyFiles = fs.readdirSync(historyDir).filter(f => f.startsWith('CURRENT_FOCUS.v'));
    expect(historyFiles.length).toBeGreaterThanOrEqual(1);
  });

  it('handles workspace without existing files gracefully', () => {
    const content = makeFocusContent([
      '| `src/ghost-file.ts` | modified | 不存在的文件 |',
    ], 90);

    fs.writeFileSync(focusPath, content);

    const result = autoCompressFocus(focusPath, workspaceDir, stateDir);

    expect(result.compressed).toBe(true);

    expect(result.newContent!).not.toContain('ghost-file.ts');
  });
});

describe('cleanupStaleInfo filesystem filtering (PRI-82)', () => {
  let tmpDir: string;
  let workspaceDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-cleanup-'));
    workspaceDir = tmpDir;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('preserves artifact row for existing file and removes row for missing file', () => {
    const existingFile = path.join(workspaceDir, 'src', 'real.ts');
    fs.mkdirSync(path.join(workspaceDir, 'src'), { recursive: true });
    fs.writeFileSync(existingFile, 'export const a = 1;');

    const content = makeFocusContent([
      '| `src/real.ts` | modified | 真实文件 |',
      '| `src/phantom.ts` | modified | 幽灵文件 |',
    ], 0);

    const result = cleanupStaleInfo(content, workspaceDir);

    expect(result).toContain('real.ts');
    expect(result).not.toContain('phantom.ts');
  });

  it('preserves all artifact rows when no workspaceDir provided', () => {
    const content = makeFocusContent([
      '| `src/real.ts` | modified | 真实文件 |',
      '| `src/phantom.ts` | modified | 幽灵文件 |',
    ], 0);

    const result = cleanupStaleInfo(content);

    expect(result).toContain('real.ts');
    expect(result).toContain('phantom.ts');
  });
});
