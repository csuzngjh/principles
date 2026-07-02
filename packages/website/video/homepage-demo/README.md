# Homepage demo video

The HyperFrames composition is rendered separately from narration. Final narration is generated only during asset production; the website never calls TTS at playback time.

Prerequisites:

```powershell
pip install edge-tts
ffmpeg -version
```

Generate localized MP4 audio tracks and WebVTT captions from the single scene manifest:

```powershell
npm run voiceover
```

The command reads `voiceover/scenes.json`, writes ignored per-scene MP3 files under `voiceover/generated/`, and publishes final MP4/VTT assets to `packages/website/public/`. It fails if a narration segment exceeds its scene budget.
