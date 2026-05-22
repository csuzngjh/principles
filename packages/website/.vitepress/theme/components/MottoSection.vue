<template>
  <div class="motto-anchor">
    <div class="motto-content">
      <p class="motto-text">
        {{ lang === 'zh-CN' 
          ? '“如果你没有在受苦，你就没有在创造价值。”' 
          : '"If you\'re not suffering, you\'re not building value."' 
        }}
      </p>
    </div>
  </div>
</template>

<script setup>
import { useData } from 'vitepress'
const { lang } = useData()
</script>

<style scoped>
.motto-anchor {
  padding: 4rem 1.5rem;
  text-align: center;
  border-top: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
  background: transparent;
  margin: 2rem 0;
}

.motto-content {
  max-width: 800px;
  margin: 0 auto;
}

.motto-text {
  font-family: var(--vp-font-family-mono);
  font-size: 1.1rem !important;
  line-height: 1.6 !important;
  color: var(--text-muted) !important;
  margin: 0 !important;
  letter-spacing: 0.05em;
  opacity: 0.8;
  font-style: italic;
}
</style>
