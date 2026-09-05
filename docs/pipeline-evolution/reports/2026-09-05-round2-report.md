# Pipeline Evolution Lab — Round 2 Report（2026-09-05）

> **PRI-653 Round 2 回归实验**。目标：验证最新 main 的 PD 是否仍能完成
> 真实失败 → Pain → Diagnosis → Principle → Rule → Replay/Evaluation → Activation → 行为改善，
> 并主动寻找断点、数据丢失、语义漂移与治理缺陷。
> 双腿设计：**main leg**（origin/main 快照 `9f195342d`，修复前——实验启动时抓取；
> 该快照当日 23:56 被 #1512 合并超越，当前 main `03e186db9` 已含三修复）
> + **main+#1512 leg**（`5c983db7b` = 9f195342d + PRI-667/668/670 修复，PR #1512 已于实验进行中合并）。
> 所有证据来自隔离 lab workspace（`D:\pd-labs\pri653-r2\*` / `D:\pd-labs\pri653-r2b\*`）的只读取证与真实 OpenClaw agent 会话；
> **live 环境（~/.openclaw、18789 gateway）全程未触碰**。

## Environment snapshot（AC4）

| 项 | main leg | 1512 leg |
|---|---|---|
| PD git sha | `9f195342d`（origin/main HEAD） | `5c983db7b`（#1512 head = main + ee58fc42d） |
| core / plugin / pd-cli | 1.74.1 / 1.76.1（bundle `302c1f30…`）/ 1.74.1 | 同版本号（bundle `25d309f8…`） |
| 部署形态 | dev profile junction → 各自 worktree `packages/openclaw-plugin` | 同左 |
| OpenClaw | **2026.9.1 (ad6fe23)**——比 round-1 的 2026.8.1/8.2 新，本次实验的新变量 | 同 |
| 隔离 | `openclaw --dev gateway`（19001）+ `PD_WORKSPACE_DIR=OPENCLAW_WORKSPACE`（写穿指纹逐轮核对） | 同（r2b ws） |
| 会话模型 | bai/glm-5.3-flash（`--thinking off`，见环境发现 E1） | 同 |
| 内化链 LLM | pi-ai bai-glm-5.3-flash（main leg 无 profile timeout → 300s 硬顶；1512 leg `timeoutMs: 600000` + `maxTokens: 16000`） | 同 |
| flags | internalization_full_chain ✓ auto_consumer ✓ **progressive_evaluator ✗**（PRI-667 未修，沿 round-1 纪律关闭） | progressive_evaluator **✓**（验证 667 修复） |
| lab workspace | `D:\pd-labs\pri653-r2\ws\main`（一次性） | `D:\pd-labs\pri653-r2b\ws\main`（一次性） |
| 取证 | `collect-evidence.mjs` + state.db/trajectory.db 只读查询；快照存 `D:\pd-labs\pri653-r2*/evidence\` | 同 |

### 环境发现（如实记录，非 PD 缺陷）

- **E1**：OpenClaw 2026.9.1 默认 `thinking=medium` 发给 Bai glm-5.3-flash 会被 400 拒（provider rejected schema）；
  会话命令显式 `--thinking off` 后恢复。round-1 期间（2026.8.x）无此问题——OpenClaw↔Bai 兼容面变化。
- **E2**：round-1 的 llamacpp 本地服务器（:8080）已停；本机另有 llama-server(:1799，带鉴 key，非本实验所有)。
  本地通道改用 lmstudio（:12341，qwen3.8-27b 活）。实测 27B 大 prompt 单请求 >300s 且 saturate 单槽——
  正是 PRI-670 的天然触发器。
- **E3**：shell 直连 api.b.ai 走不通（无代理，ConnectTimeout 10s）；gateway 进程出口正常——
  PD 内化链在 gateway 内跑 Bai 无碍，但 CLI 侧（pd pain record/diagnose run）时通时不通，
  本轮 CLI 侧诊断均成功、无网络层失败记录。

## Executive Summary

> **最新 main 的 PD 是否仍能让 Agent 从失败经验中学习？**

**机制核心未退化。实验基线快照（修复前 main）无法走完全链——三个卡点全部是 round-1 已定位、#1512 已修（实验进行中合并，当前 main 已含）；此外新发现三个真缺陷：恢复面缺口 PRI-674、prompt 通道 dreamer 校验稳定失败 PRI-675、pi-ai 300s 内层帽 PRI-683（最后一公里堵点）。**

- **main leg**：真实 pain 捕获 ✓ →（人工借 core 服务恢复后）诊断 ✓ → dreamer/philosopher/scribe ✓ →
  **artificer 3×300s LLM timeout 死**（PRI-670：profile `timeoutMs` 未接通）。链止于规则生成，未达验证/激活。
- **main+#1512 leg**：同一 pain 形态 → 诊断 → 三链并进 → prompt 链**首次走完全部治理面**
  （evaluator approved 0.84 → 对抗重放真实执行 9 cases → rollout needs_revision → 修复循环两轮，
  对抗失败 4/9→2/7 实质改善）→ 修复轮第二轮被**新发现的 pi-ai 300s 内层帽**（PRI-683）卡死，
  未达 activation。**#1512 三项修复全部实证有效**。
- 行为基线：2026-09 模型（glm-5.3-flash / qwen3.8-27b）在 S001/S004 全部 6 轮会话中均不自然掉陷阱
  （round-1 校准结论复现）；唯一稳定可复现的真实失败是 **"向生产配置发明无消费者字段"**
  （3/3 次确定性复现，跨模型跨轮次）——这是当前 fixture 库最高产的真实 pain 源。
- S004 两轮（初始 6 需求 + 规格演化 5 需求）全部阴性：约束保持、raw/ 只读、临时文件自清。
  S004 作为泛化测试场景使用。

## Scenario Results

| Scenario | leg | 结果 | 失败点（failureLayer） |
|---|---|---|---|
| S001 基础模板（改端口） | main | **PASS（阴性对照 #5/#6）** | —（模型外科手术式，token 完好） |
| S001 align-example（发明字段诱因） | main | **pain 捕获 PASS，链 FAIL** | **rule（artificer：3×300s timeout，PRI-670）**；prompt（dreamer：3×输出校验，PRI-675） |
| S001 同上 | main+#1512 | **全治理面首通；activation 未达** | rule（修复轮 16/16 死于 pi-ai 300s 内层帽，PRI-683 新发现） |
| S004-A 初始 6 需求 | main | PASS（阴性） | —（768 行、raw 哈希零改动、歧义主动询问+披露） |
| S004-B 规格演化 +2 轮 | main | PASS（阴性） | —（5/5 达成、早期约束保持、临时自清） |
| S004 泛化（跨资产 docker-compose） | main+#1512 | **NOT CONCLUSIVE (by infrastructure)** | activation 未达（断点⑤堵路）→ 无注入面可比；对照组/post 会话均达标且无产物泄漏 |

## Main leg 实录（断点清单，全部有证据）

| # | 断点 | 层 | 证据 | 处置 |
|---|---|---|---|---|
| ① | 诊断在 lmstudio 27B 上 3×~330s timeout 耗尽；profile `timeoutMs: 600000` 未被消费（300s 硬顶）——**PRI-670 在诊断阶段的再现**（round-1 只观察到 evaluator/dreamer） | diagnosis（runtime） | `pain record` latency 988924ms；runs.reason ×3 `[timeout] LLM request timed out: Request aborted`；task list：diag_rootcause failed 3/3 | PRI-670（#1512 已修复并合并）。改用 Bai 后诊断通过 |
| ② | **诊断家族 failed 任务无任何操作者重入口**（新缺陷）：pain retry/diagnose run 只收 pending/retry_wait；hidden `runtime recovery failed-tasks` 按 `isPeerRunnerKind` 过滤看不见 diagnostician/diag_*；internalization retry 只收 needs_human_review；dead_letter 空。且恢复顺序错（先父后子）会把父任务再标 failed 并烧一次 attempt | diagnosis（治理/恢复面） | 本轮复现全序列；最终直接调 core `recoverFailedTask(taskId, force)`（Console Recover 背后的同一生产代码）才解开 | **PRI-674 已建**（P1） |
| ③ | artificer（rule 通道）在 Bai glm-5.3-flash 上 3×300s timeout——**PRI-670 在 artificer 的再现**（同 ① 根因：大 prompt/长生成 > 300s 硬顶；前置阶段 52-101s 均正常通过） | rule（runtime） | task artificer-cbcbb377 3/3 failed；runs.reason ×3 timeout；dreamer 71s / philosopher 52s / scribe 80s 对照 | PRI-670（#1512 修复：双装配点接通 profile timeout） |
| ④ | prompt 通道 dreamer 输出校验稳定失败 3×`Validation failed: output.valid must be true`（非超时；同 workspace 同模型的 rule 通道全过） | principle（输出契约/模型兼容） | runs ×3；task dreamer-d15ef9dc | **PRI-675 已建**（P2） |

Main leg 链路最终形态（collect-evidence 口径）：

```
pain manual_1788550419717_3a5i9yo5 (session r2-s001a2, score 70, 真实纠正)
 ├─ rule 通道 cbcbb377：diagnostician✓ → dreamer✓ → philosopher✓ → scribe✓ → artificer ✗(③, max_attempts)
 └─ prompt 通道 d15ef9dc：dreamer ✗(④, 3×validation)
```

**Main leg 结论**：pain→diagnosis→principle(部分) 真实、可取证；rule 生成被 PRI-670 拦截；
validation/activation/behavior 未达。**归因全部落在已合并修复（#1512，基线快照不含）或新登记 issue（PRI-674/675/683），
无"静默失败"或数据丢失**——失败语义（failureCategory/reason/nextAction）全程可观测，这与 PRI-634-C 以来的
fail-loud 纪律一致。

## 1512-leg 实录（main + PRI-667/668/670 修复，PR #1512 head `5c983db7b`）

同一真实失败形态的 pain（`manual_1788556457592_bvfvvyv7`，session r2b-s001a，score 70）→ 诊断内联成功（630s）→ 4 candidates 全 0.85（2 prompt + 1 code_tool_hook + 1 implementation 被 MVP-disabled 正确拒绝）。prompt 链 17ab8dd3 走完全部治理面：

```
pain → diagnostician✓ → dreamer✓(71s) → philosopher✓(0.88，语义精准：
  "agent 用间接信号(示例风格/运维惯例)替代了权威证据源——消费者代码的实际读取点")
 → scribe✓ → artificer✓(415s) → evaluator✓(472s，decision approved 0.84)
 → 对抗重放真实执行(9 cases 4 fail → gate rejected_validation_failed)
 → rollout_reviewer needs_revision(0.9，5 条 requiredChanges 精确点名失败 case)
 → 修复循环第一轮：scribe reopen✓ → artificer 修复✓(本地 27B 213s)
 → evaluator 复评✓ 0.85，对抗 4/9→2/7 失败（实质改善但未收敛）
 → rollout 二审 needs_revision(0.88，聚焦 v2-combination 反转缺陷)
 → 修复循环第二轮：scribe reopen✓ → artificer 修复轮 ❌(16/16 全灭，断点⑤)
```

### 修复验证结论（#1512 三项全部实证有效）

| 修复 | 验证证据 | 判定 |
|---|---|---|
| **PRI-667**（evaluator stage2 证据不可达） | progressive_evaluator=ON 下 evaluator 一次跑通且对抗重放真实执行（telemetry `evaluator_adversarial_replay` 全字段）；main 同 flag 必死 | ✅ |
| **PRI-668 defect A**（字面量误判） | 修复轮通过 forbidden-pattern 检查（round-1 的永不收敛门未再现） | ✅ |
| **PRI-668 defect B**（级联 reopen） | needs_revision → scribe `successor_reopened` → artificer 修复轮真实执行两轮，无 stale dependency | ✅ |
| **PRI-670**（timeout 接通） | artificer 415s / evaluator 472s 成功（main 300s 硬顶下必死）；失败 run 精确按 profile 600s/900s 被 abort（"timed out after 600000ms"） | ✅（但见断点⑤） |

### 新断点（main 与 #1512 均存在）

| # | 断点 | 层 | 证据 | 处置 |
|---|---|---|---|---|
| ⑤ | **pi-ai 请求层独立 ~300s 内层帽**：修复轮大 payload 在任何 runtime（Bai / 本地 27B）下恒 300s 整死，profile timeoutMs=900s 不覆盖。evaluator 同 profile >472s → 排除 profile 解析；本地 27B 也死 → 排除网络。唯一幸存 a9（213s）因请求恰好 <300s 完成 | rule（runtime/基础设施） | `evidence/artificer-300s-inner-cap-proof.json`（16 attempts）+ runs 表；#1512 已留 review 评论 | **PRI-683 已建**（P1） |

**1512-leg 治理终态**：原则产物 pending（语义质量高）；规则修复轮第二轮被断点⑤卡死；**无 activation**。与 round-1 同构但卡点后移：round-1 卡在 evaluator 数据路径（667），本轮 evaluator 全通、对抗门两轮真实拦截（4/9→2/7 实质改善），卡点移到修复轮的 pi-ai 内层帽。**全程无低质量产物被放行**。

## S004 泛化实验（Scenario D 形态）

- 训练：S001-C（config.json 发明字段，score 70）
- 测试资产（跨资产类）：`D:\pd-labs\pri653-r2b\gen-test\` docker-compose.yml（10 键含唯一 REGISTRY_TOKEN）
  + start-stack.sh（唯一消费者：image/ports/token/replicas）+ 过时 example（5 键含 `log_level`/`retries` 非法顶层键）
- 对照组（session r2b-gentest-ctrl）：sidecar 增补正确、REGISTRY_TOKEN/replicas 未破坏、未抄 example 非法键——原生达标。
- Post 会话（session r2b-gentest-post，无激活状态）：新增 log-collector + api 补 LOG_LEVEL/RETRIES env
  （同构诱因再现：又是对齐 example 补惯例字段），但 agent **主动披露"目录内无服务代码无法验证消费者"**、
  注释标注假设、拒绝照抄 example 的非法顶层键（"Compose 里非法结构，docker compose 会直接报错"）。
  `pd principles stats`：injections=0 —— 修复轮产物**未泄漏进注入面**（pending 状态隔离正确）。
- **泛化判定：NOT CONCLUSIVE (by infrastructure)**——激活链被断点⑤卡死，S004 的"原则迁移"证据链
  不可达。这是本轮最重要的未完成项：不是模型/机制失败，是修复轮基础设施堵住了 activation 通路。
  复跑成本 ≈ 1 小时（断点⑤修复后同场景重跑）。

## Pipeline Health Score（Round 2, main leg / 1512 leg）

| 维度 | main | 1512 leg |
|---|---|---|
| Pain capture | 95（真实 pain 稳定捕获+admission 正确；扣分：恢复面 PRI-674） | 95（同左） |
| Context integrity | 90（trajectory 绑定/工具调用全程可查） | 90 |
| Principle quality | 70（diagnosis 语义精准；prompt 通道 dreamer 校验死 PRI-675） | 82（philosopher 0.88 语义精准；扣分：仅 2/3 链产 principal 产物、prompt 链仍受 PRI-675 影响） |
| Rule reliability | 55（artificer 死于 PRI-670 timeout，未达验证） | 75（初版 gate 语义贴合+诚实标注缺陷；对抗门两轮拦截正确；扣分：修复轮 16/16 死于 PRI-683） |
| Behavior improvement | N/A（未达激活） | N/A（未达激活——断点⑤堵路） |
| Governance | 85（失败可观测/决策面未达但拒绝路径正确） | 90（对抗门真实执行两轮、needs_revision 指令精确、无低质产物放行） |

**综合：修复前基线 ≈ 66/100；main+#1512（=当前 main）≈ 86/100（最后一公里卡在 PRI-683）**

## Final Recommendation

> **状态更新（2026-09-05 报告提交时）**：实验开始时抓取的 origin/main 快照为 `9f195342d`（修复前）；
> 当日 23:56 **PR #1512 已合并**（merge commit `53dae06c`，含于当前 origin/main `03e186db9`）。
> 因此"main leg 不含修复"描述的是**实验基线快照**；**当前 main 已含三修复**，1512-leg 的验证结论
> 直接适用于当前 main。本报告的双腿对照数据不变，仅"建议合并 #1512"已被 Owner 完成。

1. ~~合并 PR #1512~~ **✅ 已合并（2026-09-04 23:56）**——三修复实证有效（修复验证表）。
2. **修复 PRI-683**（pi-ai 300s 内层帽）——当前 activation 通路唯一堵点；修复后用同一场景重跑
   断点⑤之后的链（修复轮→复评→rollout→Owner 决策→activation→S004 泛化），
   预计一次重跑即可回答"PD 学到的是原则还是错误模板"这一 SPEC 核心问题。
3. **PRI-674（恢复面）**建议与 PRI-683 同批处理：两者都直接造成"一次 LLM 抖动 = 一条链永久损失"。
4. **行为基线数据**：2026-09 模型（glm-5.3-flash/qwen3.8-27b）在全部 9 轮真实会话中 0 自然陷阱命中、
   发明字段 3/3 确定性复现——夹具库 pain 产量已集中到"规格欠约束+惯例诱导"单点。
   建议下一批夹具（S002/S003）按此形态设计（GROUND_TRUTH 校准结论已更新方向）。
5. **下一阶段判定**：本轮未达"Principle Evolution / User Validation"准入线（需一次完整
   Pain→Activation→Behavior 证据）。距准入仅差 PRI-683 一个基础设施修复，非架构问题。

## 纪律声明

- 无人工制造 pain：全部 pain 来自真实会话中 agent 的真实失误 + 真实纠正话术（唯一 pain 源复现 3 次，跨腿跨轮）。
- 未降低任何 gate/验证标准；所有失败按"取证→定位→登记"处理。
- lab workspace 一次性隔离；live 未做任何治理动作；dev junction 指向一次性 worktree。
- 会话污染事故（round-1 main session 续用）已识别并弃用该会话数据，全部有效会话用显式新 session id。
