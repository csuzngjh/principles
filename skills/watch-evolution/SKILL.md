---
name: watch-evolution
description: Start the background evolution daemon to process queued tasks from EVOLUTION_QUEUE.json.
allowed-tools: Bash
---

# /watch-evolution: 后台进化守护者

**目标**: 启动一个持续运行的进程，自动分析并修复积压的代码问题。

## 1. 运行环境准备
- 确保已配置 `docs/PROFILE.json` 中的 `evolution_mode: "async"`。
- 确保 `docs/EVOLUTION_QUEUE.json` 存在。

## 2. 启动指令
请运行以下命令启动守护进程：

```bash
python scripts/evolution_daemon.py
```

## 3. 工作流程
1. **自动扫描**: 每隔 30 秒扫描一次 `docs/EVOLUTION_QUEUE.json`。
2. **调度策略**:
   - 按 `priority` 从高到低处理任务（高优先级先执行）。
   - `status: retrying` 的任务仅在 `next_retry_at` 到期后才会再次执行。
   - 失败任务进入指数退避重试，超过最大尝试次数后标记为 `failed`。
3. **诊断 (Diagnosis)**: 加载 `root-cause` 技能，通过 Headless 模式定位错误根因。
4. **修复 (Fix)**: 加载修复技能，自动修改代码并运行测试。
5. **落盘 (Log)**: 调用 `reflection-log` 将经验存入 `PRINCIPLES.md` 和 `ISSUE_LOG.md`。
6. **看板**: 实时更新 `docs/EVOLUTION_PRD.md` 展示进度。

## 4. 退出
- 按 `Ctrl+C` 停止后台任务。任务的状态将被保留在 JSON 中，下次启动可继续执行。
