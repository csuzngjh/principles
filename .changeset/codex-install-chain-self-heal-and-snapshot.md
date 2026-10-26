---
"create-principles-disciple": patch
---

PRI-1046 收口：Codex 插件安装链上两条「看起来正常」的静默路径不再成立。① `$pd-control setup` 把「安装后字节与 pin 一致」作为唯一验收，npm 退出码只是过程信号：当字节不符（精确 pin 被静默丢掉、模块只留在嵌套目录）时，先清掉 `runtime/node_modules` 与锁文件、从干净树重装一次，仍不符才结构化失败并逐行列出不符的包——不再把「手工删除 node_modules」当作下一步交给用户；网络请求仍不重试（失败立刻暴露，单请求超时 60 秒），判定权归字节核对，重试不会掩盖一次丢掉 pin 的安装。② `pd-status` 新增 `snapshot` 检查：把已安装缓存快照的版本与该 marketplace 本地 source 里的 `plugin.json` 版本比较，落后即 degraded 并给出 `codex plugin remove/add` 命令——旧快照过去因为 pin 与脚本都取自它自己而永远自称 pinned match。无法比较时区分两类：「非本地 marketplace / 显式 --plugin-root」按设计不适用，其余（config.toml 不可读、source checkout 已删、marketplace 已移除）属 degraded 并给出修复动作。
