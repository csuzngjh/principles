<template>
  <div class="install-guide">
    <h1 class="guide-title">{{ isZh ? '安装 PD' : 'Install Principles Disciple' }}</h1>
    <p class="guide-subtitle">
      {{ isZh
        ? '先选择你的宿主环境，再按当前路径的步骤安装。切换选择不会执行任何安装。'
        : 'Pick your host environment first, then follow that path only. Switching the selection never installs anything.'
      }}
    </p>

    <!-- ── Host selection (default view) ─────────────────────────────────── -->
    <section v-if="selectedHost === null" class="host-select" data-testid="install-host-select">
      <h2 class="step-title">{{ isZh ? '步骤 1 · 你在哪个宿主里使用 Agent？' : 'Step 1 · Which host runs your Agent?' }}</h2>
      <div class="host-entries">
        <button type="button" class="host-entry" data-testid="install-host-openclaw" @click="selectHost('openclaw')">
          <span class="host-name">OpenClaw</span>
          <span class="host-desc">{{ isZh ? '已安装或准备安装 OpenClaw CLI —— 一条 npx 命令装好运行时钩子、pd CLI 与审核控制台。' : 'OpenClaw CLI installed or planned — one npx command installs runtime hooks, the pd CLI, and the review console.' }}</span>
          <span class="host-cta">{{ isZh ? '查看 OpenClaw 安装步骤 →' : 'OpenClaw install steps →' }}</span>
        </button>
        <button type="button" class="host-entry" data-testid="install-host-codex" @click="selectHost('codex')">
          <span class="host-name">Codex</span>
          <span class="host-desc">{{ isZh ? '使用 OpenAI Codex CLI / 桌面端 —— 两行命令从插件市场安装 PD 插件。' : 'Using OpenAI Codex CLI / desktop — two commands install the PD plugin from the marketplace.' }}</span>
          <span class="host-cta">{{ isZh ? '查看 Codex 安装步骤 →' : 'Codex install steps →' }}</span>
        </button>
      </div>
      <p class="step-desc note-text">
        {{ isZh
          ? '两个入口最终安装的是同一套 PD；区别只在于宿主环境的接入方式。不确定的话，看你的 Agent 是在哪个应用里运行的。'
          : 'Both entries install the same PD; only the host integration differs. If unsure, check which application your Agent runs in.'
        }}
      </p>
    </section>

    <!-- ── OpenClaw path ──────────────────────────────────────────────────── -->
    <template v-else-if="selectedHost === 'openclaw'">
      <div class="host-banner" data-testid="install-host-banner">
        <span>{{ isZh ? '当前路径：OpenClaw 宿主' : 'Current path: OpenClaw host' }}</span>
        <button type="button" class="host-switch" data-testid="install-host-switch" @click="selectHost(null)">
          {{ isZh ? '切换宿主' : 'Switch host' }}
        </button>
      </div>

      <section class="guide-step">
        <h2 class="step-title">{{ isZh ? '步骤 1 · 前置条件（OpenClaw）' : 'Step 1 · Prerequisites (OpenClaw)' }}</h2>
        <ul class="prereq-list">
          <li>
            <strong>Node.js ≥ 22</strong> —
            <a href="https://nodejs.org/" target="_blank" rel="noopener">nodejs.org</a>
          </li>
          <li>
            <strong>OpenClaw</strong> —
            <a href="https://github.com/openclaw/openclaw" target="_blank" rel="noopener">{{ isZh ? 'OpenClaw 官方安装' : 'OpenClaw official install' }}</a>
          </li>
        </ul>
      </section>

      <section class="guide-step">
        <h2 class="step-title">{{ isZh ? '步骤 2 · 一键安装（OpenClaw）' : 'Step 2 · One-command install (OpenClaw)' }}</h2>
        <div class="command-row"><code>{{ installCommand }}</code><button type="button" :aria-label="copyLabel(isZh ? 'npx 安装命令' : 'npx install command')" aria-live="polite" data-umami-event="copy_install_command" @click="copyCommand('install', installCommand)">{{ copyState('install') }}</button></div>
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
        <h2 class="step-title">{{ isZh ? '步骤 3 · 注册 PD 网关' : 'Step 3 · Register the PD gateway' }}</h2>
        <div class="command-row"><code>openclaw gateway --force</code><button type="button" :aria-label="copyLabel(isZh ? '网关注册命令' : 'gateway command')" aria-live="polite" data-umami-event="copy_gateway_command" @click="copyCommand('gateway', gatewayCommand)">{{ copyState('gateway') }}</button></div>
        <p class="step-desc">
          {{ isZh
            ? '安装完成后，在 OpenClaw 中注册 PD 网关。--force 用于首次注册或覆盖旧版本。注册成功后 PD 钩子即生效。'
            : 'After install, register the PD gateway in OpenClaw. Use --force for first-time registration or to overwrite a previous version. PD hooks become active once registered.'
          }}
        </p>
      </section>

      <section class="guide-step">
        <h2 class="step-title">{{ isZh ? '步骤 4 · 启动审核控制台并验证' : 'Step 4 · Launch the review console and verify' }}</h2>
        <p class="step-desc">
          {{ isZh
            ? '审核控制台随安装一并装入，无需单独安装。Installer 会首次自动启动并打开浏览器到 /welcome 页面。之后随时用命令行重新打开：'
            : 'The review console is installed together with PD — no separate install. The installer auto-launches it and opens /welcome on first run. Reopen it anytime with:'
          }}
        </p>
        <div class="command-row"><code>{{ consoleCommand }}</code><button type="button" :aria-label="copyLabel(isZh ? '控制台命令' : 'console command')" aria-live="polite" data-umami-event="copy_console_command" @click="copyCommand('console', consoleCommand)">{{ copyState('console') }}</button></div>
        <p class="step-desc">
          {{ isZh
            ? '默认绑定本机 127.0.0.1:3100，仅本机可访问；端口被占用时会自动尝试下一个本地端口。想确认安装是否健康，运行：'
            : 'Binds to 127.0.0.1:3100 on your machine only; if the port is busy it auto-tries the next local port. To verify the install is healthy:'
          }}
        </p>
        <div class="command-row"><code>{{ canaryCommand }}</code><button type="button" :aria-label="copyLabel(isZh ? '健康检查命令' : 'health-check command')" aria-live="polite" data-umami-event="copy_canary_command" @click="copyCommand('canary', canaryCommand)">{{ copyState('canary') }}</button></div>
        <p class="step-desc">
          {{ isZh
            ? '输出 healthy 表示链路可用；degraded 表示存在非致命问题（如新装还没跑过任务、队列有阻塞、有孤儿候选等），控制面板仍可正常使用，按输出里的 summary / recommendedNextActions 处理即可。'
            : 'A healthy status means the pipeline works; degraded means a non-fatal issue (e.g. a fresh install not exercised yet, blocked queue tasks, or orphan candidates) — the console still works; follow summary / recommendedNextActions in the output.'
          }}
        </p>
      </section>

      <CompanionNote :is-zh="isZh" />
    </template>

    <!-- ── Codex path ─────────────────────────────────────────────────────── -->
    <template v-else>
      <div class="host-banner" data-testid="install-host-banner">
        <span>{{ isZh ? '当前路径：Codex 宿主（CLI / 桌面端）' : 'Current path: Codex host (CLI / desktop)' }}</span>
        <button type="button" class="host-switch" data-testid="install-host-switch" @click="selectHost(null)">
          {{ isZh ? '切换宿主' : 'Switch host' }}
        </button>
      </div>

      <section class="guide-step">
        <h2 class="step-title">{{ isZh ? '步骤 1 · 前置条件（Codex）' : 'Step 1 · Prerequisites (Codex)' }}</h2>
        <ul class="prereq-list">
          <li>
            <strong>Codex CLI ≥ 0.147</strong> —
            <a href="https://developers.openai.com/codex/cli/" target="_blank" rel="noopener">{{ isZh ? 'Codex CLI 官方安装' : 'Codex CLI official install' }}</a>
          </li>
          <li>
            <strong>pd CLI</strong> —
            {{ isZh
              ? 'Codex 路径的工作区初始化（$pd-setup）与 $pd-review 需要 pd 命令；缺失时按插件提示安装：'
              : 'the Codex path workspace setup ($pd-setup) and $pd-review require the pd command; if missing, install it as the plugin instructs:'
            }}
          </li>
        </ul>
        <div class="command-row"><code>{{ pdCliCommand }}</code><button type="button" :aria-label="copyLabel(isZh ? '安装 pd CLI 命令' : 'install pd CLI command')" aria-live="polite" data-umami-event="copy_pd_cli_command" @click="copyCommand('pdCli', pdCliCommand)">{{ copyState('pdCli') }}</button></div>
        <p class="step-desc">
          {{ isZh
            ? '插件安装后的 $pd-setup 会校验 Node 运行时、工作区与信任链，缺什么会明确告诉你。'
            : 'after installing the plugin, $pd-setup verifies the Node runtime, workspace, and trust chain — it names anything missing.'
          }}
        </p>
      </section>

      <section class="guide-step">
        <h2 class="step-title">{{ isZh ? '步骤 2 · 从插件市场安装（Codex）' : 'Step 2 · Install from the plugin marketplace (Codex)' }}</h2>
        <div class="command-row"><code>{{ codexMarketCommand }}</code><button type="button" :aria-label="copyLabel(isZh ? '添加插件市场命令' : 'add marketplace command')" aria-live="polite" data-umami-event="copy_codex_market_command" @click="copyCommand('codexMarket', codexMarketCommand)">{{ copyState('codexMarket') }}</button></div>
        <div class="command-row"><code>{{ codexPluginCommand }}</code><button type="button" :aria-label="copyLabel(isZh ? '安装插件命令' : 'install plugin command')" aria-live="polite" data-umami-event="copy_codex_plugin_command" @click="copyCommand('codexPlugin', codexPluginCommand)">{{ copyState('codexPlugin') }}</button></div>
        <p class="step-desc">
          {{ isZh
            ? '安装插件后，在 Codex 会话中运行 $pd-setup 初始化工作区，并通过 /hooks 信任 PD 钩子。$pd-review 打开审核控制台，$pd-disable 一键停用。'
            : 'After installing the plugin, run $pd-setup in a Codex session to initialize the workspace, then trust the PD hooks via /hooks. $pd-review opens the owner console; $pd-disable stops PD instantly.'
          }}
        </p>
      </section>

      <section class="guide-step">
        <h2 class="step-title">{{ isZh ? '步骤 3 · 验证安装（Codex）' : 'Step 3 · Verify the install (Codex)' }}</h2>
        <p class="step-desc">
          {{ isZh
            ? '$pd-setup 完成后，$pd-review 能打开审核控制台即说明插件链路可用。命令行健康检查：'
            : 'Once $pd-setup completes, opening the review console via $pd-review confirms the plugin path works. CLI health check:'
          }}
        </p>
        <div class="command-row"><code>{{ codexHealthCommand }}</code><button type="button" :aria-label="copyLabel(isZh ? 'Codex 健康检查命令' : 'Codex health-check command')" aria-live="polite" data-umami-event="copy_canary_command" @click="copyCommand('codexHealth', codexHealthCommand)">{{ copyState('codexHealth') }}</button></div>
        <p class="step-desc">
          {{ isZh
            ? '输出会标注钩子信任状态；未信任时按 /hooks 指引完成信任即可。'
            : 'The output reports hook trust state; if untrusted, follow the /hooks guidance to trust them.'
          }}
        </p>
      </section>

      <CompanionNote :is-zh="isZh" />
    </template>

    <div class="host-disclaimer">
      {{ isZh
        ? 'OpenClaw 宿主：npx 一键安装（Node ≥ 22）。Codex（CLI/桌面端）：插件市场两行命令安装（Codex CLI ≥ 0.147）。Claude Code 支持规划中。'
        : 'OpenClaw host: one-command npx install (Node ≥ 22). Codex (CLI/desktop): two-command plugin install (Codex CLI ≥ 0.147). Claude Code is planned.'
      }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useIsZh } from '../composables/useIsZh'
import CompanionNote from './CompanionNote.vue'
const isZh = useIsZh()

type Host = 'openclaw' | 'codex' | null

// SPEC-PD-UIUX-001 R7: the chosen host lives in the URL query (?host=), not in
// persisted state — refresh, back and forward all reflect the URL, and nothing
// is installed by switching.
const selectedHost = ref<Host>(null)

function readHostFromUrl() {
  if (typeof window === 'undefined') return
  const params = new URLSearchParams(window.location.search)
  const value = params.get('host')
  selectedHost.value = value === 'openclaw' || value === 'codex' ? value : null
}

function selectHost(host: Host) {
  const url = new URL(window.location.href)
  if (host === null) url.searchParams.delete('host')
  else url.searchParams.set('host', host)
  window.history.pushState({}, '', url)
  selectedHost.value = host
}

function onPopState() {
  readHostFromUrl()
}

onMounted(() => {
  readHostFromUrl()
  window.addEventListener('popstate', onPopState)
})
onUnmounted(() => {
  window.removeEventListener('popstate', onPopState)
})

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
const codexHealthCommand = 'pd health --host codex'
// Review round (P2): authoritative per the plugin itself — pd-setup.cjs fails
// with pd_cli_unavailable and instructs exactly this install command.
const pdCliCommand = 'npm install -g @principles/pd-cli'

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
// R7: the aria-label names WHICH command is copied, so several command rows on
// one page stay distinguishable for assistive tech.
function copyLabel(commandName: string) {
  return `${isZh.value ? '复制' : 'Copy'}: ${commandName}`
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

/* ── Host selection ── */
.host-entries {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 14px;
  margin: 1rem 0;
}
.host-entry {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
  padding: 20px;
  text-align: left;
  border: 1px solid var(--border);
  border-radius: 16px;
  background: var(--surface);
  cursor: pointer;
  transition: border-color 0.25s ease;
  min-height: 44px;
}
.host-entry:hover { border-color: var(--accent-border); }
.host-entry:focus-visible { outline: 3px solid var(--accent); outline-offset: 3px; }
.host-name {
  font-size: 1.15rem;
  font-weight: 650;
  color: var(--text-main);
}
.host-desc {
  font-size: 0.9rem;
  line-height: 1.6;
  color: var(--text-secondary);
}
.host-cta {
  margin-top: auto;
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--accent);
}

/* ── Selected-host banner ── */
.host-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 1.5rem;
  padding: 12px 16px;
  border: 1px solid var(--accent-border);
  border-radius: 12px;
  background: var(--accent-dim);
  color: var(--text-main);
  font-size: 0.95rem;
  font-weight: 600;
}
.host-switch {
  min-height: 44px;
  padding: 0 16px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text-secondary);
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
}
.host-switch:hover { color: var(--text-main); border-color: var(--accent-border); }
.host-switch:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }

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
