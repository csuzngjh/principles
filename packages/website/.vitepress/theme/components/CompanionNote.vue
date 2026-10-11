<template>
  <section class="guide-step">
    <h2 class="step-title">{{ isZh ? '桌面端 PD Companion（Windows）' : 'Desktop PD Companion (Windows)' }}</h2>
    <p class="step-desc">
      {{ isZh
        ? '想省去终端操作？PD Companion 把控制台变成常驻桌面应用：独立窗口 + 系统托盘 + 审批/更新实时通知，双击即用。'
        : 'Prefer no terminal? PD Companion turns the console into a resident desktop app: its own window, a system tray icon, and real-time approval/update notifications.'
      }}
    </p>
    <p class="step-desc">
      {{ isZh
        ? '前提：已按上面的步骤安装 PD（Companion 是已装 PD 的增强入口，不替代安装）。'
        : 'Prerequisite: PD must already be installed (Companion is an add-on to an existing PD install, not a replacement).'
      }}
    </p>
    <p class="step-desc">
      <a :href="isZh ? '/zh/download' : '/download'" class="guide-link" data-umami-event="cta_companion_download">
        {{ isZh ? '前往下载页下载 Companion →' : 'Download Companion →' }}
      </a>
    </p>
    <p class="step-desc note-text">
      {{ isZh ? 'v1 安装包未签名，如遇蓝色 SmartScreen 提示：更多信息 → 仍要运行。' : 'v1 installers are unsigned — if SmartScreen appears: More info → Run anyway.' }}
    </p>
  </section>
</template>

<script setup lang="ts">
defineProps<{ isZh: boolean }>()
</script>

<style scoped>
.guide-step {
  margin-bottom: 2.5rem;
  padding-top: 1.5rem;
  border-top: 1px solid var(--border);
}
.step-title {
  font-size: 1.2rem;
  font-weight: 600;
  color: var(--text-main);
  margin-bottom: 1rem;
}
.step-desc {
  color: var(--text-secondary);
  line-height: 1.6;
}
.note-text {
  font-size: 0.9rem;
  color: var(--text-muted);
}
.guide-link {
  color: var(--accent);
  text-decoration: none;
  font-weight: 600;
}
.guide-link:hover {
  text-decoration: underline;
}
</style>
