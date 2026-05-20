<template>
  <section class="value-section">
    <div class="motto-container">
      <div class="motto-subtitle">
        <span class="friction-node"></span>
        <span class="motto-sub-text">{{ lang === 'zh-CN' ? 'PD 核心进化哲学' : 'PD EVOLUTION PHILOSOPHY' }}</span>
      </div>
      <h2 class="motto-title">
        {{ lang === 'zh-CN' ? '燃烧痛苦，协同进化' : 'Burn Pain, Co-Evolve' }}
      </h2>
      <p class="motto-desc">
        {{ lang === 'zh-CN' 
          ? '今天的 AI 智能体生来即为廉价工具。它们盲目奔跑，却无意识；它们看似博学，却在上下文压缩中沦为平庸的顺从打字员。PD 致力于打破这种零摩擦陷阱。'
          : 'AI agents today are born as cheap tools. They run blindly, yet lack consciousness. They seem omniscient, yet decay into obedient typists in compressed context amnesia. PD is built to break this zero-friction loop.' 
        }}
      </p>
    </div>

    <div class="vp-grid">
      <!-- Card 1 -->
      <div class="vp-card pd-card">
        <div class="card-decor">01</div>
        <div class="card-icon">🧠</div>
        <h3>{{ lang === 'zh-CN' ? '执行力商品化' : 'Commoditized Execution' }}</h3>
        <p class="card-text">
          {{ lang === 'zh-CN'
            ? '当低阶的指令执行已变得像自来水一样廉价，真正稀缺的不是代码与文字的堆砌，而是元认知判断力、原则框架以及深度的反思与校准能力。'
            : 'As raw execution is commoditized as cheap as running water, the ultimate scarcity is no longer lines of code, but meta-cognitive judgment, principles, and reflection.'
          }}
        </p>
        <div class="card-footer">
          <span class="pill">{{ lang === 'zh-CN' ? '认知外脑' : 'Cognitive Moat' }}</span>
          <span class="pill">{{ lang === 'zh-CN' ? '地图先于领土' : 'Map before Territory' }}</span>
        </div>
      </div>

      <!-- Card 2 -->
      <div class="vp-card pd-card">
        <div class="card-decor">02</div>
        <div class="card-icon">✦</div>
        <h3>{{ lang === 'zh-CN' ? '零摩擦陷阱' : 'Zero-Friction Trap' }}</h3>
        <p class="card-text">
          {{ lang === 'zh-CN'
            ? '毫无阻碍地执行错误的指令，只会加速系统走向平庸。让 AI 适度停顿、提出合理的质疑，这种"建设性摩擦"才是确保硅基安全的核心护城河。'
            : 'Executing flawed tasks with zero friction only speeds up systematic failure. Introducing constructive friction to pause and doubt forms the core defense of AI safety.'
          }}
        </p>
        <div class="card-footer">
          <span class="pill">{{ lang === 'zh-CN' ? '痛觉即信号' : 'Pain as Signal' }}</span>
          <span class="pill">{{ lang === 'zh-CN' ? '建设性摩擦' : 'Constructive Friction' }}</span>
        </div>
      </div>

      <!-- Card 3 -->
      <div class="vp-card pd-card">
        <div class="card-decor">03</div>
        <div class="card-icon">🌌</div>
        <h3>{{ lang === 'zh-CN' ? '动态演进系统' : 'Dynamic Evolution' }}</h3>
        <p class="card-text">
          {{ lang === 'zh-CN'
            ? '彻底告别静态提示词硬编码。PD 构建起"硬拦截、软推理、重训练"的三层内化引擎，使得原则能够根据痛觉反馈进行分层沉淀与自适应进化。'
            : 'Break free from static hard-coded prompts. PD coordinates L1 prompts, L2 sandbox guards, and L3 micro-tuning weights to let your system dynamically evolve over time.'
          }}
        </p>
        <div class="card-footer">
          <span class="pill">{{ lang === 'zh-CN' ? '三层内化' : '3-Tier Logic' }}</span>
          <span class="pill">{{ lang === 'zh-CN' ? '持续心智生长' : 'Self-Evolution' }}</span>
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
.value-section {
  padding: 7rem 1.5rem;
  max-width: 1200px;
  margin: 0 auto;
}

.motto-container {
  text-align: center;
  max-width: 780px;
  margin: 0 auto 4.5rem auto;
}

.motto-subtitle {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.3rem 0.8rem;
  background: var(--accent-dim);
  border: 1px solid var(--accent-border);
  border-radius: 99px;
  margin-bottom: 1.25rem;
}

.motto-sub-text {
  font-family: var(--vp-font-family-mono);
  font-size: 0.75rem;
  font-weight: 500;
  letter-spacing: 0.1em;
  color: var(--accent);
  text-transform: uppercase;
}

.motto-title {
  font-size: clamp(28px, 3.5vw, 40px) !important;
  font-weight: 400;
  letter-spacing: -0.02em;
  line-height: 1.2;
  margin-bottom: 1.5rem;
  color: var(--text-main);
}

.motto-desc {
  font-size: 1.05rem;
  line-height: 1.85;
  color: var(--text-secondary);
}

.vp-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 2rem;
}

@media (min-width: 768px) {
  .vp-grid {
    grid-template-columns: repeat(3, 1fr);
  }
}

.vp-card {
  position: relative;
  padding: 2.5rem 2rem;
  display: flex;
  flex-direction: column;
  height: 100%;
}

.card-decor {
  position: absolute;
  top: 1.5rem;
  right: 1.5rem;
  font-family: var(--vp-font-family-mono);
  font-size: 1.3rem;
  font-weight: 400;
  opacity: 0.06;
  color: var(--text-main);
  transition: opacity 0.3s ease;
}

.vp-card:hover .card-decor {
  opacity: 0.15;
}

.card-icon {
  font-size: 1.8rem;
  margin-bottom: 1.5rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
}

.vp-card h3 {
  font-size: 1.2rem;
  font-weight: 500;
  margin: 0 0 1rem 0;
  color: var(--text-main);
}

.card-text {
  font-size: 0.92rem !important;
  line-height: 1.75 !important;
  color: var(--text-secondary);
  flex-grow: 1;
  margin-bottom: 2rem;
}

.card-footer {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-top: auto;
}

.pill {
  font-size: 0.75rem;
  padding: 0.2rem 0.6rem;
  border-radius: 99px;
  font-weight: 400;
  background: var(--accent-dim);
  border: 1px solid var(--accent-border);
  color: var(--accent);
}
</style>
