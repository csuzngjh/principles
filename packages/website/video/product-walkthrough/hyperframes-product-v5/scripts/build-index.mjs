#!/usr/bin/env node
/**
 * Generate index.html (the film timeline) from the measured voice-over manifest.
 * Scene offsets can never drift from the narration.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(HERE, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(PROJECT, 'assets/audio/vo/timing.json'), 'utf8'));

const SOURCES = {
  ch01: 'compositions/01-question.html',
  ch02: 'compositions/02-case.html',
  ch03: 'compositions/03-pain.html',
  ch04: 'compositions/04-principle.html',
  ch05: 'compositions/05-owner.html',
  ch06: 'compositions/06-activation.html',
  ch07: 'compositions/07-behavior.html',
  ch08: 'compositions/08-vision.html',
};

let start = 0;
const scenes = manifest.chapters.map((chapter, i) => {
  const duration = Number(chapter.duration.toFixed(3));
  const scene = {
    id: chapter.id,
    src: SOURCES[chapter.id],
    start: Number(start.toFixed(3)),
    duration,
    track: i + 1,
    title: chapter.title,
  };
  start += duration;
  return scene;
});

const total = Number(start.toFixed(3));
const sceneHtml = scenes
  .map(
    (s) => `      <!-- ${s.id} · ${s.title} · ${s.start.toFixed(3)}–${(s.start + s.duration).toFixed(3)} s -->
      <div
        id="${s.id}"
        data-composition-id="${s.id}"
        data-composition-src="${s.src}"
        data-start="${s.start}"
        data-duration="${s.duration}"
        data-track-index="${s.track}"
        data-width="1920"
        data-height="1080"
      ></div>`,
  )
  .join('\n');

const html = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=1920, height=1080" />
    <title>Principles Disciple — 从一次纠正，到未来行为的改变（${total}s）</title>
    <script src="assets/vendor/gsap.min.js"></script>
    <style>
      html,
      body {
        margin: 0;
        width: 1920px;
        height: 1080px;
        overflow: hidden;
        background: #0b0f1a;
      }
    </style>
  </head>
  <body>
    <div
      id="root"
      data-composition-id="film"
      data-start="0"
      data-duration="${total}"
      data-width="1920"
      data-height="1080"
      data-fps="30"
    >
${sceneHtml}
    </div>
    <script>
      window.__timelines = window.__timelines || {};
      window.__timelines["film"] = gsap.timeline({ paused: true });
    </script>
  </body>
</html>
`;

fs.writeFileSync(path.join(PROJECT, 'index.html'), html, 'utf8');
fs.writeFileSync(
  path.join(PROJECT, 'assets/audio/vo/scene-map.json'),
  `${JSON.stringify({ total, scenes }, null, 2)}\n`,
  'utf8',
);
console.log(`index.html: ${scenes.length} scenes, ${total}s`);
for (const s of scenes) console.log(`  ${String(s.track).padStart(3, '0')} ${s.id}  ${s.start.toFixed(3)}s  +${s.duration.toFixed(3)}s  ${s.src}`);
