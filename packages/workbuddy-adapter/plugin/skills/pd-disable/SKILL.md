---
name: pd-disable
description: 当 Owner 要求停止或关闭 WorkBuddy 的 Principles Disciple 行为时，关闭此宿主治理开关并保留数据。
---

# 关闭 WorkBuddy PD

Owner 的关闭请求已经授权这次操作。根据本技能文件的路径定位同一插件根目录（`skills/pd-disable/SKILL.md` 的上三级目录），运行随插件交付的控制脚本：

```text
node "<插件根目录>/scripts/pd-control.cjs" disable
```

脚本调用正式安装器的 `setWorkbuddyGovernanceFlag` API，在用户固定工作区 `~/.workbuddy/pd-workspace` 关闭 `host.workbuddy` 并读回验证。它保留治理数据和其他宿主配置，不手工修改数据库或已安装运行时代码。

只有退出码为 0 且 JSON 回执 `ok=true`、`enabled=false`、`host=workbuddy` 时才确认开关已关闭。报告回执中的工作区和状态；新 Hook 调用将读取该配置。已运行中的任务是否停止须另查证。

如果正式安装器 API 或工作区缺失，脚本明确失败；按回执使用官方安装/修复流程恢复能力。不要搜索 npm 缓存、拼装第二套写开关逻辑或用删除文件替代关闭。
