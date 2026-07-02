<template>
  <section class="pd-section boundary-section" aria-labelledby="boundary-title">
    <div class="section-heading">
      <p class="pd-eyebrow">{{ isZh ? '治理边界' : 'What PD governs' }}</p>
      <h2 id="boundary-title">{{ isZh ? 'PD 治理的是人与 AI 之间的行为偏差。' : 'PD governs the behavior gap between you and your Agent.' }}</h2>
      <p>{{ isZh ? '不是工具报错，也不是单次任务失败——而是那些跨会话反复出现、值得沉淀为原则的行为模式。' : 'Not tool errors, not one-off task failures — but the behavior patterns that recur across sessions and are worth distilling into principles.' }}</p>
    </div>

    <div class="boundary-table">
      <div class="row pd-cares">
        <span class="badge" aria-hidden="true">{{ isZh ? 'PD 治理' : 'PD governs' }}</span>
        <div class="content">
          <strong>{{ isZh ? '行为模式级 · 跨会话的人机行为偏差' : 'Behavior-pattern · cross-session human–Agent gaps' }}</strong>
          <ul>
            <li v-for="item in caresItems" :key="item">{{ item }}</li>
          </ul>
        </div>
      </div>
      <div class="row pd-skips">
        <span class="badge dim" aria-hidden="true">{{ isZh ? '不由 PD' : 'Not PD' }}</span>
        <div class="content">
          <strong>{{ isZh ? '工具级 / 任务级 · 由宿主与会话记忆处理' : 'Tool / task level · handled by host & session memory' }}</strong>
          <ul>
            <li v-for="item in skipsItems" :key="item">{{ item }}</li>
          </ul>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup>
import { computed } from 'vue'
import { useData } from 'vitepress'
const { lang } = useData()
const isZh = computed(() => lang.value === 'zh-CN')
const caresItems = computed(() => isZh.value ? [
  '在不可逆操作前缺乏确认习惯。',
  '重构时偏激进而非保守。',
  '扩大范围前不说明影响。',
] : [
  'Lacks a confirmation habit before irreversible operations.',
  'Leans aggressive rather than conservative in refactors.',
  'Expands scope without explaining the impact.',
])
// Neutral wording: the host/runtime is any agent tool (OpenClaw, Claude Code, Codex, …),
// not specifically OpenClaw. Keep host-agnostic per PRODUCT_IDENTITY boundary.
const skipsItems = computed(() => isZh.value ? [
  'git push 失败、命令缺参数 —— 由宿主 / runtime 处理。',
  '输出格式或 JSON 损坏 —— 由宿主重试与修复。',
  '单次任务的同类失败 —— 由会话记忆处理。',
] : [
  'A failed git push, a missing flag — handled by the host / runtime.',
  'Malformed output or JSON — handled by the host\'s retry & repair.',
  'A repeated same-task failure — handled by session memory.',
])
</script>

<style scoped>
.section-heading { max-width: 820px; margin-bottom: 40px; }
.section-heading h2 { margin: 14px 0; }

/* Honest-boundary table: two rows, one accent-filled, one quietly dimmed.
   The contrast itself communicates the boundary. */
.boundary-table { display: grid; gap: 14px; }
.row { display: grid; grid-template-columns: 120px 1fr; gap: 24px; align-items: start; padding: 24px 26px; border: 1px solid var(--border); border-radius: 16px; background: var(--surface); }
.row.pd-cares { border-color: var(--accent-border); background: var(--accent-dim); }
.badge { display: inline-flex; align-items: center; justify-content: center; height: 28px; padding: 0 12px; border-radius: 99px; background: var(--accent); color: #fff; font: 600 11px/1 var(--vp-font-family-mono); letter-spacing: 0.04em; }
:root.dark .badge { color: #0B0D11; }
/* FIX: dark-mode readability — give .dim a visible border + surface fill instead of bare transparency */
.badge.dim { background: var(--surface); color: var(--text-secondary); border: 1px solid var(--border); }
/* the global `:root.dark .badge { color:#0B0D11 }` above is more specific and would
   force the dim badge's text dark on a dark fill — explicitly restore a readable
   light tone and a stronger border so the badge stays visible in dark mode. */
:root.dark .badge.dim { color: var(--text-main); border-color: var(--vp-c-divider); background: rgba(255, 255, 255, 0.04); }
.content strong { display: block; color: var(--text-main); font-size: 15px; font-weight: 600; margin-bottom: 12px; }
.row.pd-skips .content strong { color: var(--text-secondary); }
.content ul { margin: 0; padding: 0; list-style: none; display: grid; gap: 8px; }
.content li { position: relative; padding-left: 20px; color: var(--text-secondary); font-size: 14.5px; line-height: 1.65; }
.row.pd-skips .content li { color: var(--text-muted); }
.content li::before { content: ''; position: absolute; left: 2px; top: 11px; width: 6px; height: 6px; border-radius: 50%; background: var(--accent); }
.row.pd-skips .content li::before { background: var(--text-muted); opacity: 0.5; }

@media (max-width: 640px) {
  .row { grid-template-columns: 1fr; gap: 14px; padding: 20px; }
  .badge { align-self: flex-start; }
}
</style>
