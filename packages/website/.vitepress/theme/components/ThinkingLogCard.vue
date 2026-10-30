<template>
  <section class="log-section">
    <div class="section-header">
      <div class="section-tag">
        <span class="friction-node"></span>
        <span class="tag-text">{{ lang === 'zh-CN' ? '观点与研究' : 'Ideas & Research' }}</span>
      </div>
      <h2 class="section-title">
        {{ lang === 'zh-CN' ? '理解 Owner 不可外包的判断' : 'Explore the judgment an Owner cannot outsource' }}
      </h2>
      <p class="section-desc">
        {{ lang === 'zh-CN' 
          ? '阅读 PD 对 Owner、Agent 行为边界和可治理协作方式的持续研究。'
          : 'Read PD\'s ongoing research into Owners, Agent behavior boundaries, and governable collaboration.'
        }}
      </p>
    </div>

    <div class="journal-card pd-card">
      <div class="journal-thumb">
        <!-- SPEC-PD-UIUX-001 R9: below-the-fold cover — lazy + async decode +
             a compressed 880px (2x display) variant via srcset; the 1916px
             original stays in /public untouched for the article page.
             Review round: sizes caps at the real card slot (461px), so the
             880w variant is chosen on retina too instead of falling back to
             the 1916w original. -->
        <img
          src="/images/abyss/08/abyss-08-cover.webp"
          :srcset="`/images/abyss/08/abyss-08-cover-880.webp 880w, /images/abyss/08/abyss-08-cover.webp 1916w`"
          sizes="(max-width: 767px) 100vw, min(46vw, 461px)"
          width="880"
          height="377"
          loading="lazy"
          decoding="async"
          :alt="lang === 'zh-CN' ? '潜艇在深渊海沟中航行的文章封面' : 'Article cover of a submarine navigating an abyssal trench'"
        />
        <div class="thumb-overlay"></div>
      </div>
      
      <div class="journal-body">
        <div class="journal-meta">
          <span class="journal-series">LOG #008</span>
          <span class="meta-dot">&middot;</span>
          <span class="journal-date">2026-10-30</span>
        </div>

        <h3 class="journal-title">
          {{ lang === 'zh-CN' ? '目标不是一段 Prompt：当智能体学会执行，谁来负责判断？' : 'A Goal Is Not a Prompt: When Agents Learn to Execute, Who Is Responsible for Judgment?' }}
        </h3>

        <p class="journal-excerpt">
          {{ lang === 'zh-CN'
            ? '从圣塔菲号的错误命令，到西蒙的决策前提与 Bungay 的三重落差：当智能体学会执行，谁来负责判断？探讨“我打算”式的意图协作，以及从服从指令到共同承担判断的第三条道路。'
            : 'From the Santa Fe\'s wrong order to Simon\'s decision premises and Bungay\'s three gaps: when agents learn to execute, who judges what is worth doing? Exploring "I intend to..." collaboration and the third path from obedience to shared judgment.'
          }}
        </p>

        <div class="journal-tags">
          <span class="j-tag">{{ lang === 'zh-CN' ? '意图领导' : 'Intent-Based Leadership' }}</span>
          <span class="j-tag">{{ lang === 'zh-CN' ? '决策前提' : 'Decision Premises' }}</span>
          <span class="j-tag">{{ lang === 'zh-CN' ? '人机协作' : 'Human–AI Collaboration' }}</span>
        </div>

        <div class="journal-action">
          <a :href="lang === 'zh-CN' ? '/zh/abyss/08-goal-not-a-prompt' : '/abyss/08-goal-not-a-prompt'" class="read-link">
            <span>{{ lang === 'zh-CN' ? '阅读文章' : 'Read the article' }}</span>
            <span class="arrow">&rarr;</span>
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
.log-section { width: min(1152px, calc(100% - 48px)); padding: 88px 0 112px; max-width: none; margin: 0 auto; border-top: 1px solid var(--border); }
.section-header { text-align: center; max-width: 780px; margin: 0 auto 3.5rem auto; }
.section-tag { display: inline-flex; align-items: center; gap: 0.5rem; padding: 0.3rem 0.8rem; background: var(--accent-dim); border: 1px solid var(--accent-border); border-radius: 99px; margin-bottom: 1.25rem; }
.tag-text { font-family: var(--vp-font-family-mono); font-size: 0.75rem; font-weight: 500; letter-spacing: 0.06em; color: var(--text-secondary); text-transform: uppercase; }
.section-title { font-size: clamp(24px, 3vw, 34px) !important; font-weight: 400; margin-bottom: 1.25rem; color: var(--text-main); letter-spacing: -0.015em; }
.section-desc { font-size: 1rem; line-height: 1.8; color: var(--text-secondary); }

.journal-card { display: grid; grid-template-columns: 1fr; overflow: hidden; align-items: stretch; }
@media (min-width: 768px) { .journal-card { grid-template-columns: 0.8fr 1.2fr; } }

.journal-thumb { position: relative; min-height: 200px; background: var(--surface); border-bottom: 1px solid var(--border); }
@media (min-width: 768px) { .journal-thumb { border-bottom: none; border-right: 1px solid var(--border); } }
.journal-thumb img { width: 100%; height: 100%; object-fit: cover; opacity: 0.4; transition: opacity 0.5s ease; }
.journal-card:hover .journal-thumb img { opacity: 0.55; }
.thumb-overlay { content: ''; position: absolute; inset: 0; background: linear-gradient(180deg, transparent 40%, rgba(11,13,17,0.6) 100%); pointer-events: none; }

.journal-body { padding: 2.5rem; display: flex; flex-direction: column; justify-content: center; }
.journal-meta { display: flex; align-items: center; gap: 0.6rem; margin-bottom: 0.85rem; font-family: var(--vp-font-family-mono); font-size: 0.78rem; font-weight: 400; color: var(--accent); opacity: 0.7; }
.meta-dot { color: var(--text-muted); opacity: 0.5; }
.journal-date { color: var(--text-muted); }
.journal-title { font-size: clamp(20px, 2.5vw, 24px) !important; font-weight: 500; line-height: 1.3; color: var(--text-main); margin-bottom: 1.2rem; }
.journal-excerpt { font-size: 0.95rem !important; line-height: 1.8 !important; color: var(--text-secondary); margin-bottom: 1.8rem; }

.journal-tags { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 2rem; }
.j-tag { font-size: 0.72rem; color: var(--text-muted); background: rgba(255,255,255,0.02); border: 1px solid var(--border); padding: 0.15rem 0.5rem; border-radius: 4px; }

.journal-action { margin-top: auto; }
.read-link { display: inline-flex; align-items: center; gap: 0.5rem; font-size: 0.9rem; font-weight: 400; color: var(--accent); text-decoration: none !important; transition: gap 0.25s ease, opacity 0.25s ease; }
.read-link:hover { gap: 0.8rem; opacity: 0.8; }
@media (max-width: 640px) { .log-section { width: min(100% - 32px, 1152px); padding: 56px 0 72px; } .journal-body { padding: 1.5rem; } }
</style>
