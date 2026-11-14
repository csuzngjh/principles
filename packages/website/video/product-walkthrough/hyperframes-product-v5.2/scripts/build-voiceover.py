"""V5 voice-over build: CosyVoice2 renders -> trimmed, levelled, placed chapter beds.

Source of truth: VOICEOVER_ZH.json (frozen narration, 62 lines).
Timeline: lead-in + per-line natural speech + per-line pauseAfter, all in integer
samples at 48 kHz so the audio bed is sample-exact against the rendered picture.

Renders are cached in .tmp/vo-raw (deterministic seed); rerunning only re-places.
Run with D:\\pd-labs\\cosyvoice\\.venv\\Scripts\\python.exe
"""
import json
import os
import sys

import numpy as np
import soundfile as sf

PROJECT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
COSY = r"D:\pd-labs\cosyvoice"
RAW = os.path.join(PROJECT, ".tmp", "vo-raw")
OUT = os.path.join(PROJECT, "assets", "audio", "vo")
REF = os.path.join(PROJECT, "..", "hyperframes-full", ".tmp", "qwen-tts", "work-local",
                   "02-serena-female-l0.wav")
REF_TEXT = "你让 Agent 改一处配置。它改了，还顺手动了别的地方。"
SR = 48000
SEED = 20261114

os.makedirs(RAW, exist_ok=True)
os.makedirs(OUT, exist_ok=True)

spec = json.load(open(os.path.join(PROJECT, "VOICEOVER_ZH.json"), encoding="utf-8"))
lead_in = int(round(float(spec["meta"].get("leadIn", 0.35)) * SR))

flat = [(c["id"], i, l) for c in spec["chapters"] for i, l in enumerate(c["lines"])]
missing = [k for k in range(len(flat))
           if not (os.path.exists(os.path.join(RAW, "l%02d.wav" % k))
                   and os.path.getsize(os.path.join(RAW, "l%02d.wav" % k)) > 4000)]

if missing:
    sys.path.insert(0, COSY)
    sys.path.insert(0, os.path.join(COSY, "third_party", "Matcha-TTS"))
    import torch
    import torchaudio
    from cosyvoice.cli.cosyvoice import CosyVoice2

    print("loading CosyVoice2, %d lines to render" % len(missing), flush=True)
    model = CosyVoice2(os.path.join(COSY, "pretrained_models", "CosyVoice2-0.5B"),
                       load_jit=False, load_trt=False, fp16=False)
    for k in missing:
        _, _, line = flat[k]
        torch.manual_seed(SEED + k)
        chunks = []
        for out in model.inference_zero_shot(line["text"], REF_TEXT, REF, stream=False, speed=1.0):
            chunks.append(out["tts_speech"])
        wav = chunks[0] if len(chunks) == 1 else torch.cat(chunks, dim=1)
        torchaudio.save(os.path.join(RAW, "l%02d.wav" % k), wav, model.sample_rate)
        print("  [%02d] %s" % (k, line["text"][:18]), flush=True)


def load_trimmed(path):
    """Cut the model's own head/tail padding; keep 60 ms on each side."""
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


clips = [load_trimmed(os.path.join(RAW, "l%02d.wav" % k)) for k in range(len(flat))]

# gentle level match so one quiet sentence does not fall out of the bed
rms = [20 * np.log10(np.sqrt(np.mean(c ** 2)) + 1e-9) for c in clips]
target = float(np.median(rms))
for i, c in enumerate(clips):
    db = max(-4.0, min(4.0, target - rms[i]))
    if abs(db) > 0.25:
        clips[i] = c * (10 ** (db / 20))

new_chapters = []
total = 0
k = 0
for chapter in spec["chapters"]:
    cursor = lead_in
    lines = []
    for line in chapter["lines"]:
        clip = clips[k]
        k += 1
        if cursor + len(clip) > 2 ** 31:
            raise RuntimeError("timeline overflow")
        lines.append({
            "index": len(lines),
            "text": line["text"],
            "caption": line.get("caption"),
            "start": round(cursor / SR, 4),
            "end": round((cursor + len(clip)) / SR, 4),
            "duration": round(len(clip) / SR, 4),
        })
        cursor += len(clip)
        cursor += int(round(float(line.get("pauseAfter", 0.30)) * SR))
    duration = cursor
    new_chapters.append({"id": chapter["id"], "title": chapter["title"], "duration": duration, "lines": lines})
    total += duration

# second pass: place the clips at their sample offsets
beds = []
k = 0
cursor_abs = 0
for chapter, meta in zip(spec["chapters"], new_chapters):
    bed = np.zeros(meta["duration"], dtype=np.float64)
    for line in meta["lines"]:
        clip = clips[k]
        k += 1
        a = int(round(line["start"] * SR))
        bed[a:a + len(clip)] += clip
    beds.append(bed)

full = np.concatenate(beds)

# One global gain so the bed sits at the same operating point as the accepted V4
# build (-22 LUFS dry VO); a per-chapter normalisation would pump the compressor.
def integrated_lufs(samples):
    import subprocess
    tmp = os.path.join(PROJECT, ".tmp", "_loudness_probe.wav")
    sf.write(tmp, samples, SR, subtype="PCM_16")
    probe = subprocess.run(["ffmpeg", "-nostdin", "-hide_banner", "-i", tmp, "-af",
                            "loudnorm=I=-22:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-"],
                           capture_output=True, text=True, errors="replace")
    txt = probe.stderr
    return float(json.loads(txt[txt.rfind("{"):txt.rfind("}") + 1])["input_i"])


lufs = integrated_lufs(full)
gain_db = -22.0 - lufs
if abs(gain_db) > 0.1:
    g = 10 ** (gain_db / 20)
    full *= g
    beds = [b * g for b in beds]
print("dry VO %.2f LUFS -> gain %+.2f dB" % (lufs, gain_db))

for chapter, bed in zip(spec["chapters"], beds):
    sf.write(os.path.join(OUT, "%s.wav" % chapter["id"]), bed, SR, subtype="PCM_16")

sf.write(os.path.join(PROJECT, "renders", "audio", "vo-full.wav"), full, SR, subtype="PCM_16")

manifest = {
    "voice": "CosyVoice2-0.5B zero-shot",
    "reference": "qwen3-tts 02-serena-female-l0.wav (renders/audition/cosyvoice2/ref)",
    "seed": SEED,
    "sampleRate": SR,
    "total": round(len(full) / SR, 4),
    "lineCount": len(flat),
    "chapters": [],
}
start = 0
for chapter, meta in zip(spec["chapters"], new_chapters):
    manifest["chapters"].append({
        "id": meta["id"],
        "title": meta["title"],
        "start": round(start / SR, 4),
        "duration": round(meta["duration"] / SR, 4),
        "lines": meta["lines"],
    })
    start += meta["duration"]
json.dump(manifest, open(os.path.join(OUT, "timing.json"), "w", encoding="utf-8"),
          ensure_ascii=False, indent=2)

spoken = sum(l["duration"] for c in manifest["chapters"] for l in c["lines"])
print("chapters: " + "  ".join("%s %.1fs" % (c["id"], c["duration"]) for c in manifest["chapters"]))
print("total %.1fs (%.2f min), spoken %.1fs, silence %.1fs"
      % (manifest["total"], manifest["total"] / 60, spoken, manifest["total"] - spoken))
