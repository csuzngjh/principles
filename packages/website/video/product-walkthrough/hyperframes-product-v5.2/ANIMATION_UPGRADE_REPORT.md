# V5.2 动画升级清单与验收报告

本文件对应本轮「纯代码动画升级」：只改 GSAP / CSS / SVG，不改旁白、字幕文案、BGM、叙事顺序、真实数据与品牌色。

- 工程根：`packages/website/video/product-walkthrough/hyperframes-product-v5.2/`
- 分支 / PR：`ai/adhoc-20261114-v52-video-submit-3f9a1c-video-v5-2` → PR #2647（增量提交）
- 渲染器：HyperFrames `0.9.43`（已从 `npx --yes hyperframes` 改为固定版本）

## 1. 统一 Motion System

| 档位 | ease | 时长 | 用途 |
| --- | --- | --- | --- |
| `in` | `power2.out` | 0.55s | 普通信息入场 |
| `hero` | `power3.out` | 0.70s | 关键视觉入场 |
| `agg` | `power2.inOut` | 0.70s | 信息聚合 / 形态转换 |
| `state` | `power1.out` | 0.35s | 状态切换，无弹跳 |
| `exit` | `power2.in` | 0.45s | 退场，比入场克制且归零 |
| `cam` | `sine.inOut` | 长时段 | 镜头缓推 / 回稳 |

- 八章各有一份**逐字相同**的 `const M = Object.freeze({...})`；`scripts/verify-motion.mjs` 做一致性校验，防止漂移。
- 空间层：`film.css` 新增 `.cam`（`position:absolute; inset:0; transform-origin:50% 46%`）。镜头只作用于章节内容，背景网格、章节标识、字幕不参与运动。
- 技法：遮罩揭示 `clip-path`、路径描边 `stroke-dashoffset`、景深靠 `.cam` 缩放 + 各层不同位移；**全片无 CSS animation**。

## 2. 逐章升级清单

### CH01 Question（48.730s）
- 原表现：会话窗口整体淡入，消息逐条淡入，纠正条 scaleX 展开，治理线 scaleX。
- 改动：镜头 0–25s 缓推 1→1.026；纠正条出现时 `#c1-user1` 降到 0.7（非焦点降权），2.05s 复原；纠正文案改为自左向右遮罩揭示 + 一次 26px 辉光脉冲；三张重影卡加入 −0.8°/−1.5°/−2.2° 旋转，避免机械复制感；新增 `#c1-drop` 竖向光带，从纠正条位置向下延伸到治理线，再横向展开；节点从线下 `y:10/scale:0.4` 升起（`back.out(1.6)`）。
- 技术：GSAP Timeline、clip-path、box-shadow 脉冲、CSS transform。
- 改善：纠正信息成为明确焦点；治理线与消息位置产生空间因果。

### CH02 Case（47.999s）
- 原表现：提交卡淡入，三列数字依次淡入，结论卡淡入。
- 改动：镜头 0–42.2s 缓推 1→1.024，随后回稳到 1.012（覆盖原本 5.8s 静止尾巴）；提交卡改为遮罩横向展开；数字入场后统一 1.05× 聚光再回落（不做滚动计数）；两句结论改为自下而上遮罩成形。
- 改善：证据逐项揭示有节奏；关键指标有聚焦；结论是“收束”而不是“又淡入一次”。

### CH03 Pain（40.633s）★
- 原表现：对话行淡出 → Pain 卡淡入，字段逐个淡入。
- 改动：聚合阶段 12 条对话行向一条水平带收拢（`y` 函数化 + `scaleX 0.16` + 22ms 错峰），日志卡同步回位并快速归零；新增 `#c3-beam` 光带 `width 120→1320` 展开，Pain 卡从带子位置 `scaleY 0.08→1` + `clip-path` 自下而上长出；字段改为遮罩揭示 + 10px 位移；Owner 记录出现后字段降到 0.62，负向排除出现后降到 0.45。
- 技术：GSAP + clip-path + 函数化位移（无随机）。
- 改善：真实经验→结构化问题是同一段运动，不再是“旧内容消失、新卡片出现”。

### CH04 Principle（57.377s）★
- 原表现：诊断卡淡出，原则文字淡入，五个关键词依次淡入。
- 改动：两张原因卡向中间收束（x ±150、scale 0.94）后再消失；原则原文自下而上遮罩成形；新增 `#c4-track` 判断轴，随五个维度依次落位而缓慢绘制（9s），把并列标签变成一条判断链；沉淀段镜头从 1.028 → 1.014 → 1.0，token 以 1.04→1 落定。
- 改善：混乱信息→结构化原则有连续因果；原则成形后视觉从动态转稳定。

### CH05 Owner（33.863s）
- 原表现：面板与四格逐条淡入，状态标签变色。
- 改动：面板改为遮罩展开；四格进入时前序格子降到 0.6，全部到齐后 13.4s 复原为 1（逐项聚焦）；镜头 0–23.6s 推近、决定落定后回稳；批准状态变更时状态胶囊 1.08× 脉冲 + 批准项 26px 辉光，明确“决定已落定”。
- 改善：审批的层级与重量；AI 提议（冷灰、降权）与 Owner 决定（亮色）对比更清楚。

### CH06 Activation（75.353s）★
- 原表现：数据包水平位移，关卡换边框色，原因标签平移。
- 改动：新增 SVG 轨迹（Agent→关卡→工具执行）`stroke-dashoffset` 描边；数据包带拖尾（`#c6-trail` 350px 渐变）；进入检查区时 `#c6-scan` 自上而下扫描 296px；阻止时数据包先过冲 8px 再硬停回弹到关卡外侧，包体与关卡同时转红、红叉落位、原因沿 `#c6-track-return` 回程路径返回 Agent；镜头 24.4s 推近到 1.032，对比段退回 1.018，提问段收至 1.0。
- 修复：原 `tl.set("#c6-call", …)` 省略时间定位且 `left/top` 为 0，导致数据包压在 RULEHOST 标签上（叠字）。改为 CSS `left:250px/top:190px` + 显式 `x` 位移，并删除隐式定位。
- 改善：机制链条有明确路径与反馈，阻止状态一眼可辨。

### CH07 Behavior（57.777s）
- 原表现：连接线 scaleX、日期点、条目逐条淡入。
- 改动：新增 `#c7-prog` 已走过段落点亮 + `#c7-travel` 移动点（740px / 1.7s），把“时间往后推”变成可见推进；关键行“先提交修复方案”6.8s 起 1.028× 聚光；三个待验证方向之间新增 `#c7-qline` 连接线（53.2–55.4s 绘制），表达跨任务延续。
- 改善：时间轴有推进；跨任务关系可见。

### CH08 Vision（41.437s）★ 修复
- 原表现（源码推断 + 渲染验证）：品牌 41.2s 起、Tagline 43.7s 起，章长 41.437s → 品牌被截断、Tagline 零帧。
- 改动：整体按旁白重排——四个检验问题 6.75/10.3/13.3/17.6s 逐项揭示且前项降权；PD/Examiner 22.5–23.4s 之间用 SVG 曲线 + 移动光点建立连接；核心句 30.0s 遮罩成形；品牌 34.55s 入场（35.25s 完成）；Tagline 36.75s 入场（37.50s 完成）；治理线 35.1s 居中展开；镜头 29.6s 后收束，**34.5s 之后完全静止**。
- 结果：品牌落版静止窗口 3.94s（要求 ≥2s），末帧为稳定态。

## 3. 验收

### 3.1 自动化
- `node scripts/verify-motion.mjs`：PASS（token 一致、无禁用 API、无隐式时间定位、八章结束时间均 ≤ 章长、CH08 静止窗口 3.937s）。
- `hyperframes lint`：0 error / 0 warning。
- `hyperframes check`：Runtime 0 error、Layout 0 issue、Motion 0 error；Craft 的 3 条警告为既有属性（整片静音渲染、由后期混音；dead_stretch 为顶层时间轴静态误判）。
- `hyperframes inspect --at-transitions --json`：每个 tween 起止边界都采样，`errorCount=0 / issueCount=0`。
- 确定性：`hyperframes snapshot` 对 104.9s / 270.1s / 402.9s 连续两次独立渲染，三张 PNG SHA256 完全一致。

### 3.2 浏览器 / 抽帧
- `hyperframes snapshot --review`：八章起始帧、中点帧、每个切点前后 5 帧（seam strip）、竖屏 sheet。
- 已逐项检查：无黑场、无残影、无文字遮挡/裁切、无动画未完成即切章；切点首帧不再空白（各章首个元素在 t=0 即在位）。

### 3.3 成片（实测）

产物：`renders/final/principles-disciple-v5-zh.mp4`（八章重渲 → concat → 混音 → 烧字幕）。

ffprobe 原始输出：

```text
codec_name=h264
profile=High
width=1920
height=1080
pix_fmt=yuv420p
level=40
r_frame_rate=30/1
avg_frame_rate=30/1
bit_rate=713510
nb_frames=12095
codec_name=aac
profile=LC
sample_rate=48000
channels=2
bit_rate=291071
nb_frames=18900
duration=403.170000
size=51067775
bit_rate=1013324
```

- 响度（`loudnorm` 实测）：I = −16.02 LUFS，TP = −1.47 dBTP，LRA = 1.80（与上一版基线一致）。
- 黑场检测：`blackdetect=d=0.1:pix_th=0.10` 全片 **无命中**。
- 分章时长：48.733 / 48.000 / 40.633 / 57.367 / 33.867 / 75.367 / 57.767 / 41.433 s，合计 403.167 s，全部与锚点一致。
- 关键帧：0s（完整会话首帧）、八章切点、403.1s（完整品牌落版）逐张确认，无空白帧、无残影、无文字截断。
- 最后 10 秒：393.2 / 396.0 / 399.0 / 401.5 / 403.1 五帧确认核心句 → 品牌落版过渡完整，末帧稳定。
- 字幕同步抽查：50.5s 显示「在一个 AI 产品研发项目中，Codex 承担了一项复杂的开发任务。」、230.4s 显示「经过批准的原则，还需要真正进入 Agent 的工作流程。」，均与 `SUBTITLES_ZH.srt` 对应条目一致。
- 真实浏览器：HyperFrames Studio（`localhost:3002`）实播 0→10s 画面连续变化；拖到 06:38 播放至 06:43，品牌卡（Logo + Principles Disciple + Tagline）完整显示。**注意**：用 Chromium 直接播放 mp4 时画面全黑，原因是该 Chromium 构建不带 H.264 解码器（元数据与播放时钟正常），不是成片问题；成片解码正确性由 ffmpeg 全片解码 + 抽帧证明。

