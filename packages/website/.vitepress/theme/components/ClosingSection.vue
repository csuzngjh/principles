<template>
  <!-- SPEC-PD-UIUX-001 R8: the closing invitation centers on reduced repeated
       corrections, owner control, observability and reversibility. The old
       suffering declaration is no longer the main closing statement; the
       brand thinking stays reachable via the Abyss link below. -->
  <section class="pd-section closing-section" aria-label="closing">
    <h2 class="closing-title">{{ isZh ? '少一点重复纠正，多一点确定感。' : 'Fewer repeated corrections. More certainty.' }}</h2>
    <p class="closing-sub">
      {{ isZh
        ? 'PD 把每一次纠正变成可审查、可观察、可撤回的原则——最终决定始终在你手里。'
        : 'PD turns each correction into a reviewable, observable, reversible principle — the final decision stays yours.'
      }}
    </p>
    <div class="closing-actions">
      <a class="pd-btn pd-btn-brand" :href="isZh ? '/zh/install' : '/install'" data-umami-event="cta_get_started">{{ isZh ? '开始使用' : 'Get started' }}</a>
      <a class="pd-btn pd-btn-alt" href="https://github.com/csuzngjh/principles" target="_blank" rel="noopener" data-umami-event="outbound_click" data-umami-event-target="github">{{ isZh ? 'GitHub' : 'GitHub' }}</a>
    </div>
    <p class="closing-thought">
      <a :href="isZh ? '/zh/abyss/' : '/abyss/'" data-umami-event="cta_abyss_index">
        {{ isZh ? '理念与研究：燃烧痛苦，协同进化 →' : 'Ideas & research: Burn Pain, Co-Evolve →' }}
      </a>
    </p>
  </section>
</template>

<script setup>
import { useIsZh } from '../composables/useIsZh'
const isZh = useIsZh()
</script>

<style scoped>
/* A designed closing: invitation + CTA, with a calm band that gives the page
   a deliberate end-point instead of trailing off. */
.closing-section {
  text-align: center;
  padding: 120px 0;
}
.closing-title {
  margin: 0 auto;
  max-width: 820px;
  font-size: clamp(22px, 2.8vw, 32px) !important;
  font-weight: 500;
  letter-spacing: -0.01em;
  line-height: 1.4 !important;
  color: var(--text-main) !important;
  border: 0;
  padding: 0;
}
.closing-sub {
  max-width: 640px;
  margin: 18px auto 0;
  font-size: 15px;
  line-height: 1.8;
  color: var(--text-secondary);
}
.closing-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  justify-content: center;
  margin-top: 44px;
}
.closing-thought {
  margin: 40px 0 0;
  font-family: var(--vp-font-family-mono);
  font-size: 12px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}
.closing-thought a {
  color: var(--text-muted);
  text-decoration: none;
}
.closing-thought a:hover,
.closing-thought a:focus-visible {
  color: var(--accent);
  text-decoration: underline;
}
@media (max-width: 640px) { .closing-section { padding: 88px 0; } .closing-actions { flex-direction: column; align-items: stretch; } .closing-actions .pd-btn { width: 100%; } }
</style>
