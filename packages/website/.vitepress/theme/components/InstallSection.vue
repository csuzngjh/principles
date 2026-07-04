<template>
  <section class="pd-section install-section" aria-labelledby="install-title">
    <div class="install-copy">
      <p class="pd-eyebrow">{{ isZh ? '安装' : 'Install' }}</p>
      <h2 id="install-title">{{ isZh ? '从下一次纠正开始沉淀。' : 'Start with the next correction.' }}</h2>
      <p>{{ isZh ? '安装后，你仍然掌握每条原则的审核权。当前需要 Node.js ≥ 18 和一个可用的 OpenClaw 环境。' : 'After installation, you still control review and activation. You currently need Node.js ≥ 18 and a working OpenClaw environment.' }}</p>
      <div class="compatibility"><span>{{ isZh ? '当前可用' : 'Available now' }}</span><strong>OpenClaw</strong></div>
    </div>
    <div class="command-card">
      <div class="command-label">{{ isZh ? '在终端运行' : 'Run in your terminal' }}</div>
      <div class="command-row"><code>{{ command }}</code><button type="button" :aria-label="copyLabel" data-umami-event="copy_install_command" @click="copyCommand">{{ copyState }}</button></div>
      <a :href="isZh ? '/zh/docs/getting-started' : '/docs/getting-started'" data-umami-event="cta_read_install_guide">{{ isZh ? '查看完整安装向导' : 'Read the complete installation guide' }} <span aria-hidden="true">→</span></a>
    </div>
  </section>
</template>
<script setup>
import { computed, ref } from 'vue'
import { useIsZh } from '../composables/useIsZh'
const isZh = useIsZh()
const command = 'npx create-principles-disciple --yes'
const copyStatus = ref('idle')
const copyState = computed(() => copyStatus.value === 'success' ? (isZh.value ? '已复制' : 'Copied') : copyStatus.value === 'error' ? (isZh.value ? '复制失败' : 'Copy failed') : (isZh.value ? '复制' : 'Copy'))
const copyLabel = computed(() => isZh.value ? '复制安装命令' : 'Copy install command')
async function copyCommand() {
  try { await navigator.clipboard.writeText(command); copyStatus.value = 'success' }
  catch { copyStatus.value = 'error' }
  window.setTimeout(() => { copyStatus.value = 'idle' }, 2000)
}
</script>
<style scoped>
.install-section { display: grid; grid-template-columns: minmax(0, .9fr) minmax(480px, 1.1fr); gap: 64px; align-items: center; }
.install-copy h2 { margin: 14px 0; }.compatibility { display: inline-flex; align-items: center; gap: 10px; margin-top: 24px; padding: 9px 12px; border: 1px solid var(--accent-border); border-radius: 99px; background: var(--accent-dim); font-size: 13px; color: var(--text-secondary); }.compatibility strong { color: var(--accent); }
.command-card { padding: 26px; border: 1px solid var(--border); border-radius: 18px; background: var(--surface); }.command-label { margin-bottom: 12px; color: var(--text-secondary); font-size: 13px; }.command-row { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 10px; padding: 10px 10px 10px 16px; border-radius: 10px; background: #111827; }.command-row code { overflow-x: auto; color: #f8fafc; white-space: nowrap; }.command-row button { min-width: 68px; min-height: 44px; border: 0; border-radius: 8px; background: #7eb8da; color: #111827; font-weight: 650; cursor: pointer; }.command-card > a { display: inline-flex; gap: 8px; margin-top: 18px; color: var(--accent); font-size: 14px; text-decoration: none; }
@media (max-width: 900px) { .install-section { grid-template-columns: 1fr; gap: 32px; } }
@media (max-width: 520px) { .command-card { padding: 16px; } .command-row { grid-template-columns: 1fr; padding: 12px; }.command-row button { width: 100%; } }
</style>
