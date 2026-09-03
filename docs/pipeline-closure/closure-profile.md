# PRI-634-C Closure Validation Profile

## 目的

SPEC 第 9 节要求：不修改代码默认 flag，用独立 profile 只开启验证所需能力。

## 实现

PD 的 flag SSoT 是代码内 `feature-flag-contract.ts`（默认值）+ workspace `.pd/config.yaml`（sparse 覆盖，PRI-645）。
本验证没有引入新的 profile 机制（P7：不造投机抽象），而是：

1. 记录 DEFAULT_PROFILE（改动前生效状态，见 BASELINE.md）；
2. 在 `D:\.openclaw\workspace\.pd\config.yaml` 的 `features:` 段把两个已注册的 quiet flag 翻为 `enabled: true`（带注释标记 PRI-634-C）；
3. `internalization_full_chain` 已默认开启，无需改动。

## DEFAULT_PROFILE（46 flag / 29 enabled，摘录关键项）

```
internalization_full_chain [core]  = true
progressive_evaluator      [quiet] = false
context_manifest_budget    [quiet] = false
```

## CLOSURE_PROFILE（验证期生效，46 flag / 31 enabled）

```
internalization_full_chain [core]  = true   (默认)
progressive_evaluator      [quiet] = true   (本次覆盖)
context_manifest_budget    [quiet] = true   (本次覆盖)
```

验证命令：

```
pd runtime features --workspace "D:\.openclaw\workspace" --json
# status: degraded(4 条预存 warning) | source: user_config | 31/46 enabled
```

## 回滚

删除 `config.yaml` 中这两个条目或将 `enabled` 翻回 `false` 即恢复 DEFAULT_PROFILE；
两个 flag 的 flag-off 行为 = 各自 Layer 1/Layer 2 的既有装配路径不变（flag 契约描述原文）。

## 注意

- 两个 quiet flag 打开后产生了 4 条 warning，经核对全部为预存配置卫生问题（别名冲突 ×1、未知 flag ×2、遗留文件 ×1），与本次开启无关。
- 版本标签漂移：安装版插件包 `package.json` 显示 1.76.1（release asset 保留源码组件版本），实际代码 = origin/main 1ce9d825。已知 P2 类问题（memory: console 版本标签漂移），不影响功能验证。
