<template>
  <section class="contrast-section">
    <div class="section-header">
      <div class="section-tag">
        <span class="friction-node"></span>
        <span class="tag-text">{{ lang === 'zh-CN' ? '心智路线图' : 'Cognitive Roadmap' }}</span>
      </div>
      <h2 class="section-title">
        {{ lang === 'zh-CN' ? '零摩擦陷阱 vs. 建设性摩擦' : 'Zero-Friction Trap vs. Constructive Friction' }}
      </h2>
      <p class="section-desc">
        {{ lang === 'zh-CN' 
          ? '为什么智能体越听话，执行结果反而越脆弱？对比两种完全不同的硅基思考路径。' 
          : 'Why does a more obedient agent yield more fragile outcomes? Contrast two entirely different execution models.' 
        }}
      </p>
    </div>

    <div class="contrast-grid">
      <div class="contrast-card normal-agent-card pd-card">
        <div class="card-header">
          <div class="agent-tag">{{ lang === 'zh-CN' ? '传统智能体' : 'Traditional Agent' }}</div>
          <h3>{{ lang === 'zh-CN' ? '普通 Agent' : 'Standard Agent' }}</h3>
          <p class="subtitle">{{ lang === 'zh-CN' ? '低摩擦执行 (Low-Friction)' : 'Low-Friction Execution' }}</p>
        </div>
        <div class="pipeline-visual">
          <div class="pipe-step">Prompt</div>
          <div class="pipe-arrow">&#8594;</div>
          <div class="pipe-step dead-end">
            <span>{{ lang === 'zh-CN' ? '直接生成' : 'Generate' }}</span>
          </div>
          <div class="pipe-arrow">&#8594;</div>
          <div class="pipe-step">{{ lang === 'zh-CN' ? '交付结果' : 'Deliver' }}</div>
        </div>
        <div class="card-footer-text">
          <p class="summary-highlight">{{ lang === 'zh-CN' ? '快，但脆弱。' : 'Fast, yet highly fragile.' }}</p>
          <p class="desc-text">
            {{ lang === 'zh-CN'
              ? '无意识地直接运行，对含有漏洞的 Prompt 或错误逻辑照单全收，毫无刹车机制，最终导致平庸或灾难性的偏离。'
              : 'Executes instructions instantly without questioning, absorbing flaws and wrong goals blindly. No braking system, leading to systemic failure.'
            }}
          </p>
        </div>
      </div>

      <div class="contrast-card pd-agent-card pd-card">
        <div class="card-header">
          <div class="agent-tag active-tag">{{ lang === 'zh-CN' ? 'PD 认知系统' : 'PD Thinking OS' }}</div>
          <h3>{{ lang === 'zh-CN' ? 'PD Agent' : 'PD Agent' }}</h3>
          <p class="subtitle active-sub">{{ lang === 'zh-CN' ? '原则驱动的建设性摩擦' : 'Principle-Driven Constructive Friction' }}</p>
        </div>
        <div class="pipeline-visual active-pipeline">
          <div class="active-step"><span class="step-lbl">Goal</span></div>
          <div class="active-line"></div>
          <div class="active-step friction-trigger"><span class="friction-node"></span><span class="step-lbl">Why?</span></div>
          <div class="active-line"></div>
          <div class="active-step friction-trigger"><span class="friction-node"></span><span class="step-lbl">Risk?</span></div>
          <div class="active-line"></div>
          <div class="active-step friction-trigger"><span class="friction-node"></span><span class="step-lbl">Moat?</span></div>
          <div class="active-line"></div>
          <div class="active-step success-step"><span class="step-lbl">Better Decision</span></div>
        </div>
        <div class="card-footer-text">
          <p class="summary-highlight active-highlight">{{ lang === 'zh-CN' ? '慢一点，但更稳、更准、可进化。' : 'Slower, but safer, precise, and evolutionary.' }}</p>
          <p class="desc-text">
            {{ lang === 'zh-CN'
              ? '在关键节点产生建设性摩擦主动拦截，通过原则校准、风险质疑与反思闭环，让 AI 在执行前先深度确认，构筑高阶心智护城河。'
              : 'Triggers active constructive friction at key points. Pauses to evaluate constraints and goals, leading to owner-reviewed principles and robust decisions.'
            }}
          </p>
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
.contrast-section { padding: 5rem 1.5rem; max-width: 1100px; margin: 0 auto; }
.section-header { text-align: center; max-width: 780px; margin: 0 auto 3.5rem auto; }
.section-tag { display: inline-flex; align-items: center; gap: 0.5rem; padding: 0.3rem 0.8rem; background: var(--accent-dim); border: 1px solid var(--accent-border); border-radius: 99px; margin-bottom: 1.25rem; }
.tag-text { font-family: var(--vp-font-family-mono); font-size: 0.75rem; font-weight: 500; letter-spacing: 0.06em; color: var(--text-secondary); text-transform: uppercase; }
.section-title { font-size: clamp(24px, 3vw, 34px) !important; font-weight: 400; margin-bottom: 1.25rem; color: var(--text-main); letter-spacing: -0.015em; }
.section-desc { font-size: 1rem; line-height: 1.8; color: var(--text-secondary); }
.contrast-grid { display: grid; grid-template-columns: 1fr; gap: 2rem; }
@media (min-width: 768px) { .contrast-grid { grid-template-columns: 1fr 1fr; } }
.contrast-card { padding: 2.5rem; display: flex; flex-direction: column; height: 100%; }
.normal-agent-card { opacity: 0.55; }
.normal-agent-card:hover { transform: none; opacity: 0.6; }
.card-header { margin-bottom: 2rem; }
.agent-tag { display: inline-block; font-family: var(--vp-font-family-mono); font-size: 0.72rem; font-weight: 400; color: var(--text-muted); border: 1px solid var(--border); padding: 0.15rem 0.55rem; border-radius: 4px; margin-bottom: 0.75rem; text-transform: uppercase; }
.active-tag { color: var(--accent); border-color: var(--accent-border); background: var(--accent-dim); }
.contrast-card h3 { font-size: 1.3rem; font-weight: 500; color: var(--text-main); margin: 0 0 0.35rem 0; }
.subtitle { font-size: 0.88rem; color: var(--text-muted); margin: 0; }
.active-sub { color: var(--accent); }
.pipeline-visual { display: flex; align-items: center; justify-content: space-between; margin: 2rem 0; padding: 1rem; border-radius: 10px; background: rgba(0,0,0,0.15); border: 1px solid var(--border); }
.pipe-step { font-family: var(--vp-font-family-mono); font-size: 0.82rem; padding: 0.35rem 0.7rem; background: rgba(255,255,255,0.03); border: 1px solid var(--border); border-radius: 6px; color: var(--text-secondary); }
.dead-end { border-color: rgba(180,80,80,0.15); color: var(--text-muted); }
.pipe-arrow { color: var(--text-muted); font-size: 0.85rem; }
.active-pipeline { border-color: var(--accent-border); }
.active-step { position: relative; display: flex; flex-direction: column; align-items: center; }
.step-lbl { font-family: var(--vp-font-family-mono); font-size: 0.72rem; color: var(--text-secondary); margin-top: 0.4rem; }
.friction-trigger .step-lbl { color: var(--accent); font-weight: 500; }
.success-step .step-lbl { color: var(--accent); font-weight: 500; padding: 0.15rem 0.45rem; background: var(--accent-dim); border: 1px solid var(--accent-border); border-radius: 4px; margin-top: 0; }
.active-line { flex-grow: 1; height: 1px; background: rgba(255,255,255,0.06); margin: 0 0.5rem; }
.card-footer-text { margin-top: auto; }
.summary-highlight { font-size: 1rem; font-weight: 500; color: var(--text-secondary); margin-bottom: 0.6rem; }
.active-highlight { color: var(--accent); }
.desc-text { font-size: 0.9rem !important; line-height: 1.7 !important; color: var(--text-muted); margin: 0; }
</style>
