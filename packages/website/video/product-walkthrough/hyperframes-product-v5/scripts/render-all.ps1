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

  Usage:
    pwsh -File scripts/render-all.ps1              # full rebuild
    pwsh -File scripts/render-all.ps1 -SkipVoice   # reuse timing + audio
    pwsh -File scripts/render-all.ps1 -DryRun      # print, do not execute
#>
param(
  [switch]$SkipVoice,
  [switch]$ForceChapters,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$python = 'D:\pd-labs\cosyvoice\.venv\Scripts\python.exe'
$voDir = 'assets/audio/vo'
$bgmBed = 'assets/audio/bgm/bgm-bed-340s.wav'
$mixPre = 'renders/audio/mix-pre.wav'
$mixFinal = 'renders/audio/mix-final.wav'
$silent = 'renders/final/film-silent.mp4'
$final = 'renders/final/principles-disciple-v5-zh.mp4'

function Invoke-Step([string]$label, [scriptblock]$body) {
  Write-Host "== $label"
  if ($DryRun) { Write-Host '   (dry run)'; return }
  & $body
  if ($LASTEXITCODE -ne 0) { throw "$label failed with exit code $LASTEXITCODE" }
}

# ---------------------------------------------------------------- 1..4 text
if (-not $SkipVoice) {
  Invoke-Step 'voiceover + timing.json' { & $python 'scripts/build-voiceover.py' }
}
Invoke-Step 'narration markdown' { node 'scripts/gen-narration.mjs' }
Invoke-Step 'index + scene map' { node 'scripts/build-index.mjs' }
Invoke-Step 'subtitles' { node 'scripts/build-subtitles.mjs' }

$timing = Get-Content "$voDir/timing.json" -Raw | ConvertFrom-Json
$chapters = $timing.chapters
$total = [double]$chapters[-1].start + [double]$chapters[-1].duration
Write-Host ("total programme: {0:N4}s" -f $total)

# ---------------------------------------------------------------- 5 chapters
New-Item -ItemType Directory -Force -Path 'renders/chapters' | Out-Null
foreach ($c in $chapters) {
  $start = [double]$c.start
  $end = $start + [double]$c.duration
  $out = "renders/chapters/$($c.id).video.mp4"
  if ((Test-Path $out) -and -not $ForceChapters) {
    Write-Host "== $($c.id) exists, skipped (use -ForceChapters to redo)"
    continue
  }
  if (Test-Path $out) { Remove-Item $out -Force }
  Invoke-Step "$($c.id) render $start -> $end" {
    npx --yes hyperframes render $root --start $start --end $end -o (Join-Path $root $out)
  }
}

# ---------------------------------------------------------------- 6 mix
New-Item -ItemType Directory -Force -Path 'renders/audio' | Out-Null
$bedDur = [double](& ffprobe -v error -show_entries format=duration -of csv=p=0 $bgmBed)
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
Invoke-Step 'mix vo + loop-extended bgm' {
  ffmpeg -y -v warning -i $bgmBed -i 'renders/audio/vo-full.wav' -filter_complex $mix `
    -map '[out]' -ar 48000 -ac 2 -c:a pcm_s24le $mixPre
}

# ------------------------------------------- 6b two-pass loudnorm on the mix
Write-Host '== loudnorm pass 1 (measure the mixed file)'
$probeLog = (ffmpeg -hide_banner -nostats -i $mixPre `
    -af 'loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json' -f null NUL 2>&1) -join "`n"
$json = [regex]::Match($probeLog, '(?s)\{.*\}').Value | ConvertFrom-Json
Write-Host ("   measured I={0} TP={1} LRA={2} thresh={3}" -f $json.input_i, $json.input_tp, $json.input_lra, $json.input_thresh)

$norm = "loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=$($json.input_i):measured_TP=$($json.input_tp)" +
":measured_LRA=$($json.input_lra):measured_thresh=$($json.input_thresh):offset=$($json.target_offset):linear=false:print_format=summary"
Invoke-Step 'loudnorm pass 2 (apply to the mix)' {
  ffmpeg -y -hide_banner -nostats -i $mixPre -af $norm -ar 48000 -ac 2 -c:a pcm_s24le $mixFinal
}

# ---------------------------------------------------------------- 7 picture
$list = Join-Path $root '.tmp/concat-list.txt'
New-Item -ItemType Directory -Force -Path (Split-Path $list) | Out-Null
($chapters | ForEach-Object { "file '$(Join-Path $root "renders/chapters/$($_.id).video.mp4")'" -replace '\\', '/' }) |
  Set-Content -Path $list -Encoding UTF8

New-Item -ItemType Directory -Force -Path 'renders/final' | Out-Null
Invoke-Step 'concat chapters' { ffmpeg -y -v error -f concat -safe 0 -i $list -c copy $silent }
Invoke-Step 'burn subtitles + mux audio' {
  ffmpeg -y -v warning -i $silent -i $mixFinal -vf 'ass=SUBTITLES_ZH.ass' `
    -c:v libx264 -crf 18 -preset medium -pix_fmt yuv420p `
    -c:a aac -b:a 320k -ar 48000 -movflags +faststart $final
}

Write-Host ''
Write-Host "done -> $final"
ffprobe -v error -select_streams v:0 -count_frames -show_entries stream=nb_read_frames,duration,width,height -of default=nw=1 $final
