import { spawn } from 'node:child_process'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const websiteRoot = path.resolve(projectRoot, '..', '..')
const manifestPath = path.join(projectRoot, 'voiceover', 'scenes.json')
const generatedRoot = path.join(projectRoot, 'voiceover', 'generated')
const publicRoot = path.join(websiteRoot, 'public')
const rendersRoot = path.join(projectRoot, 'renders')

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => code === 0 ? resolve(stdout) : reject(new Error(`${command} exited ${code}: ${stderr}`)))
  })
}

async function publishFile(temporary, output) {
  await rm(output, { force: true })
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    try {
      await rename(temporary, output)
      return
    } catch (error) {
      if (error?.code !== 'EBUSY' || attempt === 10) throw error
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
    const budget = scene.end - scene.start
    if (actualDuration > budget) {
      throw new Error(`${locale}/${scene.id}: narration ${actualDuration.toFixed(2)}s exceeds ${budget.toFixed(2)}s scene budget`)
    }
    console.log(`${locale}/${scene.id}: ${actualDuration.toFixed(2)}s / ${budget.toFixed(2)}s`)
    inputs.push(output)
  }

  const vtt = ['WEBVTT', '']
  for (const scene of config.scenes) {
    vtt.push(`${timestamp(scene.start)} --> ${timestamp(scene.end)}`, scene.text, '')
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

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
for (const locale of ['zh', 'en']) {
  const inputs = await synthesize(locale, manifest.locales[locale])
  await mux(locale, inputs, manifest.duration)
}
