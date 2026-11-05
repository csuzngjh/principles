# Homepage Video Voiceover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish synchronized Chinese and English male narration, WebVTT captions, and a meditative ripple poster for the 36-second homepage video.

**Architecture:** A single bilingual scene manifest owns timings, visible facts, narration, voices, and caption text. A Node generator calls Edge TTS per scene, validates each duration, writes VTT, and uses FFmpeg to align/mux audio with the existing HyperFrames render. The homepage contract inspects final build HTML and FFprobe output so source-only success cannot pass.

**Tech Stack:** Node.js, `edge-tts` CLI, FFmpeg/FFprobe, HyperFrames 0.7.24, VitePress, Node test runner, Sharp.

---

### Task 1: Add failing published-asset contracts

**Files:**
- Modify: `packages/website/tests/homepage-contract.test.mjs`
- Modify: `packages/website/.vitepress/theme/components/HeroSection.vue`

- [ ] Add a test that runs FFprobe for both MP4 files and asserts one H.264 video stream plus one audio stream.
- [ ] Add assertions for `/homepage-demo-zh.vtt`, `/homepage-demo-en.vtt`, matching `<track kind="subtitles" ... default>`, and the exact six cue start times.
- [ ] Run `npm test --workspace=@principles/website`; expect failure because current MP4 files have no audio stream and the VTT files/tracks do not exist.
- [ ] Add bilingual `<track>` elements to `HeroSection.vue` only after observing the failure.

### Task 2: Create the single scene manifest and deterministic generator

**Files:**
- Create: `packages/website/video/homepage-demo/voiceover/scenes.json`
- Create: `packages/website/video/homepage-demo/scripts/generate-voiceover.mjs`
- Modify: `packages/website/video/homepage-demo/package.json`

- [ ] Encode the approved six time windows and exact bilingual narration from the design spec in `scenes.json`.
- [ ] Write a generator that invokes `edge-tts` once per scene with `zh-CN-YunyangNeural` or `en-US-AndrewNeural`, fails loud on empty output/unavailable voices, probes duration, and reports any segment that exceeds its scene budget.
- [ ] Generate WebVTT from the same manifest, beginning cues at `0, 4, 10, 17, 24, 31` seconds.
- [ ] Mix scene files with FFmpeg `adelay` and `amix`, normalize speech, and mux AAC audio into the language-specific MP4 without changing video timing.
- [ ] Add `npm run voiceover` and document prerequisites (`edge-tts`, FFmpeg) in `video/homepage-demo/README.md`.

### Task 3: Replace the first-frame motif and poster

**Files:**
- Modify: `packages/website/video/homepage-demo/index.html`
- Modify: `packages/website/video/homepage-demo/variables-zh.json`
- Modify: `packages/website/video/homepage-demo/variables-en.json`
- Replace: `packages/website/public/images/homepage-demo-poster-zh.webp`
- Replace: `packages/website/public/images/homepage-demo-poster-en.webp`

- [ ] Replace the three-card scene-one stack with restrained concentric rings and the localized line “纠正不会蒸发。它会沉淀。” / “Corrections do not evaporate. They settle into principles.”
- [ ] Keep scene-one narration and visible fact aligned: the repeated behavior remains visible while rings converge toward the center.
- [ ] Run `npx hyperframes lint`, `validate`, and `inspect --strict --samples 15`; expect zero issues.
- [ ] Capture the localized meditative frame at 2 seconds and encode 960×540 WebP posters below 100KiB.

### Task 4: Generate and verify final media

**Files:**
- Replace: `packages/website/public/homepage-demo-zh.mp4`
- Replace: `packages/website/public/homepage-demo-en.mp4`
- Create: `packages/website/public/homepage-demo-zh.vtt`
- Create: `packages/website/public/homepage-demo-en.vtt`

- [ ] Generate all twelve TTS segments and record measured durations.
- [ ] Render updated bilingual picture masters with HyperFrames after preview/keyframe inspection.
- [ ] Mux narration into both masters and optimize H.264/AAC output below 4MiB.
- [ ] Use FFprobe to assert 36 seconds, 1920×1080, 30fps, H.264 video and AAC audio.
- [ ] Listen at every cue boundary and confirm narration describes the visible scene before proceeding.

### Task 5: Green tests and browser acceptance

**Files:**
- Modify: `packages/website/tests/homepage-contract.test.mjs`

- [ ] Run `npm test --workspace=@principles/website`; expect all media and homepage contracts to pass.
- [ ] Run `npm run verify:merge`; expect exit code 0.
- [ ] In the browser, verify Chinese and English pages: poster fit, native caption control, default subtitle language, no autoplay, audible narration, and no console errors.
- [ ] Save accepted screenshots and probe evidence under `.codex-output/website-homepage-video-voiceover/`.
