<template>
  <div class="install-guide">
    <h1 class="guide-title">{{ isZh ? '安装 PD' : 'Install Principles Disciple' }}</h1>
    <p class="guide-subtitle">
      {{ isZh
        ? '一条命令装好全部组件：运行时钩子 + pd CLI + 审核控制台。Installer 会检测环境并自动启动控制台。'
        : 'One command installs everything: runtime hooks, pd CLI, and the review console. The installer checks your environment and auto-launches the console.'
      }}
    </p>

    <section class="guide-step">
      <h2 class="step-title">{{ isZh ? '步骤 1 · 前置条件' : 'Step 1 · Prerequisites' }}</h2>
      <ul class="prereq-list">
        <li>
          <strong>Node.js ≥ 18</strong> —
          <a href="https://nodejs.org/" target="_blank" rel="noopener">nodejs.org</a>
        </li>
        <li>
          <strong>OpenClaw</strong> —
          <a href="https://github.com/openclaw/openclaw" target="_blank" rel="noopener">{{ isZh ? 'OpenClaw 官方安装' : 'OpenClaw official install' }}</a>
          <span class="note">{{ isZh ? '（仅 OpenClaw 宿主需要；Codex 宿主可用 --host codex 跳过）' : '(OpenClaw host only; Codex host can skip with --host codex)' }}</span>
        </li>
      </ul>
    </section>

    <section class="guide-step">
      <h2 class="step-title">{{ isZh ? '步骤 2 · 一键安装' : 'Step 2 · One-command install' }}</h2>
      <div class="command-row"><code>{{ installCommand }}</code><button type="button" :aria-label="copyLabel('install')" aria-live="polite" data-umami-event="copy_install_command" @click="copyCommand('install', installCommand)">{{ copyState('install') }}</button></div>
      <p class="step-desc">{{ isZh ? '一次安装三个组件：' : 'Installs three components in one pass:' }}</p>
      <ul class="component-list">
        <li>
          <span class="component-dot" aria-hidden="true"></span>
          <span><strong>{{ isZh ? '运行时钩子' : 'Runtime hooks' }}</strong> — {{ isZh ? '在 AI 助手运行时捕捉痛苦信号、注入已批准的原则' : 'capture pain signals and inject approved principles while the agent runs' }}</span>
        </li>
        <li>
          <span class="component-dot" aria-hidden="true"></span>
          <span><strong>pd CLI</strong> — {{ isZh ? '命令行工具：健康检查、诊断、启动控制台' : 'CLI tool: health checks, diagnostics, console launch' }}</span>
        </li>
        <li>
          <span class="component-dot" aria-hidden="true"></span>
          <span><strong>{{ isZh ? '审核控制台' : 'Review console' }}</strong>（pd-console）— {{ isZh ? '浏览器审核界面，观察与审批原则' : 'browser UI to review and approve principles' }}</span>
        </li>
      </ul>
      <p class="step-desc">
        {{ isZh
          ? '--yes 跳过 npx 安装确认提示；Installer 自动检测 Node 与 OpenClaw，缺失时给出官方下载链接。'
          : '--yes skips the npx install confirmation; Installer auto-detects Node and OpenClaw and provides official download links if missing.'
        }}
      </p>
    </section>

    <section class="guide-step">
      <h2 class="step-title">{{ isZh ? '步骤 3 · 注册 PD 网关（OpenClaw 宿主）' : 'Step 3 · Register PD gateway (OpenClaw host)' }}</h2>
      <div class="command-row"><code>openclaw gateway --force</code><button type="button" :aria-label="copyLabel('gateway')" aria-live="polite" data-umami-event="copy_gateway_command" @click="copyCommand('gateway', gatewayCommand)">{{ copyState('gateway') }}</button></div>
      <p class="step-desc">
        {{ isZh
          ? '安装完成后，在 OpenClaw 中注册 PD 网关。--force 用于首次注册或覆盖旧版本。注册成功后 PD 钩子即生效。Codex 宿主跳过此步。'
          : 'After install, register the PD gateway in OpenClaw. Use --force for first-time registration or to overwrite a previous version. PD hooks become active once registered. Codex host skips this step.'
        }}
      </p>
    </section>

    <section class="guide-step">
      <h2 class="step-title">{{ isZh ? '步骤 4 · 安装完成后 · 启动审核控制台' : 'Step 4 · After install · Launch the review console' }}</h2>
      <p class="step-desc">
        {{ isZh
          ? '审核控制台随安装一并装入，无需单独安装。Installer 会首次自动启动并打开浏览器到 /welcome 页面。之后随时用命令行重新打开：'
          : 'The review console is installed together with PD — no separate install. The installer auto-launches it and opens /welcome on first run. Reopen it anytime with:'
        }}
      </p>
      <div class="command-row"><code>{{ consoleCommand }}</code><button type="button" :aria-label="copyLabel('console')" aria-live="polite" data-umami-event="copy_console_command" @click="copyCommand('console', consoleCommand)">{{ copyState('console') }}</button></div>
      <p class="step-desc">
        {{ isZh
          ? '默认绑定本机 127.0.0.1:3100，仅本机可访问；端口被占用时会自动尝试下一个本地端口。想确认安装是否健康，运行：'
          : 'Binds to 127.0.0.1:3100 on your machine only; if the port is busy it auto-tries the next local port. To verify the install is healthy:'
        }}
      </p>
      <div class="command-row"><code>{{ canaryCommand }}</code><button type="button" :aria-label="copyLabel('canary')" aria-live="polite" data-umami-event="copy_canary_command" @click="copyCommand('canary', canaryCommand)">{{ copyState('canary') }}</button></div>
      <p class="step-desc">
        {{ isZh
          ? '输出 healthy 表示链路可用；degraded 表示存在非致命问题（如新装还没跑过任务、队列有阻塞、有孤儿候选等），控制面板仍可正常使用，按输出里的 summary / recommendedNextActions 处理即可。'
          : 'A healthy status means the pipeline works; degraded means a non-fatal issue (e.g. a fresh install not exercised yet, blocked queue tasks, or orphan candidates) — the console still works; follow summary / recommendedNextActions in the output.'
        }}
      </p>
    </section>

    <section class="guide-step">
      <h2 class="step-title">{{ isZh ? '桌面端 PD Companion（Windows）' : 'Desktop PD Companion (Windows)' }}</h2>
      <p class="step-desc">
        {{ isZh
          ? '想省去终端操作？PD Companion 把控制台变成常驻桌面应用：独立窗口 + 系统托盘 + 审批/更新实时通知，双击即用。'
          : 'Prefer no terminal? PD Companion turns the console into a resident desktop app: its own window, a system tray icon, and real-time approval/update notifications.'
        }}
      </p>
      <p class="step-desc">
        {{ isZh
          ? '前提：已按上面的步骤安装 PD（Companion 是已装 PD 的增强入口，不替代安装）。'
          : 'Prerequisite: PD must already be installed (Companion is an add-on to an existing PD install, not a replacement).'
        }}
      </p>
      <p class="step-desc">
        <a :href="isZh ? '/zh/download' : '/download'" class="guide-link" data-umami-event="cta_companion_download">
          {{ isZh ? '前往下载页下载 Companion →' : 'Download Companion →' }}
        </a>
      </p>
      <p class="step-desc note-text">
        {{ isZh ? 'v1 安装包未签名，如遇蓝色 SmartScreen 提示：更多信息 → 仍要运行。' : 'v1 installers are unsigned — if SmartScreen appears: More info → Run anyway.' }}
      </p>
    </section>

    <section class="guide-step">
      <h2 class="step-title">{{ isZh ? 'Codex 宿主（CLI / 桌面端）' : 'Codex host (CLI / Desktop)' }}</h2>
      <div class="command-row"><code>codex plugin marketplace add csuzngjh/principles</code><button type="button" :aria-label="copyLabel('codexMarket')" aria-live="polite" data-umami-event="copy_codex_market_command" @click="copyCommand('codexMarket', codexMarketCommand)">{{ copyState('codexMarket') }}</button></div>
      <div class="command-row"><code>codex plugin add principles-disciple@principles</code><button type="button" :aria-label="copyLabel('codexPlugin')" aria-live="polite" data-umami-event="copy_codex_plugin_command" @click="copyCommand('codexPlugin', codexPluginCommand)">{{ copyState('codexPlugin') }}</button></div>
      <p class="step-desc">
        {{ isZh
          ? '需要 Codex CLI ≥ 0.147 与 Node ≥ 20。安装插件后，在 Codex 会话中运行 $pd-setup 初始化工作区，并通过 /hooks 信任 PD 钩子。$pd-review 打开审核控制台，$pd-disable 一键停用。'
          : 'Requires Codex CLI >= 0.147 and Node >= 20. After installing the plugin, run $pd-setup in a Codex session to initialize the workspace, then trust the PD hooks via /hooks. $pd-review opens the owner console; $pd-disable stops PD instantly.'
        }}
      </p>
    </section>

    <div class="host-disclaimer">
      {{ isZh
        ? 'OpenClaw 宿主：npx 一键安装。Codex（CLI/桌面端）：插件市场两行命令安装。Claude Code 支持规划中。'
        : 'OpenClaw host: one-command npx install. Codex (CLI/Desktop): two-command plugin install. Claude Code is planned.'
      }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useIsZh } from '../composables/useIsZh'
const isZh = useIsZh()

const installCommand = 'npx create-principles-disciple --yes'
const gatewayCommand = 'openclaw gateway --force'
const consoleCommand = computed(() => isZh.value
  ? 'pd console open --workspace "<你的工作区路径>"'
  : 'pd console open --workspace "<your-workspace-path>"')
const canaryCommand = computed(() => isZh.value
  ? 'pd runtime canary --workspace "<你的工作区路径>" --json'
  : 'pd runtime canary --workspace "<your-workspace-path>" --json')
const codexMarketCommand = 'codex plugin marketplace add csuzngjh/principles'
const codexPluginCommand = 'codex plugin add principles-disciple@principles'

const copiedKey = ref<string | null>(null)
let copyTimer: number | null = null
async function copyCommand(key: string, text: string) {
  try {
    await navigator.clipboard.writeText(text)
    copiedKey.value = key
  } catch {
    copiedKey.value = 'error'
  }
  if (copyTimer) clearTimeout(copyTimer)
  copyTimer = window.setTimeout(() => {
    copiedKey.value = null
    copyTimer = null
  }, 2000)
}
function copyState(key: string) {
  return copiedKey.value === key ? (isZh.value ? '已复制' : 'Copied')
    : copiedKey.value === 'error' ? (isZh.value ? '复制失败' : 'Copy failed')
    : (isZh.value ? '复制' : 'Copy')
}
function copyLabel(key: string) {
  return `${isZh.value ? '复制' : 'Copy'} command`
}
</script>

<style scoped>
.install-guide {
  max-width: 720px;
  margin: 0 auto;
  padding: 2rem 1.5rem 4rem;
}

.guide-title {
  font-size: 2rem;
  font-weight: 700;
  color: var(--text-main);
  margin-bottom: 0.5rem;
}

.guide-subtitle {
  font-size: 1.05rem;
  color: var(--text-secondary);
  margin-bottom: 2.5rem;
}

.guide-step {
  margin-bottom: 2.5rem;
  padding-top: 1.5rem;
  border-top: 1px solid var(--border);
}

.step-title {
  font-size: 1.2rem;
  font-weight: 600;
  color: var(--text-main);
  margin-bottom: 1rem;
}

.prereq-list {
  list-style: none;
  padding: 0;
}

.prereq-list li {
  padding: 0.5rem 0;
  color: var(--text-secondary);
}

.prereq-list a {
  color: var(--accent);
  text-decoration: none;
}

.prereq-list a:hover {
  text-decoration: underline;
}

.note {
  color: var(--text-muted);
  font-size: 0.85rem;
  margin-left: 0.5rem;
}

.component-list {
  list-style: none;
  padding: 0;
  margin: 0.5rem 0 1rem;
}

.component-list li {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 0.35rem 0;
  color: var(--text-secondary);
  line-height: 1.6;
}

.component-dot {
  flex: 0 0 auto;
  width: 8px;
  height: 8px;
  margin-top: 0.55em;
  border-radius: 50%;
  background: var(--accent);
  opacity: 0.8;
}

.command-row {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: center;
  gap: 10px;
  padding: 10px 10px 10px 16px;
  border-radius: 10px;
  background: #111827;
  margin: 1rem 0;
}

.command-row code {
  font-family: var(--vp-font-family-mono);
  font-size: 0.95rem;
  color: #f8fafc;
  white-space: nowrap;
  overflow-x: auto;
  display: block;
}

.command-row button {
  min-width: 68px;
  min-height: 44px;
  border: 0;
  border-radius: 8px;
  background: #7eb8da;
  color: #111827;
  font-weight: 650;
  cursor: pointer;
}

.step-desc {
  color: var(--text-secondary);
  line-height: 1.6;
}

.note-text {
  font-size: 0.9rem;
  color: var(--text-muted);
}

.guide-link {
  color: var(--accent);
  text-decoration: none;
  font-weight: 600;
}

.guide-link:hover {
  text-decoration: underline;
}

.host-disclaimer {
  margin-top: 3rem;
  padding: 1rem 1.25rem;
  background: var(--accent-dim);
  border-radius: 8px;
  color: var(--text-secondary);
  font-size: 0.9rem;
}

@media (max-width: 520px) {
  .command-row { grid-template-columns: 1fr; padding: 12px; }
  .command-row button { width: 100%; }
}
</style>
