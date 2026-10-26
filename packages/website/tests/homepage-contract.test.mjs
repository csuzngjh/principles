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
  // SPEC-PD-UIUX-001 R8 — INTENTIONAL CONTENT CONTRACT CHANGE: the suffering
  // declaration is no longer the main closing statement. The closing is an
  // invitation around fewer repeated corrections + owner control +
  // observability/reversibility; the brand thinking stays reachable via the
  // Abyss link (燃烧痛苦，协同进化 as the link text).
  assert.doesNotMatch(html, /如果你没有在受苦/)
  assert.match(html, /少一点重复纠正/)
  assert.match(html, /最终决定始终在你手里/)
  assert.match(html, /理念与研究：燃烧痛苦，协同进化/)
  // R8: the behavior timeline is labeled an illustration, not a verified case
  assert.match(html, /行为变化示意/)
  assert.doesNotMatch(html, /真实变化示例/)
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
  // SPEC-PD-UIUX-001 R8 — same contract change as the Chinese page.
  assert.doesNotMatch(html, /not suffering, you/)
  assert.match(html, /Fewer repeated corrections\. More certainty\./)
  assert.match(html, /the final decision stays yours/)
  assert.match(html, /Burn Pain, Co-Evolve/)
  assert.match(html, /illustrated behavior change/)
  assert.doesNotMatch(html, /A concrete behavior change/)
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

test('published videos contain synchronized narration and scene-aligned captions', async () => {
  const voiceoverManifest = JSON.parse(await readFile(voiceoverManifestPath, 'utf8'))
  // SPEC-PD-HOMEPAGE-VIDEO-002: 30s bilingual remake. The duration and the six
  // scene boundaries are asserted from the SPEC, not copied from the manifest,
  // so a manifest regression cannot silently redshift the published film.
  const SPEC_DURATION = 30
  const SPEC_SCENE_STARTS = [0, 4, 8, 13, 17, 25]
  const vttSeconds = (stamp) => {
    const [h, m, s] = stamp.split(':').map(Number)
    return h * 3600 + m * 60 + s
  }

  for (const locale of ['zh', 'en']) {
    const media = probeMedia(path.join(publicRoot, `homepage-demo-${locale}.mp4`))
    if (media) {
      assert.ok(Math.abs(Number(media.format.duration) - SPEC_DURATION) < 0.1, `unexpected duration: ${media.format.duration}`)
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
    const cues = [...captions.matchAll(/^(\d{2}:\d{2}:\d{2}\.\d{3}) --> (\d{2}:\d{2}:\d{2}\.\d{3})$/gm)]
    assert.ok(cues.length >= SPEC_SCENE_STARTS.length, `expected at least six cues, found ${cues.length}`)
    let previousEnd = -1
    for (const cue of cues) {
      const start = vttSeconds(cue[1])
      const end = vttSeconds(cue[2])
      assert.ok(start < end, `cue ${cue[1]} has non-positive length`)
      assert.ok(start >= previousEnd, `cue ${cue[1]} starts before the previous cue ends`)
      assert.ok(end <= SPEC_DURATION, `cue ${cue[1]} ends past the video duration`)
      previousEnd = end
    }
    const cueStarts = cues.map((cue) => vttSeconds(cue[1]))
    // Each scene's first cue starts exactly at its SPEC boundary.
    for (const [index, boundary] of SPEC_SCENE_STARTS.entries()) {
      assert.ok(cueStarts.includes(boundary), `expected a cue starting at ${boundary}s (scene ${index + 1})`)
    }
    // Longer scenes may split into multiple cues; every cue text must be a
    // piece of the narration manifest so captions cannot drift from speech.
    const cueTexts = captions
      .split('\n')
      .filter((line) => line.trim() && !line.includes('-->') && !line.startsWith('WEBVTT'))
    const narration = voiceoverManifest.locales[locale].scenes.flatMap((scene) =>
      scene.cues ? scene.cues.map((cue) => cue.text) : [scene.text],
    )
    for (const cueText of cueTexts) {
      assert.ok(
        narration.includes(cueText),
        `caption text is not part of the narration manifest: ${cueText}`,
      )
    }
    for (const scene of voiceoverManifest.locales[locale].scenes) {
      const pieces = scene.cues ? scene.cues.map((cue) => cue.text) : [scene.text]
      for (const piece of pieces) {
        assert.match(captions, new RegExp(piece.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      }
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
  // SPEC-PD-UIUX-001 R7: Node floor follows the installer manifest (>= 22);
  // the old ">= 18" copy was stale.
  assert.match(zh, /≥ 22/)
  assert.doesNotMatch(zh, /≥ 18/)
  assert.match(zh, /npx create-principles-disciple/)
  assert.match(zh, /每个版本只提醒一次/)
  assert.match(zh, /不影响.*PD 本体/s)
  assert.match(en, /First install in four steps/)
  assert.match(en, /Run anyway/)
  assert.match(en, /Node\.js/)
  assert.match(en, /≥ 22/)
  assert.doesNotMatch(en, /≥ 18/)

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

// SPEC-PD-UIUX-001 R7: the install page asks for the host FIRST; the download
// page states the PD prerequisite next to its CTA; Node requirements follow
// the installer manifest (>= 22), not the stale >= 18 copy.
test('install and download pages route by host and state prerequisites honestly', async () => {
  const zhInstall = await page(path.join('zh', 'install.html'))
  const enInstall = await page('install.html')
  for (const html of [zhInstall, enInstall]) {
    // Default view = host selection, both entries present, no host assumed.
    assert.match(html, /install-host-select/)
    assert.match(html, /install-host-openclaw/)
    assert.match(html, /install-host-codex/)
    // The npx command is NOT the unscoped default on the install page.
    assert.doesNotMatch(html, /create-principles-disciple --yes/)
    // Node requirement matches the installer engines (>= 22).
    assert.doesNotMatch(html, /Node\.js ≥ 18|Node ≥ 18/)
    assert.match(html, /≥ ?22/)
  }
  // Codex path facts survive into the disclaimer.
  assert.match(zhInstall, /Codex CLI ≥ 0\.147/)
  assert.match(enInstall, /Codex CLI ≥ 0\.147/)

  const zhDownload = await page(path.join('zh', 'download.html'))
  const enDownload = await page('download.html')
  assert.match(zhDownload, /需先安装 PD/)
  assert.match(enDownload, /PD must be installed first/)
  assert.match(zhDownload, /≥ 22/)
  assert.match(enDownload, /≥ 22/)
})
