# SOURCE_MAP — V5 素材与事实来源

> 对外交付物中不出现案例客户名称；本文是内部追溯表，列出每条事实的核查来源。
> 核查日期：2026-11-14。

## 一、唯一核心案例（CASE-001）

| 事实 | 内容 | 来源 | 可用于画面 |
|---|---|---|---|
| 初始行为 | Agent 在具体设计未获批准前推进实施，提交 20 个文件 | `docs/case-studies/nextme-design-approval-boundary/STORY.md`（真实提交记录） | 是（脱敏） |
| 验证结果 | AI 回归 522 passed / 14 skipped；Backend 相关 60 passed；Web 相关 42 passed；真实 GPU 两轮 6 张图 | 同上（实施报告） | 是（不写成"全量通过"） |
| 冲突本质 | 决策权限，不是代码质量 | 同上 | 是 |
| Pain | `manual_1791868470372_8c47edyh`，Owner 手工录入，`severe`，score 80 | `STORY.md` / 案例 README | 是 |
| 诊断 | 设计确认流程缺口 + 授权层级混淆 | 案例 README（Diagnostician 两轮） | 是 |
| 原则原文 | 「当变更非简单、涉及高成本或多个设计选择点时，先调查现状并交付可审阅的方案……方向或操作授权不得替代设计批准。」 | 案例 README | 是 |
| 口播短句 | 「非简单变更，先提交设计方案，获得批准后再编码。」 | 任务书冻结旁白 | 是 |
| 审批 | 2026-10-15 由 `operator` 批准 | `STORY.md`；`EVIDENCE-001` | 是（按记录呈现，不演真人点击） |
| 激活 | Codex Prompt 渠道 | 同上 | 是（不展示 Runtime Rule 阻断） |
| 后续观察 | 2026-10-16 新修复任务：先交方案、明确「尚未改产品代码」、主动请求批准、引用该原则 | `EVIDENCE-001-followup-design-gate-2026-10-17.md`；截图 `evidence-001-…-2026-10-16.png` | 是（带单次观察角标） |
| 归因限制 | 同一回复引用 `brainstorming` 技能（也要求先批准）；PD 独立贡献未证实 | `EVIDENCE-001` | 画面须标注「不构成独立因果证明」 |

## 二、产品能力（按代码/文档核对）

| 能力 | 表述边界 | 依据 |
|---|---|---|
| Pain 由 Owner 主动记录 | 不是全自动发现 | 案例事实 + `PRODUCT_IDENTITY.md`（C1） |
| 原则提案可审查 | 不自动生效 | 矩阵 C2/C3 |
| Owner 批准 / 修改 / 拒绝 | 核心边界 | C3 |
| 激活可撤销、可观察 | 可以说"可撤销" | C4 |
| Prompt 治理为软通道 | 不能阻断动作 | C7 |
| Runtime Rule | 仅一句带过，不展示阻断画面 | C5/C6（shadow/fail-open） |
| Examiner | 长期验证定位，不是已完成结论 | 任务书 CH08；无真实数据界面则用动态图形 |

## 三、禁止项（沿用 PRODUCT_CLAIMS_MATRIX）

- 不说"自动学习""每条错误都会变成原则""三振出局""PD 训练模型/改权重""默认阻断所有危险操作"。
- 不把单次后续观察说成因果证明，不把 Agent 自述当成行为证据。
- 不展示带客户名称的界面/仓库/任务标题；如素材含该名称，裁切、遮挡或换用同类素材。
- 概念动画统一标注「概念示意 · 非产品界面」。

## 四、音频与视觉素材

| 素材 | 位置 | 说明 |
|---|---|---|
| BGM《数字暖流》 | `assets/audio/bgm/bgm-bed-340s.wav`（自带 340 s 母带） | V5 时长 384.8 s，需从母带尾部循环延伸，见 TECHNICAL_REPORT |
| 品牌字体 / Logo / GSAP | `assets/fonts`、`assets/logo/logo.svg`、`assets/vendor/gsap.min.js` | 复用 Creative V2 |
| 共享视觉系统 | `assets/style/film.css` | 治理线、卡片、字幕 scrim、章节标识 |
| 音色参考 | `renders/audition/cosyvoice2/ref/02-serena-female-l0.wav` | Owner 选定音色的原始 zero-shot 参考 |
