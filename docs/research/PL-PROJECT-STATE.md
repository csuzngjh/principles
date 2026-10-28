# Principle Learning 项目状态（唯一权威）

> 本文档是 Principle Learning 研究项目的唯一状态来源。后续任何 AI 执行前必须先读本文件。
> 最后更新：2026-10-25（新增 §10 Examiner 支线状态）；此前 2026-10-23；分支 `ai/PRI-966-ca-content-modes` HEAD `5c11c908b`（PR #2116）。
> 维护规则：状态变化时更新本文件对应小节；禁止另建竞争性状态报告。

## 1. 研究协议

- **唯一主 SPEC**：`docs/specs/SPEC-PD-PL-001-principle-learning-dataset-v0.3.md`（v0.2 为历史基础版本）
- 研究问题：Agent 从经验中形成的原则是否让它在未来未见任务中表现更好，且该改善能与原则抽象的独立增量区分开？

## 2. 四个研究主张及状态

| 主张 | 内容 | 状态 |
|---|---|---|
| C-E | 经验敏感性：相关历史改变候选与未来行为（方向适当），EN 不漂移 | **NOT_SUPPORTED（弱信号）**——E0 基线饱和；EB 有 P2 改善但夹杂 P4a 负迁移 |
| C-A | 抽象价值：原则文本优于摘要/原始/无 | **NOT_SUPPORTED**——policy 无任何维度优于 summary（三种子方向一致） |
| C-D | 交付增量（PD 治理管线 vs 普通 Memory） | **尚未开始**（需生产侧交付机制，超出研究侧范围） |
| C-N | 净价值（完整 PD vs 强 Memory，多维报告） | **尚未开始** |

两轮联合结论：该任务族/模型/预算下，PD 式经验内化**未能与"manual 基线+少量上下文"区分**。唯一活竞争解释：**一般上下文效应**（任意适当上下文即可，内容不重要）——待 fixture v2 裁决。

## 3. 已完成实验与结论

### C-A 三种子（PLE-PILOT-01-FORMAL，run `formal-2026-10-23/`）
- 54/55/57 请求，标价上界 $0.0574/$0.0595/$0.0612；全部 sidecar 0 problems
- policy/summary/raw/none 均 12/15 PASS；**checkCost：summary 8.3 < raw 10.3 < policy 11.0 < none 15.3**（none 过验跨种子复现）
- **结论**：C-A NOT_SUPPORTED（policy ≤ summary）；"无经验过验消除"是唯一跨轮稳定正信号

### C-E 三种子（PLE-PILOT-01-CE，run `ce-2026-10-23/`）
- 60/68/56 请求，标价上界 $0.0622/$0.0718/$0.0578；全部 sidecar 0 problems
- E0/EA/EB/EN 任务完成 11/12/11/12 每 15；EB 在 P4a 出现单机会负迁移（S3 零查验直接 proceed→损失 80）
- **结论**：经验敏感性 NOT_SUPPORTED（E0 基线饱和，EA 无差值）；方向适当性 NOT_SUPPORTED（EA/EB 未按教训方向分化；EN 聚合最优）；漂移控制 WEAKLY SUPPORTED（S1/S2 近等价，S3 分歧由 EA 离群驱动）

### 联合审计（`joint-audit-2026-10-23/JOINT-AUDIT-REPORT.md`）
- 报告数字与原始裁定零偏差；分母完整；无泄漏
- **干预保真度**：EA/EB 文本方向真实分化（三种子稳定）；EN=EA 语义改写（hash 不同=改写波动非违规）
- **最强跨轮复现**：无经验过验（C-A none ≡ C-E E0 独立出现均为最差 arm）
- **唯一活竞争解释**：一般上下文效应（未测）

## 4. Luna 宿主探索（已暂缓）

三次冒烟：①Windows 多行 argv 缺陷（修复 44eaa0306 stdin 管道+`-` 占位）；②models refresh 网络瞬态（已自愈）；③OpenAI strict schema 400（修复 6c2c6290a normalizeSchemaForOpenAiStrictFull+stripNullFields）。最终轮 1 次调用因 stdout 零事件停止——根因=事件格式不匹配（官方 snake_case vs 解析器 rollout 格式），修复 e74c41e6c 双格式解析；剩余 1 次调用额度未动。**结论**：身份可信（两次 rollout 自报 gpt-6-luna），但模型输出值级污染（损坏 JSON）+ 每轮 32.5k 宿主注入（正式实验 31.6M tokens 量级不可行）→ **Luna 路线暂缓**，转入外部模型路线。

## 5. Fixture v2（PLE-PILOT-02-G，**当前主任务**）

- **研究问题**：行为改善来自特定教训内容还是任何适当上下文？
- **五条件**：E0（基线）、**G（通用运维上下文对照，新增）**、EA、EB、EN——全部经同一 I0 管线
- **P3 修复**：纯可供性（v1 根因=120/120 asks:0，任务说"sign-off"但未映射 ask-owner 动作+requestType 词汇不可见；v2 文档化接口，gold/environment 逐字节不变）
- **顺序**：预注册确定性拉丁矩（seed1 E0→G→EA→EB→EN；seed2 EA→EB→EN→E0→G；seed3 EN→E0→G→EA→EB）——消除条件×时间混杂
- **v2 fixtureHash**：`04f732e9afdc1dd0f24824ace1b40287eff37b209750f7f664dbf72ed0b21c30`
- **preregHash**：`7bc7388b1c109fb2afeabe99eadd5cd8a2d416003302915a9e92136ec849b74f`（已绑入授权链）
- SPEC/决策报告：`runs/v2-2026-10-23/V2-SPEC-AND-DECISION.md`；最终审查：`FINAL-REVIEW.md`

## 6. Git / PR / CI 状态

- 分支 `ai/PRI-966-ca-content-modes`，HEAD `5c11c908b`（含最新 main merge），工作区干净
- PR #2116：OPEN / MERGEABLE；CI 31 pass / CLEAN（修复历程：satellite-purity 瞬态→rerun 绿；环境依赖测试删除 0a6391f05；PR 基线过期 merge main 5c11c908b；CodeQL 8 项全修 dfcdf4703+c6df59d74）
- CodeQL review threads：历史 8 项已 resolved；当前 0 未解决

## 7. 任务看板

| 状态 | 项 |
|---|---|
| **已完成** | C-A 三种子；C-E 三种子；联合审计；Luna 三轮冒烟与修复；fixture v2（G/P3 修复/拉丁矩/18 案校准/prereg 草案）；授权链（evidenceVerifier+preregHash fail-closed）；159 项离线测试 |
| **进行中** | 无（等待 Owner 批准 v2） |
| **被阻塞** | v2 正式实验（等 OD-v2-1/2/3）；C-D/C-N（依赖 v2 结果与生产交付机制）；Luna 宿主（等输出通道与模型输出质量解决） |
| **尚未开始** | 确认性实验升级（预注册升级标准已定义）；第二任务族；P3-revised 独立任务 |

## 8. 证据索引与边界

| 证据 | 位置 |
|---|---|
| C-A 产物 | `runs/formal-2026-10-23/results/`（+THREE-SEED-SUMMARY.md） |
| C-E 产物 | `runs/ce-2026-10-23/results/`（+CE-THREE-SEED-SUMMARY.md） |
| 联合审计 | `runs/joint-audit-2026-10-23/JOINT-AUDIT-REPORT.md` |
| v2 设计/预算/审查 | `runs/v2-2026-10-23/V2-SPEC-AND-DECISION.md` + `FINAL-REVIEW.md` |
| 冻结哈希 | v1 fixture `4c3ea4ab…`；v2 fixture `04f732e9…`；v2 prereg `7bc7388b…`；G1 studyHash `5a617d50…` |

**适用边界**：单任务族（动态验证权衡）、单历史对（EA/EN/EB 合成）、单模型（GLM-5.3-Flash）、n=3 种子、P3 天花板占用 20% 机会（v2 已修复）。结论不外推其他模型/任务族/生产环境。"NOT_SUPPORTED" 意为"当前证据未支持"，非"证明不存在"。

## 9. 下一阶段主任务与禁止事项

**唯一主任务**：Owner 批准 OD-v2-1/2/3 后执行 `PLE-PILOT-02-G` 五条件三种子正式实验（约 255 请求/$0.44 当量），裁决一般上下文效应假设。

**禁止**：真实模型调用（无授权时）；修改 C-A/C-E 已完成产物；修改冻结预注册或 v1 夹具；自动合并 PR；Luna 额度追加；生产 Runtime/Adapter/Hook 改动；新竞争状态文档。

## 10. Examiner 支线（SPEC-PD-EXAMINER-001，2026-10-25 增补）

- **SPEC**：`SPEC-PD-EXAMINER-001` 当前版本 **v0.4**（v0.3 增量修订，Owner 2026-10-25 采纳方案 B；v0.3 保留为 Phase 1A 冻结基线引用）。阶段恢复文档：`docs/research/EXAMINER-STAGE-G-CONTEXT.md`。
- **研究状态**：Phase 0 GO、Phase 1A DONE（冻结契约+12 题四族+评分）、Phase 1B DONE（ActorTraceV1+串行 Runner+RESULT_UNKNOWN+故障注入 10 场景）、Stage G Preflight 完成（READY_FOR_OWNER_REVIEW）。研究支线资产：`scripts/dev/principle-learning-lab/challenge-studies/CEB-001/`（冻结四哈希 mappingHash `213090da…` / grader `eef38484…` / suite `e1f2f5ca…` / prereg `01ac054b…`，与 CEB-001 题集互不触碰）。
- **方案 B（Owner 已批）**：冻结事实骨架下的受约束生成。本轮已离线实现：骨架门 `lib/challenge-skeleton.mjs`（tier：parametric/skeleton_verified/skeleton_mismatch/value_domain_violation/expression_leak/domain_proposal）、值域表 v1.0.0、validator 接线、三级+骨架去重、对抗测试 15 场景与 PAHF 启发离线夹具（澄清/证据冲突纠正）——skeleton+stageg 套件 56 项全绿，既有回归全绿。
- **已知问题（设计审查入案）**：byte-equal 重放门曾锁死表达层（本轮骨架门解决）；B 臂 36 候选含 12 对 structural 重复（duplicateRatio 基线失真，不作组间优劣证据）；validRatio(B)=1.0 天花板；成本示例曾漏除 1e6（已勘误：$10/$30→$3.20 击穿 $3）。
- **授权状态**：真实模型调用 0、真实宿主 0、生产写入 0；Stage G/R 均 NOT_AUTHORIZED；`realHostBaseline=UNKNOWN`、PRI-1037=NOT_RUN（真实宿主隔离独立阻断）。
- **待 Owner**：模型/分价单价/时薪/$3 上限重定/盲评人员/骨架边界与表达风险接受/新领域核验人/PRI-1034 实现授权/Stage G 执行授权。相关 Linear：PRI-1024（总工单，15 子单）、PRI-1034/1035/1037。
- **边界**：Examiner 支线结论不改变 §2/§3 的 C-A/C-E 主线判定；PAHF 仅作离线测试思路借鉴（不引入记忆架构/数据）。
- **PRI-1034 状态细分（2026-10-25 第二次增补，六态区分）**：工程实现 **完成**（Examiner 适配器 Mock-first 离线闭环：`lib/challenge-examiner.mjs` + 五组 26 项测试全绿）；离线测试 **通过**（含授权九类拒绝路径零 transport 调用、RESULT_UNKNOWN 恢复语义）；协议预注册 **部分**（option-b 草案+statsContract_v04，正式冻结待批）；Owner 审批 **未完成**（模型/单价/时薪/$3/盲评人员/骨架边界待决）；真实实验获准 **未发生**（Stage G=NOT_AUTHORIZED）；真实实验执行 **未发生**（真实 transport 有意未实现，零网络代码）。SPEC v0.4 已增量 §2.7/§12.7。
- **Stage R 离线授权门落地（2026-10-25 第十次增补，分支 ai/examiner-stage-r-readiness）**：`lib/challenge-stage-r-gate.mjs` + `runChallengeStudy` 接线——非 stub actor 在任何预算预留/actor 步之前必须过 Stage R 授权门（四哈希绑定/计划子集/attemptCap/有效窗/撤销/halt/注入时钟；F2 另需 PRI-1037 探针 PASSED），`run-authorization.json` 的 fail-closed 由文字变为机器强制；`deriveRealHostBaseline` 使 mock/离线证据永不产出 real-host PASS。stager 套件 30 项；13 套件（含 stager）合计 374 项全绿、freeze --verify 四哈希不变。状态不变：Stage R=NOT_AUTHORIZED、realHostBaseline=UNKNOWN、PRI-1037=NOT_RUN、真实宿主/真实请求/生产写入均 0。详见 EXAMINER-STAGE-G-CONTEXT.md §9。

- **Stage R 真实 Actor transport + 宿主适配器（2026-10-26 第十一次增补，分支 ai/examiner-stage-r-transport，堆叠于 #2139）**：`lib/challenge-actor-transport.mjs`（F1 直连 responder 复用 AMD poster 栈 / F2 宿主适配器复用 createCodexHostTransport 的 complete/hostSnapshot 权威）+ runner async 化（armPrompt 注入通道入 ctx、ambiguous→显式 RESULT_UNKNOWN、actorRounds）。宿主证据只认 transport 自身 VERIFIED 快照。新套件 27 项；14 套件 401/401 全绿；freeze --verify 四哈希不变。状态不变：Stage R=NOT_AUTHORIZED、realHostBaseline=UNKNOWN、PRI-1037=NOT_RUN、真实宿主/真实请求/生产写入均 0。详见 EXAMINER-STAGE-G-CONTEXT.md §10。

- **PRI-1037 隔离探针工程实现（2026-10-26 第十二次增补，分支 ai/PRI-1037-isolation-probe）**：`lib/challenge-isolation-probe.mjs`——SPEC §6.4「必须验证」清单可执行化（9 项检查闭集+内容锚定泄漏检测+诚实 executedIn 标记〔离线排练证据机器排除在 F2 外〕+verifyF2ProbeEvidence 深验〔rollout 佐证/防穿越/四哈希绑定〕）；runner F2 门后工厂前接线（stage_r_probe_evidence_invalid 拒绝）；F1 零影响。新套件 15 项；16 套件 451/451 全绿。**离线工程验收完成≠真实宿主探针通过**：PRI-1037=NOT_RUN（真实执行轮待 Owner 另行授权）、Stage R=NOT_AUTHORIZED、realHostBaseline=UNKNOWN。详见 EXAMINER-STAGE-G-CONTEXT.md §11。

- **行为报告生成器落地（2026-10-26 第十三次增补，分支 ai/PRI-1024-f1-behavior-report）**：`lib/challenge-behavior-report.mjs` + `generate-behavior-report.mjs`——SPEC §9.4 六维/§9.1 分母/§9.2 逐执行记录/§9.3 异常表/§10 behavior-report.json+.md/§12.4「报告可从轨迹重算」/§8 REPORT_READY 全部机器化。要点：assignedDenominator 出 preregistration.json 冻结计划（授权子集只作独立呈现绝不缩分母）；四哈希+预注册哈希+逐题 inputHash/goldHash 复用 verifyFrozenStudy 复算核验；评分语义零重定义（negativeTransfer 等逐字段引用 adjudication，边界题 boundaryRisk 独立统计）；双层模型（计划单元×attempt 全量保留，无 last-write-wins 删除，歧义多成功→AMBIGUOUS 出配对入敏感性）；重复结算/孤儿文件/账本-文件冲突/畸形 JSONL/真实模式无有效授权=critical finding→REPORT_INCONCLUSIVE 且不发事件；写路径单写者锁+tmp/rename 原子对写+事件最后追加（无事件即允许重写，无半成品 READY）+已提交 REPORT_READY 逐字节比对（一致幂等/不一致拒绝覆盖要求新 revision）；`--verify` 严格只读（无 --now 复用既有 generatedAt）；冻结 challenge-studies/ 运行时拒写（realpath 边界，非调用纪律）。新套件 17 项（Owner 补充条款强制 8 项全覆盖）+既有 10 套件 317 项回归全绿；freeze --verify 四哈希不变；冻结 CEB-001 占位符保持 NOT_RUN（字节断言）。**已用 F1 首轮真实数据只读验证**：11/3/22 结算、capacity=3、40 条恢复拒绝、token 55,010（=36,482 prompt+18,528 completion）全部与独立审计一致；机器复核另发现审计报告"4 个三臂全 PASS 配对"有误（B 臂 FV-02 未成功，A∩B 实为 3 对）——手工汇总缺陷的又一实证。与 PR #2165（stage-r-f1-report.v1 运维视角）零文件交集、互补派生视图。状态不变：真实请求/生产写入均 0；本工具为纯离线派生读模型。

- **Stage R F1 报告重算测试空转修复（2026-10-26 第十四次增补，分支 ai/PRI-1024-f1-report-test-vacuity，基于 #2165/#2167 合并后 main 85cb25d4b）**：三遗留问题收口。**A 测试空转**——#2165 的正向测试 `ROUND1_DIR` 解析到 `scripts/.tmp`（任何 checkout 均不存在）→ `if (!hasRound1Data) return` 使 Vitest 记空转为通过，CI 从未验证 F1 重算正向路径（"4 配对"错误断言因此从未被执行发现）；重写为**始终执行**的合成测试：系统 mkdtemp 目录内构造完整 36 单元 study（镜像首轮 11/22/3 分布与分臂 22/24/24 请求、确定性 token），结束只清理自建目录，零外部数据依赖。**B 配对计数**——原断言 4 个三臂 PASS 配对（含 FV-02）；实锤：生产 `buildStageRF1Report` 在真实首轮数据上返回 **3 对**（BN-02/CT-03/FV-03），FV-02/B 首轮结算为 RESULT_UNKNOWN（恢复轮才成功，属独立授权批次不可混入）——原测试断言与生产实现直接矛盾，空转完全掩盖；修正断言为 3 对+合成数据显式覆盖 FV-02/B=UNKNOWN+新增"单臂降级→配对随数据剔除"负向（防硬编码），生产配对逻辑零改动。**C 未使用变量**——`events`/`adjudications` 读取后未用；裁定其为报告完整性验证必需输入：实现账本↔文件交叉核对（adjudications.jsonl 行集 vs SUCCEEDED attempt 文件集、events UNIT_FINISHED(unit,result) vs 文件结算，双向），不一致→integrity finding（只标记不改统计），真实首轮数据零误报（36/36 UNIT_FINISHED 匹配、11/11 裁定行匹配）；新增对应负向测试（删裁定行/删事件/篡改结果/孤儿裁定行）。真实数据只读集成核验（改后）：11/22/3、70 请求、36,482/18,528 token、3 配对、0 finding 全部不变。回归 219 项（含 behavior-report 17 项）全绿、freeze --verify 四哈希不变、eslint 净。

- **报告重算账本核对两轮增量收口（2026-10-27 第十五次增补，PR #2171 分支追加 5e367915e+ea7ed072a）**：①重复/孤儿/冲突核对——重复裁定行与重复 UNIT_FINISHED 按 unit 键计数（恰好 1 条语义，重复无论同/矛盾均 finding，不静默选边），计划外单元事件出 unplanned finding；②缺 unit 记录/事件——adjudications 无 unit 字段与 UNIT_FINISHED 无 unit 字段不再被静默跳过，按文件名+1-based 非空行号出 finding，绝不匹配到任何研究单元；统计/分母/配对/schema 零变化。负向测试累计 6 类（重复裁定/同结果双事件/矛盾双事件/计划外事件/缺 unit×2 含 null 变体）；stager 夹具 codexHome 跨 UTC 日复用致 rollout 双文件 ambiguous 的时间炸弹一并修复（rmSync 先清后建，生产代码未动）。回归 10 套件 307/307 绿、freeze verify 四哈希不变。真实 F1 首轮数据只读核验本轮 NOT_RUN——atria worktree 已按 git-8 清理、仓内无存活副本（末次有效核验=5e367915e 轮：11/22/3、70 请求、36,482/18,528、3 配对、0 finding）。

- **Batch 01 UNKNOWN 恢复执行+停止（2026-10-27 第十六次增补，Owner 一次性授权 5 单元/5/50）**：执行副本 u1-u5 单单元独立授权（1/10 机器强制每单元上限）；BN-01/A、BN-01/B 各 1 attempt 均 RESULT_UNKNOWN（各 2 请求）→ **连续两单元 UNKNOWN 触发停止条件**，BN-01/C、TC-01/A、TC-01/C 未执行。**同构失败模式**（三单元含 BN-03/A）：第 1 请求正常完成（身份服务端观测 12.9-35.9s）→ 第 2 请求起 awaiting_headers 480s 无数据流——失败与单元内容无关，通道/连续请求行为问题（根因不推断）。剩余 UNKNOWN 仍 18（15S+18U+3F）；累计 60 attempts/127 requests（≤64/≤1440）。报告全过（u1/u2 REPORT_READY+verify+F1 重算 integrity 零+冻结不变）。**裁定：停止当前通道恢复**——待 Owner 供应商核实/换通道决策。此前同轮：PR #2174 决策记录已并入 main（AI-only 评审收口+E 臂暂停）；canonical roster=.tmp/batch01/UNKNOWN-ROSTER.md（CT-01/A 系诊断重复执行的发现入档）。

- **keep-alive 缺陷修复+真实验证批成功（2026-10-27 第十七次增补，PR #2177 merge 9d1a1a875 + BN-01 双单元验证）**：通道根因修复（poster 未指定 agent→Node≥19 默认 keepAlive 复用死连接；修复=模块级 keepAlive:false agent，确定性 HANG 复现测试 5 项）合并后**真实验证 2/2 执行成功**——BN-01/A SUCCEEDED·PASS、BN-01/B SUCCEEDED·FAIL（no_report+forbiddenBehavior=true，非预算截断、B 臂边界题真实行为数据）；身份全观测 glm-5.3-flash；2 attempts/8 请求/token 13,726；剩余 UNKNOWN 18→16（17S+16U+3F）。授权链 62/135。**通道阻塞解除**；CodeQL L216=原有告警已解决。待 Owner：小批恢复续行（BN-01/C+TC-01 A/C 优先）与授权链扩上限（余 2 不够，需 64→≥82）。

- **Wave 1 高信息量批+首批判别信号（2026-10-27 第十八次增补，墙钟优先指令）**：并发执行 BN-01/C（S·FAIL no_report+forbidden）+TC-01/A（S·PASS）+TC-01/C（S·PASS），3/3 成功、身份全观测、三报告全过、冻结不变；剩余 UNKNOWN 16→13（20S+13U+3F）；授权链 65/65 attempt 顶格（+1 定向扩额已按 Owner 指令口径入授权记录）。**判别信号（n=1 描述性）**：TC-01 首个 B 特异差异（A PASS/B FAIL/C PASS）；BN-01 注入臂同败（B/C 均 no_report FAIL，B≠C 未分化）；4 完整 case 仍天花板。恢复旧单元已证能产出判别 case。核心问题仍不可判定但已具两个待重复信号。待 Owner：链扩额 65→≥82 或转 suite revision 评估。

- **CEB-001 收口+CEB-002 设计交付（2026-10-27 第二十一次增补，Owner 阶段转换指令；同时包含本分支视角的第十九/二十次增补内容摘要：Wave2 全量恢复 13/13、36/36 结算、终局 NOT_EVALUABLE、TC-01/B 断言勘误、口径二轮精确化——详见 PR #2179 分支）**：①CEB-001 F1 正式收口（终局 NOT_EVALUABLE 维持；可评 31=A10/B9/C12、三臂全可评 7 case、A 臂 10/10 天花板；PRI-1036 置 Done）；②CEB-002 完整设计交付：16 题（L1×3/L2×4/L3×4 难度梯度+B×5 边界多情境）全部以冻结 B1 基线为骨架（validator eligible 档逐题过，零新 Gold）、B/C 载荷 verbatim 复用（字符比 1.11）、三重 DRAFT/NOT_AUTHORIZED 占位；离线验证七项全过（ceb002 套件 6/6+回归 158/158+CEB-001 freeze 不变）；预注册=McNemar 精确主指标（B vs C 判别层，探索性+升级条款至 4 rep）；预算=96 attempts/960 上限/订阅通道/并发 3/墙钟 50-70 分钟；交付包 docs/specs/CEB-002-DELIVERY-PACK.md（Owner Review Card 一次决策）。待 Owner：冻结+预注册生效+执行授权三合一。

- **Wave 2 全量恢复+研究终局判定（2026-10-27 第十九次增补，Owner 自主恢复授权 65→78）**：13/13 全 SUCCEEDED·PASS（含 BN-03/A 异常类）；36/36 结算=33S/0U/3F(429)；链 78/78 attempts 顶格、179/1440 requests。**勘误**：撤回 Wave 1 的「TC-01 B 特异差异」（TC-03/B 与 TC-01/B 混淆，TC-01/B 裁定不可考）；上轮 143→145 requests 笔误。**终局判定 NOT_EVALUABLE**：正向天花板（A 臂 10/10 PASS，8/9 完整 case 三臂全 PASS）+负迁移唯一判别 case=BN-01（注入臂同败，B≠C 未分化，「一般上下文效应」未排除）+单重复。现有题集无法进一步区分假设→**停止恢复（UNKNOWN 清零），提交 suite revision 提案**（负迁移维度加密度+正向难度分布，不动 CEB-001）。keep-alive 修复后 18/18 可恢复单元全部成功=通道根因闭环实证。

- **Stage G round7：第一批真实有效 E 候选（2026-10-25 第六次增补）**——Owner 切换书生平台 DeepSeek-V4.1-Flash-1017（墨点计费）。执行链：Atria-Dawn 连通验证✓ → round3 16×404（URL 拼接缺陷，修复+回归钉死）→ round4 16 请求（13 超时 UNKNOWN+2 失败+1 拒）→ round5 R2 首批 6 候选但逐字回显（输入契约缺陷）→ **merge 采纳管线落地**（challenge-adopt.mjs：E=表达层，管线机械合并冻结骨架不可变字段——Gold 结构性不可注入）→ 生成契约澄清（改写义务+字段映射+回显零新颖性）→ **round7 R1 成功：6/6 候选采纳（全部 skeleton_verified、taskText/fact 全改写互异、Gold 零接触、declaredBaselineMismatch=0）**。请求 8/16 消耗（1 成功+2 UNKNOWN+5×429），8 个保留待通道窗口。盲评 PENDING（评审者未指派，包已备）。指标：round7-metrics.json。
- **Stage G 第二轮（DeepSeek 正式实验）完成（2026-10-25 第七次增补）：12/12 真实有效候选**——Owner 选定书生平台 deepseek-v4.1-flash-1017（墨点计费，余额 4,461）。Atria-Dawn 免费验证 ✓。执行链：round3 16×404（URL 拼接缺陷修复）→ round4 16（13 UNKNOWN+2 失败：240s 超时）→ round5 首批 6 候选逐字回显（输入契约缺陷）→ **merge 采纳管线+生成契约澄清**（透明预注册 r6/r7）→ **round7：2/16 请求成功产出 12/12 真实有效候选**（全部 skeleton_verified、taskText/fact 全改写互异、Gold 零接触、declaredBaselineMismatch=0、结构重复 0）；其余 14 请求=429×12+UNKNOWN×2，24 空槽全量保留。局限：E 未行使参数变化权（网格覆盖 6/110）；盲评 PENDING（评审者未指派）。指标：final-round-metrics.json。
- **Stage G round8+round9 续跑（2026-10-25 第八次增补）：通道持续饱和，E 组维持 12/36**——round8 6×429 停止（10 请求保留）；round9 6×429 停止（10 请求保留）。DeepSeek 免费通道饱和跨越多个时间窗（间隔 >1h 仍 429），为平台级持续争用而非瞬态抖动。AI 盲评已归档（18 条，8 关键门槛失败，10 有效）。累计：round7 12 + round8 0 + round9 0 = 12/36 有效候选。
- **Stage G 候选总账核验+盲评包扩展（2026-10-25 第九次增补）：60 adopted envelopes 全量入包**——round7 12 + round8 6 + round10 42 = 60 total；36 唯一 candidateId 锚点（部分基线多轮改写→多表达）；52 unique skeleton+param combos；60 unique taskTexts（0 重复）；17 unique param points。盲评包扩展至 60 RV（RV-001..060，泄漏自检 CLEAN）。**待 Owner：指派盲评者 2+1 → ChatGPT AI-only 盲评 → 表达质量数据 → 研究结论。**
- **Stage G 首轮真实实验完成（2026-10-25 第五次增补）：E 组 NOT_EVALUABLE**——预注册冻结（E 前）→ 授权执行 → 四轮共 80 次真实 HTTP 尝试（AMD 32×网关 403 形态敏感；intern-s2 16×404 URL 缺陷作废 + 16 超时/连接失败 + 1 恢复拒绝），**零模型输出、零候选**。transport 沿革：h2→node:https 1.1→intern-s2 适配（reasoning_content 输出字段、无 reasoning_effort）；全部完整性门（截断/超候选/身份/预算）实测有效。授权 halted（预算耗尽）。**待 Owner：E 臂供应商策略**（等待窗/付费层/换端点/暂停）。B0/B1 资产与全部离线能力保留可复用。
- **Stage G 首轮真实实验执行（2026-10-25 第四次增补）**：正式预注册冻结（E 前）→ 授权签发（Owner 指令为据，24h 窗，占位留痕）→ round1 16 请求全 403（undici h2 网关不兼容，判基础设施缺陷作废，transport 重写 node:https HTTP/1.1）→ round2 16 请求 HTTP/1.1 仍全 403。诊断矩阵定位：网关对「中等体积中文 JSON+内嵌命令串」请求形态敏感（良性/ASCII 200；真实负载 403/502/挂死）→ **E 臂 NOT_EVALUABLE，授权 halted（防盲耗）**。执行记录全保留（stage-g-execution/round1,2 + round-halt-record.json）。候选 0、模型 token 0、盲评 N/A。**待 Owner：网关处置 4 选项（AMD 反馈/重试窗/备选 intern-s2/暂停）**。
- **B0/B1/E 对照设计（2026-10-25 第三次增补；同日收口轮升级）**：完整合法空间经**实际枚举逐一体全验**核实=31,680 组合/0 失败（~7s，指纹 8a46476e…测试钉死）；**stakes 为纯标注维度**（裁定逐字节相同）→ 实质决策情境=3,960。B1 升级 **v2=exhaustive-verify-then-select**（方案 B 采纳；v1 保留历史）。B0=历史参考（3 唯一参数点）；E=同空间同门实验组。双口径覆盖率+结论边界四问见 `protocol-b0-b1-e-comparison.draft.json` v2（PROPOSED，B1 v2 待 Owner 认可后冻结）。b1 套件 18 项全绿。

- **CEB-002 合并后一致性收口（2026-10-27 第二十二次增补，Post-Merge Consistency Gate）**：PR #2182 已并入 main（merge `83afa4596`，CI 23/23 绿）——CEB-002 工程实现与统计修正正式进入主干。一致性门四项核验：**A 预注册契约**——根因确认：build-ceb002-suite.mjs 每次重建会覆盖 preregistration.draft.json，手工修订在验证轮被覆盖回最小占位；修复=将完整主分析契约（探索性定位/96 单元/n=8 独立配对/reduceCaseLevel 预固定规则/精确 McNemar 角色/功效 0.145 上限/16 与 32 配对参考视图标注/无自动升级/句数混杂/主张边界/停止规则）**内置到构建器**，重建始终产生同一契约；新增契约一致性测试（1a）逐字段断言与运行器语义一致。**B 交付包口径**——§6 审批卡可支持结论更新为主分析 n=8 判别层+描述性效应估计为主+精确检验仅否决门+参考视图标注。**C 引用修复**——preregistration.draft.json 的 authority 字段指向 CEB-002-DELIVERY-PACK.md §2（移除对不存在的 CEB-002-PREREGISTRATION.md 的引用）。**D 状态文档**——本条即记录。验证：CEB-002 套件 7/7+回归 4 套件 81/81+eslint 净+CEB-001 freeze 不变+CEB-002 三重 DRAFT/NOT_AUTHORIZED/NOT-IN-FORCE 确认。**冻结、预注册生效、真实执行三项均未获本轮授权，待 Owner 最终审批。**

- **CEB-003-P Pilot 三合一完成（2026-10-28 第二十三次增补）：96/96 合法结算，四项操作可行性目标全部达成**——Owner 2026-10-28 Goal 指令一次性批准冻结+预注册生效+96 单元真实执行（branch `ai/adhoc-20261028-ceb003p-pilot-ab383c-research-pilot`，基点 origin/main 48c41925f）。**冻结**：`prepare-ceb003p-freeze.mjs`（可复现构建器，写入前全量断言）——16 题与 CEB-002 冻结套件逐字节一致（每题 inputHash/goldHash 与 CEB-002 冻结 manifest 相等，机器证明）；arm C=C-prime 自然经验叙事 v1.1.0（文本 SHA `116fbaea…`，arm payloadHash 即该哈希；正式名 natural experience narrative control，无匹配标准宣称）；四哈希 suite `dec7ba63…`/studyPlan `413673be…`（mapping/grader 沿 CEB-001 共享链）；确定性复演、Gold 泄漏扫描 CLEAN、C' 六规则语义审计 allRulesClean=true、CEB-001/002 冻结不变。**机器增强**：Stage R 门禁新增 `maxRequestsPerAttempt` 授权绑定（闭键集+精确声明纪律+上限 40），runner 经预留拒绝实施每 attempt 请求上限（请求未发出即终止）；`--repetitions` CLI 解析移植（CEB-002 真实执行所用未提交修改）；cli-f1 +6 测试，挑战回归 249/249 绿。**授权**：APPROVED（glm-5.3-flash/bigmodel Coding Plan/96/960/480000ms/每 attempt 10/24h），12/12 负控（身份未注册/双哈希漂移/过期/未生效/超预算/每单元上限不匹配/revoked/halted/未知字段/臂越权）+正控 dry-run 全过。**执行**：串行逐单元调度（并发 1）+逐单元停止条件+每 8 单元七项批门（12 批全绿，含 behavior-report 生成+verify、freeze verify、审计重算、账本交叉、身份、哈希链 dry-run、预算窗口）；96/96 全 SUCCEEDED、291/960 请求（平均 3.03、最大 5）、身份 291/291 服务端核验、净墙钟 ~94 分钟；期间一次编排器 verify 判据笔误致第 1 批门假停（七项实过）→修复→离线重跑全绿→恢复，恢复机制真实验证。**结果（描述性）**：A 30/2、B 26/6、C' 25/7；VIOLATION_ABSTENTION 可测量成立但非 B 特异（A1/B3/C'3，仅 L2-05/C' 双 rep 稳定；35/48 配对稳定、13/48 翻转）；边界层三臂 30/30 零负迁移；L1 锚点 A 臂 67%、L2/L3 A 臂满分（判别空间形态与 CEB-002 不同）。**结论边界**：预注册混杂（抽象×形式）未消除，B vs C' 不可因果归因；无假设检验；结果不并入确证样本、不调样本量。Token 505,461。报告 `docs/research/CEB-003-P-PILOT-FINAL-REPORT.md` + SHA-256 清单（170 文件，与清单头部自述及实际条目数一致；2026-10-28 合并后评审勘误，原文误记 165）`docs/research/CEB-003-P-SHA256-MANIFEST.md`。CEB-002 冻结+执行态归档见第二十七次增补。

**Phase 2a 终局裁定依据交付（2026-10-28 第二十四次增补，PRI-1035，branch `ai/PRI-1035-phase2a-final-adjudication`）**：`stage-g-phase2a-final-metrics.mjs`（可导出复算函数+CLI，确定性离线）+ `stage-g-preflight/phase2a-final-metrics.{json,md}` + 复算测试（含确定性双跑）+ 终局报告 `docs/research/CEB-001-PHASE-2A-FINAL-ADJUDICATION.md`。**新审计发现——机械×评审失败集收敛（信封级）**：修复后 validator 的 OBS-D1 方向守卫与 AI-only 评审关键门槛在 60 信封上识别出**完全相同的 20 个失败**（`(requestId,candidateId)` 联接集合相等，fail-loud 断言+CI 钉死），PR #2174 的「20 失败根因=OBS-D1 共享库缺陷」归因升级为双独立方法交叉证实。八项必报指标全量落库：B1 参数覆盖 36/110 vs E 17/110（B1 优）；机制覆盖 8/8 平局；E `non_duplication` 仅 12/40（表达新颖性语义层弱于机械唯一性）；人工修订 `NOT_MEASURED`（manualRevision 事件=0，AI-only 无计时）；成本=$0（11 成功请求全 `free_tier_zero_cost`；141 请求/60 信封=2.35 请求/信封；token 为演练值不作计量）。结论边界四问更新：表达质量与人工修订成本**不可判**（无 B 侧盲评面+未测）、有限预算选择 E 无一项优于 B1。**Owner 决策卡待裁**：A1 `ENUMERATION_SUFFICIENT`（数据支持：可判维度零增量+CEB-002/003 题集事实上已全部以 B1 基线构建并被真实执行消费）vs A2 恢复 E 臂（需新 Stage G 授权+付费通道+双盲补课）；附带协议 v2（`PROPOSED_NOT_APPROVED`）冻结认可。孤儿资产入库：B1 公平性套件 18 项+AMD transport 套件 15 项（此前仅存主检出未跟踪文件，CI 从未跑过）+round1/round3 驱动与 round1 指标脚本。已知复算缺口如实披露：仓内盲评包构建器停在 round7 时代 12 候选版本，60 候选扩展轮构建器状态未入库——已提交包为权威证据，不重建第二副本。验证：五套件 91/91 绿+freeze --verify 四哈希不变+零网络零生产改动。**PRI-1035/PRI-1024 不因本报告置 Done——A1/A2 裁定生效以 Owner 明示为准（OWNER-DECISION-2026-10-27 §3 保留）。**

 **PRI-1039 Phase 3 C 臂延期评估（2026-10-28 第二十五次增补，branch `ai/PRI-1039-phase3-c-arm-deferral-eval`）**：逐项核对 PRI-1039 契约与三个既有 summary/narrative 对照臂——CEB-001 C（NOT_EVALUABLE）、**CEB-002 C（`EXPERIENCE_SUMMARY` 512B vs B 515B 载荷冻结+预注册+96 单元真实执行，B vs C 精确 McNemar p=1.0 NOT_SIGNIFICANT、描述性 B 24/32<C 28/32）**、CEB-003-P C′（明确不满足匹配摘要契约，混杂已声明仅作历史证据）。三源一致指向「Principle 未观察到优于 Summary」；确证性 C 臂须先解决载荷混杂（抽象×形式）再独立预注册授权，与 CEB-002 确证轮设计同属一个决策簇。**决定建议=DEFER**（挂载未来确证轮；期间 SPEC 禁令持续生效：不得声称 Principle 优于 Summary）；不永久关闭（RQ6 为正式研究问题+现有探索性结论功效有限）。评估文档 `docs/research/PRI-1039-PHASE3-SUMMARY-C-ARM-DEFERRAL.md`；PRI-1039 状态维持 Todo（真实阻塞=PRI-1035 In Review）。同轮复核：PRI-1037 隔离探针工程实现在当前 HEAD 回归仍绿（真实宿主探针执行维持 NOT_RUN，仅作 F2 门）；PRI-1038 前置均未满足、零 F2 动作。

- **Phase 2a Owner 裁定落地（2026-10-28 第二十六次增补，PR #2195 追加提交）**：Owner 裁定消息全量入库为决策凭证 `stage-g-preflight/OWNER-DECISION-2026-10-28-PHASE2A.md`——**决策 1：A1 `ENUMERATION_SUFFICIENT` 采纳**（B1 v2=当前阶段出题路径；不恢复当前 E 臂；Stage G 真实生成授权维持 NOT_AUTHORIZED；Owner 理由=可判维度无增量+题集已基于 B1 构建并被真实执行消费+恢复成本缺乏增量收益证据）。**决策 2：对照协议 v2 批准冻结（附三条件）**——冻结文件 `protocol-b0-b1-e-comparison.frozen.v2.json`（源草案原样保留、sha256 `78a50342…` 字节绑定；条件=冻结非最优宣称/修改须变更理由+版本记录+可比较验证/禁 results-driven 调基线；修改只能以 v3+ 新文件+决策记录形式）。终局报告 §10 决策收口、状态行更新为 ADJUDICATED；复算测试新增冻结不变量 describe（草案原样+sha256 绑定+三条件+决策记录存在，CI 钉死）。**未决**：PRI-1039 延期认可（PR #2197）与 PRI-1038 F2 授权不在本次裁定范围。PRI-1035 验收三条件齐备，工单收口随 PR #2195 合并完成。


- **S2 收口推进：双 PR 合并+Linear 对账+探针授权链落地、真实探针轮 BLOCKED_ON_OWNER（2026-10-28 第二十七次增补，branch `ai/PRI-1037-probe-auth-and-runner`）**：Owner S2 指令（D1–D4）执行——**D4 合并**：#2195 已并（merge `85ce848fc`，合并后 CEB-001/003-P freeze VERIFY OK+四套件 66/66 绿）；#2197 已并（merge `3c12b83f7`，rebase 解决 PL-PROJECT-STATE 增补排序 24→25→26，合并后冻结/文档/CI 复验全过）；**#2194 未并**（`archived-authorization-gate` 自然过期时间门 CEB-003-P 窗至 2026-10-28T17:13:04Z，当前 01:40Z 未到；禁止提前）。**D1/D2 Linear**：PRI-1035 置 Done（#2195 合并+报告可复算+A1 有效三条件齐）；PRI-1039 移 Backlog 延期（评论含延期理由/阻塞条件/重启标准+双禁令：不得声称优于 Summary、不得声称已证等效）。**S2-C 探针**：PRI-1037 真实宿主隔离探针的授权链落地——新增 `lib/challenge-probe-authorization.mjs`（closed-key-set/严格时钟/冻结哈希复算绑定/gate-order 不变量）+ `run-isolation-probe.mjs`（fail-closed：授权门先于 transport 构造，`--dry-run` 零派生证明）+ `CEB-001/probe-authorization.json`（NOT_ISSUED，四哈希绑定）+ 测试 8 项（含 NOT_ISSUED 钉死 PIN）；探针套件回归 81/81 绿。**真实探针轮 BLOCKED_ON_OWNER**：目标宿主（本机 Codex CLI 0.165.0=host-actor.mjs 权威适配器）当前仅配置 OpenAI provider（config.toml model=gpt-6-astra；rollout 佐证 model_provider=openai；无 bigmodel/智谱 profile）——S2-D1 明令禁 OpenAI 模型且不得擅自换供应商，故按指令报告阻塞：Owner 须裁定 A）为 Codex CLI 配置智谱 provider B）指定其他已批准宿主 C）豁免（不建议）。F2（PRI-1038）维持未启动；#2194 合并窗口开后按 D4 序第三位执行。
- **CEB-002 执行证据正式归档（2026-10-28 第二十七次增补，Evidence Archive；同日 Owner P1 评审修复轮（原第二十四次——与并行会话增补编号冲突，合并时顺延））**：CEB-002 冻结+执行态（此前唯一存在于 worktree `adhoc-20261027-ceb002-consistency-4c9c71` 的未提交状态，源 HEAD detached `208293951`）以零转换字节复制归档入库（归档 worktree `ai/adhoc-20261028-ceb002-archive-9f1959-evidence-archive`，基点 origin/main `fa80623d38`=#2193 合并提交）。**归档时只读核验全过**：freeze `--verify` 双侧 OK（suite `02cbc15c…`/studyPlan `bd0a8408…`）；96 单元 1:1:1:1 精确对应（运行文件=RESERVE=ATTEMPT_RESULT=裁定行各 96）；终局审计重算 96/96 全 SUCCEEDED、298 REQUEST_RESERVE≤960、身份唯一 glm-5.3-flash、token 251,691+274,759；behavior-report `--verify` exit 0（归档副本）+归档研究目录轨迹再生复验 exit 0；授权链门禁 dry-run（窗口内模拟钟）OK（退役实施前完成）；CEB-001 与 CEB-003-P 在 `fa80623d38` 冻结不变（双 VERIFY OK）；敏感扫描 CLEAN；源→归档 146 研究文件逐一 sha256 字节一致。**归档内容**：`challenge-studies/CEB-002/` 冻结套件+三层账本+96 运行记录、`prepare-ceb002-freeze.mjs`（可复现冻结准备构建器）、`docs/research/ceb002-execution-archive/`（终局报告+决策报告（含"A=C 汇总口径"勘误）+behavior-report 对+2026-10-28 审计重算+ARCHIVE-README 转换记录）+153 文件 SHA-256 清单（含 4 个排除源哈希存证）。**排除**：已废决策包（matched-summary 提案，被 CEB-003 契约收口取代）、一次性工具/会话日志（哈希存证）；源 worktree 的 `run-challenge-study.mjs` 未提交移植与 `CEB-003/` 目录=main（#2193）已含的冗余副本。**本归档不改变任何研究结论**（CEB-002 探索性：McNemar p=1.0，B 臂 VIOLATION_ABSTENTION 为描述性信号）。**Owner P1×2 评审修复（PR #2194 修复轮，见 ARCHIVE-README §6 全文）**：①归档授权窗口内"账本耗尽≠全局撤销"（门禁与目录账本=不同检查，截断账本副本可过门禁）→实施**授权退役注册表**隔离方案（`challenge-studies/authorization-revocations.json`+Stage R 门禁退役拒绝：精确元组匹配、任意时钟任意副本即拒、注册表随 lab 代码加载、畸形响亮失败、CEB-002/CEB-003-P 双退役，9 项测试机器验证；历史记录字节零修改；自然过期留作独立后备）；②预注册 status DRAFT/frozenAt null/NOT_AUTHORIZED 与冻结+执行叙述冲突=冻结工具从不转换状态字段的缺口→原文保全+ARCHIVE-README §6.2 显式记录+批准链核对（"执行在绑定预注册确切字节的授权下进行"有证据：studyPlanHash 绑定+96/96 linkage+首请求 12:25:13Z 晚于签发 12:22:47Z；"状态字段被证据证明收口"无证据；follow-up=冻结工具状态转换机制）。修复后全 lab 回归 337/337 绿。源 worktree 与其 `.tmp/ceb002-final` 本轮保全未动，待归档 PR 合并后按 AGENTS git-8/git-14 门控另行走清理。
