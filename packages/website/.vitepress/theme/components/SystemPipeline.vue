<template>
  <section class="pipeline-section">
    <div class="section-header">
      <div class="section-tag">
        <span class="friction-node"></span>
        <span class="tag-text">{{ lang === 'zh-CN' ? '系统工作流' : 'System Flow' }}</span>
      </div>
      <h2 class="section-title">
        {{ lang === 'zh-CN' ? 'PD 心智演化流水线' : 'PD Mind Evolution Pipeline' }}
      </h2>
      <p class="section-desc">
        {{ lang === 'zh-CN' 
          ? '从捕获痛觉到反思进化，PD 的系统逻辑由一条清晰、高阶的闭环链路驱动。' 
          : 'From capturing pain to reflective evolution, PD is governed by an elegant closed-loop pipeline.' 
        }}
      </p>
    </div>

    <div class="desktop-pipeline">
      <div class="pipeline-track"></div>
      <div v-for="(step, index) in steps" :key="index" class="pipeline-node">
        <div class="node-badge">
          <span class="step-num">0{{ index + 1 }}</span>
          <span class="friction-node"></span>
        </div>
        <div class="node-content pd-card">
          <h4>{{ lang === 'zh-CN' ? step.zhTitle : step.enTitle }}</h4>
          <p>{{ lang === 'zh-CN' ? step.zhDesc : step.enDesc }}</p>
        </div>
      </div>
    </div>

    <div class="mobile-timeline">
      <div v-for="(step, index) in steps" :key="index" class="timeline-item">
        <div class="timeline-left">
          <span class="timeline-num">0{{ index + 1 }}</span>
          <span class="friction-node"></span>
          <div class="timeline-line" v-if="index < steps.length - 1"></div>
        </div>
        <div class="timeline-right pd-card">
          <h4>{{ lang === 'zh-CN' ? step.zhTitle : step.enTitle }}</h4>
          <p>{{ lang === 'zh-CN' ? step.zhDesc : step.enDesc }}</p>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup>
import { useData } from 'vitepress'
const { lang } = useData()

const steps = [
  {
    zhTitle: '目标痛觉捕获',
    enTitle: 'GAP Capture',
    zhDesc: '从 OKR 目标偏离、用户纠正和多次重做循环中自动捕捉高维度认知痛苦。',
    enDesc: 'Automatically capture high-order cognitive pain from target deviations and rework loops.'
  },
  {
    zhTitle: '原则知识检索',
    enTitle: 'Principle Retrieval',
    zhDesc: '根据痛觉特征向量，精准匹配知识库中沉淀的元认知、第一性原理与决策边界。',
    enDesc: 'Vector-retrieve meta-cognitive models and decision constraints based on the pain profile.'
  },
  {
    zhTitle: '摩擦阻断生成',
    enTitle: 'Friction Gen',
    zhDesc: '动态生成阻断机制，在执行前主动质疑意图、警告风险，迫使系统停顿再反思。',
    enDesc: 'Generate warning gates dynamically, forcing agents to pause and self-reflect before execution.'
  },
  {
    zhTitle: '人类决策记录',
    enTitle: 'Decision Log',
    zhDesc: '向控制台输出结构化反问与审核，将人类的主 Sovereignty 决策以凭证永久记录。',
    enDesc: 'Log structural checks in the dashboard, anchoring final human approval and judgment.'
  },
  {
    zhTitle: '真实反馈回流',
    enTitle: 'Feedback Loop',
    zhDesc: '真实结果转化为算料流回沙盒，动态微调演化出更优心智模型，实现自我进化。',
    enDesc: 'Feed back execution values into the sandbox, fine-tuning internal weights to auto-evolve rules.'
  }
]
</script>

<style scoped>
.pipeline-section { padding: 7rem 1.5rem; max-width: 1200px; margin: 0 auto; position: relative; }
.section-header { text-align: center; max-width: 780px; margin: 0 auto 4rem auto; }
.section-tag { display: inline-flex; align-items: center; gap: 0.5rem; padding: 0.3rem 0.8rem; background: var(--accent-dim); border: 1px solid var(--accent-border); border-radius: 99px; margin-bottom: 1.25rem; }
.tag-text { font-family: var(--vp-font-family-mono); font-size: 0.75rem; font-weight: 500; letter-spacing: 0.06em; color: var(--text-secondary); text-transform: uppercase; }
.section-title { font-size: clamp(24px, 3vw, 34px) !important; font-weight: 400; margin-bottom: 1.25rem; color: var(--text-main); letter-spacing: -0.015em; }
.section-desc { font-size: 1rem; line-height: 1.8; color: var(--text-secondary); }

.desktop-pipeline { display: none; position: relative; grid-template-columns: repeat(5, 1fr); gap: 1.5rem; padding: 2rem 0; }
@media (min-width: 960px) { .desktop-pipeline { display: grid; } }

.pipeline-track { position: absolute; top: 3.5rem; left: 10%; right: 10%; height: 1px; background: rgba(255,255,255,0.05); z-index: 1; }
.pipeline-node { display: flex; flex-direction: column; align-items: center; text-align: center; position: relative; z-index: 2; }
.node-badge { display: flex; flex-direction: column; align-items: center; gap: 0.5rem; margin-bottom: 1.8rem; background: var(--bg); padding: 0 0.5rem; }
.step-num { font-family: var(--vp-font-family-mono); font-size: 0.78rem; color: var(--text-muted); font-weight: 400; }
.node-content { padding: 1.5rem 1.2rem; height: 100%; }
.node-content h4 { font-size: 1.05rem; font-weight: 500; color: var(--text-main); margin-bottom: 0.7rem; }
.node-content p { font-size: 0.88rem !important; line-height: 1.65 !important; color: var(--text-muted); margin: 0; }

.mobile-timeline { display: flex; flex-direction: column; gap: 1.5rem; }
@media (min-width: 960px) { .mobile-timeline { display: none; } }
.timeline-item { display: flex; gap: 1.25rem; }
.timeline-left { display: flex; flex-direction: column; align-items: center; position: relative; min-width: 2.5rem; }
.timeline-num { font-family: var(--vp-font-family-mono); font-size: 0.82rem; color: var(--text-muted); font-weight: 400; margin-bottom: 0.4rem; }
.timeline-line { position: absolute; top: 2.2rem; bottom: -2rem; width: 1px; background: rgba(255,255,255,0.05); z-index: 1; }
.timeline-right { flex-grow: 1; padding: 1.5rem; }
.timeline-right h4 { font-size: 1.1rem; font-weight: 500; color: var(--text-main); margin-bottom: 0.6rem; }
.timeline-right p { font-size: 0.9rem !important; line-height: 1.65 !important; color: var(--text-secondary); margin: 0; }
</style>
