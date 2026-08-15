<script setup>
import { ref, computed, onMounted } from 'vue'
import baked from '../companion-release.json'

const props = defineProps({
  lang: { type: String, default: 'zh' },
})

const REPO = 'csuzngjh/principles'
const zh = props.lang === 'zh'

// Allowlist before a URL is bound to the <a href> sink (EP-08). Applies to
// both the build-time baked URL and the client-side refresh URL, so a crafted
// payload can never inject a non-https / non-GitHub href (rc-1).
function isSafeDownloadUrl(value) {
  if (typeof value !== 'string') return false
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' && parsed.hostname === 'github.com'
  } catch {
    return false
  }
}

// Baked at build time by scripts/fetch-companion-release.mjs (rc-1: validated
// before use). The page never depends on the visitor's ability to reach
// api.github.com — CN visitors otherwise always hit the fallback link.
const version = ref(typeof baked.version === 'string' ? baked.version : '')
const downloadUrl = ref(isSafeDownloadUrl(baked.url) ? baked.url : '')
const sizeBytes = ref(typeof baked.sizeBytes === 'number' ? baked.sizeBytes : null)
const refreshing = ref(false)

const fileName = computed(() => (version.value ? `pd-companion-${version.value}-setup.exe` : ''))
const sizeMb = computed(() => (sizeBytes.value ? (sizeBytes.value / (1024 * 1024)).toFixed(1) : ''))

const labels = zh
  ? {
      eyebrow: 'PD Companion · Windows 桌面版',
      title: '把完整控制台装进你的桌面',
      lead: '双击即用的 Principles Disciple：完整控制台独立成窗，常驻系统托盘，待审批事项实时通知。不需要终端，也不需要开浏览器标签页。',
      features: ['完整控制台独立窗口', '常驻系统托盘', '待审批实时通知'],
      platformOk: 'Windows 10 / 11（64 位）',
      platformSoon: 'macOS 即将推出',
      versionLabel: '当前版本',
      download: '下载安装包',
      refreshing: '正在检查新版本…',
      fallbackHint: '暂时无法获取版本信息，请前往 GitHub Releases 手动下载：',
      fallbackLink: 'GitHub Releases 下载页',
      stepsTitle: '首次安装四步',
      steps: [
        { title: '下载', body: '点击上方按钮下载安装包（或从 GitHub Releases 下载）。' },
        { title: '安装', body: '运行安装包。v1 未签名，如遇蓝色 SmartScreen 提示：更多信息 → 仍要运行。' },
        { title: '启动', body: '双击桌面图标。托盘出现 Companion，控制台窗口直接打开你的数据。' },
        { title: '完成', body: '默认开机自启（首次气泡告知一次），随时可在托盘菜单关闭。' },
      ],
      reqTitle: '环境要求',
      reqs: [
        { k: '操作系统', v: 'Windows 10 / 11（64 位）' },
        { k: 'Node.js', v: '≥ 18 且在 PATH 中（node -v 可用）——Companion 用系统 Node 运行控制台服务' },
        { k: 'PD', v: '已安装：OpenClaw 宿主（npx create-principles-disciple）或 Codex 插件市场安装' },
      ],
      reqNote: 'Companion 是已装 PD 的增强入口——控制台未安装时会显示明确的修复指引，而不是白屏。',
      notifyTitle: '它会通知什么',
      notify: [
        '新的待审批项——点击通知直达审批页',
        'PD 新版本可用——每个版本只提醒一次，不做重复打扰',
      ],
      notifyNote: '在控制台里点「更新」后，Companion 会在约 30 秒内自动重启控制台服务——不需要「Ctrl+C 后重跑」。',
      controlTitle: '控制与卸载',
      control: [
        '关闭窗口后仍驻留托盘；托盘「退出」会同时停掉控制台服务，不留孤儿进程',
        '从 Windows 设置卸载——不影响 PD 本体、pd console open 与工作区数据',
      ],
    }
  : {
      eyebrow: 'PD Companion · Windows desktop',
      title: 'The full Console on your desktop',
      lead: 'Principles Disciple in one double-click: the full Console in its own window, a tray icon, and notifications when approvals need you. No terminal, no browser tab.',
      features: ['Full Console in its own window', 'Lives in the system tray', 'Real-time approval notifications'],
      platformOk: 'Windows 10 / 11 (64-bit)',
      platformSoon: 'macOS coming later',
      versionLabel: 'Current version',
      download: 'Download installer',
      refreshing: 'Checking for a newer version…',
      fallbackHint: 'Could not fetch release info right now. Download manually from GitHub Releases:',
      fallbackLink: 'GitHub Releases page',
      stepsTitle: 'First install in four steps',
      steps: [
        { title: 'Download', body: 'Click the button above (or grab it from GitHub Releases).' },
        { title: 'Install', body: 'Run the installer. v1 is unsigned — if SmartScreen appears: More info → Run anyway.' },
        { title: 'Launch', body: 'Double-click the desktop icon. The tray appears and the Console opens with your data.' },
        { title: 'Done', body: 'Auto-start on login is on by default (announced once); toggle it in the tray menu.' },
      ],
      reqTitle: 'Requirements',
      reqs: [
        { k: 'OS', v: 'Windows 10 / 11 (64-bit)' },
        { k: 'Node.js', v: '≥ 18 on PATH (node -v) — Companion runs the console server with your system Node' },
        { k: 'PD', v: 'Installed via the OpenClaw host (npx create-principles-disciple) or the Codex plugin marketplace' },
      ],
      reqNote: 'Companion is an add-on to an existing PD install — if the console is missing it shows the exact fix, not a blank window.',
      notifyTitle: 'What it notifies about',
      notify: [
        'New pending approval — click to jump straight to the review page',
        'New PD version available — once per version, never nagging',
      ],
      notifyNote: 'After you apply an update inside the Console, Companion restarts the console server within ~30 seconds — no "Ctrl+C and rerun".',
      controlTitle: 'Control & uninstall',
      control: [
        'Closing the window keeps it in the tray; Exit from the tray also stops the console server — no orphan processes',
        'Uninstall from Windows Settings — your PD install, pd console open, and workspace data are untouched',
      ],
    }

// Best-effort client refresh for freshness between website deploys. The
// baked data above is the source of truth for first paint; a browser that
// cannot reach api.github.com simply keeps it (rc-9: no visible failure).
onMounted(async () => {
  refreshing.value = true
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=30`)
    if (!res.ok) throw new Error(`status ${res.status}`)
    const data = await res.json()
    if (!Array.isArray(data)) throw new Error('not an array')
    for (const rel of data) {
      if (typeof rel !== 'object' || rel === null) continue
      const tag = rel.tag_name
      if (typeof tag !== 'string' || !tag.startsWith('companion-v')) continue
      const assets = Array.isArray(rel.assets) ? rel.assets : []
      const exe = assets.find(
        (a) =>
          typeof a === 'object' && a !== null &&
          typeof a.name === 'string' && a.name.endsWith('-setup.exe') &&
          isSafeDownloadUrl(a.browser_download_url),
      )
      if (exe) {
        version.value = tag.replace('companion-v', '')
        downloadUrl.value = exe.browser_download_url
        sizeBytes.value = typeof exe.size === 'number' ? exe.size : null
        break
      }
    }
  } catch {
    /* keep baked data */
  }
  refreshing.value = false
})
</script>

<template>
  <div class="dl-page" data-testid="companion-download-page">
    <section class="dl-hero">
      <p class="dl-eyebrow">{{ labels.eyebrow }}</p>
      <h1 class="dl-title">{{ labels.title }}</h1>
      <p class="dl-lead">{{ labels.lead }}</p>

      <ul class="dl-features">
        <li v-for="feature in labels.features" :key="feature">{{ feature }}</li>
      </ul>

      <div class="dl-platform">
        <span class="badge badge-ok">✓ {{ labels.platformOk }}</span>
        <span class="badge badge-soon">{{ labels.platformSoon }}</span>
      </div>

      <div v-if="downloadUrl" class="dl-cta">
        <a data-testid="companion-download" class="download-btn" :href="downloadUrl">
          {{ labels.download }}<span class="btn-arrow" aria-hidden="true">↓</span>
        </a>
        <p class="dl-fileinfo" data-testid="companion-download-fileinfo">
          <span v-if="version" class="fileinfo-version">{{ labels.versionLabel }} v{{ version }}</span>
          <code>{{ fileName }}</code>
          <span v-if="sizeMb"> · {{ sizeMb }} MB</span>
          <span v-if="refreshing" class="dl-refreshing">（{{ labels.refreshing }}）</span>
        </p>
      </div>
      <div v-else class="dl-cta">
        <p class="dl-fallback-hint">{{ labels.fallbackHint }}</p>
        <a data-testid="companion-download-fallback" class="download-btn download-btn-alt" :href="`https://github.com/${REPO}/releases`">
          {{ labels.fallbackLink }}
        </a>
      </div>
    </section>

    <section class="dl-section" aria-labelledby="dl-steps-title">
      <h2 id="dl-steps-title" class="dl-section-title">{{ labels.stepsTitle }}</h2>
      <ol class="dl-steps">
        <li v-for="(step, index) in labels.steps" :key="step.title" class="dl-step">
          <span class="dl-step-num">{{ String(index + 1).padStart(2, '0') }}</span>
          <h3>{{ step.title }}</h3>
          <p>{{ step.body }}</p>
        </li>
      </ol>
    </section>

    <section class="dl-section" aria-labelledby="dl-req-title">
      <h2 id="dl-req-title" class="dl-section-title">{{ labels.reqTitle }}</h2>
      <dl class="dl-reqs">
        <template v-for="req in labels.reqs" :key="req.k">
          <dt>{{ req.k }}</dt>
          <dd>{{ req.v }}</dd>
        </template>
      </dl>
      <p class="dl-note">{{ labels.reqNote }}</p>
    </section>

    <section class="dl-two-col">
      <div class="dl-card">
        <h2 class="dl-section-title">{{ labels.notifyTitle }}</h2>
        <ul class="dl-list">
          <li v-for="item in labels.notify" :key="item">{{ item }}</li>
        </ul>
        <p class="dl-note">{{ labels.notifyNote }}</p>
      </div>
      <div class="dl-card">
        <h2 class="dl-section-title">{{ labels.controlTitle }}</h2>
        <ul class="dl-list">
          <li v-for="item in labels.control" :key="item">{{ item }}</li>
        </ul>
      </div>
    </section>
  </div>
</template>

<style scoped>
.dl-page {
  max-width: 880px;
  margin: 0 auto;
  padding: 24px 4px 64px;
  color: var(--text-main);
  font-family: var(--vp-font-family-base);
}
/* ── Hero ── */
.dl-hero {
  position: relative;
  overflow: hidden;
  text-align: center;
  padding: 56px 32px 48px;
  border: 1px solid var(--border);
  border-radius: 20px;
  background: var(--surface);
}
.dl-hero::before {
  content: "";
  position: absolute;
  inset: -40% -20% auto;
  height: 240px;
  background: radial-gradient(60% 100% at 50% 0%, var(--accent-dim), transparent 70%);
  pointer-events: none;
}
.dl-eyebrow {
  position: relative;
  margin: 0;
  color: var(--accent);
  font: 600 12px/1.4 var(--vp-font-family-mono);
  letter-spacing: 0.12em;
  text-transform: uppercase;
}
.dl-title {
  position: relative;
  margin: 18px auto 0;
  max-width: 640px;
  font-size: clamp(28px, 4.5vw, 44px);
  line-height: 1.18;
  letter-spacing: -0.02em;
  font-weight: 500;
  color: var(--text-main);
  border: 0;
  padding: 0;
}
.dl-lead {
  position: relative;
  max-width: 56ch;
  margin: 18px auto 0;
  color: var(--text-secondary);
  font-size: 15px;
  line-height: 1.8;
}
.dl-features {
  position: relative;
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
  margin: 22px 0 0;
  padding: 0;
  list-style: none;
}
.dl-features li {
  padding: 7px 14px;
  border: 1px solid var(--accent-border);
  border-radius: 99px;
  background: var(--accent-dim);
  color: var(--text-secondary);
  font-size: 13px;
}
.dl-platform {
  position: relative;
  display: flex;
  justify-content: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 18px;
}
.badge {
  padding: 5px 14px;
  border: 1px solid var(--border);
  border-radius: 99px;
  font-size: 13px;
}
.badge-ok { color: var(--accent); }
.badge-soon { color: var(--text-muted); }
.dl-cta { position: relative; margin-top: 30px; }
.download-btn {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding: 0 38px;
  min-height: 52px;
  border-radius: 99px;
  background: var(--accent);
  color: #fff;
  font-size: 16px;
  font-weight: 500;
  text-decoration: none;
  transition: opacity 0.2s ease, transform 0.2s ease;
  box-shadow: 0 10px 28px rgba(36, 59, 83, 0.18);
}
:root.dark .download-btn { color: #0b0d11; }
.download-btn:hover { opacity: 0.9; transform: translateY(-1px); }
.download-btn:focus-visible { outline: 3px solid var(--accent); outline-offset: 3px; }
.download-btn-alt { background: transparent; color: var(--text-secondary); border: 1px solid var(--border); box-shadow: none; }
.download-btn-alt:hover { color: var(--text-main); border-color: var(--accent-border); }
.btn-arrow { font-size: 19px; }
.dl-fileinfo {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  align-items: center;
  gap: 8px;
  margin: 14px 0 0;
  color: var(--text-secondary);
  font-size: 13px;
}
.fileinfo-version { color: var(--accent); font-weight: 650; }
.dl-fileinfo code {
  padding: 2px 8px;
  border-radius: 5px;
  background: var(--accent-dim);
  font-family: var(--vp-font-family-mono);
  font-size: 12px;
  color: var(--text-main);
}
.dl-refreshing { color: var(--text-muted); }
.dl-fallback-hint { margin: 0 0 14px; color: var(--text-secondary); font-size: 14px; }
/* ── Sections ── */
.dl-section { margin-top: 52px; }
.dl-section-title {
  margin: 0 0 18px;
  font-size: 20px;
  font-weight: 500;
  color: var(--text-main);
  border: 0;
  padding: 0;
}
.dl-steps {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  gap: 14px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.dl-step {
  padding: 20px;
  border: 1px solid var(--border);
  border-radius: 16px;
  background: var(--surface);
  transition: border-color 0.3s ease;
}
.dl-step:hover { border-color: var(--accent-border); }
.dl-step-num {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 99px;
  background: var(--accent-dim);
  color: var(--accent);
  font-size: 13px;
  font-weight: 700;
  font-family: var(--vp-font-family-mono);
}
.dl-step h3 {
  margin: 14px 0 6px;
  font-size: 15px;
  font-weight: 500;
  color: var(--text-main);
  border: 0;
  padding: 0;
}
.dl-step p {
  margin: 0;
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1.7;
}
.dl-reqs {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 12px 24px;
  margin: 0;
  padding: 22px 24px;
  border: 1px solid var(--border);
  border-radius: 16px;
  background: var(--surface);
}
.dl-reqs dt {
  font-weight: 600;
  font-size: 14px;
  color: var(--text-main);
  white-space: nowrap;
}
.dl-reqs dd {
  margin: 0;
  color: var(--text-secondary);
  font-size: 14px;
  line-height: 1.7;
}
.dl-note {
  margin: 14px 0 0;
  color: var(--text-muted);
  font-size: 13px;
  line-height: 1.7;
}
.dl-two-col {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 14px;
  margin-top: 52px;
}
.dl-card {
  padding: 24px;
  border: 1px solid var(--border);
  border-radius: 16px;
  background: var(--surface);
}
.dl-list {
  margin: 0;
  padding-left: 18px;
  color: var(--text-secondary);
  font-size: 14px;
  line-height: 1.9;
}
@media (max-width: 640px) {
  .dl-page { padding-top: 16px; }
  .dl-hero { padding: 40px 18px 36px; }
  .dl-reqs { grid-template-columns: 1fr; gap: 8px 0; }
}
@media (prefers-reduced-motion: reduce) {
  .download-btn { transition: none; }
}
</style>
