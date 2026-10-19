# SPEC-PD-CROSS-HOST-KEYWORD-PAIN-001 — P0 实施与验收记录（2026-10-19）

**结论：P0 源码接线与隔离测试已完成；LIVE VERIFIED、Node22/npm10 全量门禁和 Codex 可选 live-only P1 均未宣称完成。**

- Base: `origin/main@9f2184d6b533ae6eb1a42b8358efde3059d61815`
- Branch: `ai/cross-host-keyword-pain-20261019`
- Worktree: `D:\Code\_worktrees\pd-cross-host-keyword-pain`（原仓库的脏工作区未覆盖）
- 原始 SPEC: `docs/specs/SPEC-PD-CROSS-HOST-KEYWORD-PAIN-001-v0.1.md`

## A. 已交付代码

1. `@principles/core` 增加 `workbuddy_live_keyword_pain` quiet 默认 OFF 及生命周期记录。
2. `@principles/host-runtime` 增加四个现有高精度 seed 的确定性投影；`assessWorkbuddyLiveKeyword()` 仅对 16KiB 以下当前 prompt 做前缀/共享 Stage1 检测；未命中无新增 DB 写及网络 LLM。
3. `admitTrustedWorkbuddyLiveCorrection()` 先验证原生 WorkBuddy `UserPromptSubmit`、`is_internal_continuation=false`、session/generation ID 与工作区有效开关；普通泛型 `admitGovernanceSignals()` 仍不开放 WorkBuddy 非显式候选。
4. 唯一规范 Pain ID、`pain_events`/`governance_signal_admissions` 事务、5 次每会话每小时准入和 `ensureGovernanceDiagnosticianTask()` 继续使用原有代码；重放幂等。WorkBuddy 自动纠正的 task payload 以已经提交的 `pain_event:<canonicalPainId>` 标记真实来源，不虚构 Codex `governance_observation`。
5. `workbuddy-adapter` 仅在开关打开、真实当前 Owner message 且非显式前缀时调用；正常 stdout/exitCode 不改变；仅命中后写结构化 event（不含原文）。
6. `pd workbuddy worker --status` 报告有效的 auto keyword Pain 开关和 flag 来源，默认 OFF。

## B. 隔离测试（非真实宿主 LIVE E2E）

| 范围 | 结果 |
| --- | --- |
| `workbuddy-adapter/tests/live-keyword-pain.test.ts` | 5/5 PASS（real SQLite + task + 幂等/限额/负例/无 transcript） |
| `workbuddy-adapter/tests/explicit-owner-statement.test.ts` + `pd-hook-production.test.ts` | 36/36 PASS |
| `host-runtime/tests/governance-signal-admission.test.ts` | 52/52 PASS |
| `codex-adapter/tests/pd-hook-slice-b.test.ts` | 9/9 PASS（已有同意开启的 Codex ingestion + 规范 Pain/Task + replay） |
| `principles-core/.../feature-flag-contract.test.ts` | 76/76 PASS |
| **累计** | **178/178 PASS** |

静态编译：`host-runtime`、`workbuddy-adapter`、`codex-adapter` 成功；`pd-cli` 和 `principles-core` 在本地旧依赖与未满足工具链条件下出现非改动范围错误（Pi API 类型漂移、CLI 缺少原仓库其他包导出/声明），不等于完整仓库构建通过。当前执行工具是 **Node 26.7.0 / npm 11.19.0**，而项目指定验收工具链 **Node22/npm10**；这项差距仍需在 CI 或对应本地环境重新验收。

纯扫描性能：10,000 次 Node 微测，p50 0.0040ms，p95 0.0066ms，p99 0.0108ms，max 1.679ms。**这不是子进程、SQLite 或真实宿主 p95/p99；不得代替 SPEC `6 性能门禁。**

## C. 仍需执行的 Gate

- **G5 UI/CLI / 完整安装验收：** 已增加 status 可视性，但尚未增加正式受控“启用/关闭此新开关”的专门命令；配置仍可通过经 Owner 审核的工作区 config 设置。需测升级/重装插件与版本缓存是否包含新 bundle，不得手工补丁运行时。
- **Gate B CI:** 提交 PR 后需等待远端 Node22/npm10 构建和评审；不能用上述隔离测试代替全量 CI。
- **Gate C LIVE:** 安装官方交付产物到隔离 WorkBuddy 和 Codex 宿主，确认实际 UserPromptSubmit/Stop 钩子触发并以只读 SQL 检查 Pain/任务，特别核查 WorkBuddy *首个*启动 prompt 在 CLI print/stream-json 不派发钩子的已知限制。生产工作区配置尚未改动。
- **安全验证:** WorkBuddy `pain_event:...` 引用可在 transaction 同一 SQLite 查到真实规范 Pain 行，但尚无单独的 Diagnostician sourceRef 通用 resolver E2E；任务文本来自已脱敏用户当前 message，后续应验证诊断端对来源的解读不会夸大为完整轨迹。
- **时延:** 需真 Node22/Windows 库和真 SQLite 测量钩子增量延迟、锁争用与 p95/p99，并核查禁用时不增加当前 prompt 扫描。
- **P1 可选:** Codex `codex_live_keyword_pain` 独立于 transcript 采集的 live-only 能力是 SPEC 中另需 Owner 决策的阶段；本次未改变 Codex 的现有 `codex_conversation_ingestion` 同意边界。

## D. 安全启用与回滚（示意，不在本次实施中自动执行）

在**正确的 WorkBuddy governance workspace**（不是 Codex/项目目录）的 `.pd/config.yaml` 中，确认 `features.host.workbuddy.enabled=true`，再经 Owner 审核添加：

```yaml
features:
  workbuddy_live_keyword_pain:
    enabled: true
    category: quiet
```

不要覆盖其余已有 features。关闭时将该项 `enabled: false`；显式 Owner 痛苦登记、工具失败治理与已有 Pain 数据保持不变。Codex 现成路径须经其独立 ingestion 同意流程，不能因 WorkBuddy P0 自动打开 Codex transcript 权限。

## E. 已知发布边界

- 本次**没有**读写生产 `trajectory.db` / `.pd/state.db`，没有 Owner 自动批准原则，没有修改用户宿主开关。
- WorkBuddy 新建的 P0 功能只检查以四个词开头的**当前**用户消息；引号、引用、第三方转述故意降低召回，防止误报。
- 源码接线已测试，但不能把“CI 未过、未部署真实宿主、缺性能门禁”写成 FULL PASS。
