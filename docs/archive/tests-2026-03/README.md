# 2026-03 手工测试体系归档（Test Diet Phase 1B）

> 归档日期：2026-09-21 · 依据：`docs/testing/test-archaeology-report.md` §3.1/§10 项 3-4 · 工单：PRI-885

本目录归档 2026-03-11 一次性 OKR/信任引擎手工验证体系，自 2026-03-19 后无任何改动：

- `reports-2026-03-11/`、`session-2026-03-11/`、`README.md`：当时的测试执行结果与会话记录（原 `tests/archive/`）；
- `scripts/`：当时的驱动脚本（OKR 测试族、compare/save/score 工具、`test_event_bus.py`）。
  其被测对象（trust engine、`hooks/hook_runner.py`、`/home/csuzngjh/clawd` 工作区）均已不存在，
  且 CI 从不执行这些脚本（无 pytest/vitest 引用）。

保留为历史证据，不再维护；现行测试入口见 `WORKFLOW.md` 与各包 vitest 配置。
