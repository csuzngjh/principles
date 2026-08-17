import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { FeedbackReport } from '@principles/core/runtime-v2/feedback';
import {
  detectGithubCli,
  submitToGithub,
  DEFAULT_GH_TIMEOUT_MS,
} from '../../../src/server/feedback/github-adapter.js';

type ExecFileFn = typeof import('node:child_process').execFile;

function execFileMock(behavior: { stdout?: string; code?: number; err?: Error }) {
  const fn = vi.fn(
    (
      _cmd: string,
      _args: string[],
      _opts: unknown,
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      if (behavior.err) {
        cb(behavior.err, '', '');
        return;
      }
      cb(null, behavior.stdout ?? '', '');
    },
  );
  return fn as unknown as ExecFileFn;
}

function makeReport(id = 'gh-test-' + Date.now()): FeedbackReport {
  return {
    id,
    createdAt: '2026-08-17T00:00:00.000Z',
    type: 'bug',
    title: 'Peers never finish',
    userText: { description: 'peers never finish' },
    diagnosticSummary: { versions: {}, platform: {}, featureFlags: {}, canary: { status: 'unavailable' }, recentEvents: [] },
    privacy: { redactionNotes: [] },
    outputs: { markdown: '# Peers never finish\n\nbody', emailText: '', githubIssueUrl: '', mailtoUrl: '' },
  };
}

describe('detectGithubCli', () => {
  it('reports unavailable + install guidance when gh is missing', async () => {
    const err = Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
    const execFile = execFileMock({ err });
    const r = await detectGithubCli({ execFile });
    expect(r.available).toBe(false);
    expect(r.nextAction).toContain('安装 GitHub CLI');
  });

  it('reports unavailable + `gh auth login` when not authenticated', async () => {
    // First --version succeeds, then auth status fails.
    const execFile = vi.fn(
      (
        _cmd: string,
        args: string[],
        _opts: unknown,
        cb: (err: Error | null, stdout: string, stderr: string) => void,
      ) => {
        if (args[0] === '--version') cb(null, 'gh version 2.x', '');
        else cb(Object.assign(new Error('not logged in'), { code: 1 }), '', '');
      },
    ) as unknown as ExecFileFn;
    const r = await detectGithubCli({ execFile });
    expect(r.available).toBe(false);
    expect(r.nextAction).toContain('gh auth login');
  });

  it('reports available when gh exists and is authenticated', async () => {
    const execFile = execFileMock({ stdout: '' });
    const r = await detectGithubCli({ execFile });
    expect(r.available).toBe(true);
    expect(execFile).toHaveBeenCalledWith('gh', ['auth', 'status'], expect.anything(), expect.anything());
  });
});

describe('submitToGithub', () => {
  it('executes gh with a safe argument array, cleans the temp body, and parses the URL', async () => {
    const report = makeReport();
    const execFile = execFileMock({
      stdout: 'https://github.com/csuzngjh/principles/issues/42\ncreating issue...',
    });
    const tmpPath = path.join(os.tmpdir(), `pd-feedback-${report.id}.md`);
    const r = await submitToGithub({ repo: 'csuzngjh/principles', report, execFile });

    expect(r).toEqual({ ok: true, issueUrl: 'https://github.com/csuzngjh/principles/issues/42' });

    const call = execFile.mock.calls[0] as [string, string[], unknown];
    expect(call[0]).toBe('gh');
    expect(call[1]).toEqual([
      'issue',
      'create',
      '--repo',
      'csuzngjh/principles',
      '--title',
      'Peers never finish',
      '--body-file',
      tmpPath,
      '--label',
      'feedback',
    ]);

    // Temp body file was created then deleted.
    expect(fs.existsSync(tmpPath)).toBe(false);
  });

  it('sets HTTPS_PROXY on the child env when proxy is configured', async () => {
    const report = makeReport();
    const execFile = vi.fn(
      (
        _c: string,
        _a: string[],
        opts: { env: NodeJS.ProcessEnv },
        cb: (err: Error | null, stdout: string) => void,
      ) => {
        expect(opts.env.HTTPS_PROXY).toBe('http://127.0.0.1:1080');
        expect(opts.env.https_proxy).toBe('http://127.0.0.1:1080');
        setTimeout(() => cb(null, 'https://github.com/x/y/issues/1'), 0);
      },
    ) as unknown as ExecFileFn;
    const r = await submitToGithub({ repo: 'x/y', proxy: 'http://127.0.0.1:1080', report, execFile });
    expect(r.ok).toBe(true);
  });

  it('returns a structured failure and removes the temp file when gh fails', async () => {
    const report = makeReport();
    const execFile = execFileMock({ err: Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' }) });
    const tmpPath = path.join(os.tmpdir(), `pd-feedback-${report.id}.md`);
    const r = await submitToGithub({ repo: 'x/y', report, execFile });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain('gh 建单失败');
      expect(r.nextAction).toContain('改用反馈服务');
    }
    expect(fs.existsSync(tmpPath)).toBe(false);
  });

  it('defaults to a 30s timeout', () => {
    expect(DEFAULT_GH_TIMEOUT_MS).toBe(30_000);
  });
});