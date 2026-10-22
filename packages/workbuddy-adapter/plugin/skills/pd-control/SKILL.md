---
name: pd-control
description: 当 Owner 明确要求管理 WorkBuddy 的 PD 接入、停用或修复时使用。当前随插件交付的控制脚本只提供停用操作；不得猜测启用命令或手工修改配置。
---

# PD Control（WorkBuddy）

## 前提

只在 Owner 明确要求停用 WorkBuddy PD 时执行操作。WorkBuddy 的固定治理工作区是 `~/.workbuddy/pd-workspace`；安装/注册插件不等于启用治理，插件默认状态为关闭。

## 停用

根据当前技能文件所在位置定位同一插件根目录，运行随插件交付的控制脚本：

    node "<plugin-root>/scripts/pd-control.cjs" disable

不要搜索任意 npm 缓存，也不要使用其他宿主的脚本。

只有退出码为 0 且 JSON 回执确认 `ok=true`、`enabled=false`、`host=workbuddy` 时，才能报告停用成功。报告真实回执中的工作区与状态。新 Hook 调用读取该开关；已运行中的任务是否停止必须另行核验。

## 安装、启用与修复

当前插件内的 `pd-control.cjs` 只实现停用。安装/注册、启用或修复必须使用正式 WorkBuddy 插件安装器/宿主管理流程。若该流程没有提供可验证的启用操作，明确报告不支持；不得猜测命令、手工修改配置或调用私有安装器函数。

## 禁止

- 不直接编辑配置、数据库、Runtime 或业务状态文件。
- 不删除数据来实现停用。
- 不将安装、注册或配置存在描述为 PD 已实际启用。
- 不批准、拒绝或激活原则。
