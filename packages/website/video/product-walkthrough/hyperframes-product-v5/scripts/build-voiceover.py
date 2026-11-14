"""V5 voice-over build: CosyVoice2 renders -> trimmed, levelled, placed chapter beds.

Source of truth: VOICEOVER_ZH.json (frozen narration, 62 lines).
Timeline: lead-in + per-line natural speech + per-line pauseAfter, all in integer
samples at 48 kHz so the audio bed is sample-exact against the rendered picture.

Renders are cached in .tmp/vo-raw (deterministic seed); rerunning only re-places.

No developer directory is baked in. The CosyVoice checkout and the zero-shot
reference clip come from arguments or environment variables:

    --cosyvoice-root   / PD_VIDEO_COSYVOICE_ROOT
    --reference-audio  / PD_VIDEO_REFERENCE_AUDIO
    --project          (default: the parent of this script's directory)

Dependency names, versions, acquisition, expected paths and SHA-256 are listed
in ../ASSET_MANIFEST.md.

`--check` validates the environment without writing anything and without
synthesizing: it is what render-all.ps1 calls during preflight.
"""
import argparse
import json
import os
import sys

DEFAULT_REFERENCE = os.path.join("assets", "audio", "ref", "02-serena-female-l0.wav")
REF_TEXT = "你让 Agent 改一处配置。它改了，还顺手动了别的地方。"
SR = 48000
SEED = 20261114
MODEL_REL = os.path.join("pretrained_models", "CosyVoice2-0.5B")
MODEL_FILES = ("config.json", "llm.pt", "flow.pt", "hift.pt")


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description="Render the V5 Chinese voice-over beds and timing.json.",
    )
    parser.add_argument("--project", default=None,
                        help="V5 project root (default: parent of scripts/).")
    parser.add_argument("--cosyvoice-root", default=os.environ.get("PD_VIDEO_COSYVOICE_ROOT"),
                        help="CosyVoice repository root (or PD_VIDEO_COSYVOICE_ROOT).")
    parser.add_argument("--reference-audio", default=os.environ.get("PD_VIDEO_REFERENCE_AUDIO"),
                        help="Zero-shot reference clip (or PD_VIDEO_REFERENCE_AUDIO).")
    parser.add_argument("--reference-text", default=REF_TEXT,
                        help="Transcript of the reference clip.")
    parser.add_argument("--check", action="store_true",
                        help="Validate Python packages, model and reference audio; write nothing.")
    return parser.parse_args(argv)


def resolve_paths(args):
    if args.project:
        project = os.path.abspath(args.project)
    else:
        project = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
    cosy = os.path.abspath(args.cosyvoice_root) if args.cosyvoice_root else None
    reference = os.path.abspath(args.reference_audio) if args.reference_audio else os.path.join(project, DEFAULT_REFERENCE)
    return project, cosy, os.path.abspath(reference)


def load_spec(project):
    with open(os.path.join(project, "VOICEOVER_ZH.json"), encoding="utf-8") as handle:
        return json.load(handle)


def flatten(spec):
    return [(chapter["id"], index, line)
            for chapter in spec["chapters"]
            for index, line in enumerate(chapter["lines"])]


def cached_line_count(raw_dir, total):
    return sum(1 for k in range(total)
               if os.path.exists(os.path.join(raw_dir, "l%02d.wav" % k))
               and os.path.getsize(os.path.join(raw_dir, "l%02d.wav" % k)) > 4000)


def missing_lines(raw_dir, total):
    return [k for k in range(total)
            if not (os.path.exists(os.path.join(raw_dir, "l%02d.wav" % k))
                    and os.path.getsize(os.path.join(raw_dir, "l%02d.wav" % k)) > 4000)]


def check_environment(args):
    """Read-only preflight: no directory is created, no audio is synthesized."""
    project, cosy, reference = resolve_paths(args)
    problems = []
    print("check: project=%s" % project)

    try:
        import numpy
        import soundfile
        print("check: numpy=%s soundfile=%s" % (numpy.__version__, soundfile.__version__))
    except Exception as exc:  # noqa: BLE001 - report the real import error
        problems.append("python packages missing (numpy/soundfile): %s" % exc)

    spec = None
    try:
        spec = load_spec(project)
        total = len(flatten(spec))
        print("check: narration=%d lines" % total)
    except Exception as exc:  # noqa: BLE001
        problems.append("narration spec unreadable: %s" % exc)
        total = 0

    raw_dir = os.path.join(project, ".tmp", "vo-raw")
    missing = missing_lines(raw_dir, total) if total else []
    print("check: cached=%d/%d" % (cached_line_count(raw_dir, total), total))

    if missing:
        if not cosy:
            problems.append("--cosyvoice-root / PD_VIDEO_COSYVOICE_ROOT is required (%d lines need synthesis)" % len(missing))
        else:
            model_dir = os.path.join(cosy, MODEL_REL)
            if not os.path.isdir(cosy):
                problems.append("CosyVoice root not found: %s" % cosy)
            elif not os.path.isdir(model_dir):
                problems.append("model directory not found: %s" % model_dir)
            else:
                absent = [name for name in MODEL_FILES if not os.path.isfile(os.path.join(model_dir, name))]
                if absent:
                    problems.append("model files missing in %s: %s" % (model_dir, ", ".join(absent)))
            if not (os.path.isfile(reference) and os.path.getsize(reference) > 4000):
                problems.append("reference audio missing: %s" % reference)
            try:
                sys.path.insert(0, cosy)
                sys.path.insert(0, os.path.join(cosy, "third_party", "Matcha-TTS"))
                import torch
                import torchaudio
                from cosyvoice.cli.cosyvoice import CosyVoice2  # noqa: F401 - import is the check
                print("check: torch=%s torchaudio=%s cosyvoice=importable" % (torch.__version__, torchaudio.__version__))
            except Exception as exc:  # noqa: BLE001
                problems.append("CosyVoice import failed: %s" % exc)
    else:
        print("check: synthesis cache complete; torch/CosyVoice imports not required")

    print("check: reference=%s" % reference)
    if problems:
        for problem in problems:
            print("check: MISSING %s" % problem)
        print("check: result=FAIL")
        return 2
    print("check: result=OK")
    return 0


def build(args):
    import numpy as np
    import soundfile as sf

    project, cosy, reference = resolve_paths(args)
    raw = os.path.join(project, ".tmp", "vo-raw")
    out = os.path.join(project, "assets", "audio", "vo")
    render_audio = os.path.join(project, "renders", "audio")

    os.makedirs(raw, exist_ok=True)
    os.makedirs(out, exist_ok=True)
    os.makedirs(render_audio, exist_ok=True)

    spec = load_spec(project)
    lead_in = int(round(float(spec["meta"].get("leadIn", 0.35)) * SR))
    flat = flatten(spec)

    missing = missing_lines(raw, len(flat))
    if missing:
        if not cosy:
            raise SystemExit("missing --cosyvoice-root / PD_VIDEO_COSYVOICE_ROOT: %d lines need synthesis" % len(missing))
        sys.path.insert(0, cosy)
        sys.path.insert(0, os.path.join(cosy, "third_party", "Matcha-TTS"))
        import torch
        import torchaudio
        from cosyvoice.cli.cosyvoice import CosyVoice2

        print("loading CosyVoice2, %d lines to render" % len(missing), flush=True)
        model = CosyVoice2(os.path.join(cosy, MODEL_REL),
                           load_jit=False, load_trt=False, fp16=False)
        for k in missing:
            _, _, line = flat[k]
            torch.manual_seed(SEED + k)
            chunks = []
            for item in model.inference_zero_shot(line["text"], args.reference_text, reference, stream=False, speed=1.0):
                chunks.append(item["tts_speech"])
            wav = chunks[0] if len(chunks) == 1 else torch.cat(chunks, dim=1)
            torchaudio.save(os.path.join(raw, "l%02d.wav" % k), wav, model.sample_rate)
            print("  [%02d] %s" % (k, line["text"][:18]), flush=True)

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

    clips = [load_trimmed(os.path.join(raw, "l%02d.wav" % k)) for k in range(len(flat))]

    # gentle level match so one quiet sentence does not fall out of the bed
    rms = [20 * np.log10(np.sqrt(np.mean(c ** 2)) + 1e-9) for c in clips]
    target = float(np.median(rms))
    for i, c in enumerate(clips):
        db = max(-4.0, min(4.0, target - rms[i]))
        if abs(db) > 0.25:
            clips[i] = c * (10 ** (db / 20))

    new_chapters = []
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

    # second pass: place the clips at their sample offsets
    beds = []
    k = 0
    for meta in new_chapters:
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
        tmp = os.path.join(project, ".tmp", "_loudness_probe.wav")
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
        sf.write(os.path.join(out, "%s.wav" % chapter["id"]), bed, SR, subtype="PCM_16")

    sf.write(os.path.join(render_audio, "vo-full.wav"), full, SR, subtype="PCM_16")

    manifest = {
        "voice": "CosyVoice2-0.5B zero-shot",
        "reference": os.path.basename(reference),
        "seed": SEED,
        "sampleRate": SR,
        "total": round(len(full) / SR, 4),
        "lineCount": len(flat),
        "chapters": [],
    }
    start = 0
    for meta in new_chapters:
        manifest["chapters"].append({
            "id": meta["id"],
            "title": meta["title"],
            "start": round(start / SR, 4),
            "duration": round(meta["duration"] / SR, 4),
            "lines": meta["lines"],
        })
        start += meta["duration"]
    with open(os.path.join(out, "timing.json"), "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, ensure_ascii=False, indent=2)

    spoken = sum(line["duration"] for chapter in manifest["chapters"] for line in chapter["lines"])
    print("chapters: " + "  ".join("%s %.1fs" % (chapter["id"], chapter["duration"]) for chapter in manifest["chapters"]))
    print("total %.1fs (%.2f min), spoken %.1fs, silence %.1fs"
          % (manifest["total"], manifest["total"] / 60, spoken, manifest["total"] - spoken))
    return 0


def main(argv=None):
    args = parse_args(argv)
    if args.check:
        return check_environment(args)
    return build(args)


if __name__ == "__main__":
    sys.exit(main())
