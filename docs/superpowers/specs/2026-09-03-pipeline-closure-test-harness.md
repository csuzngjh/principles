# SPEC — Pipeline Closure Test Harness（管道闭环验证资产化）

- **Date:** 2026-09-03
- **Status:** Proposed（Phase 0 已随本 PR 交付；Phase 1+ 待 Owner 批准排期）
- **来源:** PRI-634-C（闭环验证）+ PRI-634-E（RuleCode 审计）的实测沉淀
- **Linear:** 待 Owner 登记（建议挂 PRI-634 系列后续）

## 1. 问题

PRI-634-C 证明了一轮完整闭环验证的价值（发现 P0 上下文断裂）但也暴露：每轮验证
都要**从零搭建**实验环境、重新发明取证查询、人工判读结果。四个场景夹具散落在
live workspace（一次 reset 即丢失）。Owner 明确：这是项目重要资产，后续会**多次
重跑**同类验证。

## 2. 目标 / 非目标

**目标**
1. 夹具、生成器、ground truth、取证查询全部入仓、版本化、确定性可重建
2. 一轮验证的启动成本从 ~2 小时（搭环境+写脚本）降到 ~10 分钟（部署副本+读清单）
3. 结果可对比：行为基线与管道断言跨模型/跨版本/跨 PD 版本可重复测量

**非目标**
- 不做 CI 自动化（Phase 3 再评估——真实 LLM 会话成本高，适合例行人工触发）
- 不替代现有 `pd runtime-uat` / `mvp-smoke`（它们测单元链路；本套件测
  **真实 agent 会话 → 管道 → 行为** 的端到端闭环）
- 不制造 pain（只能等待/诱发真实失误——SPEC 纪律见 lab README）

## 3. 分期

### Phase 0 — 资产保全（本 PR，已交付）

- `scripts/dev/pipeline-closure-lab/`：四场景夹具 + `generate.mjs`（公式种子，
  `--out` 部署一次性副本）+ `GROUND_TRUTH.md`（机械断言/行为基线/管道断言）
  + `FORENSICS.md`（state.db / trajectory.db / telemetry / pd CLI 取证 runbook）
- 验证：A 的 audit 数字与 634-C 基线逐位一致；B 的 bug 端到端复现（verify exit 1、
  0 字节报告）；D 的 drift 唯一且与基线哈希不符
- Complexity Delta：全部 NO（纯 dev 资产，无运行时变更；新增一个 `dev:closure-lab`
  npm script）

### Phase 1 — 断言化检查脚本（下 PR，小）

- `verify.mjs`：一键跑 GROUND_TRUTH 的全部机械断言（A 数字/B 复现/D 漂移/C 清单），
  输出 PASS/FAIL 表——替代人工判读夹具健康
- 管道断言组合同样脚本化（输入 workspace 路径，输出链状态摘要）
- 依据：FORENSICS 的查询形状在两轮任务中被重复使用 10+ 次，非投机抽象

### Phase 2 — 场景驱动记录仪（中）

- 每轮验证自动生成 `round-report.md` 骨架（会话清单/绑定 pain/链推进/对抗门事件/
  断言结果），消除"结果散落在对话里"的问题
- 沉淀为 `docs/pipeline-closure/rounds/<date>.md` 的标准目录结构

### Phase 3 — 触发与节奏（Owner 决定后）

- 触发时机候选：PD 大版本安装后 / 内化链相关 PR 合并后 / 每月例行
- 可选：qa-channel（OpenClaw 官方合成通道，走完整 reply 管线含命令派发）驱动，
  解决 dashboard/CLI 斜杠命令不派发的 G-3 缺口——需先验证其对 PD hooks 的兼容性

## 4. MVP Questions

### `mvp-q-1-what-if-skip`

不做：每轮验证继续 2 小时从零搭建 + 取证靠翻对话记录 + 夹具随时可能丢。
634-C 已证明每轮都能抓到真问题（P0 上下文断裂、对抗门死锁）——资产化直接
决定这类验证的发生频率。

### `mvp-q-2-how-observed`

`npm run dev:closure-lab -- <dir>` 部署副本；夹具健康自检（README §夹具健康自检）
输出确定性断言结果；一轮验证产出可对比的 round 报告（Phase 2 后自动生成）。

### `mvp-q-3-how-disabled`

纯 dev 资产：不部署/不运行即无影响；删除目录 + npm script 即完全移除。
（☑ backward-compatible revert）

### `mvp-q-4-emotional-value`

N/A — internal engineering change（dev 工具资产）。

## 5. 风险与对策

| 风险 | 对策 |
|---|---|
| 夹具代码被误改导致基线失效 | GROUND_TRUTH 机械断言 + 生成器形状自检（generate.mjs 已内置 B 的形状校验） |
| 场景答案泄给 agent（测试失效） | 任务模板只给意图不给答案；agent 操作的是部署副本，无法读到仓库内的 ground truth |
| 行为基线依赖特定模型 | GROUND_TRUTH 明确标注"参考基线非断言"；跨模型对比时以机械断言为准 |
| LLM 会话成本 | 默认人工触发；CI 自动化推迟到 Phase 3 由 Owner 决策 |

## 6. 反模式自查

- 无 `antipattern-future-extensibility`：Phase 0 只保全已验证资产；Phase 1 脚本化
  的依据是 10+ 次实际复用，非假设
- 无 `antipattern-prep-next-phase`：Phase 1+ 均为独立 PR，未提前实现
- 与 `pd runtime-uat` 的边界：后者是 repo 内单元级 UAT；本套件是真实宿主会话级
  闭环验证——职责不重叠（Phase 3 若收敛再评估合并）
