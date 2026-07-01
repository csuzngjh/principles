<template>
  <div class="quick-install-card">
    <div class="card-header">
      <span class="card-title">{{ lang === 'zh-CN' ? '安装' : 'Install' }}</span>
    </div>
    <div class="command-row">
      <code class="command-text">npx create-principles-disciple</code>
      <button class="copy-btn" @click="copyCommand">
        {{ copied ? (lang === 'zh-CN' ? '已复制' : 'Copied') : (lang === 'zh-CN' ? '复制' : 'Copy') }}
      </button>
    </div>
    <div class="card-footer">
      <a :href="lang === 'zh-CN' ? '/zh/install' : '/install'" class="guide-link">
        {{ lang === 'zh-CN' ? '需要分步引导？→ 查看完整安装向导' : 'Need step-by-step guide? → View full install guide' }}
      </a>
      <span class="host-note">{{ lang === 'zh-CN' ? '当前支持 OpenClaw 宿主' : 'Currently supports OpenClaw host' }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useData } from 'vitepress'

const { lang } = useData()
const copied = ref(false)

async function copyCommand() {
  try {
    await navigator.clipboard.writeText('npx create-principles-disciple')
    copied.value = true
    setTimeout(() => { copied.value = false }, 2000)
  } catch {
    // fallback for older browsers
  }
}
</script>

<style scoped>
.quick-install-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 1.5rem;
  margin: 2rem auto;
  max-width: 640px;
}

.card-header {
  margin-bottom: 1rem;
}

.card-title {
  font-size: 1.125rem;
  font-weight: 600;
  color: var(--text-main);
}

.command-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  background: var(--vp-c-bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 0.75rem 1rem;
}

.command-text {
  font-family: var(--vp-font-family-mono);
  font-size: 0.95rem;
  color: var(--text-main);
  flex: 1;
  overflow-x: auto;
}

.copy-btn {
  background: var(--accent);
  color: white;
  border: none;
  border-radius: 6px;
  padding: 0.4rem 0.8rem;
  font-size: 0.85rem;
  cursor: pointer;
  white-space: nowrap;
  transition: opacity 0.2s;
}

.copy-btn:hover {
  opacity: 0.85;
}

.card-footer {
  margin-top: 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.guide-link {
  color: var(--accent);
  font-size: 0.9rem;
  text-decoration: none;
}

.guide-link:hover {
  text-decoration: underline;
}

.host-note {
  font-size: 0.8rem;
  color: var(--text-muted);
}
</style>
