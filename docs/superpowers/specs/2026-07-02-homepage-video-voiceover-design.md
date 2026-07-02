# PD 首页品牌视频旁白、字幕与封面设计

## 目标

为中英文 36 秒首页视频补充低沉男声旁白和同步字幕，并将封面调整为“沉淀涟漪”。旁白必须解释画面正在发生的行为变化，不建立与页面产品定义平行或冲突的另一套叙事。

## 视觉方向

封面使用 B「沉淀涟漪」：Deep Ink 背景、低对比度 Quiet Cyan 同心圆、中心文案“纠正不会蒸发，它会沉淀”。不使用卡片、按钮截图、粒子、霓虹或高饱和渐变。

封面与视频第一场共享同一视觉母题。播放开始后，涟漪收束为三次相似纠正，避免封面与第一帧发生视觉跳变。

## 语音方案

- 生成工具：Microsoft Edge 在线 TTS，通过 `edge-tts` CLI 调用；无需项目 API Key。
- 中文声音：`zh-CN-YunyangNeural`，专业、可靠的男声，并通过轻微降调获得更沉稳的表达。
- 英文声音：`en-US-AndrewNeural`，沉稳男声。
- 初始参数：语速 `-4%` 至 `-8%`，音调轻微降低，无背景音乐；最终以场景时长和清晰度为准。
- 六个场景分别生成音频。每段测量实际时长后，只允许小幅调整语速或停顿，不裁掉语义内容。
- 最终音频执行响度归一化后按场景起点延迟、混音，再与 H.264 画面封装为 MP4。

## 单一内容矩阵

画面文字、旁白和 WebVTT 均由同一份双语场景数据生成。旁白可以增加连接词，但不得引入画面和页面没有表达的能力、宿主或承诺。

| 时间 | 画面事实 | 中文旁白 / 字幕 | 英文旁白 / 字幕 |
| --- | --- | --- | --- |
| 0–4s | 同类行为再次出现 | 同样的行为，又要纠正一次。 | The same behavior. Another correction. |
| 4–10s | 三次相似纠正收束为证据 | 三次相似纠正，被收束为一个可追溯的行为模式。 | Three related corrections converge into one traceable behavior pattern. |
| 10–17s | 系统提出原则，不自动生效 | 系统提出原则：扩大任务范围前，先说明影响、风险和验证方式。 | The system proposes a principle: explain impact, risks, and verification before expanding scope. |
| 17–24s | Owner 修改、批准或暂存 | 但建议不会自动生效。修改、批准或暂存，始终由 Owner 决定。 | But nothing activates on its own. The Owner edits, approves, or defers. |
| 24–31s | 下一次行为发生改变 | 下一次相似任务，Agent 先说明范围、风险和验证计划，再等待确认。 | Next time, the Agent presents scope, risks, and a verification plan, then waits. |
| 31–36s | 品牌收束 | 让纠正变成 Agent 的下一次行为。燃烧痛苦，协同进化。 | Turn corrections into the Agent's next behavior. Burn pain. Co-evolve. |

如果某段 TTS 超出场景时长，优先缩短连接词、恢复正常语速或提前 0.2–0.4 秒进入；不得让一段旁白跨入表达不同事实的下一场景。

## 页面集成

- 中文视频加载中文 MP4、中文 Poster、中文 VTT；英文同理。
- `<video>` 保持 `controls preload="metadata" playsinline`，不自动播放。
- 添加对应语言的 `<track kind="subtitles" default>`。
- 页面现有 Hero、真实变化时间线与视频共享相同术语：重复纠正、原则建议、Owner 审查、后续行为改变、回滚。

## 可维护生成流程

在 `packages/website/video/homepage-demo/` 保存：

- 双语场景数据与旁白文本；
- Edge TTS 生成脚本；
- 分段音频与字幕生成规则；
- FFmpeg 混音、封装及 Poster 抽帧命令；
- HyperFrames HTML 源。

生成资产写入被忽略的工作目录，最终仅发布两条 MP4、两张 Poster 和两份 VTT。

## 验证

- HyperFrames lint、validate、strict inspect 全部通过。
- FFprobe 证明每条 MP4 都有一个 H.264 视频流和一个音频流，时长 36 秒、1920×1080、30fps、文件不超过 4MiB。
- Poster 为 960×540 WebP，不超过 100KiB。
- VTT cue 边界与六个场景一致，语言与对应页面一致。
- 构建合同验证 `<track>`、MP4、Poster、VTT 和宿主中立文案。
- 浏览器人工检查 0/4/10/17/24/31 秒附近：听到的事实必须与画面和页面术语一致。

## 失败处理

- Edge TTS 网络失败时明确退出，不保留半生成资产。
- 声音不可用时列出当前声音并要求显式替换，不静默切换音色。
- 任一分段超出时间预算时输出场景编号、实际时长和目标时长，停止最终封装。
