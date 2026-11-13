---
"principles-disciple": patch
"@principles/pd-cli": patch
---

E2E Closure Round 3：实验隔离与归因缺陷收口（P0 安全 + P1 可运行性）。

- **实验工作区隔离（P0）**：`CorrectionObserverService` / `TrajectoryService` / `PDTaskService` 在 `start()` 最前置 `assertExperimentWorkspaceIsolation`，拒绝即 return（日志带 `reason=`）。新增 `declaredExperimentWorkspace()`：除"位于实验根内"外，还必须与显式声明的 canonical 工作区一致；新增 `workspace_missing` 与非存在目录、junction/realpath 越界的拒绝。生产模式（无 `PD_EXPERIMENT_ROOT`）行为不变。
- **安装布局（P1）**：实验 canonical 布局复用既有 `collectLabModuleClosure` 从本轮源码物化 `console/lab`，修复 Examiner `503 examiner_lab_unavailable`；verify 阶段断言 payload 存在。
- **CLI 健康（P1）**：`pd health` 新增 `resolveHealthHomeDir()`，无法解析实验 PD home 时返回不可解析占位路径，**绝不**静默回退生产 home。
- **跨轮纠正归因（P1）**：新增 `correction-anchor.ts`，纠正消息带回指时锚到最近一个"带写类工具调用"的 assistant turn；无法确定时返回结构化 `unresolved`，不再默认最近一轮。
- **回归**：`experiment-workspace-isolation`、`correction-anchor`、`health`/`health-mcp`、`experiment-install-layout` 定向测试全绿；真实 launcher MCP 越界 exit 1；实验环境 `pd health` 输出 0 条生产路径。
