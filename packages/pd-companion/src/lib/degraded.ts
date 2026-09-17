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

// ─── Workspace worker degradation (PRI-715) ──────────────────────────────────
// When the restart ladder is exhausted the workspace pipeline stays stopped
// until the Owner acts — there is NO automatic recovery (Owner decision), so
// the copy must name the workspace, the reason and the real recovery path.

const WORKER_DEGRADED_REASON = 'worker 反复崩溃，自动重启次数已耗尽';
const WORKER_DEGRADED_NEXT_ACTION = '重启 PD Companion（托盘菜单「退出」后重新打开）即可恢复该工作区的管道';

/** Last path segment as display name; falls back to the full path for roots. */
function workspaceDisplayName(canonicalWorkspace: string): string {
  const normalized = canonicalWorkspace.replaceAll('\\', '/');
  const base = normalized.slice(normalized.lastIndexOf('/') + 1);
  return base.length > 0 ? base : canonicalWorkspace;
}

/** One-shot notification copy for a workspace that just became degraded. */
export function describeWorkspaceWorkerDegraded(canonicalWorkspace: string): { title: string; body: string } {
  return {
    title: `PD 工作区管道已停止：${workspaceDisplayName(canonicalWorkspace)}`,
    body: `${WORKER_DEGRADED_REASON}，该工作区的管道已暂停。${WORKER_DEGRADED_NEXT_ACTION}。`,
  };
}

export interface DegradedWorkspacesTrayView {
  /** Appended to the tray status line; '' when nothing is degraded. */
  statusSuffix: string;
  /** Disabled informational menu items: header, one per workspace, recovery. */
  menuLabels: string[];
}

/** Persistent tray projection of the currently degraded workspaces (pure read). */
export function buildDegradedWorkspacesTrayView(canonicalWorkspaces: readonly string[]): DegradedWorkspacesTrayView {
  if (canonicalWorkspaces.length === 0) return { statusSuffix: '', menuLabels: [] };
  const count = `${canonicalWorkspaces.length}`;
  return {
    statusSuffix: `；⚠ ${count} 个工作区管道已停止`,
    menuLabels: [
      `⚠ ${count} 个工作区管道已停止（${WORKER_DEGRADED_REASON}）`,
      ...canonicalWorkspaces.map((canonical) => `・${workspaceDisplayName(canonical)}（${canonical}）`),
      `恢复方式：${WORKER_DEGRADED_NEXT_ACTION}`,
    ],
  };
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
