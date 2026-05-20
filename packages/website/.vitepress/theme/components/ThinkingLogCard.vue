<template>
  <section class="log-section">
    <div class="section-header">
      <div class="section-tag">
        <span class="friction-node"></span>
        <span class="tag-text">{{ lang === 'zh-CN' ? '演化日志' : 'Thinking Log' }}</span>
      </div>
      <h2 class="section-title">
        {{ lang === 'zh-CN' ? '思想演进日志' : 'System Thinking Logs' }}
      </h2>
      <p class="section-desc">
        {{ lang === 'zh-CN' 
          ? 'PD 并非一款平庸的功能展示型工具，而是一个在不断拷问中持续自我演化的认知外脑。' 
          : 'PD is not an ordinary utility, but a cognitive engine evolving through persistent questioning.' 
        }}
      </p>
    </div>

    <!-- Journal Showcase Card -->
    <div class="journal-card pd-card">
      <div class="journal-thumb">
        <img src="/images/pd_hero_21_9.png" :alt="lang === 'zh-CN' ? '思考日志图' : 'Thinking Log Cover'" />
        <div class="thumb-overlay"></div>
      </div>
      
      <div class="journal-body">
        <div class="journal-meta">
          <span class="journal-series">LOG #001</span>
          <span class="meta-dot">•</span>
          <span class="journal-date">2026-05-20</span>
        </div>
        
        <h3 class="journal-title">
          {{ lang === 'zh-CN' ? '赛博垃圾围城与人类的逃生舱' : 'The Cyber Trash Siege & Human Escape Pod' }}
        </h3>
        
        <p class="journal-excerpt">
          {{ lang === 'zh-CN'
            ? '当执行力变得像自来水一样廉价，无序的机器轮转将让这个世界充斥着代码垃圾与低质信息。在这个时刻，真正稀缺的不再是效率，而是我们赖以生存的判断力、第一性原则和反思机制。'
            : 'As low-level execution turns as cheap as tap water, unordered machines will flood our digital world with cognitive spam. In this age of abundance, the ultimate scarcity is meta-cognitive judgment, principles, and pausing.'
          }}
        </p>

        <div class="journal-tags">
          <span class="j-tag">{{ lang === 'zh-CN' ? '建设性摩擦' : 'Constructive Friction' }}</span>
          <span class="j-tag">{{ lang === 'zh-CN' ? '赛博垃圾' : 'Cyber Junk' }}</span>
          <span class="j-tag">{{ lang === 'zh-CN' ? '认知外脑' : 'Cognitive Moat' }}</span>
        </div>

        <div class="journal-action">
          <a :href="lang === 'zh-CN' ? '/zh/blog/01-the-helmsman-crisis' : '/blog/01-the-helmsman-crisis'" class="read-link">
            <span>{{ lang === 'zh-CN' ? '阅读全文' : 'Read Full Text' }}</span>
            <span class="arrow">→</span>
          </a>
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
.log-section {
  padding: 4.5rem 1.5rem 6rem 1.5rem;
  max-width: 1000px;
  margin: 0 auto;
}

.section-header {
  text-align: center;
  max-width: 800px;
  margin: 0 auto 3.5rem auto;
}

.section-tag {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.35rem 0.85rem;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(150, 170, 255, 0.08);
  border-radius: 99px;
  margin-bottom: 1.25rem;
}

.tag-text {
  font-family: var(--vp-font-family-mono);
  font-size: 0.75rem;
  font-weight: 600;
  letter-spacing: 0.05em;
  color: var(--text-secondary);
  text-transform: uppercase;
}

.section-title {
  font-size: clamp(24px, 3.2vw, 36px) !important;
  font-weight: 800;
  margin-bottom: 1.25rem;
  color: var(--text-main);
  letter-spacing: -0.02em;
}

.section-desc {
  font-size: 1.05rem;
  line-height: 1.7;
  color: var(--text-secondary);
}

.journal-card {
  display: grid;
  grid-template-columns: 1fr;
  overflow: hidden;
  align-items: stretch;
}

@media (min-width: 768px) {
  .journal-card {
    grid-template-columns: 0.8fr 1.2fr;
  }
}

.journal-thumb {
  position: relative;
  min-height: 200px;
  background: rgba(10, 14, 28, 0.5);
  border-bottom: 1px solid rgba(150, 170, 255, 0.08);
}

@media (min-width: 768px) {
  .journal-thumb {
    border-bottom: none;
    border-right: 1px solid rgba(150, 170, 255, 0.08);
  }
}

.journal-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  opacity: 0.5;
  transition: transform 0.8s ease;
}

.journal-card:hover .journal-thumb img {
  transform: scale(1.03);
}

.thumb-overlay {
  content: "";
  position: absolute;
  inset: 0;
  background:
    radial-gradient(circle at 50% 50%, rgba(7, 10, 18, 0.2), rgba(7, 10, 18, 0.75)),
    linear-gradient(to right, transparent, rgba(7, 10, 18, 0.35));
  pointer-events: none;
}

.journal-body {
  padding: 2.5rem;
  display: flex;
  flex-direction: column;
  justify-content: center;
}

.journal-meta {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  margin-bottom: 0.85rem;
  font-family: var(--vp-font-family-mono);
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--blue);
}

.meta-dot {
  color: var(--text-muted);
  opacity: 0.6;
}

.journal-date {
  color: var(--text-muted);
}

.journal-title {
  font-size: clamp(20px, 2.5vw, 24px) !important;
  font-weight: 700;
  line-height: 1.3;
  color: var(--text-main);
  margin-bottom: 1.2rem;
}

.journal-excerpt {
  font-size: 0.95rem !important;
  line-height: 1.75 !important;
  color: var(--text-secondary);
  margin-bottom: 1.8rem;
}

.journal-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-bottom: 2rem;
}

.j-tag {
  font-size: 0.75rem;
  color: var(--text-muted);
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.05);
  padding: 0.15rem 0.55rem;
  border-radius: 4px;
}

.journal-action {
  margin-top: auto;
}

.read-link {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.95rem;
  font-weight: 600;
  color: var(--amber);
  text-decoration: none !important;
  transition: gap 0.25s ease;
}

.read-link:hover {
  gap: 0.85rem;
  color: #f7be62;
}

.read-link .arrow {
  transition: transform 0.25s ease;
}
</style>
