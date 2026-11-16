# PD 中文介绍片 V5.4

本目录对应 Owner 最终确认的对话框修订版。工程入口为 `index.html`，发布剪辑为本地归档中的 `renders/final/pd-v5.4-chat-zh.mp4`。片头、各章动效和审片记录均在此目录。

## 复用与重建

1. 从本机仓库根目录的 `artifacts/pd-video-v5.4-review/` 按相对路径复制 `assets/fonts/NotoSansSC-VF.ttf`、`assets/audio/bgm/bgm-bed-340s.wav` 和 `renders/audio/vo-full.wav`。这是已验收版本使用的字体、配乐和旁白母带。归档目录也保有分章音频、封面、片头和成片。复制这份归档可在其他机器上复用这些素材。
2. 使用 Node.js 22 或更新版本、PowerShell 7、FFmpeg 和浏览器。在本工程目录运行 `pwsh -File scripts/render-all.ps1 -SkipVoice`。脚本使用 HyperFrames 0.9.43，生成字幕、分章和完整有声视频。修改已有分章后使用 `-ForceChapters`，或者只移走改动章节的缓存 MP4。
3. 片头时长由 `assets/opening.json` 决定。正文旁白文本在 `VOICEOVER_ZH.json`，实测时码在 `assets/audio/vo/timing.json`。修改旁白后，需要用 `scripts/build-voiceover.py` 和本机 CosyVoice2 环境重录，并同步调整相关动画时点。句子按序号缓存，改词或重排时先移走受影响的 `.tmp/vo-raw/lNN.wav`。复用现有旁白请使用上一步。
4. 封面取第 4.80 秒标题帧。最终调整和原始成片校验值见 `REVIEW_ZH.md`。从源码全量重渲染可能产生不同的编码字节。

成片、缓存、字体和大体积音频采用本地归档。配音参考、脱敏证据截图和其他小型静态素材随源码存档。
