# Homepage demo video

The HyperFrames composition is rendered separately from narration. Final narration is generated only during asset production; the website never calls TTS at playback time.

Prerequisites:

```powershell
pip install edge-tts fonttools brotli   # narration + font subsetting
ffmpeg -version                          # render muxing / posters
node scripts/subset-fonts.mjs            # only after changing zh copy
```

## Commands (reproducible chain)

Full check gate (lint + runtime + layout + motion + contrast + craft):

```powershell
npm run check
```

Render the two silent locale masters (spec: SPEC-PD-HOMEPAGE-VIDEO-002, 30s):

```powershell
npx --yes hyperframes@0.8.200 render --variables-file variables-zh.json --strict-variables --quality looks --output renders/homepage-demo-zh-high.mp4
npx --yes hyperframes@0.8.200 render --variables-file variables-en.json --strict-variables --quality looks --output renders/homepage-demo-en-high.mp4
```

`--strict-variables` is required: without it this CLI build silently drops the file's values and renders the declared defaults.

Generate localized narration MP4s, per-cue WebVTT captions, and posters from
the single scene manifest (`voiceover/scenes.json`). Fails if any narration
clip exceeds its scene budget (minus a 0.3s tail margin) or if cue text
drifts from the narration text:

```powershell
npm run voiceover                 # publishes MP4/VTT/WebP into ../public
npm run voiceover -- --out renders/preview   # preview build, nothing touches public
```

The final `npm run voiceover` writes `homepage-demo-{zh,en}.mp4/.vtt` and
`images/homepage-demo-poster-{zh,en}.webp` (960×540, ≤100 KiB) into
`packages/website/public/`. Posters are one frame of the final film plus the
localized tagline, rendered by ffmpeg `drawtext` with the subset TTF.

Preview in the studio while iterating:

```powershell
npm run dev        # long-running preview server
```

## Where things live

- `index.html` — composition: six scenes + persistent chrome, one paused GSAP timeline.
- `variables-{zh,en}.json` — locale copy for render (`--variables-file`).
- `voiceover/scenes.json` — narration text, per-scene timing, VTT cue splits, poster tagline. Single source of truth for time.
- `scripts/generate-voiceover.mjs` — TTS → budget check → ffmpeg mux → VTT → poster.
- `scripts/subset-fonts.mjs` — regenerates the Chinese glyph subsets from the system Noto Sans SC when copy changes.
- `BRIEF.md` / `STORYBOARD.md` — what the film says and how each second looks.
- `capture/assets/` — local fonts + vendored GSAP (no network at render time).
