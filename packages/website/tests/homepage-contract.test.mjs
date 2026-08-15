import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const websiteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const distRoot = path.join(websiteRoot, '.vitepress', 'dist')
const publicRoot = path.join(websiteRoot, 'public')
const voiceoverManifestPath = path.join(websiteRoot, 'video', 'homepage-demo', 'voiceover', 'scenes.json')

async function page(relativePath) {
  return readFile(path.join(distRoot, relativePath), 'utf8')
}

function probeMedia(filePath) {
  const result = spawnSync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration:stream=codec_name,codec_type,width,height,r_frame_rate',
    '-of', 'json',
    filePath,
  ], { encoding: 'utf8' })
  if (result.error && result.error.code === 'ENOENT') {
    console.warn(`[WARN] ffprobe not found in environment. Skipping detailed stream probe for ${filePath}.`)
    return null
  }
  assert.equal(result.status, 0, result.error?.message || result.stderr)
  return JSON.parse(result.stdout)
}

test('Chinese homepage ships the Owner-governed story and working paths', async () => {
  const html = await page(path.join('zh', 'index.html'))
  assert.match(html, /<title>Principles Disciple \| 让纠正变成 Agent 的下一次行为<\/title>/)
  assert.match(html, /别再反复纠正同一个 Agent。/)
  assert.match(html, /href="#example"/)
  assert.match(html, /href="\/zh\/install"/)
  assert.match(html, /当前可用/)
  assert.match(html, /OpenClaw/)
  assert.match(html, /Codex/)
  assert.match(html, /homepage-demo-zh\.mp4/)
  assert.match(html, /homepage-demo-poster-zh\.webp/)
  // Motto breathing space is present (rewritten, MVP-aligned placement)
  assert.match(html, /如果你没有在受苦/)
  assert.match(html, /燃烧痛苦，协同进化/)
  // Off-position legacy framing stays removed
  assert.doesNotMatch(html, /硅基生命的思维操作系统|自主进化/)
})

test('English homepage preserves the same host-neutral contract', async () => {
  const html = await page('index.html')
  assert.match(html, /<title>Principles Disciple \| Turn corrections into the Agent's next behavior<\/title>/)
  assert.match(html, /Stop correcting the same Agent behavior\./)
  assert.match(html, /href="#example"/)
  assert.match(html, /href="\/install"/)
  assert.match(html, /Available now/)
  assert.match(html, /OpenClaw/)
  assert.match(html, /Codex/)
  assert.match(html, /homepage-demo-en\.mp4/)
  assert.match(html, /homepage-demo-poster-en\.webp/)
  assert.match(html, /not suffering, you/)
  assert.match(html, /Burn Pain, Co-Evolve/)
  assert.doesNotMatch(html, /Thinking OS for Silicon Lifeforms|autonomous evolution/i)
})

test('videos, posters, and Open Graph image are publishable assets', async () => {
  for (const name of ['homepage-demo-zh.mp4', 'homepage-demo-en.mp4']) {
    const asset = await stat(path.join(publicRoot, name))
    assert.ok(asset.size > 100_000, `${name} must contain a rendered video`)
    assert.ok(asset.size <= 4 * 1024 * 1024, `${name} must stay within 4 MiB`)
  }
  for (const name of ['homepage-demo-poster-zh.webp', 'homepage-demo-poster-en.webp']) {
    const posterPath = path.join(publicRoot, 'images', name)
    const asset = await stat(posterPath)
    assert.ok(asset.size > 1_000, `${name} must contain a rendered poster`)
    assert.ok(asset.size <= 100 * 1024, `${name} must stay within 100 KiB`)
    const metadata = await sharp(posterPath).metadata()
    assert.deepEqual([metadata.width, metadata.height, metadata.format], [960, 540, 'webp'])
  }
  const ogPath = path.join(publicRoot, 'images', 'og-image.png')
  const og = await stat(ogPath)
  assert.ok(og.size > 10_000, 'Open Graph image must not be a placeholder')
  const ogMetadata = await sharp(ogPath).metadata()
  assert.deepEqual([ogMetadata.width, ogMetadata.height, ogMetadata.format], [1200, 630, 'png'])
})

test('homepage videos remain user-controlled and accessible', async () => {
  for (const [relativePath, locale, suffix] of [
    ['index.html', 'en', 'en'],
    [path.join('zh', 'index.html'), 'zh', 'zh'],
  ]) {
    const html = await page(relativePath)
    const videos = html.match(/<video[\s\S]*?<\/video>/g) ?? []
    assert.equal(videos.length, 1)
    assert.match(videos[0], /controls/)
    assert.match(videos[0], /preload="metadata"/)
    assert.match(videos[0], /playsinline/)
    assert.match(videos[0], /aria-label=/)
    assert.doesNotMatch(videos[0], /autoplay/)
    assert.match(videos[0], new RegExp(`<track[^>]+src="/homepage-demo-${suffix}\\.vtt"`))
    assert.match(videos[0], new RegExp(`srclang="${locale}"`))
    assert.match(videos[0], /kind="subtitles"/)
    assert.match(videos[0], /\sdefault(?:="")?/)
  }
})

test('published videos contain synchronized narration and six-scene captions', async () => {
  const voiceoverManifest = JSON.parse(await readFile(voiceoverManifestPath, 'utf8'))

  for (const locale of ['zh', 'en']) {
    const media = probeMedia(path.join(publicRoot, `homepage-demo-${locale}.mp4`))
    if (media) {
      assert.ok(Math.abs(Number(media.format.duration) - 36) < 0.1, `unexpected duration: ${media.format.duration}`)
      assert.deepEqual(media.streams.map((stream) => [stream.codec_type, stream.codec_name]), [
        ['video', 'h264'],
        ['audio', 'aac'],
      ])
      assert.deepEqual(
        [media.streams[0].width, media.streams[0].height, media.streams[0].r_frame_rate],
        [1920, 1080, '30/1'],
      )
    }

    const captions = await readFile(path.join(publicRoot, `homepage-demo-${locale}.vtt`), 'utf8')
    assert.match(captions, /^WEBVTT/)
    assert.deepEqual(
      [...captions.matchAll(/^(\d{2}:\d{2}:\d{2}\.\d{3}) -->/gm)].map((match) => match[1]),
      ['00:00:00.000', '00:00:04.000', '00:00:10.000', '00:00:17.000', '00:00:24.000', '00:00:31.000'],
    )
    for (const scene of voiceoverManifest.locales[locale].scenes) {
      assert.match(captions, new RegExp(scene.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    }
  }
})

test('Download pages state what/which version/platform and guide first install', async () => {
  const zh = await page(path.join('zh', 'download.html'))
  const en = await page('download.html')

  // Page identity (frontmatter title) + the DownloadPage mount point.
  assert.match(zh, /下载 PD Companion/)
  assert.match(en, /Download PD Companion/)
  assert.match(zh, /companion-download-page/)
  assert.match(en, /companion-download-page/)

  // Platform clarity: supported Windows badge + macOS expectation, both static
  assert.match(zh, /Windows 10 \/ 11（64 位）/)
  assert.match(zh, /macOS 即将推出/)
  assert.match(en, /Windows 10 \/ 11 \(64-bit\)/)
  assert.match(en, /macOS coming later/)

  // What you download and what it is
  assert.match(zh, /Windows 桌面版/)
  assert.match(zh, /首次安装四步/)
  assert.match(zh, /仍要运行/)
  assert.match(zh, /Node\.js/)
  assert.match(zh, /≥ 18/)
  assert.match(zh, /npx create-principles-disciple/)
  assert.match(zh, /每个版本只提醒一次/)
  assert.match(zh, /不影响.*PD 本体/s)
  assert.match(en, /First install in four steps/)
  assert.match(en, /Run anyway/)
  assert.match(en, /Node\.js/)
  assert.match(en, /≥ 18/)

  // Deterministic CTA branch: SSG bakes the release data at build time
  // (scripts/fetch-companion-release.mjs) and renders either the real download
  // button or the fallback link. Assert against the same baked JSON the build
  // used so the test never depends on the GitHub network.
  const baked = JSON.parse(
    await readFile(path.join(websiteRoot, '.vitepress', 'theme', 'companion-release.json'), 'utf8'),
  )
  const hasUrl = typeof baked.url === 'string' && baked.url.length > 0
  for (const html of [zh, en]) {
    if (hasUrl) {
      assert.match(html, /companion-download"/)
      assert.match(html, /setup\.exe/)
      assert.doesNotMatch(html, /companion-download-fallback/)
    } else {
      assert.match(html, /companion-download-fallback"/)
      assert.doesNotMatch(html, /companion-download"/)
    }
  }
})
