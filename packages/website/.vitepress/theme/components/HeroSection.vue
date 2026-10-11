<template>
  <section class="pd-section hero-section" aria-labelledby="home-title">
    <div class="hero-copy">
      <p class="pd-eyebrow">{{ isZh ? '可审查 · 可撤回 · 可观察' : 'Reviewable · Reversible · Observable' }}</p>
      <h1 id="home-title" :aria-label="isZh ? '别再反复纠正同一个 Agent。' : 'Stop correcting the same Agent behavior.'">
        <template v-if="isZh"><span>别再反复纠正</span><span>同一个 Agent。</span></template>
        <template v-else><span>Stop correcting the</span><span>same Agent behavior.</span></template>
      </h1>
      <p class="hero-category">{{ isZh ? 'AI Agent 行为治理运行时' : 'AI Agent Governance Runtime' }}</p>
      <!-- SPEC-PD-UIUX-001 R7: the lead states the core loop in plain language
           (correction → reviewable principle → your approval → later
           evidence); the governance-channel vocabulary moved to a secondary
           line so first-time visitors are not asked to parse jargon first. -->
      <p class="hero-lead">
        {{ isZh
          ? '把你反复纠正的行为沉淀为 Agent 的行为原则：PD 观察重复纠正 → 生成可审查的原则草案 → 你批准 → 后续任务留下可观察的证据，随时可撤回。'
          : 'Turn your repeated corrections into Agent behavior principles: PD observes the recurring corrections → drafts a reviewable principle → you approve → later tasks leave observable evidence — reversible at any time.'
        }}
      </p>
      <p class="hero-terms">
        {{ isZh
          ? '如何生效（提示词引导、运行时治理等治理通道）在下方各节逐步说明。'
          : 'How it takes effect (prompt guidance, runtime governance) is explained in the sections below.'
        }}
      </p>
      <p class="hero-proof">
        {{ isZh ? '每条原则先由你批准，效果可观察，随时可回滚。' : 'You approve every principle first. Its effect stays observable and can be rolled back.' }}
      </p>
      <div class="hero-actions">
        <a class="pd-btn pd-btn-brand" href="#example" data-umami-event="cta_see_example">{{ isZh ? '看一个行为变化示意' : 'See an illustrated behavior change' }}</a>
        <a class="pd-btn pd-btn-alt" :href="isZh ? '/zh/install' : '/install'" data-umami-event="cta_get_started">{{ isZh ? '开始使用' : 'Get started' }}</a>
      </div>
    </div>

    <div class="hero-visual-wrapper">
      <video
        class="hero-video"
        :src="isZh ? '/homepage-demo-zh.mp4' : '/homepage-demo-en.mp4'"
        :poster="isZh ? '/images/homepage-demo-poster-zh.webp' : '/images/homepage-demo-poster-en.webp'"
        controls
        preload="metadata"
        playsinline
        :aria-label="isZh ? 'PD Owner 治理行为变化演示视频' : 'PD Owner-governed behavior change demo'"
      >
        <track
          kind="subtitles"
          :src="isZh ? '/homepage-demo-zh.vtt' : '/homepage-demo-en.vtt'"
          :srclang="isZh ? 'zh' : 'en'"
          :label="isZh ? '中文' : 'English'"
          default
        />
      </video>
    </div>
  </section>
</template>

<script setup>
import { useIsZh } from '../composables/useIsZh'

const isZh = useIsZh()
</script>

<style scoped>
.hero-section { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, .9fr); align-items: center; gap: 72px; padding-top: 104px; }
.hero-copy h1 { max-width: 700px; margin: 18px 0 22px; }
.hero-copy h1 span { display: block; }
.hero-category { margin: 0 0 14px; color: var(--accent); font-weight: 600; font-size: 15px; letter-spacing: .04em; }
.hero-lead { max-width: 670px; font-size: clamp(18px, 2vw, 22px) !important; line-height: 1.65 !important; color: var(--text-main) !important; }
.hero-terms { max-width: 670px; margin-top: 12px; font-size: 14px; color: var(--text-secondary); }
.hero-proof { margin-top: 18px; max-width: 620px; }
.hero-actions { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 32px; }
.hero-visual-wrapper { aspect-ratio: 16 / 9; border: 1px solid var(--border); border-radius: 18px; overflow: hidden; background: #111827; box-shadow: 0 22px 60px rgba(17, 24, 39, .08); }
.hero-video { display: block; width: 100%; height: 100%; object-fit: cover; }
@media (max-width: 900px) { .hero-section { grid-template-columns: 1fr; gap: 44px; padding-top: 72px; } .hero-visual-wrapper { max-width: 720px; } }
@media (max-width: 520px) { .hero-section { padding-top: 56px; } .hero-actions { display: grid; grid-template-columns: 1fr; } .pd-btn { width: 100%; } }
</style>
