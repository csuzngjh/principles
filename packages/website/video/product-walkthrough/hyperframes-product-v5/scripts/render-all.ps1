#requires -Version 7.0
<#
  principles-disciple V5 — full re-render script.

  Rebuilds every deliverable from the frozen narration JSON and the
  HyperFrames compositions, in the exact order used for the delivered cut:

    1. voiceover + timing.json   (scripts/build-voiceover.py, cached synthesis)
    2. narration markdown        (scripts/gen-narration.mjs)
    3. index.html + scene map    (scripts/build-index.mjs)
    4. subtitles SRT + ASS       (scripts/build-subtitles.mjs)
    5. 8 chapter MP4s            (hyperframes render, ranges from timing.json)
    6. BGM mix + two-pass loudnorm on the mixed file
    7. concat + subtitle burn    (renders/final/principles-disciple-v5-zh.mp4)
    8. ffprobe acceptance readout

  Nothing developer-specific is hard-coded. Dependency names, versions,
  acquisition, expected paths, SHA-256 and the SkipVoice contract live in
  ./ASSET_MANIFEST.md.

  Usage:
    pwsh -File scripts/render-all.ps1                          # full rebuild
    pwsh -File scripts/render-all.ps1 -SkipVoice               # reuse timing + audio
    pwsh -File scripts/render-all.ps1 -DryRun                  # static plan, zero side effects
    pwsh -File scripts/render-all.ps1 -PythonPath /opt/cosy/.venv/bin/python `
      -CosyVoiceRoot /opt/cosy -ReferenceAudio /assets/ref.wav -BgmPath /assets/bgm.wav

  Every path parameter also reads an environment variable when the parameter
  is not supplied:
    -PythonPath        <- PD_VIDEO_PYTHON
    -CosyVoiceRoot     <- PD_VIDEO_COSYVOICE_ROOT
    -ReferenceAudio    <- PD_VIDEO_REFERENCE_AUDIO
    -BgmPath           <- PD_VIDEO_BGM_PATH
#>
[CmdletBinding()]
param(
  [string]$PythonPath = $env:PD_VIDEO_PYTHON,
  [string]$CosyVoiceRoot = $env:PD_VIDEO_COSYVOICE_ROOT,
  [string]$ReferenceAudio = $env:PD_VIDEO_REFERENCE_AUDIO,
  [string]$BgmPath = $env:PD_VIDEO_BGM_PATH,
  [switch]$SkipVoice,
  [switch]$ForceChapters,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$pyScript = Join-Path $PSScriptRoot 'build-voiceover.py'
$voDir = Join-Path $root 'assets/audio/vo'
$timingPath = Join-Path $voDir 'timing.json'
$voFull = Join-Path $root 'renders/audio/vo-full.wav'
$mixPre = Join-Path $root 'renders/audio/mix-pre.wav'
$mixFinal = Join-Path $root 'renders/audio/mix-final.wav'
$silent = Join-Path $root 'renders/final/film-silent.mp4'
$final = Join-Path $root 'renders/final/principles-disciple-v5-zh.mp4'
$nullDevice = if ($IsWindows) { 'NUL' } else { '/dev/null' }

# ------------------------------------------------------------------ helpers
function Resolve-InputPath([string]$value, [string]$baseDir) {
  if ([string]::IsNullOrWhiteSpace($value)) { return $null }
  if ([System.IO.Path]::IsPathRooted($value)) { return [System.IO.Path]::GetFullPath($value) }
  return [System.IO.Path]::GetFullPath((Join-Path $baseDir $value))
}

function Resolve-CommandOrPath([string]$value, [string]$baseDir) {
  if ([string]::IsNullOrWhiteSpace($value)) { return $null }
  $separators = @([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) |
    Select-Object -Unique
  $looksLikePath = [System.IO.Path]::IsPathRooted($value) -or
    ($value -match '\.(exe|cmd|bat|ps1)$') -or
    ($separators | Where-Object { $value.Contains($_) })
  if ($looksLikePath) { return (Resolve-InputPath $value $baseDir) }
  $command = Get-Command $value -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -eq $command) { return $null }
  return $command.Source
}

function Resolve-Tool([string]$name) {
  $command = Get-Command $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -eq $command) { return $null }
  return $command.Source
}

function Test-RegularFile([string]$path, [int64]$minimumBytes = 1) {
  if ([string]::IsNullOrWhiteSpace($path)) { return $false }
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $false }
  return ((Get-Item -LiteralPath $path).Length -ge $minimumBytes)
}

function Test-WritableDirectory([string]$target) {
  $probe = $target
  while (-not (Test-Path -LiteralPath $probe -PathType Container)) {
    $parent = Split-Path -Parent $probe
    if ([string]::IsNullOrWhiteSpace($parent) -or $parent -eq $probe) { return $false }
    $probe = $parent
  }
  $probeFile = Join-Path $probe ('.pd-render-probe-' + [guid]::NewGuid().ToString('N'))
  try {
    [System.IO.File]::WriteAllText($probeFile, 'probe')
    [System.IO.File]::Delete($probeFile)
    return $true
  }
  catch {
    return $false
  }
}

function Get-CommandOutput([string]$executable, [string]$argument) {
  # Never pipe a native command into `Select-Object -First 1`: early pipeline
  # termination can make the process exit non-zero even though it succeeded.
  $text = (& $executable $argument 2>&1 | Out-String).Trim()
  $code = $LASTEXITCODE
  $firstLine = ($text -split "\r?\n" | Where-Object { $_.Trim().Length -gt 0 } | Select-Object -First 1)
  return [pscustomobject]@{ Code = $code; Text = $text; FirstLine = $firstLine }
}

function Read-JsonFile([string]$path) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
  try { return (Get-Content -LiteralPath $path -Raw | ConvertFrom-Json) }
  catch { return $null }
}

function Get-ChapterIds($timing) {
  if ($null -eq $timing -or $null -eq $timing.chapters) { return @() }
  return @($timing.chapters | ForEach-Object { [string]$_.id })
}

$script:checks = [System.Collections.Generic.List[object]]::new()

function Add-Check([string]$id, [string]$label, [string]$status, [string]$detail, [string]$nextAction = '') {
  $script:checks.Add([pscustomobject]@{
      Id         = $id
      Label      = $label
      Status     = $status
      Detail     = $detail
      NextAction = $nextAction
    })
}

# ------------------------------------------------------------------ resolve
$pythonExe = Resolve-CommandOrPath $PythonPath $root
if ([string]::IsNullOrWhiteSpace($PythonPath)) {
  $pythonExe = Resolve-Tool 'python'
  if ($null -eq $pythonExe) { $pythonExe = Resolve-Tool 'python3' }
}

$cosyDir = Resolve-InputPath $CosyVoiceRoot $root
if ([string]::IsNullOrWhiteSpace($cosyDir) -and -not [string]::IsNullOrWhiteSpace($CosyVoiceRoot)) {
  $cosyDir = Resolve-CommandOrPath $CosyVoiceRoot $root
}

$refAudio = Resolve-InputPath $ReferenceAudio $root
if ([string]::IsNullOrWhiteSpace($refAudio)) {
  $refAudio = Join-Path $root 'assets/audio/ref/02-serena-female-l0.wav'
}

$bgmBed = Resolve-InputPath $BgmPath $root
if ([string]::IsNullOrWhiteSpace($bgmBed)) {
  $bgmBed = Join-Path $root 'assets/audio/bgm/bgm-bed-340s.wav'
}

$narrationPath = Join-Path $root 'VOICEOVER_ZH.json'
$hyperframesManifest = Join-Path $root 'hyperframes.json'
$nodeExe = Resolve-Tool 'node'
$npxExe = Resolve-Tool 'npx'
$ffmpegExe = Resolve-Tool 'ffmpeg'
$ffprobeExe = Resolve-Tool 'ffprobe'

# ------------------------------------------------------------------ preflight
Write-Host '== Preflight'

# 1. Node.js
if ($null -ne $nodeExe) {
  if ($DryRun) {
    Add-Check 'node' 'Node.js' 'ok' "resolved $nodeExe (not executed in dry run)"
  }
  else {
    $nodeProbe = Get-CommandOutput $nodeExe '--version'
    if ($nodeProbe.Code -eq 0) { Add-Check 'node' 'Node.js' 'ok' "$($nodeProbe.FirstLine) ($nodeExe)" }
    else { Add-Check 'node' 'Node.js' 'missing' "node --version failed: $($nodeProbe.FirstLine)" 'Install Node.js 20+ and re-run.' }
  }
}
else {
  Add-Check 'node' 'Node.js' 'missing' 'node not found on PATH' 'Install Node.js 20+ so `node` resolves on PATH.'
}

# 2. Python
if ($SkipVoice) {
  Add-Check 'python' 'Python' 'skip' 'not needed with -SkipVoice'
}
elseif ($null -eq $pythonExe) {
  Add-Check 'python' 'Python' 'missing' 'no Python interpreter resolved' 'Install Python 3.10+ and pass -PythonPath / set PD_VIDEO_PYTHON.'
}
elseif ($DryRun) {
  Add-Check 'python' 'Python' 'ok' "resolved $pythonExe (not executed in dry run)"
}
else {
  $pythonProbe = Get-CommandOutput $pythonExe '--version'
  if ($pythonProbe.Code -eq 0) { Add-Check 'python' 'Python' 'ok' "$($pythonProbe.FirstLine) ($pythonExe)" }
  else { Add-Check 'python' 'Python' 'missing' "python --version failed: $($pythonProbe.FirstLine)" 'Point -PythonPath / PD_VIDEO_PYTHON at a working interpreter.' }
}

# 3. CosyVoice model
$modelDir = if ($null -ne $cosyDir) { Join-Path $cosyDir 'pretrained_models/CosyVoice2-0.5B' } else { $null }
$modelFiles = @('config.json', 'llm.pt', 'flow.pt', 'hift.pt')
if ($SkipVoice) {
  Add-Check 'cosyvoice-model' 'CosyVoice 模型' 'skip' 'not needed with -SkipVoice'
}
elseif ($null -eq $cosyDir -or -not (Test-Path -LiteralPath $cosyDir -PathType Container)) {
  Add-Check 'cosyvoice-model' 'CosyVoice 模型' 'missing' 'CosyVoiceRoot not found' 'Pass -CosyVoiceRoot / set PD_VIDEO_COSYVOICE_ROOT (see ASSET_MANIFEST.md).'
}
elseif (-not (Test-Path -LiteralPath $modelDir -PathType Container)) {
  Add-Check 'cosyvoice-model' 'CosyVoice 模型' 'missing' "missing model directory $modelDir" 'Download CosyVoice2-0.5B into <CosyVoiceRoot>/pretrained_models/ (see ASSET_MANIFEST.md).'
}
else {
  $missingModelFiles = @($modelFiles | Where-Object { -not (Test-RegularFile (Join-Path $modelDir $_) 1) })
  if ($missingModelFiles.Count -gt 0) {
    Add-Check 'cosyvoice-model' 'CosyVoice 模型' 'missing' ("missing model files: " + ($missingModelFiles -join ', ')) 'Re-download CosyVoice2-0.5B; verify its file list against ASSET_MANIFEST.md.'
  }
  elseif ($DryRun) {
    Add-Check 'cosyvoice-model' 'CosyVoice 模型' 'ok' "$modelDir (import probe skipped in dry run)"
  }
  else {
    $checkOutput = (& $pythonExe $pyScript --check --cosyvoice-root $cosyDir --reference-audio $refAudio --project $root 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -eq 0) {
      Add-Check 'cosyvoice-model' 'CosyVoice 模型' 'ok' "$modelDir (python --check passed)"
    }
    else {
      Add-Check 'cosyvoice-model' 'CosyVoice 模型' 'missing' ($checkOutput -replace '\s+', ' ') 'Fix the reported CosyVoice import/model/reference problem, then re-run.'
    }
  }
}

# 4. Reference audio
if ($SkipVoice) {
  Add-Check 'reference-audio' 'Reference Audio' 'skip' 'not needed with -SkipVoice'
}
elseif (Test-RegularFile $refAudio 1000) {
  Add-Check 'reference-audio' 'Reference Audio' 'ok' $refAudio
}
else {
  Add-Check 'reference-audio' 'Reference Audio' 'missing' "missing or unreadable: $refAudio" 'Pass -ReferenceAudio / set PD_VIDEO_REFERENCE_AUDIO (SHA-256 in ASSET_MANIFEST.md).'
}

# 5. BGM
if (Test-RegularFile $bgmBed 1000) {
  Add-Check 'bgm' 'BGM' 'ok' $bgmBed
}
else {
  Add-Check 'bgm' 'BGM' 'missing' "missing or unreadable: $bgmBed" 'Pass -BgmPath / set PD_VIDEO_BGM_PATH (see ASSET_MANIFEST.md).'
}

# 6. Narration source JSON
$spec = Read-JsonFile $narrationPath
$specChapters = if ($null -ne $spec -and $null -ne $spec.chapters) { @($spec.chapters) } else { @() }
$specLines = 0
foreach ($chapter in $specChapters) {
  if ($null -ne $chapter.lines) { $specLines += @($chapter.lines).Count }
}
if ($null -eq $spec) {
  Add-Check 'narration-json' '旁白源 JSON' 'missing' "missing or invalid: $narrationPath" 'Restore VOICEOVER_ZH.json (tracked narration source of truth).'
}
elseif ($specChapters.Count -ne 8) {
  Add-Check 'narration-json' '旁白源 JSON' 'missing' "expected 8 chapters, found $($specChapters.Count)" 'Restore the tracked VOICEOVER_ZH.json; do not hand-edit generated files.'
}
else {
  Add-Check 'narration-json' '旁白源 JSON' 'ok' "$narrationPath ($($specChapters.Count) chapters, $specLines lines)"
}

# 7. timing.json
$timing = Read-JsonFile $timingPath
$timingIds = Get-ChapterIds $timing
if ($SkipVoice) {
  if ($null -eq $timing -or $timingIds.Count -ne 8) {
    Add-Check 'timing-json' 'timing.json' 'missing' "missing or not 8 chapters: $timingPath" 'Run without -SkipVoice first, or restore the tracked assets/audio/vo/timing.json.'
  }
  else {
    Add-Check 'timing-json' 'timing.json' 'ok' "$timingPath (8 chapters)"
  }
}
elseif ($null -ne $timing -and $timingIds.Count -eq 8) {
  Add-Check 'timing-json' 'timing.json' 'ok' "$timingPath (8 chapters, will be regenerated in step 1)"
}
else {
  Add-Check 'timing-json' 'timing.json' 'planned' "$timingPath will be generated by step 1"
}

# 8. HyperFrames dependency
$manifestOk = Test-RegularFile $hyperframesManifest 1
if ($null -eq $npxExe) {
  Add-Check 'hyperframes' 'HyperFrames 依赖' 'missing' 'npx not found on PATH' 'Install Node.js/npm so `npx` resolves; hyperframes is fetched with `npx --yes hyperframes`.'
}
elseif (-not $manifestOk) {
  Add-Check 'hyperframes' 'HyperFrames 依赖' 'missing' "missing project manifest: $hyperframesManifest" 'Restore hyperframes.json (tracked HyperFrames project manifest).'
}
elseif ($DryRun) {
  Add-Check 'hyperframes' 'HyperFrames 依赖' 'ok' "npx=$npxExe; hyperframes CLI is resolved/fetched at render time (not probed in dry run)"
}
else {
  Add-Check 'hyperframes' 'HyperFrames 依赖' 'ok' "npx=$npxExe; npx --yes hyperframes fetches the CLI on demand (network required on first run)"
}

# 9. ffmpeg / ffprobe
if ($null -eq $ffmpegExe -or $null -eq $ffprobeExe) {
  $missingTools = @()
  if ($null -eq $ffmpegExe) { $missingTools += 'ffmpeg' }
  if ($null -eq $ffprobeExe) { $missingTools += 'ffprobe' }
  Add-Check 'ffmpeg' 'ffmpeg / ffprobe' 'missing' ("not found on PATH: " + ($missingTools -join ', ')) 'Install ffmpeg (which ships ffprobe) and ensure both resolve on PATH.'
}
elseif ($DryRun) {
  Add-Check 'ffmpeg' 'ffmpeg / ffprobe' 'ok' "resolved $ffmpegExe / $ffprobeExe (not executed in dry run)"
}
else {
  $ffmpegProbe = Get-CommandOutput $ffmpegExe '-version'
  $ffprobeProbe = Get-CommandOutput $ffprobeExe '-version'
  if ($ffmpegProbe.Code -eq 0 -and $ffprobeProbe.Code -eq 0) {
    Add-Check 'ffmpeg' 'ffmpeg / ffprobe' 'ok' "$($ffmpegProbe.FirstLine) / $($ffprobeProbe.FirstLine)"
  }
  else {
    Add-Check 'ffmpeg' 'ffmpeg / ffprobe' 'missing' 'ffmpeg/ffprobe failed to start' 'Reinstall ffmpeg and verify ffmpeg -version works.'
  }
}

# 10. Output directory permissions
$outputDirs = @(
  (Join-Path $root 'renders/chapters'),
  (Join-Path $root 'renders/audio'),
  (Join-Path $root 'renders/final'),
  (Join-Path $root 'renders/subs'),
  (Join-Path $root '.tmp')
)
if ($DryRun) {
  Add-Check 'output-dirs' '输出目录权限' 'ok' 'not probed in dry run (no file is written)'
}
else {
  $unwritable = @($outputDirs | Where-Object { -not (Test-WritableDirectory $_) })
  if ($unwritable.Count -gt 0) {
    Add-Check 'output-dirs' '输出目录权限' 'missing' ("not writable: " + ($unwritable -join ', ')) 'Fix permissions/ownership on the project renders/ and .tmp/ paths.'
  }
  else {
    Add-Check 'output-dirs' '输出目录权限' 'ok' ($outputDirs -join ', ')
  }
}

# SkipVoice extra contract: 8 chapter WAVs + vo-full + timing.json
if ($SkipVoice) {
  $chapterIds = if ($timingIds.Count -gt 0) { $timingIds } else { @('ch01', 'ch02', 'ch03', 'ch04', 'ch05', 'ch06', 'ch07', 'ch08') }
  $missingVoice = @()
  foreach ($id in $chapterIds) {
    $wav = Join-Path $voDir "$id.wav"
    if (-not (Test-RegularFile $wav 1)) { $missingVoice += $wav }
  }
  if (-not (Test-RegularFile $voFull 1)) { $missingVoice += $voFull }
  if ($missingVoice.Count -gt 0) {
    Add-Check 'skip-voice-assets' 'SkipVoice 音频资产' 'missing' ("missing " + $missingVoice.Count + " file(s): " + ($missingVoice -join ', ')) 'Run a full build without -SkipVoice, or restore the chapter WAVs + renders/audio/vo-full.wav.'
  }
  else {
    Add-Check 'skip-voice-assets' 'SkipVoice 音频资产' 'ok' "$($chapterIds.Count) chapter WAVs + $voFull"
  }
}

# ------------------------------------------------------------------ report
$missingChecks = @($script:checks | Where-Object { $_.Status -eq 'missing' })
Write-Host ''
Write-Host '== Preflight report'
foreach ($check in $script:checks) {
  $tag = switch ($check.Status) {
    'ok' { ' OK ' }
    'missing' { 'MISS' }
    'skip' { 'SKIP' }
    'warn' { 'WARN' }
    'planned' { 'PLAN' }
    default { '????' }
  }
  Write-Host ("[{0}] {1,-20} {2}" -f $tag, $check.Label, $check.Detail)
  if ($check.Status -eq 'missing' -and $check.NextAction) {
    Write-Host ("         nextAction: {0}" -f $check.NextAction)
  }
}

if ($missingChecks.Count -gt 0) {
  Write-Host ''
  Write-Host ("Preflight FAILED — {0} missing dependency(ies). Nothing was built." -f $missingChecks.Count)
  foreach ($check in $missingChecks) {
    Write-Host ("  - {0}: {1}" -f $check.Label, $check.Detail)
    Write-Host ("    nextAction: {0}" -f $check.NextAction)
  }
}

# ------------------------------------------------------------------ dry run
function Write-Plan {
  Write-Host ''
  Write-Host '== Plan (DRY RUN — no external program is started and no file is written)'
  Write-Host ("project root : {0}" -f $root)
  Write-Host ("python       : {0}" -f $(if ($null -ne $pythonExe) { $pythonExe } else { '<missing>' }))
  Write-Host ("cosyvoice    : {0}" -f $(if ($null -ne $cosyDir) { $cosyDir } else { '<missing>' }))
  Write-Host ("reference    : {0}" -f $refAudio)
  Write-Host ("bgm          : {0}" -f $bgmBed)
  Write-Host ("node         : {0}" -f $(if ($null -ne $nodeExe) { $nodeExe } else { '<missing>' }))
  Write-Host ("npx          : {0}" -f $(if ($null -ne $npxExe) { $npxExe } else { '<missing>' }))
  Write-Host ("ffmpeg       : {0}" -f $(if ($null -ne $ffmpegExe) { $ffmpegExe } else { '<missing>' }))
  Write-Host ("ffprobe      : {0}" -f $(if ($null -ne $ffprobeExe) { $ffprobeExe } else { '<missing>' }))
  Write-Host ''

  $step = 0
  if (-not $SkipVoice) {
    $step += 1
    Write-Host ("{0}. voiceover + timing.json" -f $step)
    Write-Host ("   cmd : {0} {1} --cosyvoice-root {2} --reference-audio {3} --project {4}" -f $pythonExe, $pyScript, $cosyDir, $refAudio, $root)
    Write-Host ("   in  : {0}, {1}, {2}" -f $narrationPath, $modelDir, $refAudio)
    Write-Host ("   out : {0}/ch01..ch08.wav, {1}, {2}" -f $voDir, $voFull, $timingPath)
  }

  $step += 1
  Write-Host ("{0}. narration markdown" -f $step)
  Write-Host ("   cmd : node {0}" -f (Join-Path $PSScriptRoot 'gen-narration.mjs'))
  Write-Host ("   in  : {0}" -f $narrationPath)
  Write-Host ("   out : {0}" -f (Join-Path $root 'NARRATION_ZH.md'))

  $step += 1
  Write-Host ("{0}. index + scene map" -f $step)
  Write-Host ("   cmd : node {0}" -f (Join-Path $PSScriptRoot 'build-index.mjs'))
  Write-Host ("   in  : {0}" -f $timingPath)
  Write-Host ("   out : {0}, {1}" -f (Join-Path $root 'index.html'), (Join-Path $voDir 'scene-map.json'))

  $step += 1
  Write-Host ("{0}. subtitles" -f $step)
  Write-Host ("   cmd : node {0}" -f (Join-Path $PSScriptRoot 'build-subtitles.mjs'))
  Write-Host ("   in  : {0}" -f $timingPath)
  Write-Host ("   out : {0}, {1}, {2}" -f (Join-Path $root 'SUBTITLES_ZH.srt'), (Join-Path $root 'SUBTITLES_ZH.ass'), (Join-Path $root 'renders/subs'))

  $step += 1
  Write-Host ("{0}. chapter renders" -f $step)
  if ($null -ne $timing -and $timingIds.Count -eq 8) {
    foreach ($chapter in $timing.chapters) {
      $start = [double]$chapter.start
      $end = $start + [double]$chapter.duration
      $out = Join-Path $root "renders/chapters/$($chapter.id).video.mp4"
      $skipNote = if ((Test-Path -LiteralPath $out) -and -not $ForceChapters) { ' [exists, skipped unless -ForceChapters]' } else { '' }
      Write-Host ("   cmd : npx --yes hyperframes render {0} --start {1} --end {2} -o {3}{4}" -f $root, $start, $end, $out, $skipNote)
    }
  }
  else {
    Write-Host '   cmd : npx --yes hyperframes render <root> --start <chapter.start> --end <chapter.start+chapter.duration> -o renders/chapters/<id>.video.mp4'
    Write-Host '   note: chapter ranges are resolved from timing.json after step 1'
  }

  $step += 1
  Write-Host ("{0}. mix vo + loop-extended bgm" -f $step)
  Write-Host ("   cmd : ffmpeg -y -v warning -i {0} -i {1} -filter_complex_script {2} -map [out] -ar 48000 -ac 2 -c:a pcm_s24le {3}" -f $bgmBed, $voFull, (Join-Path $root '.tmp/mix-filter.txt'), $mixPre)

  $step += 1
  Write-Host ("{0}. loudnorm pass 1 (measure) + pass 2 (apply)" -f $step)
  Write-Host ("   cmd : ffmpeg ... -i {0} -af loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json -f null {1}" -f $mixPre, $nullDevice)
  Write-Host ("   cmd : ffmpeg -y ... -i {0} -af loudnorm=...measured_* -ar 48000 -ac 2 -c:a pcm_s24le {1}" -f $mixPre, $mixFinal)

  $step += 1
  Write-Host ("{0}. concat + subtitle burn" -f $step)
  Write-Host ("   in  : renders/chapters/*.mp4, {0}, {1}" -f $mixFinal, (Join-Path $root 'SUBTITLES_ZH.ass'))
  Write-Host ("   out : {0}, {1}" -f $silent, $final)

  $step += 1
  Write-Host ("{0}. acceptance readout" -f $step)
  Write-Host ("   cmd : ffprobe -v error -select_streams v:0 -count_frames -show_entries stream=nb_read_frames,duration,width,height -of default=nw=1 {0}" -f $final)

  Write-Host ''
  Write-Host 'Dry run complete: 0 external programs started, 0 files written.'
}

if ($DryRun) {
  Write-Plan
  if ($missingChecks.Count -gt 0) { exit 1 }
  exit 0
}

if ($missingChecks.Count -gt 0) { exit 1 }

# ------------------------------------------------------------------ execute
function Invoke-Step([string]$label, [scriptblock]$body) {
  Write-Host "== $label"
  $global:LASTEXITCODE = 0
  & $body
  if ($LASTEXITCODE -ne 0) { throw "$label failed with exit code $LASTEXITCODE" }
}

foreach ($dir in $outputDirs) {
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
}

Push-Location $root
try {
  # ---------------------------------------------------------------- 1..4 text
  if (-not $SkipVoice) {
    if ($null -eq $cosyDir) { throw 'CosyVoiceRoot is required for a full build (see ASSET_MANIFEST.md).' }
    Invoke-Step 'voiceover + timing.json' {
      & $pythonExe $pyScript --cosyvoice-root $cosyDir --reference-audio $refAudio --project $root
    }
  }
  Invoke-Step 'narration markdown' { & $nodeExe (Join-Path $PSScriptRoot 'gen-narration.mjs') }
  Invoke-Step 'index + scene map' { & $nodeExe (Join-Path $PSScriptRoot 'build-index.mjs') }
  Invoke-Step 'subtitles' { & $nodeExe (Join-Path $PSScriptRoot 'build-subtitles.mjs') }

  $timing = Read-JsonFile $timingPath
  if ($null -eq $timing -or $null -eq $timing.chapters) { throw "timing.json is missing or invalid after the text steps: $timingPath" }
  $chapters = @($timing.chapters)
  if ($chapters.Count -ne 8) { throw "timing.json must contain 8 chapters, found $($chapters.Count)" }
  $total = [double]$chapters[-1].start + [double]$chapters[-1].duration
  Write-Host ("total programme: {0:N4}s" -f $total)

  # ---------------------------------------------------------------- 5 chapters
  foreach ($chapter in $chapters) {
    $start = [double]$chapter.start
    $end = $start + [double]$chapter.duration
    $out = "renders/chapters/$($chapter.id).video.mp4"
    if ((Test-Path -LiteralPath $out) -and -not $ForceChapters) {
      Write-Host "== $($chapter.id) exists, skipped (use -ForceChapters to redo)"
      continue
    }
    if (Test-Path -LiteralPath $out) { Remove-Item -LiteralPath $out -Force }
    Invoke-Step "$($chapter.id) render $start -> $end" {
      & $npxExe --yes hyperframes render $root --start $start --end $end -o (Join-Path $root $out)
    }
  }

  # ---------------------------------------------------------------- 6 mix
  $bedDur = [double](& $ffprobeExe -v error -show_entries format=duration -of csv=p=0 $bgmBed)
  if ($LASTEXITCODE -ne 0) { throw 'ffprobe could not read the BGM duration' }
  $xfade = 2.0
  $loopLen = [math]::Round($total - $bedDur + $xfade, 4)
  $fadeOutAt = [math]::Round($total - 2.0, 2)
  Write-Host ("bgm {0:N2}s -> programme {1:N4}s, loop segment {2}s, tail crossfade {3}s" -f $bedDur, $total, $loopLen, $xfade)

  $mix = (
    "[0:a]asplit=2[a][b];" +
    "[b]atrim=0:$loopLen,asetpts=N/SR/TB[lp];" +
    "[a][lp]acrossfade=d=${xfade}:c1=tri:c2=tri[ext];" +
    "[ext]atrim=0:$total,asetpts=N/SR/TB,volume=0.30,afade=t=out:st=${fadeOutAt}:d=2.0[bg];" +
    "[1:a]volume=-0.5dB,highpass=f=85,acompressor=threshold=-20dB:ratio=2.2:attack=6:release=180," +
    "pan=stereo|c0=c0|c1=c0,asplit=2[vo][vk];" +
    "[bg][vk]sidechaincompress=threshold=0.05:ratio=8:attack=5:release=400[duck];" +
    "[vo][duck]amix=inputs=2:normalize=0[out]"
  )
  # Written to a file so the chain never travels through a shell: `|` is part of
  # the ffmpeg filter syntax, not a pipeline operator.
  $mixScript = Join-Path $root '.tmp/mix-filter.txt'
  Set-Content -LiteralPath $mixScript -Value $mix -Encoding UTF8
  Invoke-Step 'mix vo + loop-extended bgm' {
    & $ffmpegExe -y -v warning -i $bgmBed -i 'renders/audio/vo-full.wav' -filter_complex_script $mixScript `
      -map '[out]' -ar 48000 -ac 2 -c:a pcm_s24le $mixPre
  }

  # ------------------------------------------- 6b two-pass loudnorm on the mix
  Write-Host '== loudnorm pass 1 (measure the mixed file)'
  $probeLog = (& $ffmpegExe -hide_banner -nostats -i $mixPre `
      -af 'loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json' -f null $nullDevice 2>&1) -join "`n"
  $json = [regex]::Match($probeLog, '(?s)\{.*\}').Value | ConvertFrom-Json
  Write-Host ("   measured I={0} TP={1} LRA={2} thresh={3}" -f $json.input_i, $json.input_tp, $json.input_lra, $json.input_thresh)

  $norm = "loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=$($json.input_i):measured_TP=$($json.input_tp)" +
  ":measured_LRA=$($json.input_lra):measured_thresh=$($json.input_thresh):offset=$($json.target_offset):linear=false:print_format=summary"
  Invoke-Step 'loudnorm pass 2 (apply to the mix)' {
    & $ffmpegExe -y -hide_banner -nostats -i $mixPre -af $norm -ar 48000 -ac 2 -c:a pcm_s24le $mixFinal
  }

  # ---------------------------------------------------------------- 7 picture
  $list = Join-Path $root '.tmp/concat-list.txt'
  ($chapters | ForEach-Object { "file '$(Join-Path $root "renders/chapters/$($_.id).video.mp4")'" -replace '\\', '/' }) |
    Set-Content -Path $list -Encoding UTF8

  Invoke-Step 'concat chapters' { & $ffmpegExe -y -v error -f concat -safe 0 -i $list -c copy $silent }
  Invoke-Step 'burn subtitles + mux audio' {
    & $ffmpegExe -y -v warning -i $silent -i $mixFinal -vf 'ass=SUBTITLES_ZH.ass' `
      -c:v libx264 -crf 18 -preset medium -pix_fmt yuv420p `
      -c:a aac -b:a 320k -ar 48000 -movflags +faststart $final
  }

  Write-Host ''
  Write-Host "done -> $final"
  & $ffprobeExe -v error -select_streams v:0 -count_frames -show_entries stream=nb_read_frames,duration,width,height -of default=nw=1 $final
}
finally {
  Pop-Location
}
