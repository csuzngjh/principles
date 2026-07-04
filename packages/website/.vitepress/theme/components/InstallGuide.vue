<template>
  <div class="install-guide">
    <h1 class="guide-title">{{ isZh ? '安装 PD' : 'Install Principles Disciple' }}</h1>
    <p class="guide-subtitle">
      {{ isZh
        ? '单命令、引导式安装。Installer 会检测环境并自动启动控制台。'
        : 'Single-command, guided install. Installer checks environment and auto-launches console.'
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
          <span class="note">{{ isZh ? '（PD 当前仅支持 OpenClaw 宿主）' : '(PD currently supports OpenClaw host only)' }}</span>
        </li>
      </ul>
    </section>

    <section class="guide-step">
      <h2 class="step-title">{{ isZh ? '步骤 2 · 运行安装命令' : 'Step 2 · Run install command' }}</h2>
      <div class="command-row"><code>{{ command }}</code><button type="button" :aria-label="copyLabel" aria-live="polite" data-umami-event="copy_install_command" @click="copyCommand">{{ copyState }}</button></div>
      <p class="step-desc">
        {{ isZh
          ? '在终端中运行此命令。--yes 跳过 npx 安装确认提示；Installer 会自动检测 Node 和 OpenClaw，缺失时给出官方下载链接。'
          : 'Run this command in your terminal. --yes skips the npx install confirmation; Installer auto-detects Node and OpenClaw, provides official download links if missing.'
        }}
      </p>
    </section>

    <section class="guide-step">
      <h2 class="step-title">{{ isZh ? '步骤 3 · 注册 PD 网关' : 'Step 3 · Register PD gateway' }}</h2>
      <div class="command-row"><code>openclaw gateway --force</code></div>
      <p class="step-desc">
        {{ isZh
          ? '安装完成后，在 OpenClaw 中注册 PD 网关。--force 用于首次注册或覆盖旧版本。注册成功后 PD 钩子即生效。'
          : 'After install, register the PD gateway in OpenClaw. Use --force for first-time registration or to overwrite a previous version. PD hooks become active once registered.'
        }}
      </p>
    </section>

    <section class="guide-step">
      <h2 class="step-title">{{ isZh ? '步骤 4 · 安装完成后' : 'Step 4 · After install completes' }}</h2>
      <p class="step-desc">
        {{ isZh
          ? 'Installer 会自动启动控制台并打开浏览器到 /welcome 页面。按 onboarding 向导完成首次配置。'
          : 'Installer auto-launches console and opens browser to /welcome page. Follow the onboarding wizard to complete first-time setup.'
        }}
      </p>
    </section>

    <div class="host-disclaimer">
      {{ isZh
        ? '当前支持 OpenClaw 宿主。Codex/Claude Code 支持正在开发中。'
        : 'Currently supports OpenClaw host. Codex/Claude Code support is under development.'
      }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useIsZh } from '../composables/useIsZh'
const isZh = useIsZh()
const command = 'npx create-principles-disciple --yes'
const copyStatus = ref<'idle' | 'success' | 'error'>('idle')
const copyState = computed(() => copyStatus.value === 'success' ? (isZh.value ? '已复制' : 'Copied') : copyStatus.value === 'error' ? (isZh.value ? '复制失败' : 'Copy failed') : (isZh.value ? '复制' : 'Copy'))
const copyLabel = computed(() => isZh.value ? '复制安装命令' : 'Copy install command')
let copyTimer: number | null = null
async function copyCommand() {
  try { await navigator.clipboard.writeText(command); copyStatus.value = 'success' }
  catch { copyStatus.value = 'error' }
  if (copyTimer) clearTimeout(copyTimer)
  copyTimer = window.setTimeout(() => {
    copyStatus.value = 'idle'
    copyTimer = null
  }, 2000)
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
