# AI 冲刺编排参考

## 包结构

- `scripts/run.mjs`：package-local orchestrator 入口
- `scripts/lib/`：decision、contract validation、state store、spec loading、archive helper
- `references/specs/`：内置 validation spec
- `references/agent-registry.json`：package-local 的 agent/model 注册表
- `references/workflow-v1-acceptance-checklist.md`：handoff 检查清单
- `runtime/`：运行产物默认目录

## Runtime 结构

默认 runtime 根目录：

- `packages/openclaw-plugin/templates/langs/<lang>/skills/ai-sprint-orchestration/runtime`

子目录：

- `runs/<run-id>/`
- `archive/<run-id>/`
- `tmp/sprint-agent/<run-id>/...`

也可以通过以下方式覆盖：

- `--runtime-root <path>`
- `AI_SPRINT_RUNTIME_ROOT=<path>`

## 自检

在新安装环境中先跑：

- `node scripts/run.mjs --self-check`

它会检查：

- package-local references 是否存在
- built-in spec 是否能加载
- `agent-registry.json` 是否存在
- `acpx` 是否可调用
- runtime 根目录是否可写

## 内置 spec

- `workflow-validation-minimal`
- `workflow-validation-minimal-verify`
- `bugfix-complex-template` (copy and fill before use)
- `feature-complex-template` (copy and fill before use)

这些 spec 用来做 package 自检，验证的是 workflow 包本身，不是产品功能。

## 关键产物

每次运行重点看：

- `sprint.json`
- `timeline.md`
- `latest-summary.md`
- `decision.md`
- `scorecard.json`

重要持久化字段：

- `outputQuality`
- `qualityReasons`
- `validation`
- `nextRunRecommendation`
- `failureClassification`
- `failureSource`
- `recommendedNextAction`

每个 stage 的 carry-forward 产物：

- `checkpoint-summary.md`

下一轮 continuation 应优先读取 `checkpoint-summary.md`，只有在不够用时才退回到完整的 `decision.md` 或 `handoff.json`。

## 失败分类

只能使用其中一个：

- `workflow bug`：编排逻辑、产物布局、CLI、validation、持久化问题
- `agent behavior issue`：workflow prompt / contract 正确，但 agent 输出质量或格式漂移
- `environment issue`：二进制缺失、权限、文件系统、PATH、runtime 访问问题
- `sample-spec issue`：spec 本身有问题，或暴露了不应在当前里程碑修的 sample-side / product-side 缺口

## 复杂任务的最小 task contract

复杂 bugfix 和 feature spec 必须显式提供：

- `Goal`
- `In scope`
- `Out of scope`
- `Validation commands`
- `Expected artifacts`

如果这些字段缺失，或者仍然是占位内容，packaged skill 会直接拒绝启动 sprint。

## 执行范围限制

复杂 spec 可以额外定义：

- `maxFiles`
- `maxChecks`
- `maxDeliverables`

producer 在改代码前，应先在 worklog 里声明 `PLANNED_FILES`、`PLANNED_CHECKS` 和 `DELIVERABLES`。如果一轮会超出范围，就缩小这一轮，而不是强行把大改塞进一次执行。

## 同步规则

事实来源仍然是：

- the source repository copy of `scripts/ai-sprint-orchestrator`

只有当变更影响以下内容时，才同步 packaged copy：

- package-local CLI behavior
- validation behavior
- artifact layout
- package-local references or runtime assumptions

不要盲目镜像所有上游 orchestrator 修改。

## 下一阶段架构方向

这个 package 现在已经支持更细粒度的 `work-unit` 上下文约束。关键 work-unit 字段包括：

- `workUnitId`
- `workUnitGoal`
- `allowedFiles`
- `unitChecks`
- `unitDeliverables`
- `unitSummary`
- `carryForwardSummary`

continuation 默认优先读取更短的 `carryForwardSummary`，而不是回放整段历史 decision。目标是把跨 unit 传递的上下文压缩到最小必要信息，降低长运行过程里的上下文漂移。
