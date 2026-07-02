<template>
  <section id="example" class="pd-section example-section" aria-labelledby="example-title">
    <div class="section-heading">
      <p class="pd-eyebrow">{{ isZh ? '真实变化示例' : 'A concrete behavior change' }}</p>
      <h2 id="example-title">{{ isZh ? '不是记住一句话，而是改变下一次行动。' : 'Not a saved note. A changed next action.' }}</h2>
      <p>{{ isZh ? '从重复纠正，到 Owner 批准，再到后续行为的可观察改变。' : 'From repeated correction through Owner approval to an observable change in later behavior.' }}</p>
    </div>

    <ol class="timeline" :aria-label="isZh ? '一个真实的行为变化流程' : 'A real behavior change flow'">
      <li v-for="(item, index) in caseItems" :key="item.label" :class="{ 'is-pivot': item.pivot }">
        <span class="node" :aria-hidden="true">
          <template v-if="item.pivot">{{ isZh ? '决' : 'OK' }}</template>
          <template v-else>{{ String(index + 1).padStart(2, '0') }}</template>
        </span>
        <span class="step-label">{{ item.label }}</span>
        <p class="step-text">{{ item.value }}</p>
      </li>
    </ol>
  </section>
</template>

<script setup>
import { computed } from 'vue'
import { useIsZh } from '../composables/useIsZh'
const isZh = useIsZh()
const caseItems = computed(() => isZh.value ? [
  { label: '此前', value: 'Agent 多次在扩大任务范围前没有说明影响。' },
  { label: '发现', value: '系统识别到同类纠正已出现 3 次。' },
  { label: '建议', value: '扩大范围前，先说明影响、风险和验证方式。' },
  { label: '决定', value: 'Owner 修改并批准。', pivot: true },
  { label: '后来', value: '下一次相似任务中，Agent 主动请求确认。' },
  { label: '控制', value: '产生副作用时可以回滚。' },
] : [
  { label: 'Before', value: 'Repeatedly expanded scope without explaining the impact.' },
  { label: 'Detected', value: 'The system found three related corrections.' },
  { label: 'Proposed', value: 'Explain impact, risks, and verification before expanding scope.' },
  { label: 'Decided', value: 'The Owner edited and approved it.', pivot: true },
  { label: 'Later', value: 'On the next similar task, the Agent asked first.' },
  { label: 'Control', value: 'Roll back if it causes side effects.' },
])
</script>

<style scoped>
.example-section { scroll-margin-top: 84px; }
.section-heading { max-width: 760px; margin-bottom: 40px; }
.section-heading h2 { margin: 14px 0; }

/* Horizontal timeline: nodes connected by a line, left→right flow. */
.timeline {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 8px;
  position: relative;
}
/* the connecting spine: runs horizontally through the node row */
.timeline::before {
  content: '';
  position: absolute;
  top: 18px; /* aligns with node center (node is 36px) */
  left: calc(100%/12);   /* start at first node center */
  right: calc(100%/12);  /* end at last node center */
  height: 1px;
  background: var(--border);
  z-index: 0;
}
.timeline li {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 0 4px;
}
.node {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--vp-c-bg);
  border: 1px solid var(--border);
  color: var(--text-muted);
  font: 600 12px/1 var(--vp-font-family-mono);
}
li.is-pivot .node {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
  font-size: 13px;
}
:root.dark li.is-pivot .node { color: #0B0D11; }

.step-label {
  margin-top: 14px;
  color: var(--accent);
  font-size: 12px;
  font-weight: 650;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
li.is-pivot .step-label { font-weight: 700; }
.step-text {
  margin: 8px 0 0;
  color: var(--text-secondary);
  font-size: 13.5px;
  line-height: 1.6;
}
li.is-pivot .step-text { color: var(--text-main); font-weight: 500; }

/* wrap to 2 rows of 3 on tablet */
@media (max-width: 960px) {
  .timeline { grid-template-columns: repeat(3, 1fr); row-gap: 28px; }
  .timeline::before { display: none; }
}
/* single column on phone */
@media (max-width: 560px) {
  .timeline { grid-template-columns: 1fr; row-gap: 18px; }
  .timeline li { flex-direction: row; text-align: left; gap: 14px; }
  .step-label { margin-top: 0; }
  .step-text { margin-top: 2px; }
}
</style>
