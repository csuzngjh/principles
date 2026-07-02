<template>
  <section class="pd-section closing-section" aria-label="closing">
    <blockquote class="closing-quote">
      <p class="closing-text">{{ isZh ? '“如果你没有在受苦，你就没有在创造价值。”' : '“If you’re not suffering, you’re not building value.”' }}</p>
      <cite class="closing-sub">{{ isZh ? '燃烧痛苦，协同进化' : 'Burn Pain, Co-Evolve' }}</cite>
    </blockquote>
    <div class="closing-actions">
      <a class="pd-btn pd-btn-brand" :href="isZh ? '/zh/install' : '/install'">{{ isZh ? '开始使用' : 'Get started' }}</a>
      <a class="pd-btn pd-btn-alt" href="https://github.com/csuzngjh/principles" target="_blank" rel="noopener">{{ isZh ? 'GitHub' : 'GitHub' }}</a>
    </div>
  </section>
</template>

<script setup>
import { computed } from 'vue'
import { useData } from 'vitepress'
const { lang } = useData()
const isZh = computed(() => lang.value === 'zh-CN')
</script>

<style scoped>
/* A designed closing: motto + CTA, with a calm gradient band that gives
   the page a deliberate end-point instead of trailing off. */
.closing-section {
  text-align: center;
  padding: 120px 0;
}
.closing-quote { max-width: 820px; margin: 0 auto; }
.closing-text {
  margin: 0;
  font-family: var(--vp-font-family-mono);
  font-size: clamp(22px, 2.8vw, 32px) !important;
  line-height: 1.5 !important;
  letter-spacing: 0.02em;
  font-style: italic;
  color: var(--text-main) !important;
}
.closing-sub {
  display: block;
  margin-top: 24px;
  font-family: var(--vp-font-family-mono);
  font-size: 13px;
  font-style: normal;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--accent);
}
.closing-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  justify-content: center;
  margin-top: 44px;
}
@media (max-width: 640px) { .closing-section { padding: 88px 0; } .closing-actions { flex-direction: column; align-items: stretch; } .closing-actions .pd-btn { width: 100%; } }
</style>
