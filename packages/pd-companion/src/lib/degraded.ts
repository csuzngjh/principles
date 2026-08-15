/**
 * Degraded-state copy: every failure path surfaces a structured reason and a
 * next action (rc-9). pd-cli's own nextAction is preferred when present so
 * the companion never invents conflicting guidance.
 */

import type { DegradedReasonKey } from './supervisor.js';

export interface DegradedInfo {
  title: string;
  description: string;
  nextAction: string;
}

const COPY: Record<DegradedReasonKey, DegradedInfo> = {
  node_missing: {
    title: '未检测到 Node.js',
    description: 'PD Companion 需要系统 Node.js（≥ 18）来运行 PD 控制台服务。当前 PATH 中找不到 node 命令。',
    nextAction: '安装 Node.js ≥ 18（https://nodejs.org）后，从托盘菜单选择「重启控制台服务」。',
  },
  pd_not_installed: {
    title: '未找到已安装的 PD',
    description: '在 ~/.openclaw/extensions/principles-disciple 未找到 PD 控制台运行时。',
    nextAction: '先运行 npx create-principles-disciple 完成安装，再从托盘菜单重启控制台服务。',
  },
  workspace_missing: {
    title: '未找到 PD 工作区',
    description: '无法解析默认工作区。请显式指定一个工作区。',
    nextAction: '在 Companion 设置中选择工作区目录，或设置 PD_WORKSPACE_DIR 环境变量。',
  },
  server_crash_loop: {
    title: '控制台服务反复崩溃',
    description: '控制台服务连续多次启动失败，Companion 已停止自动重启以避免空转。',
    nextAction: '查看日志（Companion 数据目录 logs/ 下），或重新运行 npx create-principles-disciple 修复安装。',
  },
  launch_failed: {
    title: '控制台启动失败',
    description: 'pd console open 返回失败。详见下方原因。',
    nextAction: '查看日志后从托盘菜单重试；如持续失败，重新运行 npx create-principles-disciple。',
  },
};

export function describeDegraded(
  reason: DegradedReasonKey,
  detail?: string,
  cliNextAction?: string,
): DegradedInfo {
  const base = COPY[reason];
  const nextAction = cliNextAction !== undefined && cliNextAction.length > 0 ? cliNextAction : base.nextAction;
  const description = detail !== undefined && detail.length > 0 ? `${base.description}（${detail}）` : base.description;
  return { title: base.title, description, nextAction };
}

/** Escape untrusted text for embedding in the degraded data: URL page. */
export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function buildDegradedPageHtml(info: DegradedInfo): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>PD Companion</title>
<style>
  body { font-family: "Segoe UI", "Microsoft YaHei", sans-serif; background: #0f172a; color: #e2e8f0;
         display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
  .card { max-width: 560px; padding: 32px; border-radius: 12px; background: #1e293b; }
  h1 { font-size: 20px; margin: 0 0 12px; }
  p { font-size: 14px; line-height: 1.7; margin: 0 0 16px; color: #94a3b8; }
  .next { font-size: 14px; color: #7dd3fc; }
</style>
</head>
<body><div class="card">
<h1>${escapeHtml(info.title)}</h1>
<p>${escapeHtml(info.description)}</p>
<p class="next">下一步：${escapeHtml(info.nextAction)}</p>
</div></body>
</html>`;
}
