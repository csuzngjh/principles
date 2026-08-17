// github-adapter.ts
// Server-side gh CLI channel adapter (spec §8.4). Secondary channel for
// developers who can reach GitHub (proxy may be required domestically).
//
// - `execFile` with an argument array — zero shell concatenation (injection-safe).
// - Body written to a 0600 temp file, deleted after submission.
// - `github_proxy` sets HTTPS_PROXY for the child process when non-empty.
// - 30s default timeout; success parses the issue URL from stdout.

import type * as childProcessNS from 'node:child_process';
import type * as fsNS from 'node:fs';
import type * as osNS from 'node:os';
import type * as pathNS from 'node:path';
import type { FeedbackReport } from '@principles/core/runtime-v2/feedback';
import type { ChannelDeps } from './channels.js';

type ExecFileFn = typeof childProcessNS.execFile;

export type GithubCliResult = {
  available: boolean;
  reason?: string;
  nextAction?: string;
};

export type GithubSubmitOutcome =
  | { ok: true; issueUrl: string }
  | { ok: false; reason: string; nextAction: string };

export const DEFAULT_GH_TIMEOUT_MS = 30_000;

const GH_COMMAND = 'gh';

interface ExecOutcome {
  code: number;
  stdout: string;
  stderr: string;
}

interface ExecFileOpts {
  cmd: string;
  args: string[];
  timeoutMs: number;
  proxy?: string;
}

function execFileAsync(execFile: ExecFileFn, opts: ExecFileOpts): Promise<ExecOutcome> {
  return new Promise((resolve, reject) => {
    execFile(
      opts.cmd,
      opts.args,
      {
        timeout: opts.timeoutMs,
        windowsHide: true,
        env: opts.proxy
          ? { ...process.env, HTTPS_PROXY: opts.proxy, https_proxy: opts.proxy }
          : process.env,
      },
      (err, stdout, stderr) => {
        if (err) {
          reject(err);
          return;
        }
        resolve({ code: 0, stdout: stdout ?? '', stderr: stderr ?? '' });
      },
    );
  });
}

async function safeUnlink(fsMod: typeof fsNS, file: string): Promise<void> {
  try {
    await fsMod.promises.unlink(file);
  } catch {
    // Best-effort cleanup; the tmp dir is system-managed.
  }
}

/**
 * Detect whether the gh channel is usable: gh exists and `gh auth status` exits 0.
 * Any execFile error (command missing / not authenticated / other) reports
 * unavailable with a structured nextAction. Fail-closed here — unlike channel
 * probing, a non-zero auth status genuinely means submission would fail.
 */
export async function detectGithubCli(deps?: ChannelDeps): Promise<GithubCliResult> {
  const execFile = deps?.execFile ?? (await import('node:child_process')).execFile;

  // 1. gh present? A success here means the version probe ran without error.
  try {
    await execFileAsync(execFile, { cmd: GH_COMMAND, args: ['--version'], timeoutMs: 5_000 });
  } catch {
    return {
      available: false,
      reason: '未安装 gh CLI',
      nextAction: '安装 GitHub CLI:https://cli.github.com/ 后重试',
    };
  }

  // 2. authenticated?
  try {
    await execFileAsync(execFile, { cmd: GH_COMMAND, args: ['auth', 'status'], timeoutMs: 5_000 });
    return { available: true };
  } catch {
    return {
      available: false,
      reason: 'gh 未登录 GitHub',
      nextAction: '运行 `gh auth login` 完成登录后重试',
    };
  }
}

/**
 * gh issue create --repo <repo> --title <title> --body-file <tmp> --label feedback
 * Writes the markdown body to a 0600 temp file, runs gh, deletes the temp file,
 * then parses the issue URL from gh's stdout.
 */
export async function submitToGithub(args: {
  repo: string;
  proxy?: string;
  report: FeedbackReport;
  execFile?: ExecFileFn;
  fs?: typeof fsNS;
  os?: typeof osNS;
  path?: typeof pathNS;
  timeoutMs?: number;
}): Promise<GithubSubmitOutcome> {
  const execFile = args.execFile ?? (await import('node:child_process')).execFile;
  const fsMod = args.fs ?? (await import('node:fs'));
  const osMod = args.os ?? (await import('node:os'));
  const pathMod = args.path ?? (await import('node:path'));
  const timeoutMs = args.timeoutMs ?? DEFAULT_GH_TIMEOUT_MS;

  const { title, id, outputs } = args.report;
  const body = outputs?.markdown ?? '';

  // Write body to a 0600 temp file to avoid leaking via argv / shell quoting.
  const tmpFile = pathMod.join(osMod.tmpdir(), `pd-feedback-${id}.md`);
  try {
    await fsMod.promises.writeFile(tmpFile, body, { encoding: 'utf8', mode: 0o600 });
  } catch (err) {
    return {
      ok: false,
      reason: `无法写入临时文件写入 gh 正文:${err instanceof Error ? err.message : String(err)}`,
      nextAction: '检查临时目录可写后重试;或改用反馈服务通道',
    };
  }

  let out: ExecOutcome;
  try {
    out = await execFileAsync(
      execFile,
      {
        cmd: GH_COMMAND,
        args: ['issue', 'create', '--repo', args.repo, '--title', title, '--body-file', tmpFile, '--label', 'feedback'],
        timeoutMs,
        proxy: args.proxy && args.proxy.length > 0 ? args.proxy : undefined,
      },
    );
  } catch (err) {
    await safeUnlink(fsMod, tmpFile);
    const reason = err instanceof Error
      ? (err as { killed?: boolean; code?: unknown }).code === 'ETIMEDOUT'
        ? `gh 提交超时(${timeoutMs}ms)`
        : err.message
      : String(err);
    return {
      ok: false,
      reason: `gh 建单失败:${reason}`,
      nextAction: '确认 gh 已登录且网络可达(可能需要代理);重试或改用反馈服务通道',
    };
  }

  await safeUnlink(fsMod, tmpFile);

  const urlMatch = /\bhttps:\/\/github\.com\/\S+\b/.exec(out.stdout);
  if (!urlMatch) {
    return {
      ok: false,
      reason: 'gh 建单成功但无法解析 issue 链接',
      nextAction: '在 GitHub 仓库确认新 issue 已创建,并把链接手动记下',
    };
  }
  return { ok: true, issueUrl: urlMatch[0] };
}