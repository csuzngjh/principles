# SPEC-PD-HOMEPAGE-VIDEO-002 验收报告 — 官网介绍动画重制

- 日期：2026-10-26；执行：Zcode（工作树 `adhoc-20261026-hpv002-video-remake-dc8d2c`，分支 `ai/adhoc-20261026-hpv002-video-remake-dc8d2c`）
- SPEC：`docs/specs/SPEC-PD-HOMEPAGE-VIDEO-002-hyperframes-remake-v1.0.md`（Owner 已批准执行）
- 基线 HEAD：`015483a8d`（主检出）；工作树基点 `f2b51366d`（origin/main，与基线间 `packages/website/` 零差异）
- 状态分列（详见 §11）：工程检查 PASS / 浏览器视觉 PASS / 音频听检 PASS（客观指标+Owner 预览裁定）/ 人测 NOT RUN / PR 未开 / 发布未授权

## 1. 问题和最终行为

旧 36 秒动画用抽象文字卡片解释机制，约 24 秒才进入后续行为，450px 播放下卡片文字过小，审批与后续行为间缺可见的批准过程。重制后：30 秒双语动画以「只让 Agent 修按钮却扩大到整页重构」贯穿——具体困扰（首帧即有信息）→ 原话纠正并归并（无 3× 阈值）→ PD 整理原则建议 → 点击批准并出现「经你批准」→ 下一次相似任务先说明影响并等待 → 收尾卡「少一点重复纠正。决定权仍在你。随时可撤回」完整保持最后 3 秒。全程保留「机制示意 / Illustrative example」来源标识。

## 2. 复用清单（Reality Audit 结论）

复用并更新：`index.html`（重写分镜，保留单文件结构与确定性时间线模式）、`variables-{zh,en}.json`、`voiceover/scenes.json`、`scripts/generate-voiceover.mjs`（扩展，不重写）、`capture/assets/fonts/`（Inter/Cascadia 复用，Noto 子集重建）、`HeroSection.vue`（仅 aria-label 微调）、public 六个媒体位（同名替换）、`homepage-contract.test.mjs`（更新时间契约，保留全部安全/媒体质量约束）、`.gitattributes` LFS 管理不变。
新增（工程内容，非产品事实源）：`BRIEF.md`、`STORYBOARD.md`、`scripts/subset-fonts.mjs`、本地 `capture/assets/gsap.min.js`、`NotoSansSC-poster.ttf`。
未新建任何视频基础设施、框架、服务或第二时间事实源。

## 3. 实际版本与依赖

- HyperFrames CLI：0.7.24 → **0.8.200**（官方 `upgrade --project` 完成 pin 升级；升级前后 lint 全过，0.8.200 check 在旧工程可直接运行）。依据：0.8.200 的 `check` 单门禁覆盖旧版 lint+validate+inspect 三连（旧后两者已 deprecated），并新增布局/对比度/运动/craft 审计；SPEC §5.2 允许兼容升级并验证。
- GSAP 3.14.2 本地化（`capture/assets/gsap.min.js`），渲染期零网络。
- Edge TTS 7.2.8（zh-CN-YunyangNeural / en-US-AndrewNeural）；FFmpeg 8.1；fonttools 4.51 + brotli（字体子集）；Node 26.7。
- `--variables-file` 必须搭配 `--strict-variables`：本版 CLI 非 strict 模式静默丢弃文件值、按默认英文渲染（已实证：strict 下中文正确，非 strict 下英文；README 已记录）。

## 4. 交付物与媒体参数（最终 public 资产）

| 文件 | 参数 | SHA-256（前16） |
|---|---|---|
| `packages/website/public/homepage-demo-zh.mp4` | H.264+AAC，1920×1080@30fps，30.000s，1.30 MB | 00fb0005365a036b |
| `packages/website/public/homepage-demo-en.mp4` | 同上，1.40 MB | b96cfae2988f5df1 |
| `public/images/homepage-demo-poster-zh.webp` | 960×540 WebP，22.6 KiB | 2745cfc3c9cda97c |
| `public/images/homepage-demo-poster-en.webp` | 960×540 WebP，27.0 KiB | c018700af3c3a5c9 |
| `public/homepage-demo-zh.vtt` / `-en.vtt` | 各 8 条 cue | 见仓库 |

体积/规格全部满足 SPEC §6（≤4MiB、960×540≤100KiB、faststart、yuv420p）。MP4/海报经 Git LFS。

## 5. 命令与结果（可复现链）

```powershell
npm run check                        # HyperFrames check 门禁 → PASS（布局0错误/对比度47:47 AA/运动0/运行时0）
node scripts/subset-fonts.mjs        # 新文案字符集 262 字 → NotoSansSC-subset.woff2 + poster.ttf
npx --yes hyperframes@0.8.200 render --variables-file variables-{zh,en}.json --strict-variables --quality delivery --output renders/homepage-demo-{zh,en}-high.mp4
npm run voiceover                    # TTS(12段全过预算) → ffmpeg 混音 → public MP4/VTT → drawtext 海报
npm run docs:build --workspace=@principles/website   # PASS（prebake baked companion-v0.1.5）
npm run test:contract --workspace=@principles/website # 13/13 PASS（ffprobe 实测媒体断言生效，无跳过路径）
```

## 6. 工程检查（A 组）

1. HyperFrames check（0.8.200）：PASS。残余：6 条 `nested_structure_needs_subcomposition` 建议（单文件六场景结构，旧工程同类，记录为接受项）；2 条 craft 警告——`film_silent`（无声母版为既定管线，旁白后混）、`line_unread`（S5 等待行 1.70s 下限 vs 实际在屏 ~1.4s 后随场景淡出，语义由 S5 末尾两气泡+字幕承载，接受）。
2. ffprobe 双语实测：见 §4，无跳过路径。
3. 合同测试更新：36s→30s **独立 SPEC 断言**（测试内常量 SPEC_DURATION=30、SPEC_SCENE_STARTS=[0,4,8,13,17,25]，不从 manifest 复制时长）；cue 单调/边界/不超片长/逐字对应旁白清单；保留体积、轨道、海报尺寸、双语路由、controls/非自动播放/playsinline/preload 全部旧契约。
4. VTT：8 cue/语，起点含全部六场景边界，单调、≤30s。
5. docs:build + test:contract：PASS（prebake 网络成功）。
6. error:context 两遍：Pass 1（计划模式）命中 EP-09/EP-13 → 已转化为「测试测真实边界（ffprobe 实测+SPEC 常量断言）」与「沿用主题既有深色 token，无新增裸色值」；Pass 2（diff 模式）HIGH×2（EP-02/EP-06，由 video 项目的 package.json 触发）：**说明排除**——该 package.json 是私有视频制作脚本清单，非发布包（private:true、无 exports、无运行时消费者）；等效生产路径证据 = HeroSection 实际消费 public 资产 + 构建站浏览器实测播放 + 合同测试全绿。MEDIUM EP-03/09/14/05/11/13 均已由上述同组证据覆盖。

## 7. 浏览器视觉（B 组，构建站实机，Playwright）

- 桌面 1280px 视口：播放器实测 **456px**；视频元数据/时长 30s/海报/字幕轨(srclang=zh,default)/controls/无 autoplay/playsinline/preload=metadata/新 aria-label 全部正确；console 仅 Cloudflare RUM 的 localhost CORS 噪声（与本片无关）。
- 截图（工程 `.tmp/hpv002/browser/`）：zh 456px t=15（场景4：标题/原则卡/批准钮清晰，原生字幕落预留带不遮挡，光标修复后按钮干净）；zh 293px t=21（场景5：主标题+字幕可读）；zh 293px t=15 无字幕（画面自明：你审查你决定+原则卡）。
- 手机 390px 视口：播放器实测 293px（严于 SPEC 预估 350px），主阅读焦点（每镜一句标题）可读；小于画布 2.6% 的辅助文字在 293px 不可读，属预期（该层信息由字幕与旁白承载）。
- 字幕开关/静音/暂停/拖动中段：均验证；关字幕与静音下故事仍由画面标题承载。
- en 页路由：正确消费 en MP4/海报/VTT/srclang=en，可播放，新 aria-label 生效。

## 8. 音频（客观指标；听感裁定见 §10）

- 响度：en **-18.0 LUFS**（目标 -18）；zh **-19.8 LUFS**（YunyangNeural 底色偏静，与目标差 1.8 LU，无削波）；true/sample peak zh -1.7 dBFS、en -2.0 dBFS（loudnorm TP=-2 配置；zh 差 0.3dB 为 sample-peak 度量差，无削波）。
- 旁白预算 12/12 全过（最紧 zh-S1 3.14/3.70s；全部留 ≥0.3s 尾余量）；silencedetect 显示每段在场景窗内起声、无跨场抢话、片尾无截断。
- 未采用背景音乐（SPEC：非必需不添加）。

## 9. 实际文案偏差（均在 SPEC 授权的等义缩写范围）

1. S6 旁白缩写（预算门拦截后缩短）：zh「少一点重复纠正，决定权仍在你。原则随时可撤回。」→「少一点重复纠正。决定权在你，随时可撤回。」；en 省略 "the principle"→"You stay in control — withdraw anytime."。三要素（少重复纠正/决定权/可撤回）完整。
2. 画面辅助标签为叙述需要新增（你的请求/Agent 实际改动/超出请求/经你批准/新任务等），与 SPEC §4 主文案不冲突；S3/S4 短原则、S5 Agent 台词逐字采用 SPEC。
3. slogan「燃烧痛苦，协同进化」未进片：SPEC §4 S6 固定文案不含；工程 design.md Do-not 明确禁用 burn pain 类语言；与首页现行信息架构一致（slogan 为 Abyss 链接文字）。Owner 于预览评审时裁定维持（选项 A）。

## 10. 失败和修复（全过程）

1. 跨场景标题转场重叠（check 布局错误×2）→ 出场景在被覆盖窗内淡出（真交叉溶解）。
2. 全屏场景 lint `gsap_fullscreen_overlay_starts_visible` → CSS 初始 opacity:0（场景 2 的同类报错实为 **数组选择器 `[\"#a\",\"#b\"]` 干扰 lint 解析**，拆两条 tween 后消除——工具坑，记录）。
3. `--variables-file` 静默失效（渲染出英文）→ `--strict-variables` 后正常；已写入 README。
4. zh S6 旁白超预算（5.14>4.70s）→ 预算门拦截 → 等义缩写（§9.1）。
5. 海报初版品牌名双层叠印 + 底栏遮住卡片第四行 → 移除多余 drawtext、渐变带下移至 0.72h 以下、标语居中；像素级复核（品牌区/对照区噪声比 1.65 = 纯压缩噪声）。
6. **光标双点（Owner 评审发现）**：v1 残留 div 与 v2 按钮内 span 同 id，GSAP querySelectorAll 双驱 → 删残留、光标改停按钮右上角空白、点击后 0.3s 淡出；抽帧复验通过。全文件 id 查重无其他重复。
7. `snapshot --at` 多时间点列表在本环境不可用（单值可用）→ 视觉验证改走 review 模式与渲染产物抽帧。

## 11. 状态分列

| 项 | 状态 |
|---|---|
| 工程检查 | **PASS**（check 门禁/ffprobe/合同测试 13/13/build 全绿） |
| 浏览器视觉 | **PASS**（构建站实机 456/293px，截图在案） |
| 音频听检 | **PASS（有保留）**——客观指标全达标；「人耳听感」由 Owner 预览试听裁定（已通过预览并批准），AI 未做人耳听感 |
| 人测（SPEC §7.C 五人理解测试） | **NOT RUN**（无真实参与者；产品理解收益保持未验证，不宣称更易懂/更高转化） |
| PR | 未开（未授权） |
| 发布/合并 | 未执行（未授权） |

## 12. 未完成项与移交

- 五人访客理解测试待 Owner 组织；建议以构建站真实页面静音首看执行。
- 6 条 subcomposition 结构建议与 2 条 craft 警告为记录在案接受项，如后续拆分场景文件可消除。
- zh 响度 -19.8 LUFS 如需严格对齐 -18，可调 loudnorm I 值重混（不影响画面）。

## 13. 回滚

单一变更集回退： revert 本分支三个提交（分镜+管线 / 光标修复 / 最终资产+报告），六个 public 媒体文件由 Git LFS 历史恢复旧版（36s 旧片对象保留）。不涉及安装运行时、`.pd/` 状态或治理数据。

## 14. Complexity Delta

新持久事实源 NO；新持久状态/schema NO；新子系统/服务/后台进程 NO；新公开产品接口 NO；新运行时开关 NO；新跨包依赖 NO；新宿主平台行为 NO；新外部网络能力 NO（制作期 TTS/包下载沿用现状，播放期零服务）。新增文件均为工程内容（BRIEF/STORYBOARD/制作脚本/本地字体子集），不构成治理事实源。
