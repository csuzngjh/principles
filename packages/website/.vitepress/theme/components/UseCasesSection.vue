<template>
  <section class="pd-section use-cases-section" aria-labelledby="use-cases-title">
    <div class="section-heading">
      <p class="pd-eyebrow">{{ isZh ? '适用场景' : 'Where it helps' }}</p>
      <h2 id="use-cases-title">{{ isZh ? '不是单个错误，而是反复出现的品格偏差。' : 'Not a single error — a recurring character drift.' }}</h2>
      <p>{{ isZh ? '这些是 PD 真正治理的对象：跨会话稳定出现、值得沉淀为原则的行为模式。' : 'These are what PD actually governs: behavior patterns that recur across sessions and are worth distilling into principles.' }}</p>
    </div>
    <div class="case-grid">
      <article v-for="(item, index) in items" :key="item.title">
        <span class="index">0{{ index + 1 }}</span>
        <h3>{{ item.title }}</h3>
        <p class="drift">{{ item.drift }}</p>
        <p class="principle">{{ item.principle }}</p>
      </article>
    </div>
  </section>
</template>
<script setup>
import { computed } from 'vue'
import { useIsZh } from '../composables/useIsZh'
const isZh = useIsZh()
const items = computed(() => isZh.value ? [
  { title: '确认习惯', drift: '在不可逆操作（发布、删除、对外动作）前直接执行，不先确认。', principle: '不可逆操作前，先说明影响并等待确认。' },
  { title: '重构分寸', drift: '重构时倾向大改而非最小改动，引入额外风险。', principle: '大范围修改前，说明范围、风险与验证计划。' },
  { title: '影响透明', drift: '扩大任务范围或下结论时，不交代依据与来源。', principle: '重要结论说明来源，扩大范围前说明影响。' },
] : [
  { title: 'Confirmation habit', drift: 'Executes irreversible operations (ship, delete, external action) without checking first.', principle: 'Explain impact and wait for confirmation before irreversible operations.' },
  { title: 'Refactor restraint', drift: 'Leans toward broad rewrites over minimal changes, introducing extra risk.', principle: 'State scope, risks, and the verification plan before broad changes.' },
  { title: 'Impact transparency', drift: 'Expands scope or makes claims without citing sources or reasoning.', principle: 'Cite sources for important claims; explain impact before expanding scope.' },
])
</script>
<style scoped>
.section-heading { max-width: 760px; margin-bottom: 36px; }
.section-heading h2 { margin: 14px 0; }
.case-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
article { padding: 26px; border: 1px solid var(--border); border-radius: 16px; background: var(--surface); }
.index { color: var(--accent); font: 12px/1 var(--vp-font-family-mono); }
h3 { margin: 18px 0 14px; font-size: 19px; color: var(--text-main); }
/* drift = the observed character drift; principle = the distilled rule */
.drift { margin: 0 0 16px; font-size: 14.5px; line-height: 1.7; color: var(--text-secondary); }
.principle { margin: 0; padding-top: 14px; border-top: 1px solid var(--border); font-size: 14px; line-height: 1.65; color: var(--text-main); font-weight: 500; }
.principle::before { content: '→ '; color: var(--accent); font-weight: 600; }
@media (max-width: 760px) { .case-grid { grid-template-columns: 1fr; } }
</style>
