# CNB Cloud Worker 文档索引

> 状态：索引，供快速定位
> 用途：把 CNB Cloud Worker 系列文档（Phase 0 现实审计 / Phase 1 能力验证 / Phase 2 架构设计 / 接入手册）汇总为一张表，帮助读者按需进入
> 约定：每行的「一句话用途」提炼自该文档自身的标题或开头说明，不改写、不补充文档未声明的事实
> 维护：新增/移除本系列文档时，同步更新下表

---

## 索引表

| 文档路径 | 一句话用途 | 目标读者 |
|---|---|---|
| [`docs/runbooks/CNB_CLOUD_WORKER.md`](../runbooks/CNB_CLOUD_WORKER.md) | CNB Cloud Agent Worker 的接入与运行手册：给出从 GitHub 仓库到「云端 Worker 真正可用」的完整路径与验证清单 | Owner / 仓库维护者 |
| [`docs/audit/cnb-cloud-agent-architecture.md`](./cnb-cloud-agent-architecture.md) | PD Cloud Agent 架构设计（Phase 2），界定 PD 第一个云端 Agent 开发节点（CNB Cloud Agent Worker）的目标、非目标与目标架构 | Owner / 架构评审者 |
| [`docs/audit/cnb-capability-validation-report.md`](./cnb-capability-validation-report.md) | CNB 能力验证报告（Phase 1）：只以 CNB 官方文档为准，逐项验证 Workspace、自定义开发环境、VS Code/Web IDE、AI Agent、自动化任务五项能力 | Owner / 评审者 |
| [`docs/audit/cnb-environment-compatibility-report.md`](./cnb-environment-compatibility-report.md) | CNB 环境兼容性报告（Phase 0）：CNB Cloud Agent Worker 立项前，对仓库当前技术栈、必需依赖、CI 环境要求与容器适配风险的现实核查 | Owner / 评审者 |
| [`docs/audit/PRI-766-weekly-audit-reality-report.md`](./PRI-766-weekly-audit-reality-report.md) | PRI-766 周定时审计现实审计（Phase 0）：核查周定时骨架、audit report 输出位置、Linear 更新方式与权限边界，指出缺口在「证据链」 | Owner / 任务相关评审者 |
| [`docs/audit/PRI-768-developer-entry-reality-report.md`](./PRI-768-developer-entry-reality-report.md) | PRI-768 CNB Developer 入口现实审计（Phase 0）：确认「Owner 主动下达开发任务」入口的可行性与 CNB 官方能力一致 | Owner / 任务相关评审者 |
| [`docs/audit/PRI-778-cnb-github-bridge-reality-report.md`](./PRI-778-cnb-github-bridge-reality-report.md) | PRI-778 CNB → GitHub 交付桥现实审计（Phase 0）：核查 canonical 约束、CNB 事件面、同步机制现状与官方 git-sync 插件适配性 | Owner / 任务相关评审者 |

---

## 阅读顺序建议

- 想了解「为什么要做这件事」→ 先读 `cnb-environment-compatibility-report.md`（Phase 0），再读 `cnb-capability-validation-report.md`（Phase 1）。
- 想知道「最终架构长什么样」→ 读 `cnb-cloud-agent-architecture.md`（Phase 2）。
- 想动手接入/运行 → 读 `runbooks/CNB_CLOUD_WORKER.md`。
- 想追溯某条具体结论的来源 → 按 PRI- 编号读对应的 reality report。
