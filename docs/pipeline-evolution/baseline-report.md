# Pipeline Evolution Lab — 基线报告（Step 0 代码调查）

> PRI-653 Step 0 输出。基线 = origin/main `1d911a98`（PRI-634-F 合并后）。
> 所有事实均对当前仓库核实（代码/测试/文档），非记忆或 SPEC 假设。

## 1. 当前完整链路（Implementation Truth）

```
真实 Agent 会话（OpenClaw + PD plugin hooks）
 ↓ trajectory 落盘（<ws>/.state/trajectory.db：sessions / tool_calls / turns）
Owner 纠正 → pd pain record --session <sid>（PRI-642：ingress 语义 = 共享 evaluator）
 ↓ admission gate（confidence ≥ 0.5 / 证据绑定）
diag_rootcause → diag_distiller → diag_router     （split diagnostician）
 ↓ dreamer → philosopher → scribe → artificer → evaluator → rollout_reviewer
   （internalization-job-graph.ts ALLOWED_EDGES；auto-consumer 每 120s 推进，
   internalization_full_chain flag default-ON）
 ↓ 对抗门（evaluator adversarial replay：sandbox 真执行，adversarialResult runtime 写回）
rollout_reviewer → needs_human_review（Owner 决策点 = 设计终点）
 ↓ approval 队列（state.db approvals；pd activation approve）
activation（prompt 注入 / RuleHost 拦截 / defer_archive）
 ↓ 行为改变（后续会话被注入原则 / 拦截危险操作）
```

## 2. 每阶段 artifact 来源（权威存储）

| 阶段 | 权威来源 | 命令/查询 |
|---|---|---|
| 会话/工具调用 | `<ws>/.state/trajectory.db` | sessions / tool_calls / pain_events 表 |
| Pain 入队 | `<ws>/.pd/state.db` | pain_signals / tasks(diagnostician) |
| Admission | state.db candidates | `pd pain list --json` |
| 内化链 | state.db tasks + pi_artifacts | `pd evolution tasks list` / collect-evidence |
| 对抗门 | `<ws>/.pd/telemetry/critical-events.jsonl` | evaluator_adversarial*（区分判负/不可达） |
| 审批 | state.db approvals | `pd task list` / approvals 表 |
| 激活 | state.db activation + 注入产物 | `pd activation list` / `pd principles stats` |
| 运行失败原因 | state.db runs.reason | execution_status + reason |

人读 runbook：closure-lab `FORENSICS.md`（§1–3 只读 SQLite 查询 + §4 CLI 面）。

## 3. 现有能力 vs PRI-653 需要的能力（缺口）

| 需要 | 现状 | 缺口 |
|---|---|---|
| 确定性夹具 | closure-lab a–d（PRI-634-F） | 无 S001（不可逆覆盖）类夹具 → **本次补 e-service-config** |
| 演化场景契约 | 无（只有夹具机械断言） | **本次补 docs/pipeline-evolution/scenarios/** |
| 取证自动化 | FORENSICS.md 人读 runbook（查询形状已复用 10+ 次） | **本次补 collect-evidence.mjs 脚本化**（closure-harness SPEC Phase 1 的管道断言半部） |
| 报告惯例 | 散落在对话/audit 文档 | **本次补 reports/ 结构 + first-run 实录** |
| 版本比较 | 无固定快照格式 | **本次定义报告头部快照字段**（AC4） |

## 4. 已知管道质量基线（截至 2026-09-03，影响首轮预期）

- 全链机制已通（PRI-634-C/E 实测）：pain→…→rollout needs_human_review 可达，
  修复循环（needs_revision→repair→复评）与对抗门真实执行均有生产实证
- 已知短板：**RuleCode 语义质量**——LLM 把原则翻译成代码时语义漂移（634-C 首条
  rulecode 三缺陷被管道自己拦下，未放行）；PRI-634-F ABC Phase 0 审计确认
  painReasonSummary 休眠、四套工具词表无权威绑定
- 因此首轮 S001 的合理预期：管道机制层 PASS 可期；rule 语义质量层可能 FAIL/UNKNOWN
  ——**这是有效结果**（AC2：失败可解释即可，不许为绿而绿）

## 5. 环境事实（本机）

- OpenClaw 2026.8.2（0965053）；安装版 pd-cli 于 `~/.pd/runtime/pd-cli`
- live workspace `D:\.openclaw\workspace`（不动；lab 用隔离 workspace + PD_WORKSPACE_DIR）
- 仓库直跑 CLI：`packages/pd-cli && node dist/index.js`（绕过安装目录损坏风险）
- 验证 flag（既有，非新增）：`internalization_full_chain`（core, default-on）、
  `progressive_evaluator` / `context_manifest_budget`（quiet, default-off；
  lab 环境用 `.pd/feature-flags.yaml` 打开）
