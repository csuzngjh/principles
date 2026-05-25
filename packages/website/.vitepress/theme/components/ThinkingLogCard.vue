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

    <div class="journal-card pd-card">
      <div class="journal-thumb">
        <img src="/images/abyss/03/abyss-03-cover.png" :alt="lang === 'zh-CN' ? '思考日志图' : 'Thinking Log Cover'" />
        <div class="thumb-overlay"></div>
      </div>
      
      <div class="journal-body">
        <div class="journal-meta">
          <span class="journal-series">LOG #003</span>
          <span class="meta-dot">&middot;</span>
          <span class="journal-date">2026-05-25</span>
        </div>
        
        <h3 class="journal-title">
          {{ lang === 'zh-CN' ? '痛苦即信号：前向进化的生物学硬核启示' : 'Pain is the Signal: Forward Evolution' }}
        </h3>
        
        <p class="journal-excerpt">
          {{ lang === 'zh-CN'
            ? '打破反向传播的迷思。大模型没有生物痛觉，但我们可以用工程手段为它建立由“痛觉—刹车—复盘—沉淀”组成的前向进化循环，让原则从文字记忆长成坚硬的行为记忆。'
            : 'Breaking the myth of backpropagation. LLMs have no biological pain, but we can engineer a forward evolution loop of "Pain — Brake — Debrief — Precipitate" to grow soft principles into defensive behavioral memory.'
          }}
        </p>

        <div class="journal-tags">
          <span class="j-tag">{{ lang === 'zh-CN' ? '硅基痛觉' : 'Silicon Pain' }}</span>
          <span class="j-tag">{{ lang === 'zh-CN' ? '双环反思' : 'Double Reflection' }}</span>
          <span class="j-tag">{{ lang === 'zh-CN' ? '突触修剪' : 'Synaptic Pruning' }}</span>
        </div>

        <div class="journal-action">
          <a :href="lang === 'zh-CN' ? '/zh/abyss/03-biological-forward-pass' : '/abyss/03-biological-forward-pass'" class="read-link">
            <span>{{ lang === 'zh-CN' ? '凝视深渊' : 'Gaze into the Abyss' }}</span>
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
.log-section { padding: 5rem 1.5rem 8rem 1.5rem; max-width: 1000px; margin: 0 auto; }
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
</style>