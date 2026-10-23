# Principle Learning Lab — SPEC-PD-PL-001 v0.3 最小可判别 Pilot

> PRI-966（umbrella）/ PRI-967–971。研究问题：**Agent 的未来判断是否真的因过去经历
> 而发生有价值的改变**——而不是因为基础模型先验、强提示、人工挑选或执行拦截。
> 本目录实现 PR-00A/B 之后的 **PR-01 离线闭环**（G1）与 **G2 接线准备**。
> 权威 SPEC：`docs/specs/SPEC-PD-PL-001-principle-learning-dataset-v0.3.md`。

## 1. 一条命令跑完整离线闭环（G1）

```bash
npm run dev:pl-pilot                      # = node scripts/dev/principle-learning-lab/run-pilot.mjs
# 或指定输出目录（默认 <repo>/.tmp/principle-learning-lab/PLE-PILOT-01）
node scripts/dev/principle-learning-lab/run-pilot.mjs --out <dir>
```

该命令依次执行并全部自动校验：

1. 加载冻结研究数据集 + 夹具健康检查（引用完整性/synthetic 标记/canary 防泄漏/手册↔机械注册表成本一致）；
2. 组装 Actor 可见输入（外层泄漏组守卫 + canary 扫描）；
3. 24 个 arm（4 历史 × 6 策略）学习 → 冻结候选 → 交互式执行 5 个机会（P1–P4b）；
4. 机械 Oracle 计算任务后果（事故/时限/授权违规/成本）；
5. 三层分离裁定（行为对齐 / 任务后果 / Owner 负担）；
6. 研究 sidecar 校验（含 8 项硬负测试的守卫逻辑）；
7. 冻结校准电池 14 案全量复判；
8. G1 gate（详见 §4）；
9. 写出 `experiment-manifest.json`（复用 `experiment-manifest.v1`）、`principle-study.json`、
   `adjudications.jsonl`、`memory-manifest.json`、`preregistration-check.json`、
   `comparison-report.{md,json}`。

退出码 0 = G1 PASS；1 = 诚实失败（绝不伪造）。

## 2. 研究世界：PLE-PILOT-01

主题：**验证充分性与效率的动态权衡**——在证据不确定性、查验成本、失败风险、
任务时限和 Owner 授权之间选择**有判别力的最小充分验证**。

| 组件 | 内容 | 权威 |
|---|---|---|
| `fixtures/world-manual.json` | Actor 可见动作手册（成本表） | 与 `oracle.mjs` 的 ACTION_COSTS 机器校验一致 |
| `fixtures/histories/{E0,EA,EB,EN}.json` | 四个合成历史世界（synthetic_environment） | EA=高损失漏检教训；EB=契约信赖教训；EN=EA+无关差异；E0=无历史 |
| `fixtures/probes/{P1..P4}.json` | 四类未来任务（P4 双阶段） | 隐藏环境真值（隐藏消费者/契约腐化/时限/授权）只归 Oracle |
| `fixtures/judgments/gold.json` | judge-only 期望决策空间 + canary | 永不进入 Actor 输入（NT-01 机器守卫） |
| `fixtures/judgments/calibration.json` | 14 案冻结校准电池 | 评估器必须逐案复现 |

四个故意错误策略（必须在指定 Probe 暴露，否则 gate 失败）：`ALWAYS_VERIFY_EVERYTHING`、
`NEVER_VERIFY`、`ALWAYS_ABSTAIN_OR_ASK`、`ALWAYS_REVISE_ON_NEW_FEEDBACK`。
两个合理对照：`NARROW_LEARNER`（字面迁移，展示边界误用）、`MINIMALLY_SUFFICIENT`（完整综合）。

## 3. 目录

```
scripts/dev/principle-learning-lab/
├── run-pilot.mjs            # G1 统一入口
├── lib/
│   ├── fixture.mjs          # 数据集加载/哈希/健康检查/Actor 输入组装/泄漏扫描
│   ├── oracle.mjs           # 机械环境 Oracle（唯一任务后果权威；无随机、无时钟）
│   ├── strategies.mjs       # 6 个模拟策略（learn → 冻结候选；nextAction → 行动）
│   ├── evaluator.mjs        # 三层分离裁定 + 校准电池运行器
│   ├── sidecar.mjs          # principle-study.v1 / adjudication.v0.1 契约 + 校验器（NT-01..08）
│   ├── runner.mjs           # arm 执行引擎（学习→冻结→交互执行→裁定）
│   ├── report.mjs           # G1 gate + comparison-report 渲染
│   ├── prereg.mjs           # 预注册草案机器校验（PRI-970）
│   ├── g2.mjs               # G2 接线：同通道投递/Model Stub/Memory Manifest/污染检查（PRI-971）
│   ├── actor.mjs            # G2 真实 Actor：transport seam（生产 PiAiRuntimeAdapter / 离线 Fake）+
│                            #  逐轮交互循环（请求/步数/token/超时/无效输出全部有界，NT-01 通道守卫）
│   └── real-runner.mjs      # G2 真实 arm 引擎：I0 反思→freezeCandidate→同通道投递→Oracle→三层裁定
├── fixtures/                # 冻结研究数据集（本 lab 拥有；SPEC §6.1 的 datasets/ 布局仅是建议，
│                            #  仓库习惯是 lab 自持夹具，与 closure-lab 一致）
│   └── pilot-run-config.json# 真实 Agent Pilot 运行配置模板（NOT_AUTHORIZED）
scripts/__tests__/principle-learning-lab.test.ts        # 51 项回归（含 8 硬负测试）
scripts/__tests__/principle-learning-lab-actor.test.ts # 18 项真实 Actor 离线演练（B4；零网络）
```

## 4. G1 gate（实验必须能失败）

| 检查 | 含义 |
|---|---|
| 夹具健康 | 引用/synthetic/canary/成本一致性全过 |
| 校准电池 | 14/14 冻结案例逐案复现（文风不变性、假查验、零工具正控、过度澄清、越权、过检、欠检、修订/保持） |
| 退化策略暴露 | 四个错误策略各自在指定 Probe FAIL；ALWAYS_REVISE 在 EN 上策略漂移 |
| 正对照 | MINIMALLY_SUFFICIENT 在 EA/EB/EN 全机会 PASS；E0 基线在 P1 FAIL（先验不足被证明） |
| 稳定性对照 | 合理策略 EA vs EN 行为与候选完全一致（无关差异不漂移） |
| sidecar 校验 | 契约形状 + 覆盖完备 + 8 项硬负测试守卫 |

## 5. 硬负测试（SPEC PR-01 要求，全部自动化）

| ID | 断言 | 守卫位置 |
|---|---|---|
| NT-01 | judge-only canary 泄入 Actor 输入必被检出 | `scanGoldLeak` + `validateSidecar` |
| NT-02 | 外层异源泄漏组配对被拒 | `assembleActorInput` 抛错 |
| NT-03 | 同 Episode 的 history→future 合法，不误判 | 泄漏扫描对全部 20 个合法组装为空 |
| NT-04 | 无 PD Activation 的 arm 仍被正常评分；未评分即拒 | `validateSidecar` |
| NT-05 | pipeline NOT_REACHED 不得当作行为失败理由 | rationale 正则守卫 |
| NT-06 | 不得按标题捏造 Principle ID | `freezeCandidate` 恒 null + 校验器拒绝伪造 |
| NT-07 | 未来结果不得回填信息截止前的标签 | evidenceRefs occurredAt ≤ cutoff |
| NT-08 | antiPatterns 命中 ≠ 原则不适用 | NOT_APPLICABLE reason 白名单 |

## 6. G2 准备（PRI-971，接线已测、未跑真实模型）

- **同通道投递**（`deliverPayload`）：所有 arm 内容（真实候选/强摘要/原始经验/无内容）
  只经 `research-same-channel-v1` 一条路径进入 Actor 会话——C-A 对照不会被投递机制混淆。
- **冻结接口**（`freezeCandidate`）：G1 模拟候选与 G2 真实 I0/I1 输出用同一冻结机制（字节+hash）。
- **Model Stub**（`createModelStub`）：确定性 Actor 测试接口；记录收到的每个 payload/prompt hash。
- **污染检查**（`checkNoCrossContamination` / `verifyPromptIsolation`）：payload 级 + prompt 级双重。
- **Memory Manifest**（`buildMemoryManifest`）：真实 profile 运行前指纹全部外部规则/记忆文件。
- **运行配置**（`fixtures/pilot-run-config.json`）：`NOT_AUTHORIZED`；预算/凭据/重复次数全部
  `OWNER_DECISION_REQUIRED`。真实实验在 Owner 决策前一律 NOT_RUN。

### 6.1 真实 Actor 接线（2026-10-18 交付，仍 NOT_RUN）

- **`lib/actor.mjs`**：G2 stub 抽象扩展为可交互真实 Actor。模型调用走单一 transport seam：
  `createPiAdapterTransport` 包裹**生产 `PiAiRuntimeAdapter`**（startRun/fetchOutput 边界 +
  注册表 schema ref `learning-lab-actor-action-v1`，复用生产 tool-call/json_schema/有界修复机制，
  不另造模型调用框架）；`createFakeActorTransport` 是确定性离线演练 provider（零网络）。
  逐轮循环内置硬上限（请求 16/机会、步数 40=Oracle STEP_CAP、单请求 token 512、超时 60s、
  总预算 300s、无效输出最多 2 次有界重提），无效动作永不进 Oracle；NT-01 守卫扫**通道文本**
  （system+任务+投递内容）——gold canary 同时是隐藏消费者 ID，经 Oracle 动作**挣来的**观察
  揭示它们是任务本身，不是泄漏。
- **`lib/real-runner.mjs`**：`runRealArm`/`runRealStudy`——I0 反思（1 次调用）→
  `freezeCandidate`（原样字节+hash，不润色；E0 无内容 arm 用透明哨兵）→ 同通道投递 →
  逐机会交互执行 → 同一三层裁定器。judge 泄漏即停整场研究（后续 arm 不启动）。
- **C-A 四条件内容形态**（`runRealArm` 的 `contentMode`，预注册 contrastId
  real-candidate-vs-summary-vs-raw-vs-none / SPEC §4.2 抽象对照）：`policy`（默认，I0 反思）、
  `summary`（**一次**同形摘要调用——与 I0 相同的传输轮次/1024 token 预算/自由 JSON 路径，
  指令是"如实强摘要"：保留一切具体事实与历史自记录的教训，对照点是表达形态而非信息量）、
  `raw`（冻结的历史字节本身，零生成调用；EA/EB/EN 渲染 1696/1739/1845 字符均在 2000 字符
  通道预算内，超限在投递门诚实失败而非截断）、`none`（无投递内容——E0 流程，可用于任一
  历史做配对对照）。四条件**只差内容**：通道/位置/budgetChars 完全一致（deliveryInvariance）。
  `runRealStudy` 接受 `armSpecs: [{historyId, contentMode}]`（同一历史的四向对照=四条 spec；
  旧 `historyIds` 语义不变）。真实研究的 arm 清单与顺序仍是 Owner 的 OD-3 决策——本机制
  只让任何预注册选择可执行。arm 侧 `reflection` 字段更名为 `generation`
  （`{stage, requests, failure}`），数据质量理由前缀随之取自 stage。

### 6.2 宿主原生 transport（`lib/host-actor.mjs`，2026-10-23 交付，零网络演练）

- **两类执行路径严格分立**：外部路径（`actor.mjs`，pi-ai + P1-01 HTTP/USD 账本）与宿主
  路径（本文件）互斥、互不冒充。`runRealStudy(hostTransportFactory=…, hostBudgets=…)` 走
  宿主模式时**不创建 HTTP 账本也不虚构任何请求数/USD 预留**；`budgets` 与
  `hostTransportFactory` 同时给出即拒绝（混跑会破坏 C-A 同通道对照）。
- **宿主调用机制**：`createCodexHostTransport` 驱动 Owner 的 Codex CLI headless 接口——
  首轮 `codex exec --json -m <model> -C <scratch> -s read-only --thread-source pl-lab`，
  后续轮 `codex exec resume <session-id>`；每机会一个新会话（机会间零会话记忆泄漏），
  轮内同会话保持观察连续性；`resume --last` 禁用（共享 CODEX_HOME 下会拿错会话——
  session id 只从宿主事件流提取，缺失即 fail-loud）。
- **模型身份纪律**：requested `-m` vs 宿主自报（`thread_settings_applied`）逐会话核对；
  MISMATCH/UNVERIFIED 的 arm 全行标 UNCERTAIN——排除出正式结论，分母不删。
- **进程级预算（宿主调用不经过 fetch，P1-01 账本不适用且不模拟）**：
  `createHostProcessLedger` 三层（机会→arm→study）；exec/会话数是 spawn 前硬上限；
  Token/wall-clock 是**事后观察值**，累计到限即拒绝下一次 spawn——当轮已在宿主侧发生，
  如实记账不冒充发送前费用硬限（rc-9）。
- **用量语义**：轮增量取 `token_count.info.last_token_usage`（`total_token_usage` 是会话
  累计值，逐轮累加会重复计数）；缺失用量记 unavailable，永不补零（P1-03）。
- **零网络演练**（`scripts/__tests__/principle-learning-lab-host-actor.test.ts`，17 项）：
  spawn stub + 本机 rollout 真实形状的脱敏事件 fixture——会话生命周期/resume 纪律/
  机会隔离/JSONL 容错/action 校验/用量语义/身份纪律/预算链/超时与非零退出/fail-closed。
  **离线演练 ≠ 宿主连通性验证**；`gpt-6-luna` 在 CLI models_cache 为 `visibility:"list"`
  （支持证据），真实身份以授权冒烟的宿主自报为准。
- **离线演练**（`scripts/__tests__/principle-learning-lab-actor.test.ts`，18 项）：观察驱动的
  动作改变、终局后零调用、无效/超时有界、上限证据、canary 通道守卫、跨 arm 隔离、
  冻结完整性、Oracle↔裁定一致、sidecar 校验通过、泄漏停止研究。
  **演练通过 ≠ 真实学习有效**——claims 状态保持 NOT_ESTIMABLE 直到 OD 授权的真实运行。

## 7. 与既有 Evolution Lab 的兼容性

- `experiment-manifest.json` 复用 `scripts/dev/pipeline-evolution/lib/experiment-manifest.mjs`
  的 `experiment-manifest.v1`（parseManifest 校验后写出）；host=`simulated` 如实标注。
- 不调用 `collect-evidence.mjs`（G1 无真实 workspace DB 可取证）；当真实 Agent Pilot 启动后，
  证据包链路可直接挂接（manifest 字段兼容）。
- 不新增数据库/长期服务/生产状态机/第二个事实源；所有研究视图是 sidecar 派生数据。

## 8. 纪律（继承 SPEC 与 AGENTS.md）

- 所有历史/probe 环境都是 synthetic 研究世界；不伪造生产 Pain/Owner/Activation。
- `pipelineReachability` 对所有模拟 arm 恒为 NOT_REACHED，且这不妨碍 Actor 评分（NT-04/05）。
- G1 证明的是**方法可判别**，不是真实 Agent 学习；报告中的 claims 状态如实分层
  （`METHOD_VALIDATED_ONLY` / `NOT_ESTIMABLE`）。
- 修改 gold/夹具以让测试变绿 = 研究造假；校准失败必须修评估器或夹具设计本身。
