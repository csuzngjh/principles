// 搜索引擎收录契约（SEO）。读的是 `vitepress build` 的真实产物，不是配置快照：
// sitemap 与 canonical 一旦分叉，等于给 Google 两个互相矛盾的权威地址，
// 而这类分叉在配置里看不出来，只能在产物上抓。
import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const websiteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const distRoot = path.join(websiteRoot, '.vitepress', 'dist')
const SITE_HOST = 'principles-website.pages.dev'

// 域名判定一律解析 URL 后比 host，不用字符串前缀：
// `loc.startsWith('https://principles-website.pages.dev')` 会放过
// `https://principles-website.pages.dev.evil.com/` 这类假同域（CodeQL JS/高）。
function urlOf(loc) {
  const parsed = new URL(loc)
  assert.equal(parsed.protocol, 'https:', `不是 https：${loc}`)
  assert.equal(parsed.host, SITE_HOST, `不是正式域名：${loc}`)
  return parsed
}

// `video/**` 是首页演示视频的工程目录，里面的 README/CLAUDE/design/AGENTS 会被
// VitePress 当成正文页面渲染；`404.html` 不是内容页。三者都刻意排除在“应当被收录”之外
// （前者见 config.mts 的 transformItems）。
const INTERNAL = ['video/', '404.html']

async function read(relativePath) {
  return readFile(path.join(distRoot, relativePath), 'utf8')
}

function walk(dir, base = '') {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = base ? `${base}/${entry.name}` : entry.name
    return entry.isDirectory() ? walk(path.join(dir, entry.name), rel) : [rel]
  })
}

function publicPages() {
  return walk(distRoot)
    .filter((file) => file.endsWith('.html'))
    .filter((file) => !INTERNAL.some((prefix) => file.startsWith(prefix)))
    .sort()
}

function locsOf(sitemap) {
  return [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1])
}

/** cleanUrls 的 `<loc>` 路径 → 构建产物文件名。 */
function pathnameToDistFile(pathname) {
  if (pathname === '/') return 'index.html'
  const trimmed = pathname.replace(/^\//, '').replace(/\/$/, '')
  return pathname.endsWith('/') ? `${trimmed}/index.html` : `${trimmed}.html`
}

function canonicalOf(html) {
  return html.match(/<link rel="canonical" href="([^"]+)">/)?.[1]
}

test('sitemap.xml lists every public page on the production host', async () => {
  const sitemap = await read('sitemap.xml')
  const locs = locsOf(sitemap)

  assert.ok(locs.length >= 30, `sitemap 应当收录整站页面，实际只有 ${locs.length} 条`)
  const pathnames = locs.map((loc) => urlOf(loc).pathname)
  // 每条 <loc> 都必须真的对应一个产物页面，否则提交给 Google 的就是 404。
  assert.deepEqual(
    pathnames.map(pathnameToDistFile).sort(),
    publicPages(),
    'sitemap 与公开页面必须一一对应：多出来的条目会抓到 404，缺少的条目等于放弃收录',
  )
})

test('internal video-project docs stay out of the sitemap', async () => {
  const leaked = locsOf(await read('sitemap.xml'))
    .map((loc) => urlOf(loc).pathname)
    .filter((pathname) => pathname.startsWith('/video/'))
  assert.deepEqual(leaked, [], `内部文档不应被广播给搜索引擎：${leaked.join(', ')}`)
})

test('every public page ships exactly one canonical that matches the sitemap', async () => {
  const locs = new Set(locsOf(await read('sitemap.xml')))
  const pages = publicPages()
  assert.ok(pages.length >= 30, `产物页面数量异常，只有 ${pages.length} 个`)

  for (const file of pages) {
    const html = await read(file)
    const found = html.match(/<link rel="canonical"/g) || []
    assert.equal(found.length, 1, `${file} 应当只有一个 canonical，实际 ${found.length} 个`)

    const canonical = canonicalOf(html)
    assert.ok(canonical, `${file} 缺少 canonical`)
    urlOf(canonical) // 不在正式域名上就直接抛断言
    assert.ok(locs.has(canonical), `${file} 的 canonical ${canonical} 没有出现在 sitemap 里`)
  }
})

test('mirrored English and Chinese pages declare each other as alternates', async () => {
  const sitemap = await read('sitemap.xml')
  const blocks = sitemap.split('<url>').slice(1)
  const block = blocks.find((b) => {
    const loc = b.match(/<loc>([^<]+)<\/loc>/)?.[1]
    return loc && urlOf(loc).pathname === '/docs/principles'
  })
  assert.ok(block, 'sitemap 里找不到 /docs/principles 这一条')

  const alternates = [...block.matchAll(/hreflang="([^"]+)" href="([^"]+)"/g)]
    .map((m) => `${m[1]}=${new URL(m[2]).pathname}`)
    .sort()
  assert.deepEqual(
    alternates,
    ['en=/docs/principles', 'zh-CN=/zh/docs/principles'],
    '中英镜像页必须互相声明 alternates，否则两个语言版本会互相抢排名',
  )
})
