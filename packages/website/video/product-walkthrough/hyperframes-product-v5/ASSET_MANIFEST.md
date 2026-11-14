# ASSET_MANIFEST — PD 产品介绍片 V5 渲染依赖清单

> 本文档是 `scripts/render-all.ps1` / `scripts/build-voiceover.py` 的**唯一依赖契约**。
> 大型二进制（模型权重、WAV、MP4、TTF）不入库；它们是可下载或可从本地归档恢复的外部资源。
> 干净 checkout 只需按本文档准备资源，即可完整重建；脚本内不存在任何开发者专属绝对路径。

## 0. 一句话结论

| 场景 | 必需资源 |
|---|---|
| `-DryRun` | 无（只做静态参数检查，不执行任何外部程序、不写任何文件） |
| 全量构建 | Node.js、Python+CosyVoice、模型、参考音频、BGM、ffmpeg/ffprobe、`VOICEOVER_ZH.json` |
| `-SkipVoice` | Node.js、8 章 WAV、`renders/audio/vo-full.wav`、`timing.json`、BGM、ffmpeg/ffprobe |

## 1. 工具链

| 依赖 | 版本（已验证） | 获取方式 | 预期路径 | 说明 |
|---|---|---|---|---|
| Node.js | v26.12.1（已验证；CI 使用 22/24） | <https://nodejs.org/> | PATH 上的 `node` / `npx` | 运行 `gen-narration.mjs`、`build-index.mjs`、`build-subtitles.mjs`；`npx` 同时负责拉起 HyperFrames |
| HyperFrames CLI | 0.9.43（`npx --yes hyperframes` 现取） | npm（首次运行需网络） | 无需预装；`hyperframes.json` 是本工程清单 | 分章渲染。离线环境请先 `npm i -g hyperframes@0.9.43` 或预热 npx 缓存 |
| ffmpeg | 8.1（已验证） | <https://ffmpeg.org/download.html> | PATH 上的 `ffmpeg` | 混音、两遍 loudnorm、拼接、烧字幕 |
| ffprobe | 随 ffmpeg 发布 | 同上 | PATH 上的 `ffprobe` | 读取 BGM 时长、成片验收 |
| PowerShell | 7.6.2（要求 ≥ 7.0） | <https://github.com/PowerShell/PowerShell> | `pwsh` | 执行 `render-all.ps1` |

## 2. CosyVoice2 语音合成环境（仅全量构建需要）

| 依赖 | 版本（已验证） | 获取方式 |
|---|---|---|
| Python | 3.10.16（3.10–3.11 均可） | 建议用 CosyVoice 官方 `requirements.txt` 建独立 venv |
| torch | 2.3.1+cu121 | `pip install -r requirements.txt` |
| torchaudio | 2.3.1+cu121 | 同上 |
| numpy | 1.26.4 | 同上 |
| soundfile | 0.12.1 | 同上 |
| CosyVoice 仓库 | FunAudioLLM/CosyVoice（含 `cosyvoice/` 与 `third_party/Matcha-TTS/`） | <https://github.com/FunAudioLLM/CosyVoice> |
| CosyVoice2-0.5B 模型 | ModelScope `iic/CosyVoice2-0.5B` | <https://modelscope.cn/models/iic/CosyVoice2-0.5B> |

预期目录结构（`-CosyVoiceRoot` / `PD_VIDEO_COSYVOICE_ROOT` 指向仓库根）：

```
<CosyVoiceRoot>/
├── cosyvoice/                     # Python 包（import cosyvoice...）
├── third_party/Matcha-TTS/        # CosyVoice 依赖
└── pretrained_models/
    └── CosyVoice2-0.5B/
        ├── config.json
        ├── llm.pt
        ├── flow.pt
        ├── hift.pt
        ├── campplus.onnx
        ├── speech_tokenizer_v2.onnx
        └── ...
```

预检会用 `python scripts/build-voiceover.py --check` 实际导入 torch / cosyvoice 并校验模型目录，因此“Python 能启动但装不上 CosyVoice”会在构建前失败，而不是跑到一半才失败。

### 2.1 合成缓存

`scripts/build-voiceover.py` 把逐句原始合成结果缓存在 `.tmp/vo-raw/l00.wav … l61.wav`（62 句，固定 seed `20261114`）。

- 缓存完整时，脚本只做裁剪、电平匹配与时间轴放置，**不要求 torch / CosyVoice 可导入**；`--check` 也会如实报告这一点。
- 缓存不完整时，缺哪几句就合成哪几句，因此必须提供模型与参考音频。

## 3. 音频与字体资源

以下文件均被 `hyperframes-product-v5/.gitignore` 排除，不入库。

| 资源 | 预期路径 | 大小（字节） | SHA-256 | 获取方式 / 许可 |
|---|---|---:|---|---|
| BGM 母带《数字暖流》 | `assets/audio/bgm/bgm-bed-340s.wav` | 65,280,122 | `E0B71DDBCB6DBB3511AC3C4B0122FEF3BC7C86BFB0CD5FECACD94996A4D3FEC9` | 外部授权素材，仓库内无公开下载入口；本地归档于 `artifacts/pd-video-v5/`（不入库）。按原授权范围使用 |
| 参考音频（zero-shot） | 默认 `assets/audio/ref/02-serena-female-l0.wav`；也可用 `-ReferenceAudio` 指向任意位置 | 245,804 | `D752FAAB826D63947C1439E6ECFEBAC07326F107A451B9C000F01852AE250865` | 项目既有音色参考（24 kHz / 5.12 s），V4 选型沿用；随项目使用 |
| CH01 配音 | `assets/audio/vo/ch01.wav` | 4,678,132 | `032CAB9B66769F46E7FC038BDC1577ACB8F483E6FD24F3DD4639C600BE3128E9` | 由 CosyVoice2 生成（48 kHz / mono），生成参数见 `TECHNICAL_REPORT.md §3` |
| CH02 配音 | `assets/audio/vo/ch02.wav` | 4,607,996 | `1A8145C74D647AB43EA274909826D3705E9C30DD0352C9FE783CB87482C12EBE` | 同上 |
| CH03 配音 | `assets/audio/vo/ch03.wav` | 3,900,764 | `0767E0F1154097F29C427AD35B09C220C09186CA1C5E75BB817321BBDD835DFA` | 同上 |
| CH04 配音 | `assets/audio/vo/ch04.wav` | 5,508,272 | `A72AF2F733EF14AA283C8516561C28E920C5338C2B657F22DE4831F515A93493` | 同上 |
| CH05 配音 | `assets/audio/vo/ch05.wav` | 3,250,920 | `B4D769E900F37616F82AEFD0E3EC4F70606F4B4138B5432272295CC949795B45` | 同上 |
| CH06 配音 | `assets/audio/vo/ch06.wav` | 4,607,660 | `18DCFCFE554C112C1EDF2F6D5B996075D8FC9A8C072F452903B7EB0985D24C38` | 同上 |
| CH07 配音 | `assets/audio/vo/ch07.wav` | 5,730,036 | `B9F184F89CD3B1C130A6371D16D110D5C9F3577D15F3EAE97F50A95CCCED6449` | 同上 |
| CH08 配音 | `assets/audio/vo/ch08.wav` | 4,641,112 | `D036235C01DC0622061F662EE67A198CFB3CF37467F9BA63CAABC9D08391EEB8` | 同上 |
| 配音全长 | `renders/audio/vo-full.wav` | 36,924,584 | `B2BB5241811C4BF0FAE09D7D7F5F2F8BA53E7C470CC2F9AB8C394203560478D2` | 由 `build-voiceover.py` 拼接生成；`-SkipVoice` 时必需 |
| 中文字体 | `assets/fonts/NotoSansSC-VF.ttf` | 17,773,244 | `763146584CF0710223441356B4395E279021B0806C196614377A7A0174AE074A` | Noto Sans SC 可变字重，SIL Open Font License 1.1，<https://github.com/notofonts/noto-cjk> |

> 已入库的小型静态资源（无需额外获取）：`assets/fonts/inter-*.woff2`、`assets/fonts/jetbrains-mono-500.woff2`（SIL OFL 1.1）、
> `assets/vendor/gsap.min.js`（GSAP 标准免版税许可）、`assets/logo/logo.svg`、`assets/img/c7-evidence-*.png`。

### 3.1 模型权重校验值

模型体积约 3.8 GB，不入库。下载后可用下表逐文件核对（ModelScope `iic/CosyVoice2-0.5B`）：

| 文件 | 大小（字节） | SHA-256 |
|---|---:|---|
| `config.json` | 2 | `44136FA355B3678A1146AD16F7E8649E94FB4FC21FE77E8310C060F61CAAFF8A` |
| `llm.pt` | 2,023,316,821 | `B144EF55B51CE8CFB79A73C90DBBA0BDABA4E451C0EBCFAB20F769264F84A608` |
| `flow.pt` | 450,575,567 | `FF4C2F867674411E0A08CEE702996DF13FA67C1CD864C06108DA88D16D088541` |
| `hift.pt` | 83,390,254 | `3386CC880324D4E98E05987B99107F49E40ED925B8ECC87C1F4939432D429879` |
| `campplus.onnx` | 28,303,423 | `A6AC6A63997761AE2997373E2EE1C47040854B4B759EA41EC48E4E42DF0F4D73` |
| `speech_tokenizer_v2.onnx` | 496,082,973 | `D43342AA12163A80BF07BFFB94C9DE2E120A8DF2F9917CD2F642E7F4219C6F71` |

> 合成缓存完整的重建（`.tmp/vo-raw` 已有 62 句）不需要模型权重；只有缓存缺失时才需要。

## 4. 参数与环境变量

`scripts/render-all.ps1` 的全部外部依赖均可参数化；参数优先于环境变量：

| 参数 | 环境变量 | 默认值 | 作用 |
|---|---|---|---|
| `-PythonPath` | `PD_VIDEO_PYTHON` | PATH 上的 `python` / `python3` | 能导入 CosyVoice 的解释器 |
| `-CosyVoiceRoot` | `PD_VIDEO_COSYVOICE_ROOT` | 无（全量构建必需） | CosyVoice 仓库根 |
| `-ReferenceAudio` | `PD_VIDEO_REFERENCE_AUDIO` | `assets/audio/ref/02-serena-female-l0.wav` | zero-shot 参考音频 |
| `-BgmPath` | `PD_VIDEO_BGM_PATH` | `assets/audio/bgm/bgm-bed-340s.wav` | BGM 母带 |
| `-SkipVoice` | — | 关 | 跳过配音合成，复用已有 WAV / `timing.json` |
| `-ForceChapters` | — | 关 | 强制重渲已存在的分章 MP4 |
| `-DryRun` | — | 关 | 只打印计划，零副作用 |

`build-voiceover.py` 对应参数：`--cosyvoice-root`、`--reference-audio`、`--reference-text`、`--project`、`--check`。

## 5. 完整重建命令

```powershell
# 0) 先看计划：不执行 node/python/ffmpeg/ffprobe，不建目录、不写文件
pwsh -File scripts/render-all.ps1 -DryRun

# 1) 全量重建（配音 -> 时间轴 -> 字幕 -> 8 章 -> 混音 -> 合片）
pwsh -File scripts/render-all.ps1 `
  -PythonPath 'C:\venvs\cosyvoice\Scripts\python.exe' `
  -CosyVoiceRoot 'C:\repos\CosyVoice' `
  -ReferenceAudio 'D:\assets\02-serena-female-l0.wav' `
  -BgmPath 'D:\assets\bgm-bed-340s.wav'

# 1b) 等价的纯环境变量写法
$env:PD_VIDEO_PYTHON = 'C:\venvs\cosyvoice\Scripts\python.exe'
$env:PD_VIDEO_COSYVOICE_ROOT = 'C:\repos\CosyVoice'
$env:PD_VIDEO_REFERENCE_AUDIO = 'D:\assets\02-serena-female-l0.wav'
$env:PD_VIDEO_BGM_PATH = 'D:\assets\bgm-bed-340s.wav'
pwsh -File scripts/render-all.ps1

# 2) 复用已有配音与 timing.json
pwsh -File scripts/render-all.ps1 -SkipVoice
```

### 5.1 `-SkipVoice` 前置条件（脚本会逐项检查，缺一即失败）

1. `assets/audio/vo/timing.json` 存在且恰好 8 章；
2. `assets/audio/vo/ch01.wav … ch08.wav` 全部存在；
3. `renders/audio/vo-full.wav` 存在；
4. BGM、ffmpeg/ffprobe、Node.js / npx、`hyperframes.json` 就位；
5. Python、CosyVoice、参考音频**不需要**。

## 6. 构建前预检

正式执行前统一检查 10 项，缺项一次性列全并给出 `nextAction`，不会跑到一半才失败：

1. Node.js
2. Python（`-SkipVoice` 时跳过）
3. CosyVoice 模型（`-SkipVoice` 时跳过；含 `--check` 实际导入校验）
4. Reference Audio
5. BGM
6. 旁白源 JSON `VOICEOVER_ZH.json`
7. `timing.json`（`-SkipVoice` 时必须存在；全量构建中由第 1 步生成）
8. HyperFrames 依赖（`npx` + `hyperframes.json`）
9. ffmpeg / ffprobe
10. 输出目录权限

`-DryRun` 只做静态参数检查（存在性、JSON 结构、命令可解析），**不启动** node / python / ffmpeg / ffprobe，不建目录、不写文件、不改动现有音视频与缓存。

## 7. 验收

```powershell
# 成片验收（与 TECHNICAL_REPORT §8 的期望值对照）
ffprobe -v error -select_streams v:0 -count_frames `
  -show_entries stream=nb_read_frames,duration,width,height -of default=nw=1 `
  renders/final/principles-disciple-v5-zh.mp4
# 期望：nb_read_frames=11539 duration=384.633333 width=1920 height=1080

# 响度
ffmpeg -hide_banner -nostats -i renders/final/principles-disciple-v5-zh.mp4 `
  -af ebur128=peak=true -f null NUL
# 期望：I = -16.0 LUFS，TP = -1.5 dBFS
```

脚本级回归测试（参数化、fail-fast、DryRun 零副作用、SkipVoice 契约）：

```powershell
node --test packages/website/tests/video-render-scripts.test.mjs
```

## 8. 本地归档

无法再生的成品与音频（成片、分章、混音、验收截图、WAV、BGM）归档在仓库根 `artifacts/pd-video-v5/`。
该目录整体命中根 `.gitignore` 的 `/artifacts/` 规则，**不会入库**；其 README 只作为本地归档说明，不是本工程的可移植依赖。
