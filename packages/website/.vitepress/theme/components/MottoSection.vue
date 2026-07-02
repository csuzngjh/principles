<template>
  <section class="pd-section motto-section" aria-label="PD motto">
    <blockquote class="motto">
      <p class="motto-quote">{{ isZh ? '“如果你没有在受苦，你就没有在创造价值。”' : '“If you’re not suffering, you’re not building value.”' }}</p>
      <cite class="motto-sub">{{ isZh ? '燃烧痛苦，协同进化' : 'Burn Pain, Co-Evolve' }}</cite>
    </blockquote>
  </section>
</template>

<script setup>
import { computed } from 'vue'
import { useData } from 'vitepress'
const { lang } = useData()
const isZh = computed(() => lang.value === 'zh-CN')
</script>

<style scoped>
/* A non-card breathing space between dense sections — no fill, no border,
   generous vertical whitespace. Restores the rhythm the redesign lost. */
.motto-section { padding: 120px 0; }
.motto { max-width: 820px; margin: 0 auto; text-align: center; }
.motto-quote {
  margin: 0;
  font-family: var(--vp-font-family-mono);
  font-size: clamp(20px, 2.6vw, 30px) !important;
  line-height: 1.55 !important;
  letter-spacing: 0.02em;
  font-style: italic;
  color: var(--text-main) !important;
}
.motto-sub {
  display: block;
  margin-top: 28px;
  font-family: var(--vp-font-family-mono);
  font-size: 13px;
  font-style: normal;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--accent);
}
@media (max-width: 640px) { .motto-section { padding: 80px 0; } .motto-sub { margin-top: 20px; } }
</style>
