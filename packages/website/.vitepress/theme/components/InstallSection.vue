<template>
  <section class="pd-section install-section" aria-labelledby="install-title">
    <div class="install-copy">
      <p class="pd-eyebrow">{{ isZh ? '安装' : 'Install' }}</p>
      <h2 id="install-title">{{ isZh ? '从下一次纠正开始沉淀。' : 'Start with the next correction.' }}</h2>
      <p>{{ isZh ? '安装后，你仍然掌握每条原则的审核权。按你的宿主环境选择安装路径：OpenClaw 一条 npx 命令（Node.js ≥ 22），Codex 两行插件市场命令。' : 'After installation, you still control review and activation. Pick the path for your host: one npx command for OpenClaw (Node.js ≥ 22), or two plugin-marketplace commands for Codex.' }}</p>
      <div class="compatibility"><span>{{ isZh ? '当前可用' : 'Available now' }}</span><strong>OpenClaw · Codex</strong></div>
    </div>
    <div class="command-card">
      <div class="command-label">{{ isZh ? 'OpenClaw 宿主 · 在终端运行' : 'OpenClaw host · Run in your terminal' }}</div>
      <div class="command-row"><code>{{ command }}</code><button type="button" :aria-label="copyLabel" data-umami-event="copy_install_command" @click="copyCommand">{{ copyState }}</button></div>
      <div class="alt-paths">
        <a :href="codexInstallHref" data-umami-event="cta_read_install_guide">{{ isZh ? 'Codex 宿主？查看 Codex 安装路径 →' : 'On Codex? See the Codex install path →' }}</a>
        <a :href="installHref" data-umami-event="cta_read_install_guide">{{ isZh ? '查看完整安装向导' : 'Read the complete installation guide' }} <span aria-hidden="true">→</span></a>
      </div>
    </div>
  </section>
</template>
<script setup>
import { computed, ref } from 'vue'
import { useIsZh } from '../composables/useIsZh'
const isZh = useIsZh()
// SPEC-PD-UIUX-001 R7: the homepage command is explicitly scoped to the
// OpenClaw host (installer manifest: Node ≥ 22); Codex visitors are routed to
// the host selection on the install page instead of a wrong default command.
const command = 'npx create-principles-disciple --yes'
const installHref = computed(() => isZh.value ? '/zh/install' : '/install')
const codexInstallHref = computed(() => isZh.value ? '/zh/install?host=codex' : '/install?host=codex')
const copyStatus = ref('idle')
const copyState = computed(() => copyStatus.value === 'success' ? (isZh.value ? '已复制' : 'Copied') : copyStatus.value === 'error' ? (isZh.value ? '复制失败' : 'Copy failed') : (isZh.value ? '复制' : 'Copy'))
const copyLabel = computed(() => isZh.value ? '复制 OpenClaw 安装命令' : 'Copy the OpenClaw install command')
async function copyCommand() {
  try { await navigator.clipboard.writeText(command); copyStatus.value = 'success' }
  catch { copyStatus.value = 'error' }
  window.setTimeout(() => { copyStatus.value = 'idle' }, 2000)
}
</script>
<style scoped>
.install-section { display: grid; grid-template-columns: minmax(0, .9fr) minmax(480px, 1.1fr); gap: 64px; align-items: center; }
.install-copy h2 { margin: 14px 0; }.compatibility { display: inline-flex; align-items: center; gap: 10px; margin-top: 24px; padding: 9px 12px; border: 1px solid var(--accent-border); border-radius: 99px; background: var(--accent-dim); font-size: 13px; color: var(--text-secondary); }.compatibility strong { color: var(--accent); }
.command-card { padding: 26px; border: 1px solid var(--border); border-radius: 18px; background: var(--surface); }.command-label { margin-bottom: 12px; color: var(--text-secondary); font-size: 13px; }.command-row { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 10px; padding: 10px 10px 10px 16px; border-radius: 10px; background: #111827; }.command-row code { overflow-x: auto; color: #f8fafc; white-space: nowrap; }.command-row button { min-width: 68px; min-height: 44px; border: 0; border-radius: 8px; background: #7eb8da; color: #111827; font-weight: 650; cursor: pointer; }
.alt-paths { display: flex; flex-direction: column; gap: 8px; margin-top: 18px; }
.alt-paths a { color: var(--accent); font-size: 14px; text-decoration: none; }
.alt-paths a:hover { text-decoration: underline; }
@media (max-width: 900px) { .install-section { grid-template-columns: 1fr; gap: 32px; } }
@media (max-width: 520px) { .command-card { padding: 16px; } .command-row { grid-template-columns: 1fr; padding: 12px; }.command-row button { width: 100%; } }
</style>
