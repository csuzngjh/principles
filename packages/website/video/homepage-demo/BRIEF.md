# BRIEF — PD Homepage Demo (SPEC-PD-HOMEPAGE-VIDEO-002)

## What this film is

A 30-second, bilingual (zh/en) homepage animation for Principles Disciple.
One concrete story carries the whole film: the user asks for a one-button fix,
the Agent rewrites the page, the repeated correction "ask before expanding
scope" is grouped by PD into a principle proposal, the Owner approves it, and
on the next similar task the Agent explains the impact first and waits.

It is an explicitly labeled mechanism illustration ("机制示意 / Illustrative
example" stays on screen), not a product recording and not a claimed outcome.

## Audience and success

First-time visitors who already use AI agents. Success: within 5 seconds they
recognize a familiar annoyance; after one watch they can retell what PD does,
what they do, how the principle is used next time, and that it can be
withdrawn. The film never promises the agent will never repeat a mistake.

## Fixed story (SPEC §4)

| Seg | Time | Beat | Headline (zh / en) |
| --- | --- | --- | --- |
| S1 | 0–4s | request vs oversized rewrite | 只修按钮，却改了整页？ / A button fix became a page rewrite? |
| S2 | 4–8s | repeated correction, grouped | 你反复提醒： / You keep saying: |
| S3 | 8–13s | PD drafts one principle | PD 整理为原则建议 / PD drafts a principle |
| S4 | 13–17s | Owner reviews and approves | 你审查，你决定。 / You review. You decide. |
| S5 | 17–25s | next task: explain, then wait | 下一次，先说明再行动 / Next time: explain before acting |
| S6 | 25–30s | closing card, held to the end | 少一点重复纠正。决定权仍在你。 / Fewer repeated corrections. You stay in control. |

## Design rules that bind this remake

- Designed for the website player (≈450px desktop, ≈350px mobile): key text
  ≥88px on the 1920×1080 canvas, main titles ≥104px; explanation-critical
  copy never in tiny labels (floor: 28px, all text ≥30px).
- ~5% safe margins on all sides; bottom 18% kept clear of key content for
  native subtitles/player chrome.
- Warm amber marks overreach; quiet blue marks explain-first behavior; color
  is never the only cue (✓/✗ marks + borders carry the same meaning).
- No fixed "3×" threshold anywhere: corrections group as related, uncounted.
- Object continuity: correction bubbles → grouped stack → principle card →
  approved badge → approved chip on the next task.
- First frame carries real information (the request bubble is on screen at
  t=0); the closing card is fully landed by ~27s and holds intact to 30s
  (no fade-out).
- Deterministic: single paused GSAP timeline registered on
  `window.__timelines.main`; no clocks, randomness, or network at render
  time (GSAP is vendored locally at `capture/assets/gsap.min.js`).

## Pipeline

```
variables-{zh,en}.json ──┐
                        ├─ hyperframes render --variables-file …  → renders/homepage-demo-{locale}-high.mp4 (silent master)
index.html ─────────────┘
voiceover/scenes.json ── edge-tts per scene → ffprobe budget check → ffmpeg mix
                        → final MP4 + per-cue VTT + poster (scripts/generate-voiceover.mjs)
                        → packages/website/public (final run only; --out for preview builds)
```

Voiceover/subtitle timing facts live only in `voiceover/scenes.json`.
