<script setup>
import { ref, onMounted } from 'vue'

const props = defineProps({
  lang: { type: String, default: 'zh' },
})

const REPO = 'csuzngjh/principles'

const labels =
  props.lang === 'zh'
    ? {
        loading: '正在获取最新版本…',
        button: (version) => `下载 PD Companion v${version}（Windows x64）`,
        fallbackHint: '无法自动获取版本信息，请前往 GitHub Releases 手动下载：',
        fallbackLink: 'GitHub Releases 下载页',
        size: '安装包体积小，安装后驻留系统托盘。',
      }
    : {
        loading: 'Fetching the latest release…',
        button: (version) => `Download PD Companion v${version} (Windows x64)`,
        fallbackHint: 'Could not fetch release info automatically. Download manually from GitHub Releases:',
        fallbackLink: 'GitHub Releases page',
        size: 'Small installer; after install it lives in the system tray.',
      }

const loading = ref(true)
const downloadUrl = ref('')
const version = ref('')

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
        chosen = { tag, url: exe.browser_download_url }
        break
      }
    }
    if (!chosen) throw new Error('no companion release found')
    version.value = chosen.tag.replace('companion-v', '')
    downloadUrl.value = chosen.url
  } catch {
    downloadUrl.value = ''
  }
  loading.value = false
})
</script>

<template>
  <div class="download-card">
    <p v-if="loading" class="download-hint">{{ labels.loading }}</p>
    <template v-else-if="downloadUrl">
      <a data-testid="companion-download" class="download-btn" :href="downloadUrl">
        {{ labels.button(version) }}
      </a>
      <p class="download-hint">{{ labels.size }}</p>
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
.download-btn {
  display: inline-block;
  padding: 12px 24px;
  border-radius: 8px;
  background: var(--vp-button-brand-bg);
  color: var(--vp-button-brand-text);
  font-weight: 600;
  text-decoration: none;
}
.download-btn:hover {
  background: var(--vp-button-brand-hover-bg);
}
.download-hint {
  margin-top: 12px;
  color: var(--vp-c-text-2);
  font-size: 14px;
}
</style>
