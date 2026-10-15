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
│   └── g2.mjs               # G2 接线：同通道投递/Model Stub/Memory Manifest/污染检查（PRI-971）
├── fixtures/                # 冻结研究数据集（本 lab 拥有；SPEC §6.1 的 datasets/ 布局仅是建议，
│                            #  仓库习惯是 lab 自持夹具，与 closure-lab 一致）
│   └── pilot-run-config.json# 真实 Agent Pilot 运行配置模板（NOT_AUTHORIZED）
scripts/__tests__/principle-learning-lab.test.ts   # 46 项回归（含 8 硬负测试）
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
