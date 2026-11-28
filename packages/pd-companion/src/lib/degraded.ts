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
    description: 'PD Companion 需要系统 Node.js（≥ 22）来运行 PD 控制台服务。当前 PATH 中找不到 node 命令。',
    nextAction: '安装 Node.js ≥ 22（https://nodejs.org）后，从托盘菜单选择「重启控制台服务」。',
  },
  pd_not_installed: {
    title: '未找到已安装的 PD',
    description: '在 ~/.pd/runtime 未找到 PD 控制台运行时（旧版安装也会从 ~/.openclaw/extensions/principles-disciple 兼容查找）。',
    nextAction: '先运行 npx create-principles-disciple 完成安装，再从托盘菜单重启控制台服务。',
  },
  install_manifest_incompatible: {
    title: 'PD 安装清单与 Companion 版本不兼容',
    description: '~/.pd/install.json 的 layoutVersion 高于本 Companion 支持的版本。PD 运行时本身可能完好，只是桌面端过旧、无法解读新清单。',
    nextAction: '从 https://github.com/csuzngjh/principles/releases 下载最新 PD Companion（companion-v* 标签的 Windows 安装包）安装后重试；运行时无需重装。',
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
    description: '控制台服务未能拉起。详见下方原因。',
    // Do NOT point at `npx create-principles-disciple` here (PRI-1012): re-running
    // the installer over an existing install overwrites the current runtime with
    // the bundled version (AGENTS.md §1.1). Companion now waits out the update
    // chain itself, so reaching this page means that wait was exhausted.
    nextAction: '若刚刚做过 PD 更新，稍等片刻后从托盘菜单再点一次「重启控制台服务」；反复失败请查看日志（Companion 数据目录 logs/ 下）并记下原因。',
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
