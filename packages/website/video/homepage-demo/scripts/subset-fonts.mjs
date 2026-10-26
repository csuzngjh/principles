// Regenerate the Chinese glyph subset used by the composition (and the TTF
// subset used by ffmpeg drawtext for the poster) from the system's full
// Noto Sans SC variable font. The charset is derived from the actual copy
// sources (variables-zh.json + index.html zh copy map + poster line in
// voiceover/scenes.json), so a missing glyph cannot slip in silently.
//
// Usage: node scripts/subset-fonts.mjs
// Requires: fonttools (pyftsubset) on PATH and C:/Windows/Fonts/NotoSansSC-VF.ttf.

import { spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE_FONT = 'C:/Windows/Fonts/NotoSansSC-VF.ttf'
const WOFF2_OUT = path.join(projectRoot, 'capture', 'assets', 'fonts', 'NotoSansSC-subset.woff2')
const TTF_OUT = path.join(projectRoot, 'capture', 'assets', 'fonts', 'NotoSansSC-poster.ttf')
const CHARSET_FILE = path.join(projectRoot, 'renders', 'font-subset-chars.txt')

const ASCII_AND_PUNCTUATION = [
  ' !"#$%&\'()*+,-./0123456789:;<=>?',
  '@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_',
  '`abcdefghijklmnopqrstuvwxyz{|}~',
  '“”‘’«»‹›·—–…†‡✓✗€™',
]

function collectCjk(source) {
  return [...source].filter((ch) => /[\u3000-\u9fff\uff00-\uffef]/.test(ch)).join('')
}

async function main() {
  const variablesZh = await readFile(path.join(projectRoot, 'variables-zh.json'), 'utf8')
  const indexHtml = await readFile(path.join(projectRoot, 'index.html'), 'utf8')
  const scenes = JSON.parse(await readFile(path.join(projectRoot, 'voiceover', 'scenes.json'), 'utf8'))
  const posterLine = scenes.poster?.line?.zh ?? ''

  const found = collectCjk(variablesZh) + collectCjk(indexHtml) + collectCjk(posterLine)
  const charset = [...new Set([...found, ...ASCII_AND_PUNCTUATION])].join('')

  await mkdir(path.dirname(CHARSET_FILE), { recursive: true })
  await writeFile(CHARSET_FILE, charset, 'utf8')
  console.log(`charset: ${charset.length} unique characters -> ${CHARSET_FILE}`)

  const subset = (output, flavor) => {
    const args = [
      SOURCE_FONT,
      `--text-file=${CHARSET_FILE}`,
      `--output-file=${output}`,
      '--layout-features=*',
      '--name-IDs=*',
    ]
    if (flavor) args.push(`--flavor=${flavor}`)
    const result = spawnSync('pyftsubset', args, { encoding: 'utf8', shell: process.platform === 'win32' })
    if (result.status !== 0) {
      throw new Error(`pyftsubset failed for ${output}: ${result.stderr || result.stdout}`)
    }
    console.log(`wrote ${output}`)
  }

  subset(WOFF2_OUT, 'woff2')
  subset(TTF_OUT, null)

  const missing = [...new Set(collectCjk(variablesZh + indexHtml + posterLine))]
    .filter((ch) => !charset.includes(ch))
  if (missing.length > 0) throw new Error(`charset gap: ${missing.join('')}`)
  console.log('subset fonts regenerated.')
}

await main()
