<template>
  <section class="pd-section use-cases-section" aria-labelledby="use-cases-title">
    <div class="section-heading">
      <p class="pd-eyebrow">{{ isZh ? '种子用户场景' : 'Where it helps first' }}</p>
      <h2 id="use-cases-title">{{ isZh ? '把高频纠正，变成稳定的工作方式。' : 'Turn recurring corrections into a consistent way of working.' }}</h2>
      <p>{{ isZh ? 'PD 影响 Agent 如何行动，不声称替你拦截所有工具。' : 'PD shapes how the Agent acts; it does not claim to intercept every tool on your behalf.' }}</p>
    </div>
    <div class="case-grid">
      <article v-for="(item, index) in items" :key="item.title">
        <span>0{{ index + 1 }}</span><h3>{{ item.title }}</h3><p>{{ item.body }}</p>
      </article>
    </div>
  </section>
</template>
<script setup>
import { computed } from 'vue'
import { useData } from 'vitepress'
const { lang } = useData()
const isZh = computed(() => lang.value === 'zh-CN')
const items = computed(() => isZh.value ? [
  { title: '经营与运营', body: '扩大任务或执行对外动作前，先说明影响并等待确认。' },
  { title: '产品与开发', body: '大范围修改前，说明范围、风险和验证计划。' },
  { title: '内容与发布', body: '重要结论说明来源，发布前保留 Owner 确认点。' },
] : [
  { title: 'Business & operations', body: 'Explain impact and wait for confirmation before expanding work or taking external action.' },
  { title: 'Product & development', body: 'State scope, risks, and the verification plan before broad changes.' },
  { title: 'Content & publishing', body: 'Cite sources for important claims and preserve an Owner checkpoint before publishing.' },
])
</script>
<style scoped>
.section-heading { max-width: 760px; margin-bottom: 36px; }.section-heading h2 { margin: 14px 0; }
.case-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
article { padding: 26px; border: 1px solid var(--border); border-radius: 16px; background: var(--surface); }
article > span { color: var(--accent); font: 12px/1 var(--vp-font-family-mono); }
h3 { margin: 22px 0 12px; font-size: 19px; color: var(--text-main); }
article p { margin: 0; font-size: 15px; }
@media (max-width: 760px) { .case-grid { grid-template-columns: 1fr; } }
</style>
