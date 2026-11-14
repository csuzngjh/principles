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

## 4. 第二轮：视觉质量修复（布局 / 连接 / 路径）

- 基准提交：`4118a4c2154b79ea3e365717ec365e534c87d359`（第一轮动画升级后的 head）
- 修改范围：仅 5 个 composition，共 +178 / −29 行
  - `01-question.html`（+43）
  - `03-pain.html`（+36）
  - `04-principle.html`（+47）
  - `07-behavior.html`（+50）
  - `08-vision.html`（+31）
- 未改：旁白、SRT/ASS 文案、BGM、音频、`timing.json`、章节长度、总片长、渲染链、依赖。

### 4.1 根因与改动

**CH01 消息卡垂直重叠**
- 根因（实测 CSS）：`.msg` 单行总高 = `line-height 44 + padding 18+20 + border 2 = 84px`。
  - `#c1-user1` top 70 → 底 154；`#c1-agent1` top 146 → **重叠 8px**。
  - `#c1-agent1` 底 230；`#c1-fix` top 226 → **重叠 4px**。
  - `#c1-fix` 底 282；动态字段首行 top 300，仅 18px 间距，且 54px 步进会把第 5 行推到 516。
- 改动：`agent1 146→162`、`fix 226→256`、`fixtext 238→268`、`fixstate 240→270`、`check 236→266`；动态字段 `300 + 54i → 326 + 42i`。
  - 新布局：user1 底 154 → agent1 162（8px 间隙）→ 底 246 → fix 256（10px）→ 底 312 → 首字段 326（14px）；末字段 494，高 38，底 532，窗口高 560，留 28px。

**CH01 竖向连接线**
- 根因：原 `#c1-drop` 是无节点的细线，向下延伸后与治理线之间缺少“落点”。
- 改动：改为自上而下透明度递增的渐变（0.12 → 0.42 → 0.95），底部加 8px 发光节点 `::after`，`z-index: 9`；时间轴 `25.65s scaleY 0→1`、`27.5s` 淡出（与既有定位一致，未改时间）。

**CH03 聚合光束浮空**
- 根因：原 `#c3-beam` 用 `width` 补间、位置与 Pain 卡上边缘不重合，视觉上是一条漂浮色带。
- 改动：固定为 `left 314 / top 208 / width 1292 / height 2`，`transform-origin: 0% 50%`，动画改为 `scaleX 0→1`（7.8s, 0.6s）+ 8.9s 淡出；`z-index: 7`；Pain 卡仍在 7.85s 从同一条线长出。

**CH04 卡片没有连接杆、判断轴断裂**
- 根因：`.chip4` 只有背景块，没有和 `#c4-track` 建立视觉连接；卡片半透明导致轴从字下透出。
- 改动：`.chip4` 加 `line-height: 24px` 与 `background: rgba(22,34,51,0.98)`；新增 `.chip4::after`（1×12px 渐变连接杆）；`#c4-track` 固定为 `left 365 / top 558 / width 1230 / height 1`，两端 0.35、中段 0.8，`z-index: 8`。
- 复核：`#c4-scope`（top 562，20px 字）在轴下方 4px，172.4s 截图确认不压线、不压字。

**CH07 问题卡与连接轴**
- 根因：`.q7` 半透明且无 `line-height`，卡片高度不稳定；`#c7-qline` 与卡片底部没有对齐。
- 改动：`.q7` 加 `line-height: 36px`、`background: rgba(22,34,51,0.98)`（卡高 92px、底 622）；新增 `.q7::after`（24px 连接杆到 646）；`#c7-qline` 固定为 `left 471 / top 646 / width 980 / height 1`，`z-index: 9`；绘制仍为 53.2s / 2.2s / `scaleX 0→1`。

**CH08 光点靠手写关键帧，偏离曲线**
- 根因：原光点用独立 keyframes 位移，与 SVG 路径不是同一条几何；曲线一改就会脱轨。
- 改动：用 `getTotalLength()` / `getPointAtLength()` 采样，GSAP 只补间普通对象 `c8Motion.distance`，`onUpdate` 写回 `cx/cy`；描边 `strokeDashoffset → 0` 与光点距离在同一 1.1s、同一 ease 内完成。缺元素时 `throw`，不静默降级。

### 4.2 验收时间点（章节局部时间 → 整片绝对时间）

| 章 | 局部时间 | 绝对时间 | 结果 |
| --- | --- | --- | --- |
| CH01 | 0.5 / 2.5 / 5.5 | 0.5 / 2.5 / 5.5 | PASS：四行无重叠，字段在窗口内 |
| CH01 | 25.9 / 27.0 | 25.9 / 27.0 | PASS：竖线开始下延；贯通 + 底部节点 + 治理线 |
| CH03 | 7.8 / 8.3 / 9.2 | 104.529 / 105.029 / 105.929 | PASS：光束贴上边缘；9.2s 卡片成形、光束退净 |
| CH04 | 24.5 / 29.0 / 33.0 | 161.862 / 166.362 / 170.362 | PASS：chip + 连接杆 + 轴逐级成立 |
| CH07 | 53.2 / 54.3 / 55.2 | 357.155 / 358.255 / 359.155 | PASS：三卡 + 连接杆 + 轴 |
| CH08 | 22.55 / 23.1 / 23.65 | 384.282 / 384.832 / 385.382 | PASS：光点沿曲线；与描边同时到达终点 |

说明（实测）：`7.8s`、`53.2s` 这类“起始时刻”在 t=0 帧天然是动画初始态；额外补拍 `104.70s` / `357.40s` 确认元素确实成形。

截图（本地 `.tmp/`，按 git-15 不入库）：
- 修复后：`.tmp/diag/gate2/`（17 张 + 2 张联系表）、`.tmp/diag/gate2-extra/`
- 修复前：`.tmp/diag/gate5-before/`（同一 17 个时间点，4118a4c21 源码）
- 补充：`.tmp/diag/c4-scope/`、`.tmp/diag/final-check/`

### 4.3 命令结果（实测）

| 命令 | 结果 |
| --- | --- |
| `node scripts/verify-motion.mjs` | PASS（八章末动画 ≤ 章长；CH08 静止 3.937s） |
| `hyperframes lint` | 0 error / 0 warning |
| `hyperframes check` | Runtime 0 error / Layout 0 issue（9 采样）/ Motion 0 error；3 条既有 Craft 警告 |
| `hyperframes inspect --at-transitions --json` | `ok=true, errorCount=0, warningCount=0, issueCount=0, transitionSamplesDropped=0` |
| 两次独立 `snapshot`（17 帧，SwiftShader） | 17/17 PNG SHA256 完全一致（`.tmp/diag/det1` vs `det2`） |

### 4.4 成片（第二轮重渲，实测）

产物：`renders/final/principles-disciple-v5-zh.mp4`，SHA256：

```text
0F6F3FA76732A39020DB1F8519FC489D6D62FB755CA39D71DC3DD12C38F52228
```

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
bit_rate=713561
nb_frames=12095
duration=403.166667
codec_name=aac
profile=LC
sample_rate=48000
channels=2
bit_rate=291071
duration=403.170000
size=51070102
bit_rate=1013371
```

- 全解码：`ffmpeg -v error -i final -f null NUL` → 无输出，exit 0。
- 黑场：`blackdetect=d=0.1:pix_th=0.10` → `NO_BLACK_SEGMENTS`。
- 响度（`loudnorm` 实测）：I −16.02 LUFS / TP −1.47 dBTP / LRA 1.80。
- 分章时长：48.733 / 48.000 / 40.633 / 57.367 / 33.867 / 75.367 / 57.767 / 41.433 s，合计 403.167s；锚点 0/48.730/96.729/137.362/194.739/228.602/303.955/361.732 不变。
- 未改动章（CH02/CH05/CH06）从成片抽帧复核：字幕正常、无叠字、无黑帧。

### 4.5 V5 vs V5.2 源码 SHA256 结论更正

PR 描述中“只有 CH06 有改动”的结论只在**最初入库提交**成立，必须按 commit 区分：

| commit | 比对结果 |
| --- | --- |
| `a9adc9878`（V5.2 首次入库） | CH01–CH05、CH07、CH08、`film.css` 全部 **SAME**；仅 `06-activation.html` **DIFF**（v5 `49A66C81…5477B6` / v52 `BD4D9884…111E07`） |
| `4118a4c21`（第一轮动画升级） | 八章全部 **DIFF** + `film.css` **DIFF**（统一 Motion System 触及每一章） |
| 本轮工作树 | 仅 `01/03/04/07/08` 五个 composition 相对 `4118a4c21` 改变 |

因此旧结论对当前 head 已失效；本报告与 PR 描述均改为按 commit 表述，不再笼统声称“只有 CH06”。

### 4.6 遗留问题

- 渲染器并行抓帧仍会打印 `Capture attempt made no forward progress … retrying`，但重试成功后产物完整（本轮八章均成功）；这是 HyperFrames 0.9.43 的既有噪声，不是本轮回归。
- Chromium 直接播放 mp4 仍黑屏（缺 H.264 解码器），实播验收使用 HyperFrames Studio + ffmpeg 全解码。
- 本轮只做视觉修复；V5.2 渲染脚本仍无自动化测试覆盖（既有 follow-up）。

## 5. 第二阶段：动画技术能力升级

基准提交：`4441ccee9`（含 CH01 节点圆心对齐修复）。

### 5.1 八章技术能力矩阵（实测源码 + 渲染帧）

| 技术 | 文件 / 元素 | 实际实现 | 真正生效 | 结论 |
| --- | --- | --- | --- | --- |
| GSAP Timeline | 八章 `window.__timelines["cN"]` | `gsap.timeline({ paused: true })`，绝对秒定位 | 是（verify-motion PASS） | 保持 |
| Opacity / Translate / Scale | 八章全部 | `fromTo` 数值补间 | 是 | 保持 |
| Clip Path | CH01 `#c1-fixtext`；CH02 `#c2-commit/#c2-cap/#c2-swap`；CH03 `#c3-pain/#c3-f1..3`；CH04 `#c4-c1/#c4-c2/#c4-ruletext`；CH05 `#c5-panel`；CH08 `#c8-is` | `clipPath: inset(...)` 补间 | 是（6/8 章） | 保持 |
| SVG Path Drawing | CH06 `#c6-track-path`（280→0 @40.55）、`#c6-track-return`（450→0 @47.55）；CH08 `#c8-linkpath` | `stroke-dashoffset` 补间 | 是 | 保持 |
| SVG Morphing | CH04 `#c4-track-path` | 同构 `d` 字符串，GSAP `attr` 原生插值 | 是（本轮新增） | 已落地 |
| Perspective / 3D | CH05 `#c5-o1/#c5-o2/#c5-o3` | `z/rotateX/rotateY/transformPerspective` | 是（本轮新增） | 已落地 |
| Motion Path | CH08 `#c8-linkdot` | `getTotalLength()` + `getPointAtLength()` + 距离补间 | 是 | 保持并复验 |
| Motion Blur | 无 | 无 | 否 | 不落地（见 5.3） |
| Flubber | 无 | 无 | 否 | 不需要（见 5.3） |

### 5.2 落地的两个场景

**CH04：散乱折线 → 判断轴（SVG Morphing）**
- 把 `#c4-track` 从 1px div 改为 `1230×40` 的 SVG；`#c4-track-path` 为 6 点 `M/L` 折线。
- 起点 `d = M 0 8 L 246 32 L 492 10 L 738 30 L 984 9 L 1230 28`，终点为同 x、y=20 的直线；命令序列与点数完全一致，因此用 GSAP `attr: { d }` 原生字符串插值，**未引入 Flubber / MorphSVG**。
- 时间：24.0s 起、9.0s、`M.ease.cam`，与原有 `scaleX 0→1` 同步；不动旁白与章节长度。
- 实测：28s 帧为可见折线，33s 帧为直线；最终成片 167.362s 帧同样可见。
- 修正：水平线用 `objectBoundingBox` 渐变会因 bbox 高度为 0 而退化，改为 `gradientUnits="userSpaceOnUse" x1=0 x2=1230`。

**CH05：决策选项的 3D 纵深**
- 仅作用于 `#c5-o1/#c5-o2/#c5-o3`（不机械套用到所有卡片）。
- 入场：`z:-56, rotateX:4.5, rotateY:-3.5, transformPerspective:900` → `z/rotate 归零`，时长 0.45s，沿用 `M.ease.in`；角度 ≤5°。
- 实测：入场早期卡片略小、略倾斜（透视缩放约 0.94），落定后完全平面、文字锐利。

### 5.3 未实现技术及原因

- **Motion Blur**：Chromium/HyperFrames 抓帧没有速度向量，`filter: blur()` 只能做各向同性高斯模糊，属于“冒充运动模糊”；按任务要求不落地，记录为渲染链限制。
- **Flubber**：本轮 CH04 路径拓扑一致，GSAP 原生插值已满足；无拓扑不一致且需要形状插值的场景，故不新增依赖。
- **MotionPathPlugin**：CH08 原生 `getPointAtLength()` 已满足；不引入插件。

### 5.4 验收（实测）

| 项 | 结果 |
| --- | --- |
| `verify-motion` | PASS |
| `hyperframes lint` | 0 error / 0 warning |
| `hyperframes check` | 0 error（Audio 1 info：film_silent，属既有） |
| CH04 关键帧 | 24.0s 起始 / 28s 折线 / 33s 直线；成片 167.362s 复核 |
| CH05 关键帧 | 14.84s 透视入场 / 15.01s 落定；成片 210.32s 复核 |
| CH08 正向确定性 | 同参数两次正向抓帧 3/3 SHA256 完全一致 |
| CH08 反向 / 中途跳转 | 反向与单点重开帧在目标时刻视觉一致（PSNR 40–46 dB，光点位置无偏移） |
| CH08 重新初始化 | 两次全新渲染 17/17 一致；无描边/光点残留 |
| 路径长度 | 三次贝塞尔数值积分 ≈ 175.906（运行时取 `getTotalLength()` 真值） |

说明：不同 seek 路径到达同一时刻时存在亚像素栅格差异（文本/圆点抗锯齿），不是 Motion Path 状态残留。

### 5.5 修改文件与依赖

- `compositions/01-question.html`（节点圆心对齐：`.node top 700 → 714`）
- `compositions/04-principle.html`（`#c4-track` 改 SVG + 同构 `d` 变形）
- `compositions/05-owner.html`（三个决策选项 3D 入场）
- `ANIMATION_UPGRADE_REPORT.md`
- 新增依赖：**无**。

### 5.6 最终成片（第二阶段）

`renders/final/principles-disciple-v5-zh.mp4`：

```text
codec_name=h264 / profile=High / width=1920 / height=1080 / pix_fmt=yuv420p / level=40
r_frame_rate=30/1 / bit_rate=713886 / nb_frames=12095 / duration=403.166667
codec_name=aac / profile=LC / sample_rate=48000 / channels=2 / bit_rate=291071
format: duration=403.170000 / size=51086474 / bit_rate=1013695
SHA256=31049BD6BBEFC8141E390D24B0FA8FD765E7772C551EBA247CB903C2BEC3DDB1
```

- 全解码：无错误，exit 0。
- 黑场：`NO_BLACK_SEGMENTS`。
- 响度：I −16.02 / TP −1.47 / LRA 1.80。
- 分章：48.733 / 48.000 / 40.633 / 57.367 / 33.867 / 75.367 / 57.767 / 41.433s，总 403.167s；章节长度与总片长未变。

> 注：4.4 节的 `0F6F…F52228` 对应 CH01 节点修复前的中间片；当前交付片以本节 `3104…DDB1` 为准。

