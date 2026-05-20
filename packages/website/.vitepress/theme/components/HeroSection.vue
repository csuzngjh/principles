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
            ? '硅基生命的思维操作系统。通过原则、反思与建设性摩擦，让 AI 在执行前先停顿、质疑、校准，摆脱“零摩擦陷阱”。' 
            : 'A Thinking OS for silicon lifeforms. Injecting principles, reflection, and constructive friction to make AI pause, question, and calibrate before executing.' 
          }}
        </p>
        <div class="hero-actions">
          <a :href="lang === 'zh-CN' ? '/zh/blog/01-the-helmsman-crisis' : '/blog/01-the-helmsman-crisis'" class="pd-btn pd-btn-brand">
            {{ lang === 'zh-CN' ? '阅读项目思考 (Blog)' : 'Read the Blog' }}
          </a>
          <a href="https://github.com/csuzngjh/principles" target="_blank" rel="noopener" class="pd-btn pd-btn-alt">
            {{ lang === 'zh-CN' ? 'GitHub 开源' : 'GitHub Repository' }}
          </a>
        </div>
      </div>

      <!-- Right Column: Abstract Card Visual -->
      <div class="hero-visual-wrapper">
        <div class="hero-visual">
          <img src="/images/pd_hero_21_9.png" :alt="lang === 'zh-CN' ? 'PD 认知场域' : 'PD Cognitive Arena'" />
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
  padding: 4.5rem 1.5rem;
  max-width: 1200px;
  margin: 0 auto;
}

.hero-container {
  display: grid;
  grid-template-columns: 1fr;
  gap: 3rem;
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
  gap: 0.65rem;
  padding: 0.4rem 1rem;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(150, 170, 255, 0.08);
  border-radius: 99px;
  margin-bottom: 1.5rem;
}

.badge-text {
  font-family: var(--vp-font-family-mono);
  font-size: 0.8rem;
  font-weight: 600;
  letter-spacing: 0.05em;
  color: var(--text-secondary);
  text-transform: uppercase;
}

.hero-title {
  font-size: clamp(34px, 5.5vw, 56px) !important;
  line-height: 1.15 !important;
  letter-spacing: -0.03em !important;
  font-weight: 700;
  color: var(--text-main);
  margin-bottom: 1.5rem;
}

.hero-highlight {
  display: block;
  font-size: clamp(24px, 3.8vw, 36px) !important;
  font-weight: 600;
  background: linear-gradient(135deg, var(--blue) 0%, var(--violet) 50%, var(--amber) 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  margin-top: 0.5rem;
}

.hero-desc {
  font-size: clamp(15px, 1.8vw, 17px) !important;
  line-height: 1.75 !important;
  color: var(--text-secondary);
  max-width: 600px;
  margin-bottom: 2.2rem;
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

/* Specific aspect-ratio override for responsive behavior */
@media (max-width: 959px) {
  .hero-visual {
    aspect-ratio: 16 / 7;
  }
}
</style>
