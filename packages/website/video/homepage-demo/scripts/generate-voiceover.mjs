import { spawn } from 'node:child_process'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const websiteRoot = path.resolve(projectRoot, '..', '..')
const manifestPath = path.join(projectRoot, 'voiceover', 'scenes.json')
const generatedRoot = path.join(projectRoot, 'voiceover', 'generated')
// --out <dir> redirects final MP4/VTT/poster output (preview builds under
// renders/); without it the script publishes to the website public dir.
const outFlag = process.argv.indexOf('--out')
const publicRoot = outFlag !== -1 && process.argv[outFlag + 1]
  ? path.resolve(process.argv[outFlag + 1])
  : path.join(websiteRoot, 'public')
const rendersRoot = path.join(projectRoot, 'renders')
const posterFont = path.join(projectRoot, 'capture', 'assets', 'fonts', 'NotoSansSC-poster.ttf')

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`${command} timed out`))
    }, 120000)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      code === 0 ? resolve(stdout) : reject(new Error(`${command} exited ${code}: ${stderr}`))
    })
  })
}

async function publishFile(temporary, output) {
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    try {
      await rename(temporary, output)
      return
    } catch (error) {
      if (error?.code === 'EBUSY' || error?.code === 'EEXIST' || error?.code === 'EPERM') {
        await rm(output, { force: true }).catch(() => {})
      }
      if (attempt === 10) throw error
      await new Promise((resolve) => setTimeout(resolve, attempt * 100))
    }
  }
}

function timestamp(seconds) {
  const milliseconds = Math.round(seconds * 1000)
  const minutes = Math.floor(milliseconds / 60000)
  const remaining = milliseconds % 60000
  const wholeSeconds = Math.floor(remaining / 1000)
  const millis = remaining % 1000
  return `00:${String(minutes).padStart(2, '0')}:${String(wholeSeconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`
}

async function duration(filePath) {
  const output = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath])
  return Number(output.trim())
}

const stripSpaces = (text) => text.replace(/\s+/g, '')

function cuesFor(scene) {
  if (!scene.cues) return [{ start: scene.start, end: scene.end, text: scene.text }]
  return scene.cues
}

function validateCues(locale, config, totalDuration) {
  let previousEnd = -1
  for (const scene of config.scenes) {
    const cues = cuesFor(scene)
    for (const cue of cues) {
      if (cue.start < scene.start || cue.end > scene.end) {
        throw new Error(`${locale}/${scene.id}: cue [${cue.start}, ${cue.end}] escapes scene [${scene.start}, ${scene.end}]`)
      }
      if (cue.start >= cue.end) throw new Error(`${locale}/${scene.id}: cue has non-positive length`)
      if (cue.start < previousEnd) throw new Error(`${locale}/${scene.id}: cue starts before the previous cue ends`)
      if (cue.end > totalDuration) throw new Error(`${locale}/${scene.id}: cue ends past the video`)
      previousEnd = cue.end
    }
    if (scene.cues && stripSpaces(scene.cues.map((cue) => cue.text).join('')) !== stripSpaces(scene.text)) {
      throw new Error(`${locale}/${scene.id}: joined cue text does not match the narration text`)
    }
  }
}

async function synthesize(locale, config) {
  const localeDir = path.join(generatedRoot, locale)
  await mkdir(localeDir, { recursive: true })
  const inputs = []

  for (const scene of config.scenes) {
    const output = path.join(localeDir, `${scene.id}.mp3`)
    await run('edge-tts', [
      '--voice', config.voice,
      `--rate=${scene.rate}`,
      `--pitch=${scene.pitch}`,
      '--text', scene.text,
      '--write-media', output,
    ])
    const fileStat = await stat(output)
    if (fileStat.size === 0) throw new Error(`${locale}/${scene.id}: Edge TTS returned an empty file`)
    const actualDuration = await duration(output)
    const budget = scene.end - scene.start - 0.3
    if (actualDuration > budget) {
      throw new Error(`${locale}/${scene.id}: narration ${actualDuration.toFixed(2)}s exceeds ${budget.toFixed(2)}s budget (scene minus 0.3s tail margin)`)
    }
    console.log(`${locale}/${scene.id}: ${actualDuration.toFixed(2)}s / ${budget.toFixed(2)}s`)
    inputs.push(output)
  }

  const vtt = ['WEBVTT', '']
  for (const scene of config.scenes) {
    for (const cue of cuesFor(scene)) {
      vtt.push(`${timestamp(cue.start)} --> ${timestamp(cue.end)}`, cue.text, '')
    }
  }
  await writeFile(path.join(publicRoot, `homepage-demo-${locale}.vtt`), `${vtt.join('\n')}\n`, 'utf8')
  return inputs
}

async function mux(locale, inputs, totalDuration) {
  const pictureMaster = path.join(rendersRoot, `homepage-demo-${locale}-high.mp4`)
  const output = path.join(publicRoot, `homepage-demo-${locale}.mp4`)
  const temporary = path.join(publicRoot, `homepage-demo-${locale}.muxing.mp4`)
  await stat(pictureMaster)

  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const scenes = manifest.locales[locale].scenes
  const inputArgs = ['-y', '-i', pictureMaster]
  for (const input of inputs) inputArgs.push('-i', input)
  const filters = scenes.map((scene, index) => `[${index + 1}:a]adelay=${Math.round(scene.start * 1000)}|${Math.round(scene.start * 1000)},apad=pad_dur=${totalDuration}[a${index + 1}]`)
  const labels = scenes.map((_, index) => `[a${index + 1}]`).join('')
  filters.push(`${labels}amix=inputs=${scenes.length}:duration=longest:dropout_transition=0,loudnorm=I=-18:LRA=7:TP=-2,atrim=duration=${totalDuration}[narration]`)

  await run('ffmpeg', [
    ...inputArgs,
    '-filter_complex', filters.join(';'),
    '-map', '0:v:0', '-map', '[narration]',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '26', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '96k', '-ar', '48000',
    '-movflags', '+faststart', '-t', String(totalDuration), temporary,
  ])
  await publishFile(temporary, output)
}

// Poster: one frame of the final locale MP4 plus the localized tagline,
// rendered by ffmpeg drawtext with the subset TTF (960x540 WebP, <=100 KiB).
// The frame already carries the brand mark and the illustrative badge, so the
// overlay adds only the tagline over a stepped bottom gradient kept clear of
// the frame's own content (key content ends above ~0.75h).
const escapeFilterPath = (value) => value.replaceAll('\\', '/').replaceAll(':', '\\:')

async function generatePoster(locale, totalDuration) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const frameAt = Math.min(manifest.poster.frameAt, totalDuration - 0.1)
  const tagline = manifest.poster.line[locale]
  const source = path.join(publicRoot, `homepage-demo-${locale}.mp4`)
  const output = path.join(publicRoot, 'images', `homepage-demo-poster-${locale}.webp`)
  const temporary = path.join(publicRoot, 'images', `homepage-demo-poster-${locale}.poster.webp`)
  const textFile = path.join(generatedRoot, `poster-tagline-${locale}.txt`)
  await mkdir(path.dirname(textFile), { recursive: true })
  await writeFile(textFile, tagline, 'utf8')

  const overlay = [
    'scale=960:540',
    'drawbox=y=ih*0.72:color=black@0.30:width=iw:height=ih*0.10:t=fill',
    'drawbox=y=ih*0.78:color=black@0.60:width=iw:height=ih*0.22:t=fill',
    `drawtext=fontfile='${escapeFilterPath(posterFont)}':textfile='${escapeFilterPath(textFile)}':fontsize=40:fontcolor=0xFAFAF7:x=(w-text_w)/2:y=h*0.84`,
  ].join(',')

  let size = Infinity
  for (const quality of [82, 72, 62, 52]) {
    await run('ffmpeg', [
      '-y', '-ss', String(frameAt), '-i', source,
      '-frames:v', '1',
      '-vf', overlay,
      '-c:v', 'libwebp', '-quality', String(quality), temporary,
    ])
    size = (await stat(temporary)).size
    if (size <= 100 * 1024) break
  }
  if (size > 100 * 1024) throw new Error(`${locale}: poster exceeds 100 KiB even at minimum quality (${size} bytes)`)
  await publishFile(temporary, output)
  console.log(`${locale}/poster: ${(size / 1024).toFixed(1)} KiB`)
}

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
await mkdir(path.join(publicRoot, 'images'), { recursive: true })
const posterOnly = process.argv.includes('--poster-only')
for (const locale of ['zh', 'en']) {
  validateCues(locale, manifest.locales[locale], manifest.duration)
  if (posterOnly) {
    await generatePoster(locale, manifest.duration)
    continue
  }
  const inputs = await synthesize(locale, manifest.locales[locale])
  await mux(locale, inputs, manifest.duration)
  await generatePoster(locale, manifest.duration)
}
