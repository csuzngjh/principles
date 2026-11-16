# V5.2 prototype: render -> mix -> burn subtitles.
# Run from anywhere: powershell -File scripts/render-prototype.ps1 [-SkipRender]
param([switch]$SkipRender)
$ErrorActionPreference = 'Continue'
$root = Split-Path $PSScriptRoot -Parent
$bgm = Join-Path $root '..\assets\audio\bgm\bgm-bed-340s.wav'
Push-Location $root
try {
  New-Item -ItemType Directory -Force -Path 'renders\audio','renders\final' | Out-Null
  $silent = 'renders\prototype-silent.mp4'
  $mixPre = 'renders\audio\mix-pre.wav'
  $mixFinal = 'renders\audio\mix-final.wav'
  $out = 'renders\final\pd-v5.2-prototype-zh.mp4'
  $total = 61.2049
  $fadeOutAt = [math]::Round($total - 2.0, 2)

  if (-not $SkipRender) {
    Write-Host '== render 0-61.205s (no audio)'
    npx --yes hyperframes render $root --start 0 --end 61.205 -o (Join-Path $root $silent)
    if ($LASTEXITCODE -ne 0) { throw "render failed ($LASTEXITCODE)" }
  }

  Write-Host '== mix vo + bgm'
  $mix = (
    "[0:a]atrim=0:$total,asetpts=N/SR/TB,volume=0.30,afade=t=out:st=${fadeOutAt}:d=2.0[bg];" +
    "[1:a]volume=-0.5dB,highpass=f=85,acompressor=threshold=-20dB:ratio=2.2:attack=6:release=180," +
    "pan=stereo|c0=c0|c1=c0,asplit=2[vo][vk];" +
    "[bg][vk]sidechaincompress=threshold=0.05:ratio=8:attack=5:release=400[duck];" +
    "[vo][duck]amix=inputs=2:normalize=0[out]"
  )
  ffmpeg -y -v warning -i $bgm -i 'audio\vo-full.wav' -filter_complex $mix `
    -map '[out]' -ar 48000 -ac 2 -c:a pcm_s24le $mixPre
  if ($LASTEXITCODE -ne 0) { throw "mix failed ($LASTEXITCODE)" }

  Write-Host '== loudnorm pass 1'
  $probeLog = (ffmpeg -hide_banner -nostats -i $mixPre `
      -af 'loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json' -f null NUL 2>&1) -join "`n"
  $json = [regex]::Match($probeLog, '(?s)\{.*\}').Value | ConvertFrom-Json
  Write-Host ("   measured I={0} TP={1} LRA={2}" -f $json.input_i, $json.input_tp, $json.input_lra)

  Write-Host '== loudnorm pass 2'
  $norm = "loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=$($json.input_i):measured_TP=$($json.input_tp)" +
  ":measured_LRA=$($json.input_lra):measured_thresh=$($json.input_thresh):offset=$($json.target_offset):linear=false:print_format=summary"
  ffmpeg -y -hide_banner -nostats -i $mixPre -af $norm -ar 48000 -ac 2 -c:a pcm_s24le $mixFinal
  if ($LASTEXITCODE -ne 0) { throw "loudnorm failed ($LASTEXITCODE)" }

  Write-Host '== burn subtitles + mux audio'
  ffmpeg -y -v warning -i $silent -i $mixFinal -vf 'ass=SUBTITLES_ZH.ass' `
    -c:v libx264 -crf 18 -preset medium -pix_fmt yuv420p `
    -c:a aac -b:a 320k -ar 48000 -movflags +faststart $out
  if ($LASTEXITCODE -ne 0) { throw "mux failed ($LASTEXITCODE)" }

  Write-Host ''
  Write-Host "done -> $out"
  ffprobe -v error -show_entries format=duration,size -of default=nw=1 $out
}
finally { Pop-Location }
