<template>
  <section class="hero-section">
    <div class="hero-container">
      <!-- Left Column: Copy & Actions -->
      <div class="hero-content">
        <div class="hero-badge">
          <span class="friction-node"></span>
          <span class="badge-text">{{ lang === 'zh-CN' ? '思考型智能体框架' : 'Cognitive Agent Framework' }}</span>
        </div>
        <h1 class="hero-title">
          Principles Disciple
          <span class="hero-highlight">{{ lang === 'zh-CN' ? '让 AI 在关键决策时刻，不那么听话' : 'Make AI Less Obedient in Critical Moments' }}</span>
        </h1>
        <p class="hero-desc">
          {{ lang === 'zh-CN' 
            ? '硅基生命的思维操作系统。通过原则、反思与建设性摩擦，让 AI 在执行前先停顿、质疑、校准，摆脱"零摩擦陷阱"。' 
            : 'A Thinking OS for silicon lifeforms. Injecting principles, reflection, and constructive friction to make AI pause, question, and calibrate before executing.' 
          }}
        </p>
        <div class="hero-actions">
          <a :href="lang === 'zh-CN' ? '/zh/abyss/01-the-helmsman-crisis' : '/abyss/01-the-helmsman-crisis'" class="pd-btn pd-btn-brand">
            {{ lang === 'zh-CN' ? '阅读思维深渊 (Abyss)' : 'Enter the Abyss' }}
          </a>
          <a href="https://github.com/csuzngjh/principles" target="_blank" rel="noopener" class="pd-btn pd-btn-alt">
            {{ lang === 'zh-CN' ? 'GitHub 开源' : 'GitHub Repository' }}
          </a>
        </div>
      </div>

      <!-- Right Column: Bilingual Contextual Visual -->
      <div class="hero-visual-wrapper">
        <div v-if="lang === 'zh-CN'" class="hero-visual hero-video-container">
          <video 
            src="/promo.mp4" 
            poster="/images/promo-poster-zh.webp"
            controls 
            preload="metadata" 
            class="hero-video-player"
          >
            <track kind="subtitles" src="/promo.vtt" srclang="zh" label="中文" default />
          </video>
        </div>
        <div v-else class="hero-visual hero-video-container">
          <video 
            src="/promo-en.mp4" 
            poster="/images/promo-poster-en.webp"
            controls 
            preload="metadata" 
            class="hero-video-player"
          >
            <track kind="subtitles" src="/promo-en.vtt" srclang="en" label="English" default />
          </video>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup>
import { useData } from 'vitepress'
const { lang } = useData()
</script>

<style scoped>
.hero-section {
  padding: 6rem 1.5rem;
  max-width: 1200px;
  margin: 0 auto;
}

.hero-container {
  display: grid;
  grid-template-columns: 1fr;
  gap: 3.5rem;
  align-items: center;
}

@media (min-width: 960px) {
  .hero-container {
    grid-template-columns: 1.1fr 0.9fr;
    gap: 4rem;
    padding: 2rem 0;
  }
}

.hero-content {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  z-index: 5;
}

.hero-badge {
  display: inline-flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.35rem 0.9rem;
  background: var(--accent-dim);
  border: 1px solid var(--accent-border);
  border-radius: 99px;
  margin-bottom: 1.75rem;
}

.badge-text {
  font-family: var(--vp-font-family-mono);
  font-size: 0.75rem;
  font-weight: 500;
  letter-spacing: 0.06em;
  color: var(--accent);
  text-transform: uppercase;
}

.hero-title {
  font-size: clamp(34px, 5.5vw, 56px) !important;
  line-height: 1.12 !important;
  letter-spacing: -0.025em !important;
  font-weight: 400;
  color: var(--text-main);
  margin-bottom: 1.5rem;
}

.hero-highlight {
  display: block;
  font-size: clamp(22px, 3.5vw, 34px) !important;
  font-weight: 400;
  color: var(--accent);
  margin-top: 0.5rem;
}

.hero-desc {
  font-size: clamp(15px, 1.6vw, 17px) !important;
  line-height: 1.8 !important;
  color: var(--text-secondary);
  max-width: 580px;
  margin-bottom: 2.5rem;
}

.hero-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
}

.hero-visual-wrapper {
  position: relative;
  width: 100%;
  z-index: 2;
}

.hero-video-container {
  aspect-ratio: 16 / 9 !important;
  transition: all 0.3s ease;
}

.hero-video-container:hover {
  border-color: var(--accent) !important;
  box-shadow: 0 0 25px var(--accent-dim);
}

.hero-video-player {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

@media (max-width: 959px) {
  .hero-visual {
    aspect-ratio: 16 / 7;
  }
  .hero-video-container {
    aspect-ratio: 16 / 9 !important;
  }
}
</style>
