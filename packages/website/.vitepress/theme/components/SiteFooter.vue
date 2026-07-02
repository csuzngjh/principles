<template>
  <footer class="site-footer" aria-labelledby="footer-label">
    <h2 id="footer-label" class="sr-only">Footer</h2>
    <div class="footer-inner">
      <div class="footer-brand">
        <a class="brand-name" :href="isZh ? '/zh/' : '/'">Principles Disciple</a>
        <span class="brand-meta">{{ isZh ? 'MIT 许可证 · Copyright © 2026 Principles Disciple Contributors' : 'MIT License · Copyright © 2026 Principles Disciple Contributors' }}</span>
      </div>
      <nav class="footer-nav" :aria-label="isZh ? '页脚导航' : 'Footer'">
        <a :href="isZh ? '/zh/docs/getting-started' : '/docs/getting-started'">{{ isZh ? '文档' : 'Docs' }}</a>
        <a :href="isZh ? '/zh/abyss/' : '/abyss/'">{{ isZh ? '思维深渊' : 'Abyss' }}</a>
        <a :href="isZh ? '/zh/install' : '/install'">{{ isZh ? '安装' : 'Install' }}</a>
        <a href="https://github.com/csuzngjh/principles" target="_blank" rel="noopener">GitHub</a>
      </nav>
    </div>
  </footer>
</template>

<script setup>
import { useIsZh } from '../composables/useIsZh'
const isZh = useIsZh()
</script>

<style scoped>
/* A quiet, restrained footer — the page's deliberate end-point.
   No heavy columns, no logos, no metric pile-up (per PD brand constitution §3.5). */
.site-footer {
  border-top: 1px solid var(--border);
  background: var(--vp-c-bg);
}
.footer-inner {
  width: min(1152px, calc(100% - 48px));
  margin: 0 auto;
  padding: 40px 0 48px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
}
.footer-brand { display: flex; flex-direction: column; gap: 6px; }
.brand-name {
  font-family: var(--vp-font-family-mono);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--text-main);
  text-decoration: none;
}
.brand-name:hover { color: var(--accent); }
.brand-meta { font-size: 12px; color: var(--text-muted); line-height: 1.5; }
.footer-nav { display: flex; flex-wrap: wrap; gap: 24px; }
.footer-nav a {
  font-size: 13.5px;
  color: var(--text-secondary);
  text-decoration: none !important;
  transition: color 0.2s ease;
}
.footer-nav a:hover { color: var(--accent); }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }

@media (max-width: 640px) {
  .footer-inner { flex-direction: column; align-items: flex-start; padding: 32px 0 40px; }
  .footer-nav { gap: 18px; }
}
</style>
