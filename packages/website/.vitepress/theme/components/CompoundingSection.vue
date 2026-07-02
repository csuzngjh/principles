<template>
  <section class="pd-section compounding-section" aria-labelledby="compounding-title">
    <div class="compound-grid">
      <div class="compound-copy">
        <p class="pd-eyebrow">{{ isZh ? '原则的复利' : 'The compound effect' }}</p>
        <h2 id="compounding-title">{{ isZh ? '单次纠正改变一次行为；积累的原则沉淀为品格。' : 'One correction changes one action. Accumulated principles settle into character.' }}</h2>
        <p class="lead">{{ isZh ? '每条你批准的原则都在为下一次相似情境打底。纠正不会蒸发——它沉淀、累积，最终让 Agent 在你没有逐条叮嘱时，也按你的方式行动。' : 'Every principle you approve lays groundwork for the next similar situation. Corrections do not evaporate — they accumulate, until the Agent acts your way without you spelling it out each time.' }}</p>
      </div>

      <ul class="compound-list">
        <li v-for="item in points" :key="item.head">
          <span class="evidence-dot" aria-hidden="true"></span>
          <div>
            <strong>{{ item.head }}</strong>
            <p>{{ item.body }}</p>
          </div>
        </li>
      </ul>
    </div>
  </section>
</template>

<script setup>
import { computed } from 'vue'
import { useData } from 'vitepress'
const { lang } = useData()
const isZh = computed(() => lang.value === 'zh-CN')
// Two pillars here: compounding (沉淀感) + clarity (清醒感)
const points = computed(() => isZh.value ? [
  { head: '沉淀而非遗忘', body: '纠正被沉淀为可追溯的原则，而不是在下一轮对话里重新来过。' },
  { head: '复利而非单次', body: '每条原则都在为后续相似情境打底；品格是积累出来的，不是一次配好的。' },
  { head: '减负而非加压', body: '你不需要盯着每次对话——PD 只在出现值得审查的模式时找你，其余已被安静处理。' },
] : [
  { head: 'Sediment, not amnesia', body: 'Corrections settle into traceable principles, instead of being re-typed in the next session.' },
  { head: 'Compound, not one-shot', body: 'Each principle lays groundwork for the next similar context; character accrues, it is not configured once.' },
  { head: 'Less attention, not more', body: 'You do not watch every conversation — PD surfaces only patterns worth your review; the rest is handled quietly.' },
])
</script>

<style scoped>
.compound-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 56px; align-items: start; }
.compound-copy h2 { margin: 14px 0 18px; }
.compound-copy .lead { font-size: 16.5px; line-height: 1.75; color: var(--text-secondary); }

.compound-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 24px; }
/* PD visual motif: a fine vertical evidence-line connecting dots —
   the "trajectory / governance cabin" feel from the brand constitution. */
.compound-list li { position: relative; display: grid; grid-template-columns: 18px 1fr; gap: 18px; padding-left: 4px; }
.compound-list li::before { content: ''; position: absolute; left: 8px; top: 18px; bottom: -24px; width: 1px; background: var(--border); }
.compound-list li:last-child::before { display: none; }
.evidence-dot { width: 9px; height: 9px; margin-top: 7px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 4px var(--accent-dim); }
.compound-list strong { display: block; color: var(--text-main); font-size: 15.5px; font-weight: 600; margin-bottom: 6px; }
.compound-list p { margin: 0; color: var(--text-secondary); font-size: 14.5px; line-height: 1.7; }

@media (max-width: 880px) {
  .compound-grid { grid-template-columns: 1fr; gap: 36px; }
}
</style>
