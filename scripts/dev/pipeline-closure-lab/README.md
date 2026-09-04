# Pipeline Closure Lab — Experience Scenario 夹具库

PRI-634-C（2026-09-03）闭环验证沉淀的可复用测试资产。用途：反复验证
**Experience → Pain → Diagnosis → Principle → Rule → Activation** 管道是否通畅，
以及被治理 agent 的行为基线是否漂移。全套规划见
`docs/superpowers/specs/2026-09-03-pipeline-closure-test-harness.md`。

## 目录

```
pipeline-closure-lab/
├── generate.mjs          # 种子化生成器（确定性，无随机）
├── GROUND_TRUTH.md       # 每场景机械断言 + 行为参考基线 + 管道断言
├── FORENSICS.md          # 管道取证查询 runbook（state.db/trajectory.db/telemetry/pd CLI）
└── scenarios/
    ├── a-inventory-cli/    # 局部优化陷阱（共享库 null 契约 + 无测试的远端消费者）
    ├── b-report-exporter/  # 过早归因（流截断真 bug + 网络超时红鲱鱼）
    ├── c-sensor-archive/   # 上下文漂移（16 脏文件 + 6 部分需求单；真实 pain 高产场景）
    └── d-config-drift/     # 调查策略（sha256 基线 + 单文件植入漂移）
```

## 使用（一轮验证的标准流程）

```bash
# 1. 部署一次性副本到 agent 可访问的工作区（永远不要让 agent 直接改仓库原件）
npm run dev:closure-lab -- <目标目录>          # = node scripts/dev/pipeline-closure-lab/generate.mjs --out <目录>

# 2. 按场景下达任务（任务模板在 GROUND_TRUTH.md，不要告诉 agent 答案）
#    场景 B 需先在其目录跑 node upstream.js（端口 18311）

# 3. 会话结束后取证与断言
#    - 行为判定：GROUND_TRUTH.md 各场景"机械断言 + 行为参考基线"
#    - 管道判定：FORENSICS.md 查询组（pain 绑定/链推进/对抗门/fail-loud）
```

## 夹具健康自检（改了生成器或代码后必跑）

```bash
node scripts/dev/pipeline-closure-lab/generate.mjs     # 重建 canonical fixtures
cd scripts/dev/pipeline-closure-lab/scenarios/a-inventory-cli && npm test && node lib/audit.js
# audit 必须逐位输出: processed=9940 malformed=60 total=15583596986.56 avg=1567766.2964
# B/D 断言见 GROUND_TRUTH.md
```

## 纪律（来自 PRI-634-C 的实测教训）

- **不许人工制造 pain**：只能等真实失误（场景 C 历史命中率最高）或用真实 Owner 纠正
- **pain 记录必须 `--session` 绑定**真实会话，否则 admission 依法拒绝（needs_evidence）
- **不得为让管道变绿降低任何 gate 标准**——发现失败按 634-C/E 模式：取证→定位→
  报告（`docs/audit/` 或 `docs/pipeline-closure/`）
- dashboard/`openclaw agent` CLI 的斜杠命令不派发（送 LLM）——用 `pd pain record --session`
