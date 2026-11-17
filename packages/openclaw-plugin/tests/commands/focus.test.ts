import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { handleFocusCommand } from '../../src/commands/focus';
import type { PluginCommandContext, OpenClawPluginApi } from '../../src/openclaw-sdk';

/**
 * Principle Context command contract (SPEC v1.1 §8):
 * - status shows file facts (existence/size/lines/updated), no version metadata;
 * - history lists `.history/` backups;
 * - rollback restores RAW BYTES (BOM/CRLF preserved, no version/date/status text
 *   appended) and backs up the current bytes first;
 * - compress is retired (unknown command).
 *
 * The workspace resolver prefers PD_WORKSPACE_DIR/OPENCLAW_WORKSPACE/principles-disciple.json
 * over ctx.workspaceDir; without the env guard below these tests would operate
 * on a REAL canonical workspace (rollback writes!). Keep the guard.
 */

const priorPdWorkspaceDir = process.env.PD_WORKSPACE_DIR;
const priorOpenclawWorkspace = process.env.OPENCLAW_WORKSPACE;

const fakeApi = {} as OpenClawPluginApi;

function makeCtx(workspaceDir: string, args: string[]): PluginCommandContext {
  return {
    workspaceDir,
    commandBody: '/pd-focus',
    channel: 'cli',
    isAuthorizedSender: true,
    args,
    config: { language: 'zh', workspaceDir } as PluginCommandContext['config'],
  } as unknown as PluginCommandContext;
}

function sha256(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

describe('/pd-focus command (Principle Context)', () => {
  let workspaceDir: string;
  let focusPath: string;
  let historyDir: string;

  beforeEach(() => {
    // Pin the resolver onto the fixture workspace: PD_WORKSPACE_DIR is the
    // FIRST explicit source and overrides both the host ctx and any real
    // ~/.openclaw/principles-disciple.json on this machine.
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-focus-cmd-'));
    process.env.PD_WORKSPACE_DIR = workspaceDir;
    const okrDir = path.join(workspaceDir, 'memory', 'okr');
    fs.mkdirSync(okrDir, { recursive: true });
    focusPath = path.join(okrDir, 'CURRENT_FOCUS.md');
    historyDir = path.join(okrDir, '.history');
  });

  afterEach(() => {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    if (priorPdWorkspaceDir === undefined) delete process.env.PD_WORKSPACE_DIR;
    else process.env.PD_WORKSPACE_DIR = priorPdWorkspaceDir;
    if (priorOpenclawWorkspace === undefined) delete process.env.OPENCLAW_WORKSPACE;
    else process.env.OPENCLAW_WORKSPACE = priorOpenclawWorkspace;
  });

  it('status: reports file facts when the file exists', async () => {
    const content = '# Principle Context\nline2\nline3';
    fs.writeFileSync(focusPath, content, 'utf-8');
    const result = await handleFocusCommand(makeCtx(workspaceDir, ['status']), fakeApi);
    expect(result.text).toContain('存在');
    expect(result.text).toContain(`${Buffer.byteLength(content, 'utf-8')} bytes`);
    expect(result.text).toContain('3 行');
    // File facts only — no legacy version/compression semantics.
    expect(result.text).not.toContain('版本 | v');
    expect(result.text).not.toContain('compress');
  });

  it('status: reports a missing file without suggesting auto creation', async () => {
    const result = await handleFocusCommand(makeCtx(workspaceDir, ['status']), fakeApi);
    expect(result.text).toContain('不存在');
  });

  it('history: lists backups from .history/', async () => {
    fs.mkdirSync(historyDir, { recursive: true });
    fs.writeFileSync(path.join(historyDir, 'CURRENT_FOCUS.v2.2026-11-17.1000.md'), 'A', 'utf-8');
    fs.writeFileSync(path.join(historyDir, 'CURRENT_FOCUS.v1.2026-11-16.1000.md'), 'B', 'utf-8');
    const result = await handleFocusCommand(makeCtx(workspaceDir, ['history']), fakeApi);
    expect(result.text).toContain('CURRENT_FOCUS.v2.2026-11-17.1000.md');
    expect(result.text).toContain('CURRENT_FOCUS.v1.2026-11-16.1000.md');
  });

  it('rollback: restores raw bytes (BOM + CRLF), backs up current bytes, appends no text', async () => {
    const backupBytes = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('**版本**: v5\r\n**更新**: 2026-11-01\r\n历史正文\r\n', 'utf-8'),
    ]);
    fs.mkdirSync(historyDir, { recursive: true });
    const backupPath = path.join(historyDir, 'CURRENT_FOCUS.v5.2026-11-01.111.md');
    fs.writeFileSync(backupPath, backupBytes);

    const currentBytes = Buffer.from('**版本**: v9\n**更新**: 2026-11-18\ncurrent content', 'utf-8');
    fs.writeFileSync(focusPath, currentBytes);

    const result = await handleFocusCommand(makeCtx(workspaceDir, ['rollback', '1']), fakeApi);
    expect(result.text).toContain('回滚完成');

    // Raw-byte restore: the restored file is byte-identical to the backup.
    const restored = fs.readFileSync(focusPath);
    expect(restored.equals(backupBytes)).toBe(true);
    expect(restored[0]).toBe(0xef); // BOM preserved
    expect(restored.toString('utf-8')).toContain('\r\n'); // CRLF preserved
    // No appended version/date/status text.
    expect(restored.toString('utf-8')).not.toContain('ROLLBACK');
    expect(restored.toString('utf-8')).not.toContain('2026-11-18');

    // The pre-rollback current bytes were backed up byte-for-byte.
    const backups = fs.readdirSync(historyDir).filter(f => f !== path.basename(backupPath));
    expect(backups.length).toBe(1);
    expect(fs.readFileSync(path.join(historyDir, backups[0]!)).equals(currentBytes)).toBe(true);
  });

  it('rollback: rejects an invalid index with the available range', async () => {
    fs.mkdirSync(historyDir, { recursive: true });
    fs.writeFileSync(path.join(historyDir, 'CURRENT_FOCUS.v1.2026-11-16.1.md'), 'A', 'utf-8');
    const result = await handleFocusCommand(makeCtx(workspaceDir, ['rollback', '7']), fakeApi);
    expect(result.text).toContain('无效的序号');
    expect(fs.existsSync(focusPath)).toBe(false);
  });

  it('compress is retired: unknown command branch, no file mutation', async () => {
    fs.writeFileSync(focusPath, 'stable content', 'utf-8');
    const before = sha256(fs.readFileSync(focusPath));
    const result = await handleFocusCommand(makeCtx(workspaceDir, ['compress']), fakeApi);
    expect(result.text).toContain('未知命令');
    expect(sha256(fs.readFileSync(focusPath))).toBe(before);
    // Help mentions retirement.
    const help = await handleFocusCommand(makeCtx(workspaceDir, ['help']), fakeApi);
    expect(help.text).not.toContain('`/pd-focus compress` -');
    expect(help.text).toContain('已退役');
  });

  it('cp alias is retired too', async () => {
    const result = await handleFocusCommand(makeCtx(workspaceDir, ['cp']), fakeApi);
    expect(result.text).toContain('未知命令');
  });
});
