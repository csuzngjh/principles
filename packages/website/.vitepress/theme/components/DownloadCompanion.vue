<script setup>
import { ref, computed, onMounted } from 'vue'

const props = defineProps({
  lang: { type: String, default: 'zh' },
})

const REPO = 'csuzngjh/principles'

const labels =
  props.lang === 'zh'
    ? {
        loading: '正在获取最新版本…',
        button: '下载安装包',
        fileName: (version) => `pd-companion-${version}-setup.exe`,
        fileSize: (mb) => `约 ${mb} MB`,
        platformOk: 'Windows 10 / 11（64 位）',
        fallbackHint: '无法自动获取版本信息，请前往 GitHub Releases 手动下载：',
        fallbackLink: 'GitHub Releases 下载页',
      }
    : {
        loading: 'Fetching the latest release…',
        button: 'Download installer',
        fileName: (version) => `pd-companion-${version}-setup.exe`,
        fileSize: (mb) => `~${mb} MB`,
        platformOk: 'Windows 10 / 11 (64-bit)',
        fallbackHint: 'Could not fetch release info automatically. Download manually from GitHub Releases:',
        fallbackLink: 'GitHub Releases page',
      }

const loading = ref(true)
const downloadUrl = ref('')
const version = ref('')
const sizeMb = ref('')

const fileNameText = computed(() => (version.value ? labels.fileName(version.value) : ''))

// Client-side fetch of the GitHub Releases API. The response is untrusted
// (rc-1): every field is checked before use, and any failure degrades to a
// plain link to the Releases page — never a broken button.
onMounted(async () => {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=30`)
    if (!res.ok) throw new Error(`status ${res.status}`)
    const data = await res.json()
    if (!Array.isArray(data)) throw new Error('releases payload was not an array')
    let chosen
    for (const rel of data) {
      if (typeof rel !== 'object' || rel === null) continue
      const tag = rel.tag_name
      if (typeof tag !== 'string' || !tag.startsWith('companion-v')) continue
      const assets = Array.isArray(rel.assets) ? rel.assets : []
      const exe = assets.find(
        (asset) =>
          typeof asset === 'object' &&
          asset !== null &&
          typeof asset.name === 'string' &&
          asset.name.endsWith('-setup.exe') &&
          typeof asset.browser_download_url === 'string',
      )
      if (exe) {
        chosen = { tag, url: exe.browser_download_url, size: typeof exe.size === 'number' ? exe.size : undefined }
        break
      }
    }
    if (!chosen) throw new Error('no companion release found')
    version.value = chosen.tag.replace('companion-v', '')
    downloadUrl.value = chosen.url
    if (chosen.size !== undefined && chosen.size > 0) {
      sizeMb.value = (chosen.size / (1024 * 1024)).toFixed(1)
    }
  } catch {
    downloadUrl.value = ''
  }
  loading.value = false
})
</script>

<template>
  <div class="download-card" data-testid="companion-download-card">
    <div class="download-head">
      <div class="download-title">
        <h2>PD Companion</h2>
        <p class="download-subtitle">
          {{ lang === 'zh' ? 'Windows 桌面版' : 'Windows desktop app' }}
          <span v-if="version" class="version-badge">v{{ version }}</span>
        </p>
      </div>
      <div class="platform-badges">
        <span class="badge badge-ok">✓ {{ labels.platformOk }}</span>
        <span class="badge badge-soon">{{ lang === 'zh' ? 'macOS 即将推出' : 'macOS coming later' }}</span>
      </div>
    </div>

    <p v-if="loading" class="download-hint">{{ labels.loading }}</p>
    <template v-else-if="downloadUrl">
      <a data-testid="companion-download" class="download-btn" :href="downloadUrl">
        {{ labels.button }}<span class="btn-arrow" aria-hidden="true">↓</span>
      </a>
      <p class="download-fileinfo" data-testid="companion-download-fileinfo">
        <code>{{ fileNameText }}</code>
        <span v-if="sizeMb"> · {{ labels.fileSize(sizeMb) }}</span>
      </p>
    </template>
    <div v-else>
      <p class="download-hint">{{ labels.fallbackHint }}</p>
      <a data-testid="companion-download-fallback" class="download-btn" :href="`https://github.com/${REPO}/releases`">
        {{ labels.fallbackLink }}
      </a>
    </div>
  </div>
</template>

<style scoped>
.download-card {
  margin: 24px 0;
  padding: 24px;
  border: 1px solid var(--vp-c-border);
  border-radius: 12px;
}
.download-head {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 16px;
}
.download-title h2 {
  margin: 0;
  font-size: 22px;
  border: 0;
  padding: 0;
}
.download-subtitle {
  margin: 6px 0 0;
  color: var(--vp-c-text-2);
  font-size: 14px;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.version-badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 99px;
  background: var(--vp-button-brand-bg);
  color: var(--vp-button-brand-text);
  font-weight: 600;
  font-size: 12px;
}
.platform-badges {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.badge {
  display: inline-block;
  padding: 3px 10px;
  border-radius: 99px;
  font-size: 12px;
  border: 1px solid var(--vp-c-border);
}
.badge-ok { color: var(--vp-c-brand-1); }
.badge-soon { color: var(--vp-c-text-3); }
.download-btn {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding: 12px 28px;
  border-radius: 8px;
  background: var(--vp-button-brand-bg);
  color: var(--vp-button-brand-text);
  font-weight: 600;
  font-size: 16px;
  text-decoration: none;
}
.download-btn:hover { background: var(--vp-button-brand-hover-bg); }
.btn-arrow { font-size: 18px; }
.download-fileinfo {
  margin-top: 10px;
  color: var(--vp-c-text-2);
  font-size: 13px;
}
.download-fileinfo code {
  background: var(--vp-c-default-soft);
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 12px;
}
.download-hint {
  margin: 8px 0 12px;
  color: var(--vp-c-text-2);
  font-size: 14px;
}
</style>
