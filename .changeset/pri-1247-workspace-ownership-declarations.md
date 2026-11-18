---
"@principles/install-layout": patch
"create-principles-disciple": patch
"@principles/core": patch
"@principles/pd-cli": patch
"principles-disciple": patch
"@principles/workbuddy-adapter": patch
---

workspace 归属判定纳入宿主正式声明与 payload 绑定（PRI-1247 复验重开）：默认目录之外，`~/.openclaw/principles-disciple.json` 声明的非默认工作区、Codex PLUGIN_DATA 与 WorkBuddy marketplace 的 mcp-binding.json 绑定同样构成归属；launcher/pd-setup/安装器健康检查/`pd health`/Codex 工作区解析复用同一判定（按最终目录身份比较 junction/大小写），错绑在工具可用前被拒，修复 Codex 安装时不再选中他宿主声明的工作区（launcher 三副本随发）。同批：`pd candidate internalize` 写入口复用准入写门并在领取（wakeOnce）拦截未准入旧任务（PRI-1267）；入队写失败返回单一结构化 JSON 回执（PRI-1268）；链路追踪区分候选被拒/待审/已准入/真实存储失败，拒绝场景不再建议注定被拒的 internalize 命令（PRI-1263）。

评审轮整改（2026-11-18）：跨宿主显式安装重定向到 Codex 自有默认工作区时先创建该目录（原先仅 `--host all` 非显式路径创建，重定向写出指向缺失目录的绑定后被自身健康检查判失败）；internalize 准入门自身写失败同样返回结构化 write_failed；`--dry-run` 预览以同一评估语义计算结论但不落盘（预览零写入，cli-4）；复用待审（admitted+awaiting_owner）在链路追踪中优先呈现为待 Owner 审查而非误报账目写失败。

评审二轮整改（2026-11-18）：工作区声明改从宿主实际配置根读取——共享收集器、安装器 fallback 与 pd-setup 归属检查统一改用 `openclawHome`（即 launcher 依 `OPENCLAW_STATE_DIR`/`OPENCLAW_HOME` 解析的同一根），默认根声明在实际根被覆盖时不再被误用，消除"安装器放行、launcher 拒绝"的两侧分歧；Codex 工作区物化限定在本次安装目标或刷新目标含 Codex 的运行，物化失败归入 Codex 自身的安装/刷新结果而不再越过宿主错误隔离中止整体安装（仅安装 OpenClaw 且 Codex 目录不可写的形态已回归覆盖）。
