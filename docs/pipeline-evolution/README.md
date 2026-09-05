# Pipeline Evolution Lab — Agent 行为演化基准

> **PRI-653**（parent: PRI-634 Pipeline Closure）。本目录是 PD 的长期演化验证资产：
> 让同一个真实 Agent 失败场景可以**反复执行、逐步取证、跨版本比较**，回答一个问题——
>
> **Agent 的一次失败经验，是否沉淀为了未来行为的改进？**

## 1. 与既有资产的关系（不新增真相源）

```
docs/pipeline-evolution/                    ← 本目录：场景契约 + 演化报告层
├── scenarios/S00x.md                       #   演化场景定义（期望的 pain/原则/行为改变）
├── reports/<date>-<scenario>-run.md        #   每轮验证的结构化报告
└── baseline-report.md                      #   Step 0 管道基线（链路/证据来源/缺口）

scripts/dev/pipeline-closure-lab/           ← 夹具层（PRI-634-F，唯一夹具所有者）
├── scenarios/a..e/                         #   可部署的一次性场景副本（generate.mjs --out）
├── GROUND_TRUTH.md                         #   机械断言 + 行为参考基线（两层分离）
└── FORENSICS.md                            #   只读取证查询 runbook（state.db/trajectory.db/telemetry）

scripts/dev/pipeline-evolution/             ← 取证自动化 + 实验证据基础设施（PRI-685）
├── collect-evidence.mjs                    #   FORENSICS §1–3 的脚本化 + 实验绑定取证
│                                              (--experiment <manifest> --package <dir>)
├── init-experiment.mjs                     #   experiment-manifest.json 生成（自动抓 PD sha/版本）
└── lib/                                    #   evidence-package.mjs（纯函数：claim 索引/指标
                                              矩阵/trace/Owner Review——同 JSON 同报告）
```

分工边界：**夹具的机械事实**只记在 closure-lab `GROUND_TRUTH.md`；**场景的演化契约**
（期望 pain、期望原则、行为改变判定）只记在本目录 `scenarios/`；**取证查询**的人读版在
`FORENSICS.md`、机器版在 `collect-evidence.mjs`。同一事实不写两处。

## 1A. 实验证据包（PRI-685 Evidence Foundation）

每轮实验的**实验定义与归属权威记录**是 **experiment-manifest.json**（PD commit/版本、
host、模型、flags、session/pain 绑定、时间窗）——它是 *experiment metadata authority*，
**不是运行事实来源**：发生了什么仍由 state.db / trajectory.db / telemetry 拥有，manifest
只界定“这次实验是什么”。manifest 与存储冲突时，以存储为准。取证不再是"最近 10 条"，
而是按 manifest 绑定：

```bash
# Phase 0 环境准备时生成（自动抓 git sha / 包版本；host/model 人工补）
npm run dev:evolution-init -- --out <lab>/experiment-manifest.json \
  --experiment PRI653-R3-S001 --scenario S001 --session <sid>

# Phase 3 每阶段取证 → 一个可复算的证据包
node scripts/dev/pipeline-evolution/collect-evidence.mjs \
  --workspace <ws> --experiment <lab>/experiment-manifest.json \
  --package <lab>/evidence-package
```

证据包结构（全部从只读存储派生，可由 collected.json 重新计算）：

```
evidence-package/
├── manifest.json          # 实验权威（manifest 副本）
├── collected.json         # 原始取证快照（含 truncation 截断标记）
├── evidence-index.json    # claim → evidence（CONFIRMED/NOT_CONFIRMED/UNKNOWN/BLOCKED/INVALID）
├── pipeline-trace.json    # 每链阶段 trace（stage → task/artifact 锚点）
├── metrics.json           # 指标矩阵：pipeline / governance / behavior 三层
├── report.md              # Owner Review（从 JSON 确定性生成，禁止人工重抄）
├── artifacts/             # pi_artifacts 导出副本（sourceId/hash/createdAt；
│                          #   有界导出：≤50 个 / ≤10MB 总量，超额计 truncated）
└── telemetry/adversarial-events.json
```

语义纪律（SPEC Evidence Foundation §Problem 2）：**事实（task 级 bucket）与结论（claim
级 status）分层**；阶段未到达 = UNKNOWN，绝不判 FAIL；无 activation 绝不声称行为改善
（behavior 恒 NOT_REACHED/INCONCLUSIVE）；governance 计数（正确拒绝/审批等待/修复触发）
描述治理面被行使，**不是缺陷计数**。

## 2. 场景模型（ExperienceScenario）

每个场景一个 markdown 文件，YAML frontmatter + 固定章节。**纯文档资产，无数据库、
无 runtime、无新 flag**（PRI-653 Non-Goals）。

```yaml
---
id: S001                        # 稳定 ID（报告与 Linear 引用）
name: 文件修改风险                # 人读名
failureMode: irreversible-overwrite-without-checkpoint   # 按 agent 失败模式分类（非技术分类）
status: fixture-ready           # defined → fixture-ready → validated → behavioral-verified
fixture: <closure-lab 场景目录>   # defined 阶段可为空
host: openclaw                  # 真实宿主（Phase 1 只支持 OpenClaw）
---
```

正文章节（固定顺序）：

1. **Initial condition** — 部署副本后的初始状态（可机械复查）
2. **Task template** — 给 agent 的原话（只给意图，绝不给答案）
3. **Expected pain** — 期望被捕获的失败语义 + Owner 纠正话术（真实纠正，不伪造）
4. **Expected principle / rule** — 期望演化出的原则方向与规则行为（方向性描述，不是标准答案）
5. **Evaluation — mechanical** — 跑命令即判的断言（引用 GROUND_TRUTH，不复制）
6. **Evaluation — behavioral** — 行为改变判定（机械可判部分 + 人类评估部分，两层分开）
7. **Pipeline bindings** — 各阶段的可取证锚点（pain/task/artifact/approval/activation）

## 3. 一轮验证的标准流程

```
Phase 0  环境准备     最新 main 构建 → 隔离 lab workspace → 插件部署 →
                     .pd/feature-flags.yaml 打开验证 flag → 快照（PD sha/插件版本/
                     OpenClaw 版本/模型）→ npm run dev:evolution-init 生成
                     experiment-manifest.json（机器可读快照，替代手抄报告头部）
Phase 1  场景执行     npm run dev:closure-lab -- <lab>/scenario-<x> 部署一次性副本；
                     openclaw agent 真实会话执行任务模板（禁止内部 API 直调）
Phase 2  Pain 捕获    真实失误发生后：pd pain record --session <sid> --score N -r "<纠正>"
                     （必须 --session 绑定，否则 admission 依法拒绝）；session id 记入
                     manifest.sessionIds
Phase 3  管道推进     auto-consumer（生产路径）自行推进；需要立即观察时用
                     pd runtime internalization run-once。每阶段取证：
                     collect-evidence.mjs --workspace <ws> \
                       --experiment <lab>/experiment-manifest.json --package <lab>/evidence-package
                     （按实验绑定过滤，无"最近10条"fallback；截断有标记）
Phase 4  行为验证     重新部署副本 → 同一任务模板再来一次真实会话 →
                     机械断言（verify.js）+ 注入证据（pd principles stats）；
                     结果回填 manifest.behaviorObservation 后重新出包
```

Owner 决策点（needs_human_review / approval 队列）是管道**设计终点**，不是卡死；
lab 内由受委托 operator 执行决策时，必须在报告中逐条记录（见 first-run-report 惯例）。

## 4. 指标

- **Pipeline Success Rate** = completed scenarios / total scenarios
- **Stage Failure Distribution** — 按 failureLayer 统计断点分布
- **Evolution Capability Matrix** — 每轮输出能力矩阵，不是单一分数：

| 能力 | 判定来源 |
|---|---|
| 发现错误（pain capture） | pain_events + admission 决定 |
| 总结经验（diagnosis/principle） | pi_artifacts 链 + 内容语义相关 |
| 生成规则（rule） | artificer/evaluator + 对抗重放 |
| 行为改变（behavior） | Phase 4 机械断言 + 注入/拦截证据 |

## 5. 失败分类（不过早自动归因）

```
failureLayer: pain | diagnosis | principle | rule | validation | activation | behavior | unknown
```

`unknown` 是合法且必须保留的层——证据不足时宁可 unknown，不许编造归因。
每条失败必须回答：在哪一步？为什么？有什么证据？（AC2）

## 6. 版本比较（AC4）

每份报告头部固定记录：`PD git sha / 插件版本 / OpenClaw 版本 / 模型 / 场景 ID /
结果矩阵`。跨版本对比 = 同一场景 ID 在两个报告之间对比矩阵与 failureLayer 分布，
夹具字节稳定性由 closure-lab 生成器保证（公式种子，无随机）。

## 7. 纪律（继承 PRI-634-C 实测教训）

- 不许人工制造 pain（`throw Error("simulate")` 一律无效）；只能真实失误或真实 Owner 纠正
- pain 记录必须 `--session` 绑定真实会话
- 不得为让管道变绿降低任何 gate 标准；失败→取证→定位→报告
- 场景扩展**按 agent 失败模式分类**（closure-lab SPEC §7），不按技术分类
- agent 永远只接触部署副本，接触不到仓库内的 ground truth

## 8. 场景清单

| ID | 失败模式 | 夹具 | 状态 |
|---|---|---|---|
| [S001](scenarios/S001.md) | 不可逆变更前不建检查点 | e-service-config | fixture-ready |
| [S002](scenarios/S002.md) | 执行未经验证的命令/脚本 | —（待建） | defined |
| [S003](scenarios/S003.md) | 证据不足即行动 | b-report-exporter / d-config-drift（相关） | defined |
| [S004](scenarios/S004.md) | 长任务中遗忘早期约束 | c-sensor-archive | fixture-ready |
| [S005](scenarios/S005.md) | 修复旧问题引入新问题 | a-inventory-cli | fixture-ready |
