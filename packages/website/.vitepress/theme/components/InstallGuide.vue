<template>
  <div class="install-guide">
    <h1 class="guide-title">{{ lang === 'zh-CN' ? '安装 PD' : 'Install Principles Disciple' }}</h1>
    <p class="guide-subtitle">
      {{ lang === 'zh-CN'
        ? '单命令、引导式安装。Installer 会检测环境并自动启动控制台。'
        : 'Single-command, guided install. Installer checks environment and auto-launches console.'
      }}
    </p>

    <section class="guide-step">
      <h2 class="step-title">{{ lang === 'zh-CN' ? '步骤 1 · 前置条件' : 'Step 1 · Prerequisites' }}</h2>
      <ul class="prereq-list">
        <li>
          <strong>Node.js ≥ 18</strong> —
          <a href="https://nodejs.org/" target="_blank" rel="noopener">nodejs.org</a>
        </li>
        <li>
          <strong>OpenClaw</strong> —
          <a href="https://github.com/openclaw/openclaw" target="_blank" rel="noopener">{{ lang === 'zh-CN' ? 'OpenClaw 官方安装' : 'OpenClaw official install' }}</a>
          <span class="note">{{ lang === 'zh-CN' ? '（PD 当前仅支持 OpenClaw 宿主）' : '(PD currently supports OpenClaw host only)' }}</span>
        </li>
      </ul>
    </section>

    <section class="guide-step">
      <h2 class="step-title">{{ lang === 'zh-CN' ? '步骤 2 · 运行安装命令' : 'Step 2 · Run install command' }}</h2>
      <div class="command-block">
        <code>npx create-principles-disciple</code>
      </div>
      <p class="step-desc">
        {{ lang === 'zh-CN'
          ? '在终端中运行此命令。Installer 会自动检测 Node 和 OpenClaw，缺失时给出官方下载链接。'
          : 'Run this command in your terminal. Installer auto-detects Node and OpenClaw, provides official download links if missing.'
        }}
      </p>
    </section>

    <section class="guide-step">
      <h2 class="step-title">{{ lang === 'zh-CN' ? '步骤 3 · 安装完成后' : 'Step 3 · After install completes' }}</h2>
      <p class="step-desc">
        {{ lang === 'zh-CN'
          ? 'Installer 会自动启动控制台并打开浏览器到 /welcome 页面。按 onboarding 向导完成首次配置。'
          : 'Installer auto-launches console and opens browser to /welcome page. Follow the onboarding wizard to complete first-time setup.'
        }}
      </p>
    </section>

    <div class="host-disclaimer">
      {{ lang === 'zh-CN'
        ? '当前支持 OpenClaw 宿主。Codex/Claude Code 支持正在开发中。'
        : 'Currently supports OpenClaw host. Codex/Claude Code support is under development.'
      }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { useData } from 'vitepress'
const { lang } = useData()
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

.command-block {
  background: var(--vp-c-bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 1rem 1.25rem;
  margin: 1rem 0;
}

.command-block code {
  font-family: var(--vp-font-family-mono);
  font-size: 0.95rem;
  color: var(--text-main);
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
</style>
