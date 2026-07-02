<template>
  <section class="pd-section loop-section" aria-labelledby="loop-title">
    <div class="section-heading">
      <p class="pd-eyebrow">{{ isZh ? '治理回路' : 'Governance loop' }}</p>
      <h2 id="loop-title">{{ isZh ? '系统提供证据和建议，Owner 保留判断。' : 'The system brings evidence and proposals. The Owner keeps judgment.' }}</h2>
    </div>
    <ol class="loop" :aria-label="isZh ? 'PD 行为治理回路' : 'PD behavior governance loop'">
      <li v-for="(step, index) in steps" :key="step"><span>0{{ index + 1 }}</span>{{ step }}</li>
    </ol>
    <ul class="trust-grid">
      <li v-for="item in trustItems" :key="item">{{ item }}</li>
    </ul>
  </section>
</template>
<script setup>
import { computed } from 'vue'
import { useIsZh } from '../composables/useIsZh'
const isZh = useIsZh()
const steps = computed(() => isZh.value
  ? ['行为证据', '原则提案', 'Owner 审查', '可逆激活', '后续行为观察']
  : ['Behavior evidence', 'Principle proposal', 'Owner review', 'Reversible activation', 'Later behavior observation'])
const trustItems = computed(() => isZh.value ? [
  '不是每个错误都生成原则。', 'PD 不替 Owner 做价值判断。', '原则不会未经审核自动生效。', '证据不足时可以暂存或归档。'
] : [
  'Not every mistake becomes a principle.', 'PD does not make value judgments for the Owner.', 'No principle activates without review.', 'Weak evidence can be deferred or archived.'
])
</script>
<style scoped>
.section-heading { max-width: 780px; margin-bottom: 36px; }
.section-heading h2 { margin-top: 14px; }
.loop { display: grid; grid-template-columns: repeat(5, 1fr); gap: 20px; list-style: none; padding: 0; margin: 0; }
.loop li { position: relative; display: flex; flex-direction: column; gap: 14px; min-height: 132px; margin: 0; padding: 24px 20px; border: 1px solid var(--border); border-radius: 14px; background: var(--surface); color: var(--text-main); font-weight: 550; font-size: 15px; }
.loop li:not(:last-child)::after { content: '→'; position: absolute; right: -16px; top: 50%; transform: translateY(-50%); z-index: 1; color: var(--accent); font-size: 15px; }
.loop span { color: var(--accent); font: 12px/1 var(--vp-font-family-mono); }
.trust-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; list-style: none; padding: 0; margin: 32px 0 0; align-items: stretch; }
.trust-grid li { display: flex; align-items: center; min-height: 72px; margin: 0; padding: 18px 20px 18px 44px; border-left: 2px solid var(--accent); background: var(--accent-dim); color: var(--text-secondary); font-size: 14px; line-height: 1.65; }
@media (max-width: 960px) { .loop { grid-template-columns: repeat(2, 1fr); gap: 16px; } .loop li { min-height: 0; } .loop li:not(:last-child)::after { content: none; } }
@media (max-width: 600px) { .loop { grid-template-columns: 1fr; } .trust-grid { grid-template-columns: 1fr; } }
</style>
