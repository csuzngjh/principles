# Principle Learning 项目状态（唯一权威）

> 本文档是 Principle Learning 研究项目的唯一状态来源。后续任何 AI 执行前必须先读本文件。
> 最后更新：2026-10-23；分支 `ai/PRI-966-ca-content-modes` HEAD `5c11c908b`（PR #2116）。
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
