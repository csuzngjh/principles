<template>
  <div class="evo-section">
    <div class="header-container">
      <div class="evo-subtitle">
        <span class="friction-node"></span>
        <span class="evo-sub-text">{{ lang === 'zh-CN' ? 'PD 系统架构' : 'PD SYSTEM ARCHITECTURE' }}</span>
      </div>
      <h2 class="section-title">{{ lang === 'zh-CN' ? '核心心智演化引擎' : 'Core Mind Evolution Engine' }}</h2>
      <p class="evo-desc">
        {{ lang === 'zh-CN' 
          ? '基于模块化流水线设计，PD 打造了一个完整、闭环的硅基心智演化底座。从痛觉捕获到自动化内化，再到沙箱阻断激活，全程支持人类最高安全审核。' 
          : 'Built on modular pipelines, PD establishes a closed-loop cognitive evolution framework for silicon lifeforms. From pain capture to automated internalization and sandboxed activation, with human-in-the-loop sovereignty.' 
        }}
      </p>
    </div>
    
    <div class="evo-container pd-card">
      <div class="evo-sidebar">
        <button 
          v-for="(item, index) in localizedItems" 
          :key="index"
          :class="['evo-tab', { active: activeIndex === index }]"
          @click="activeIndex = index"
        >
          <span class="tab-number">0{{ index + 1 }}</span>
          <span class="tab-title">{{ item.title }}</span>
        </button>
      </div>
      <div class="evo-content-area">
        <transition name="fade" mode="out-in">
          <div :key="activeIndex" class="evo-content">
            <h3 class="content-title">{{ localizedItems[activeIndex].title }}</h3>
            <p class="content-desc">{{ localizedItems[activeIndex].description }}</p>
            <ul class="content-points">
              <li v-for="(point, i) in localizedItems[activeIndex].points" :key="i">
                {{ point }}
              </li>
            </ul>
          </div>
        </transition>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { useData } from 'vitepress'

const { lang } = useData()
const activeIndex = ref(0)

const zhItems = [
  {
    title: '目标痛觉捕获 (GAP Pipeline)',
    description: '不再局限于单次工具报错的浅层响应。PD 独创 GAP 信号源三层架构，从 OKR 目标偏离、重做循环 (rework_loop) 以及显式用户抱怨等高阶维度深度诊断痛苦。',
    points: [
      '三层信号源流：Layer 1 目标驱动（主控）、Layer 2 用户纠正、Layer 3 系统报错（辅助）',
      '目标对齐诊断：仅有真正偏离 OKR 目标或产生用户冲突的信号才会被 Diagnostician 诊断',
      '结构化脱敏数据：痛觉信号与运行 trajectory 自动脱敏并加密记录至本地 SQLite'
    ]
  },
  {
    title: '智能内化流水线 (Internalization)',
    description: '队列中的痛苦数据会自动进入内化蒸馏流程。由 7 个独立职责的 LLM Peer Runners (Dreamer, Philosopher, Artificer, Evaluator 等) 协同配合，将经历提炼为验证工件。',
    points: [
      '并发控制与状态机：LeaseManager 与 TaskStore 确保多任务流水线的并发事务安全',
      'AI 专家协同演进：Dreamer 进行概念脑暴，Philosopher 抽象建模，Scribe 编写文档，Artificer 编写规则',
      '仿真 Replay 校验：Evaluator 和 RolloutReviewer 通过自动化重演，验证规则是否真正消除痛觉'
    ]
  },
  {
    title: '5通道混合激活 (5-Channel Activation)',
    description: '通过验证的 Principle 工件由 ActivationDispatcher 路由至 5 个独立通道生效。未被明确设为 auto 的高风险动作将拦截至 ApprovalQueue，等待人类最终决策。',
    points: [
      '5大系统路由：Prompt 思维模型注入、Defer Archive 归档、Skill 自动文件写入、Code Tool Hook 动态拦截、Model Training 参数微调',
      '本地 VM 安全沙箱：所有执行态的 Rule 动作必须在 node:vm 受限沙箱中运行，严防溢出',
      '人类最高决策权：提供本地 Console 直观审批流，支持对任何激活动作一键批准、拒绝或追溯回滚'
    ]
  },
  {
    title: '长程自主生命周期 (BALM & LRAS)',
    description: '为解决 LLM 在严苛会话超时和 Token 裁剪下碎片化“失忆”的痛点，PD 提供了长程会话支持 (LRAS) 与内置生命周期管理器 (BALM)，支撑长周期 OKR 独立进化。',
    points: [
      'BALM 独立管理器：自主管理内置代理的休眠、唤醒与长线生命周期监控',
      'LRAS 长程会话连接：支持流式事件状态长连接，长效维持代理的深度认知上下文',
      'OKR 目标引导调度：配合 MissionScheduler 的三层任务调度模型，保证长程代理在数日运行中不跑偏'
    ]
  }
]

const enItems = [
  {
    title: 'Goal-Aligned Pain (GAP Pipeline)',
    description: 'Moving beyond shallow tool error catching. PD introduces the 3-tier GAP signal architecture to capture high-order cognitive pain like OKR drifts, rework loops, and explicit user complaints.',
    points: [
      '3-Tier signal streams: L1 goal-driven (primary), L2 user complaints, L3 tool errors (auxiliary evidence)',
      'Goal-aligned alignment: Only friction that actively misaligns with OKR targets triggers the Diagnostician',
      'Structured SQLite storage: Pain contexts are automatically sanitized and safely ledgered locally'
    ]
  },
  {
    title: 'Internalization Pipeline',
    description: 'Queued pain signals are distilled via an automated internalization graph. 7 highly-specialized LLM Peer Runners (Dreamer, Philosopher, Artificer, Evaluator, etc.) collaborate to build proven mind constraints.',
    points: [
      'Concurrency state machine: LeaseManager & TaskStore guarantee transactional execution safety',
      'Peer Runner collaboration: Dreamer conceptualizes, Philosopher abstracts, Artificer writes rule guards',
      'Simulation Replay validation: Evaluator and RolloutReviewer replay historical traces to prove pain elimination'
    ]
  },
  {
    title: '5-Channel Activation',
    description: 'Validated artifacts are dispatched across 5 discrete paths. High-risk channels route directly into the local ApprovalQueue, preserving strict human-in-the-loop sovereignty.',
    points: [
      '5-channel routing: Prompt Injection, Defer Archive, Skill Writing, Code Tool Hook, and Model Training',
      'VM-sandboxed security: Executable rule implementations operate in restricted node:vm sandboxes',
      'Human sovereignty: Interactive Console dashboard for single-click approving, rejecting, or rolling back actions'
    ]
  },
  {
    title: 'Durable Lifecycle (BALM & LRAS)',
    description: 'To combat session amnesia caused by severe session truncation, PD implements LRAS (Long-Running Agent Session) and BALM to orchestrate long-term cognitive tasks autonomously.',
    points: [
      'BALM (Agent Lifecycle): Autonomous manager to lifecycle monitor and wake/sleep background agents',
      'LRAS (Durable Session): Persistent long-connection streaming to bridge contextual sessions',
      'OKR mission scheduler: A 3-tier model aligning long-running agent actions directly with primary goals'
    ]
  }
]

const localizedItems = computed(() => {
  return lang.value === 'zh-CN' ? zhItems : enItems
})
</script>

<style scoped>
.evo-section {
  padding: 4.5rem 1.5rem;
  max-width: 1200px;
  margin: 0 auto;
}

.header-container {
  text-align: center;
  max-width: 800px;
  margin: 0 auto 4rem auto;
}

.evo-subtitle {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.35rem 0.85rem;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(150, 170, 255, 0.08);
  border-radius: 99px;
  margin-bottom: 1.25rem;
}

.evo-sub-text {
  font-family: var(--vp-font-family-mono);
  font-size: 0.8rem;
  font-weight: 700;
  letter-spacing: 0.12em;
  color: var(--blue);
  text-transform: uppercase;
}

.section-title {
  font-size: clamp(28px, 3.8vw, 42px) !important;
  font-weight: 800;
  margin-bottom: 1.25rem;
  color: var(--text-main);
  letter-spacing: -0.02em;
}

.evo-desc {
  font-size: 1.05rem;
  line-height: 1.8;
  color: var(--text-secondary);
}

.evo-container {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.35);
}

@media (min-width: 768px) {
  .evo-container {
    flex-direction: row;
    min-height: 440px;
  }
}

.evo-sidebar {
  display: flex;
  flex-direction: column;
  background: rgba(0, 0, 0, 0.15);
  border-bottom: 1px solid rgba(150, 170, 255, 0.08);
  min-width: 300px;
  padding: 1.5rem 0;
}

@media (min-width: 768px) {
  .evo-sidebar {
    border-bottom: none;
    border-right: 1px solid rgba(150, 170, 255, 0.08);
    padding: 2rem 0;
  }
}

.evo-tab {
  display: flex;
  align-items: center;
  padding: 1.25rem 2rem;
  font-size: 1.02rem;
  font-weight: 600;
  color: var(--text-secondary);
  border: none;
  background: transparent;
  cursor: pointer;
  text-align: left;
  transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
  border-left: 4px solid transparent;
}

.evo-tab:hover {
  color: var(--text-main);
  background: rgba(91, 141, 255, 0.04);
  padding-left: 2.25rem;
}

.evo-tab.active {
  color: var(--blue);
  background: rgba(91, 141, 255, 0.06);
  border-left-color: var(--blue);
  padding-left: 2.25rem;
}

.tab-number {
  font-family: var(--vp-font-family-mono);
  font-size: 0.9rem;
  margin-right: 1.25rem;
  color: var(--blue);
  opacity: 0.6;
}

.active .tab-number {
  opacity: 1;
  font-weight: 700;
}

.tab-title {
  flex-grow: 1;
}

.evo-content-area {
  flex: 1;
  padding: 3.5rem;
  position: relative;
  background: transparent;
  display: flex;
  align-items: center;
}

@media (max-width: 767px) {
  .evo-content-area {
    padding: 2.5rem 1.8rem;
  }
}

.evo-content {
  width: 100%;
}

.content-title {
  font-size: 1.6rem;
  font-weight: 800;
  margin-bottom: 1.25rem;
  color: var(--text-main);
  letter-spacing: -0.01em;
}

.content-desc {
  font-size: 1.02rem;
  line-height: 1.75;
  color: var(--text-secondary);
  margin-bottom: 2rem;
}

.content-points {
  list-style: none;
  padding: 0;
}

.content-points li {
  position: relative;
  padding-left: 1.75rem;
  margin-bottom: 0.95rem;
  font-size: 0.96rem;
  line-height: 1.65;
  color: var(--text-secondary);
}

.content-points li::before {
  content: '✦';
  position: absolute;
  left: 0;
  top: 0.05rem;
  color: var(--amber);
  font-size: 1rem;
}

/* Page transitions */
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.25s cubic-bezier(0.16, 1, 0.3, 1), transform 0.25s cubic-bezier(0.16, 1, 0.3, 1);
}

.fade-enter-from {
  opacity: 0;
  transform: translateY(8px);
}
.fade-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}
</style>
