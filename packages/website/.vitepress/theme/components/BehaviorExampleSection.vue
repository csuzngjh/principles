<template>
  <section id="example" class="pd-section example-section" aria-labelledby="example-title">
    <div class="section-heading">
      <p class="pd-eyebrow">{{ isZh ? '真实变化示例' : 'A concrete behavior change' }}</p>
      <h2 id="example-title">{{ isZh ? '不是记住一句话，而是改变下一次行动。' : 'Not a saved note. A changed next action.' }}</h2>
      <p>{{ isZh ? '从重复纠正，到 Owner 批准，再到后续行为的可观察改变。' : 'From repeated correction through Owner approval to an observable change in later behavior.' }}</p>
    </div>
    <dl class="case-steps">
      <div v-for="item in caseItems" :key="item.label">
        <dt>{{ item.label }}</dt>
        <dd>{{ item.value }}</dd>
      </div>
    </dl>
  </section>
</template>

<script setup>
import { computed } from 'vue'
import { useData } from 'vitepress'
const { lang } = useData()
const isZh = computed(() => lang.value === 'zh-CN')
const caseItems = computed(() => isZh.value ? [
  { label: '此前', value: 'Agent 多次在扩大任务范围前没有说明影响。' },
  { label: '发现', value: '系统识别到同类纠正已出现 3 次。' },
  { label: '建议', value: '扩大范围前，先说明影响、风险和验证方式。' },
  { label: '决定', value: 'Owner 修改并批准。' },
  { label: '后来', value: '下一次相似任务中，Agent 主动请求确认。' },
  { label: '控制', value: '产生副作用时可以回滚。' },
] : [
  { label: 'Before', value: 'The Agent repeatedly expanded scope without explaining the impact.' },
  { label: 'Detected', value: 'The system found three related corrections.' },
  { label: 'Proposed', value: 'Explain impact, risks, and verification before expanding scope.' },
  { label: 'Decided', value: 'The Owner edited and approved it.' },
  { label: 'Later', value: 'On the next similar task, the Agent asked for confirmation first.' },
  { label: 'Control', value: 'The principle can be rolled back if it causes side effects.' },
])
</script>

<style scoped>
.example-section { scroll-margin-top: 84px; }
.section-heading { max-width: 760px; margin-bottom: 38px; }
.section-heading h2 { margin: 14px 0; }
.case-steps { display: grid; grid-template-columns: repeat(2, 1fr); gap: 1px; margin: 0; border: 1px solid var(--border); border-radius: 18px; background: var(--border); overflow: hidden; }
.case-steps div { display: grid; grid-template-columns: 80px 1fr; gap: 16px; padding: 22px 24px; background: var(--surface); }
dt { color: var(--accent); font-size: 13px; font-weight: 650; }
dd { margin: 0; color: var(--text-secondary); font-size: 15px; line-height: 1.7; }
@media (max-width: 720px) { .case-steps { grid-template-columns: 1fr; } .case-steps div { grid-template-columns: 64px 1fr; padding: 18px 20px; } }
</style>
