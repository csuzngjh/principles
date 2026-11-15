"""V5.2 prototype voice-over: CosyVoice2 renders -> sentence-level timing.

Source of truth: prototype/vo.json (four frozen narration paragraphs).
Sentences are split at every "。" so subtitle timing comes from the REAL
synthesised audio, never from a text-length estimate (same rule as V5.1).

Outputs (prototype/audio/):
  s1.wav .. s4.wav     one audio bed per shot (48 kHz PCM16)
  vo-full.wav          concatenated bed
  timing.json          shot + sentence start/duration in seconds
  SUBTITLES_ZH.srt/ass shot subtitles, split at the measured sentence bounds

Run with D:\\pd-labs\\cosyvoice\\.venv\\Scripts\\python.exe
"""
import json
import os
import re
import subprocess

import numpy as np
import soundfile as sf

PROJECT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
PROTO = os.path.join(PROJECT, "prototype")
COSY = r"D:\pd-labs\cosyvoice"
RAW = os.path.join(PROJECT, ".tmp", "proto-vo-raw")
OUT = os.path.join(PROTO, "audio")
REF = os.path.join(PROJECT, "assets", "audio", "ref", "02-serena-female-l0.wav")
REF_TEXT = "你让 Agent 改一处配置。它改了，还顺手动了别的地方。"
SR = 48000
SEED = 20261114

os.makedirs(RAW, exist_ok=True)
os.makedirs(OUT, exist_ok=True)

spec = json.load(open(os.path.join(PROTO, "vo.json"), encoding="utf-8"))
lead_in = int(round(float(spec["meta"].get("leadIn", 0.30)) * SR))

# ---- sentence split (verbatim text, only cut after the full stop) -----------
sentences = []  # (shot_index, text, pause_after)
for si, shot in enumerate(spec["shots"]):
    parts = [p for p in re.split(r"(?<=。)", shot["text"].strip()) if p.strip()]
    for j, text in enumerate(parts):
        last = j == len(parts) - 1
        pause = float(shot.get("pauseAfter", 0.4)) if last else 0.18
        sentences.append((si, text.strip(), pause))

missing = [k for k, (_, _, _) in enumerate(sentences)
           if not (os.path.exists(os.path.join(RAW, "s%02d.wav" % k))
                   and os.path.getsize(os.path.join(RAW, "s%02d.wav" % k)) > 4000)]

if missing:
    import sys
    sys.path.insert(0, COSY)
    sys.path.insert(0, os.path.join(COSY, "third_party", "Matcha-TTS"))
    import torch
    import torchaudio
    from cosyvoice.cli.cosyvoice import CosyVoice2

    print("loading CosyVoice2, %d/%d sentences to render" % (len(missing), len(sentences)), flush=True)
    model = CosyVoice2(os.path.join(COSY, "pretrained_models", "CosyVoice2-0.5B"),
                       load_jit=False, load_trt=False, fp16=False)
    for k in missing:
        _, text, _ = sentences[k]
        torch.manual_seed(SEED + k)
        chunks = []
        for out in model.inference_zero_shot(text, REF_TEXT, REF, stream=False, speed=1.0):
            chunks.append(out["tts_speech"])
        wav = chunks[0] if len(chunks) == 1 else torch.cat(chunks, dim=1)
        torchaudio.save(os.path.join(RAW, "s%02d.wav" % k), wav, model.sample_rate)
        print("  [%02d] %s" % (k, text[:20]), flush=True)


def load_trimmed(path):
    """Cut the model's own head/tail padding; keep 40 ms on each side."""
    x, sr = sf.read(path, dtype="float64", always_2d=True)
    x = x[:, 0]
    peak = float(np.max(np.abs(x))) or 1.0
    idx = np.where(np.abs(x) > max(0.0035, peak * 0.02))[0]
    if idx.size == 0:
        raise RuntimeError("silent render: " + path)
    pad = int(round(0.04 * sr))
    a = max(0, int(idx[0]) - pad)
    b = min(len(x), int(idx[-1]) + 1 + pad)
    y = x[a:b]
    if sr != SR:
        n = int(round(len(y) * SR / sr))
        y = np.interp(np.linspace(0, len(y) - 1, n), np.arange(len(y)), y)
    return y


clips = [load_trimmed(os.path.join(RAW, "s%02d.wav" % k)) for k in range(len(sentences))]

rms = [20 * np.log10(np.sqrt(np.mean(c ** 2)) + 1e-9) for c in clips]
target = float(np.median(rms))
for i, c in enumerate(clips):
    db = max(-4.0, min(4.0, target - rms[i]))
    if abs(db) > 0.25:
        clips[i] = c * (10 ** (db / 20))

# ---- lay out sentences, group them into the four shots ---------------------
cursor = lead_in
placed = []
for k, (si, text, pause) in enumerate(sentences):
    clip = clips[k]
    placed.append({
        "shot": si,
        "text": text,
        "start": round(cursor / SR, 4),
        "end": round((cursor + len(clip)) / SR, 4),
        "duration": round(len(clip) / SR, 4),
    })
    cursor += len(clip)
    cursor += int(round(pause * SR))

total = cursor
beds = []
shot_meta = []
for si, shot in enumerate(spec["shots"]):
    rows = [p for p in placed if p["shot"] == si]
    # shot 1 carries the lead-in; every later shot starts where the previous bed ended
    start = 0 if si == 0 else int(round(rows[0]["start"] * SR))
    stop = int(round(rows[-1]["end"] * SR)) + int(round(float(shot.get("pauseAfter", 0.4)) * SR))
    bed = np.zeros(stop - start, dtype=np.float64)
    for p, clip in zip(placed, clips):
        if p["shot"] != si:
            continue
        a = int(round(p["start"] * SR)) - start
        bed[a:a + len(clip)] += clip
    beds.append(bed)
    shot_meta.append({
        "id": shot["id"],
        "title": shot["title"],
        "start": round(start / SR, 4),
        "duration": round(len(bed) / SR, 4),
        "lines": rows,
    })

full = np.concatenate(beds)
assert len(full) == int(round(shot_meta[-1]["start"] * SR)) + len(beds[-1])


def integrated_lufs(samples):
    tmp = os.path.join(PROJECT, ".tmp", "_proto_loudness_probe.wav")
    sf.write(tmp, samples, SR, subtype="PCM_16")
    probe = subprocess.run(["ffmpeg", "-nostdin", "-hide_banner", "-i", tmp, "-af",
                            "loudnorm=I=-22:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-"],
                           capture_output=True, text=True, errors="replace")
    txt = probe.stderr
    return float(json.loads(txt[txt.rfind("{"):txt.rfind("}") + 1])["input_i"])


# One global gain to the accepted V5.1 operating point (-22 LUFS dry VO), so the
# prototype reuses the film's mix chain unchanged.
lufs = integrated_lufs(full)
gain_db = -22.0 - lufs
if abs(gain_db) > 0.1:
    g = 10 ** (gain_db / 20)
    full = full * g
    beds = [b * g for b in beds]
print("dry VO %.2f LUFS -> gain %+.2f dB" % (lufs, gain_db))

for meta, bed in zip(shot_meta, beds):
    sf.write(os.path.join(OUT, "%s.wav" % meta["id"]), bed, SR, subtype="PCM_16")
sf.write(os.path.join(OUT, "vo-full.wav"), full, SR, subtype="PCM_16")

manifest = {
    "engine": "CosyVoice2-0.5B zero-shot",
    "reference": "assets/audio/ref/02-serena-female-l0.wav (original, no re-clone)",
    "seed": SEED,
    "sampleRate": SR,
    "total": round(len(full) / SR, 4),
    "shots": shot_meta,
}
json.dump(manifest, open(os.path.join(OUT, "timing.json"), "w", encoding="utf-8"),
          ensure_ascii=False, indent=2)

# ---- single timing source for every composition ---------------------------
# The compositions read window.PROTO_TIMING and express every cue relative to a
# sentence start, so re-timing the film (A/B/C) means re-running this script,
# not editing four HTML files.
timeline_js = {
    "total": manifest["total"],
    "shots": {
        m["id"]: {
            "start": m["start"],
            "duration": m["duration"],
            "lines": [[l["start"], l["end"]] for l in m["lines"]],
        }
        for m in shot_meta
    },
}
open(os.path.join(PROTO, "timeline.js"), "w", encoding="utf-8").write(
    "/* generated by scripts/build-prototype-vo.py — do not hand-edit */\n"
    "window.PROTO_TIMING = "
    + json.dumps(timeline_js, ensure_ascii=False, indent=2)
    + ";\n")


# ---- subtitles ------------------------------------------------------------
BREAKS = "、，；："


def wrap(text, limit=26):
    if len(text) <= limit:
        return text
    best, best_d = -1, 10 ** 6
    for i, ch in enumerate(text):
        if ch in BREAKS:
            d = abs(i - len(text) / 2)
            if d < best_d:
                best, best_d = i, d
    if best < 0:
        return text
    return text[:best + 1] + "\\N" + text[best + 1:]


def tc(sec, sep, frac=3):
    """ASS wants centiseconds; SRT wants milliseconds."""
    h = int(sec // 3600)
    m = int(sec % 3600 // 60)
    s = sec % 60
    if frac == 2:
        return ("%02d:%02d:%05.2f" % (h, m, s)).replace(".", sep)
    return ("%02d:%02d:%06.3f" % (h, m, s)).replace(".", sep)


ass = [
    "[Script Info]", "ScriptType: v4.00+", "PlayResX: 1920", "PlayResY: 1080",
    "WrapStyle: 2", "ScaledBorderAndShadow: yes", "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, "
    "Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
    "Alignment, MarginL, MarginR, MarginV, Encoding",
    "Style: ZH,Noto Sans SC,54,&H00FFFFFF,&H00FFFFFF,&H00101827,&H800B0F1A,0,0,0,0,100,100,0,0,1,2.2,0,2,120,120,54,1",
    "", "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
]
srt = []
for n, p in enumerate(placed, 1):
    body = wrap(p["text"])
    ass.append("Dialogue: 0,%s,%s,ZH,,0,0,0,,%s" % (tc(p["start"], ".", 2), tc(p["end"], ".", 2), body))
    srt.append("%d\n%s --> %s\n%s\n" % (n, tc(p["start"], ","), tc(p["end"], ","), body.replace("\\N", "\n")))

open(os.path.join(PROTO, "SUBTITLES_ZH.ass"), "w", encoding="utf-8").write("\n".join(ass) + "\n")
open(os.path.join(PROTO, "SUBTITLES_ZH.srt"), "w", encoding="utf-8").write("\n".join(srt))

print("shots: " + "  ".join("%s %.2fs" % (m["id"], m["duration"]) for m in shot_meta))
print("total %.3fs  (sentences %d)" % (len(full) / SR, len(placed)))
