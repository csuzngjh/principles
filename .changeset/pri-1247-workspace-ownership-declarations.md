---
"@principles/install-layout": patch
"create-principles-disciple": patch
"@principles/core": patch
"@principles/pd-cli": patch
"principles-disciple": patch
"@principles/workbuddy-adapter": patch
---

workspace 归属判定纳入宿主正式声明与 payload 绑定（PRI-1247 复验重开）：默认目录之外，`~/.openclaw/principles-disciple.json` 声明的非默认工作区、Codex PLUGIN_DATA 与 WorkBuddy marketplace 的 mcp-binding.json 绑定同样构成归属；launcher/pd-setup/安装器健康检查/`pd health`/Codex 工作区解析复用同一判定（按最终目录身份比较 junction/大小写），错绑在工具可用前被拒，修复 Codex 安装时不再选中他宿主声明的工作区（launcher 三副本随发）。同批：`pd candidate internalize` 写入口复用准入写门并在领取（wakeOnce）拦截未准入旧任务（PRI-1267）；入队写失败返回单一结构化 JSON 回执（PRI-1268）；链路追踪区分候选被拒/待审/已准入/真实存储失败，拒绝场景不再建议注定被拒的 internalize 命令（PRI-1263）。
