#!/usr/bin/env node
/**
 * Build subtitles from the measured voice-over timing manifest.
 * Times come from the real synthesized audio, never from an estimate.
 *
 * Writes:
 *   SUBTITLES_ZH.srt           full-film subtitles (absolute time)
 *   SUBTITLES_ZH.ass           same cues with an explicit 1920x1080 script
 *                              resolution (SRT has none, so libass would scale
 *                              a "42" font to ~157px on a 1080p frame)
 *   renders/subs/chXX.srt      per-chapter subtitles (chapter-relative time)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(HERE, '..');
const TIMING = path.join(PROJECT, 'assets/audio/vo/timing.json');
const SUBS = path.join(PROJECT, 'renders/subs');
const manifest = JSON.parse(fs.readFileSync(TIMING, 'utf8'));
fs.mkdirSync(SUBS, { recursive: true });

const pad = (n, w = 2) => String(n).padStart(w, '0');
const stamp = (seconds) => {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const ms = Math.round((s - Math.floor(s)) * 1000);
  return `${pad(h)}:${pad(m)}:${pad(sec)},${pad(ms, 3)}`;
};
const stampAss = (seconds) => {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const cs = Math.round((s - Math.floor(s)) * 100);
  return `${h}:${pad(m)}:${pad(sec)}.${pad(cs, 2)}`;
};

// Split a long line into balanced display rows on punctuation boundaries so a
// 1080p frame never carries a mid-word break or more than three stacked rows.
// A break may never fall inside a Latin word ("Examiner" / "Owner").
function wrap(text, max = 26) {
  if (text.length <= max) return [text];
  const marks = new Set(['，', '：', '；', '、', '。', '？', '！']);
  const isLetter = (c) => /[A-Za-z0-9]/.test(c);
  const safe = (p) => p > 3 && p < text.length - 3 && !(isLetter(text[p - 1]) && isLetter(text[p]));
  const near = (target, pool) =>
    pool.reduce((best, p) => {
      if (!safe(p)) return best;
      return best < 0 || Math.abs(p - target) < Math.abs(best - target) ? p : best;
    }, -1);

  const spots = [];
  for (let i = 0; i < text.length; i += 1) if (marks.has(text[i])) spots.push(i + 1);

  const two = near(text.length / 2, spots);
  if (two > 0 && text.length <= 52) return [text.slice(0, two), text.slice(two)];

  const c1 = near(text.length / 3, spots);
  const c2 = near((text.length * 2) / 3, spots);
  if (c1 > 0 && c2 > c1) return [text.slice(0, c1), text.slice(c1, c2), text.slice(c2)];

  // No punctuation at all: take the safest break nearest the middle.
  const any = [];
  for (let p = 1; p < text.length; p += 1) any.push(p);
  const mid = near(text.length / 2, any);
  if (mid > 0) return [text.slice(0, mid), text.slice(mid)];
  return [text.slice(0, max), text.slice(max)];
}

const full = [];
const fullCues = [];
let counter = 0;
for (const chapter of manifest.chapters) {
  const cues = [];
  const lines = chapter.lines;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    // 与画面中心文字重复的行只配音、不烧字幕（VOICEOVER_ZH.json 里 caption:false）
    if (line.caption === false) continue;
    const next = lines.slice(i + 1).find((candidate) => candidate.caption !== false);
    const start = line.start;
    const end = next ? Math.min(next.start - 0.08, line.end + 0.55) : line.end + 0.45;
    const rows = wrap(line.text);
    cues.push({ start, end, text: rows.join('\n') });
  }

  const chapterSrt = [];
  cues.forEach((cue, index) => {
    chapterSrt.push(`${index + 1}`, `${stamp(cue.start)} --> ${stamp(cue.end)}`, cue.text, '');
    counter += 1;
    full.push(`${counter}`, `${stamp(chapter.start + cue.start)} --> ${stamp(chapter.start + cue.end)}`, cue.text, '');
    fullCues.push({ start: chapter.start + cue.start, end: chapter.start + cue.end, text: cue.text });
  });
  fs.writeFileSync(path.join(SUBS, `${chapter.id}.srt`), `${chapterSrt.join('\r\n').trimEnd()}\r\n`, 'utf8');
}

fs.writeFileSync(path.join(PROJECT, 'SUBTITLES_ZH.srt'), `${full.join('\r\n').trimEnd()}\r\n`, 'utf8');

// ASS carry an explicit script resolution, which is what makes the burned-in
// size deterministic on a 1080p frame (SRT has no PlayRes and libass then
// assumes 384x288).
const assHeader = [
  '[Script Info]',
  'ScriptType: v4.00+',
  'PlayResX: 1920',
  'PlayResY: 1080',
  'WrapStyle: 2',
  'ScaledBorderAndShadow: yes',
  '',
  '[V4+ Styles]',
  'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
  'Style: ZH,Noto Sans SC,54,&H00FFFFFF,&H00FFFFFF,&H00101827,&H800B0F1A,0,0,0,0,100,100,0,0,1,2.2,0,2,120,120,54,1',
  '',
  '[Events]',
  'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
];
const assEvents = fullCues.map(
  (cue) => `Dialogue: 0,${stampAss(cue.start)},${stampAss(cue.end)},ZH,,0,0,0,,${cue.text.replace(/\n/g, '\\N')}`,
);
fs.writeFileSync(
  path.join(PROJECT, 'SUBTITLES_ZH.ass'),
  `${[...assHeader, ...assEvents].join('\r\n')}\r\n`,
  'utf8',
);

console.log(`subtitles: ${counter} cues, ${manifest.chapters.length} chapters, ${manifest.total.toFixed(2)}s`);
