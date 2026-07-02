import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const websiteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const distRoot = path.join(websiteRoot, '.vitepress', 'dist')
const publicRoot = path.join(websiteRoot, 'public')

async function page(relativePath) {
  return readFile(path.join(distRoot, relativePath), 'utf8')
}

test('Chinese homepage ships the Owner-governed story and working paths', async () => {
  const html = await page(path.join('zh', 'index.html'))
  assert.match(html, /<title>Principles Disciple \| 让纠正变成 Agent 的下一次行为<\/title>/)
  assert.match(html, /别再反复纠正同一个 Agent。/)
  assert.match(html, /href="#example"/)
  assert.match(html, /href="\/zh\/install"/)
  assert.match(html, /当前可用/)
  assert.match(html, /OpenClaw/)
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
  for (const relativePath of ['index.html', path.join('zh', 'index.html')]) {
    const html = await page(relativePath)
    const videos = html.match(/<video[\s\S]*?<\/video>/g) ?? []
    assert.equal(videos.length, 1)
    assert.match(videos[0], /controls/)
    assert.match(videos[0], /preload="metadata"/)
    assert.match(videos[0], /playsinline/)
    assert.match(videos[0], /aria-label=/)
    assert.doesNotMatch(videos[0], /autoplay/)
  }
})
