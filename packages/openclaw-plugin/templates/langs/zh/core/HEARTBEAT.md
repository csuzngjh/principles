# 💓 Heartbeat Checklist: Principles Disciple

每次心跳时，请自检以下项目以维持系统的进化活力：

## 1. 痛觉与进化检查 (Pain & Evolution)
- [ ] **检查 `.pain_flag`**: 是否存在未处理的痛觉信号？如果有，评估是否需要立即运行 `/reflection` 或 `/evolve-task`。
- [ ] **检查 `EVOLUTION_QUEUE.json`**: 是否有待处理的异步进化任务？
- [ ] **检查 `ISSUE_LOG.md`**: 最近是否有未解决的高优先级 Issue？

## 2. 战略对齐 (Strategic Alignment)
- [ ] **对比 `CURRENT_FOCUS.md`**: 过去一小时的操作是否偏离了当前的战略重点？
- [ ] **周治理状态**: 查阅 `memory/okr/WEEK_STATE.json`，确保当前处于 `EXECUTING` 阶段。如果处于 `INTERRUPTED`，必须优先处理恢复。

## 3. 环境健康 (System Health)
- [ ] **工具链**: 检查 `.state/SYSTEM_CAPABILITIES.json`，确保核心工具（如 `rg`, `sg`）处于可用状态。
- [ ] **文档同步**: 确保 `PLAN.md` 状态与实际进度一致。
- [ ] **熵减巡检 (Grooming)**: 运行 `ls -F` 检查项目根目录。如果发现非标准的临时文件、散落的测试脚本或命名不规范的文档，请立刻调用 `workspace-grooming` 技能发起内务整理。

---
*如果没有上述问题，请回复 `HEARTBEAT_OK` 以节省 Token。*
