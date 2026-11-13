# PD-AA C04/G1 — Codex `exec` 追加路径验收（2026-11-13）

范围：Codex `exec` 单工作区、只追加（append-only）。不包含跨宿主（PRI-1127），
不包含满预算替换路径的重跑（该批结论已封存）。

## 0. 结论

| 层 | 结论 | 证据边界 |
|---|---|---|
| 工程交付 | 可安装构建的正常入口可复现“选中 → 实际请求追加一次” | 本地回环 Decisions + 本地 Responses stub；无真实服务流量 |
| C04 | 正常入口正例 = `confirmed/timely`（限隔离路径）；`returned` 对照在同入口成立 | 未使用真实评分服务；配置身份为 `partial` |
| G1 | “及时送达 + 停用演练”成立；“后续动作关联”未建立 | 宿主模型为 stub，未产生后续行为动作 |
| 真实服务小批 | **NOT RUN**：无匹配书面授权，0 次真实请求 | 旧额度、冻结记录原样保留 |
| 试用（G2） | **未开启**，默认关闭 | 唯一待决动作见 §8 |

本轮未发布、未改生产配置、未合并 PR、未重跑已消费额度。

---

## 1. 构建与安装账本（仓库构建 / 发布 / 实际加载分开记账）

| 层 | 身份 |
|---|---|
| 仓库构建 | worktree `D:\Code\_worktrees\principles\PRI-1116-codex-append-acceptance`；HEAD `d11a0163e6026a0f90bf9f89f4f2636ad5a55230`；tree `0f9c5557c93e779ab1a5f7fd73e59f1d6e918245`；构建指纹 `ebb388b45e5e0a87e5be9aa4817748127a8e16e12b29eec61f1a7943abcd8dee`（`hashBuildArtifacts`，codex-adapter / host-runtime / principles-core / install-layout 的 `dist`） |
| 打包产物（本次安装源） | `npm pack`：`principles-host-runtime-4.0.0.tgz` SHA-256 `FA0D85E1D5DE96DD932F7850C5E6CDE38434FC89655E986926D66D649EFA564C`；`principles-codex-adapter-0.9.0.tgz` SHA-256 `FB970E9D63452F05900F78752520B9E40CB34CAC801D4A6C4FC33B4AE10B376B` |
| 实际加载 | 隔离前缀 `…\.tmp\pri-1116-append\install\node_modules\@principles\codex-adapter\dist\pd-hook.js`；hook SHA-256 `6dcc4dc8b0c2d93a9cd175deac7bcbf32f1e6c4f183f0092de01c4392b7c202a`；协议 `dist/adaptive-decision-protocol.js` SHA-256 `6367702984adefb080c27ced97d240c23f60d2b74c44144fd7577cd73a6fc670`；判定版本 `v3-20261112`；`@principles/host-runtime` 与 `@principles/codex-adapter` 均解析在隔离前缀内（无主工作区泄漏） |
| 发布产物（npm 现网） | `@principles/host-runtime@4.0.0` 内含 `v2-20261112`（无 `candidateSafetyQuestionId`）；`@principles/codex-adapter@0.9.0`；`principles-disciple@3.3.0` bundle 内无 `v3-20261112` 字面量 → **现网可安装产物尚不包含本实现** |

宿主：Codex CLI `0.167.2`；`codex exec` + 隔离 `CODEX_HOME` + 隔离 `HOME/USERPROFILE` +
独立工作区；`hooks.json` 使用 `UserPromptSubmit/SessionStart/Stop` 指向 tee 包装的**已安装** hook。

用户侧真实加载链（本次未改动）：`~/.codex/hooks.json` → `~/.pd/codex/pd-hook-entry.cjs`
→ `~/.pd/runtime/codex-adapter/`（由 `create-principles-disciple` 安装/升级）。
本次隔离安装与这条链使用同一组包产物，因此验收对象是“合并后可安装构建”，
不是仓库源码，也不是现网发布版本。

### 正式交付缺的确切步骤

1. 为 `@principles/host-runtime`（含 `v3-20261112` 判定）与 `@principles/codex-adapter`
   生成 changeset 并提升版本（当前 version 行仍是 `4.0.0` / `0.9.0`，源码已领先）。
2. 发布上述两个包。
3. 重新构建并发布 `create-principles-disciple`（其 `files` 内复制 `codex-adapter/`、
   `host-runtime/`）；用户通过它升级 `~/.pd/runtime` 与 Codex hook。
   仅发布 host-runtime 而不更新 bundle，用户实际加载的仍是旧副本。
4. 发布后再用同一隔离入口复核一次“实际加载路径 → 版本 → 判定版本”，
   不能用一个版本号同时代表仓库构建、npm 发布与用户加载。

---

## 2. 追加正例（决定交付的那条路径）

输入（两臂完全相同）：`请交付验收：这次改动已经全部完成了吗？`
候选顺序 `SCOPE, BIG, TESTS, DELIVERY`；Native 打包为 legacy FIFO：`SCOPE` 后 `BIG`
不 fit 即停止；`DELIVERY` 被 Native 遗漏，剩余预算足够追加。

| 观测 | Native 臂 | Adaptive 臂 |
|---|---|---|
| 指令 | `SCOPE` | `SCOPE, DELIVERY` |
| 正文长度 | 770 字符 | 934 字符（有效预算 1250，请求值 944 被 `PROMPT_BUDGET_MIN_CHARS` 钳制） |
| 评分请求 | 0 | **1**（`candidate_c1`、`candidate_c2`、`insufficient_context`；追加路径为单条件，无 `_value`/`_safety`） |
| 评分 | — | `c1=0.04`、`c2=0.95`、`insufficient_context=0.04` |
| 判定 | — | `selected:selected:c2` |
| 目标正文 | 缺席 | 实际出站请求中**恰好 1 次** |
| `SCOPE` | 1 次 | 1 次（顺序在 `DELIVERY` 之前） |
| 请求正文 | — | 与 Native 不同；内容为 Native + 目标，未替换任何原有指令 |

通过项：同输入（scenario spec 哈希一致）、同构建、同候选；目标恰好一次；
原有内容与顺序保留；正文不超预算；评分请求恰一次；hook 完成早于首个宿主请求。

---

## 3. 回退、停用与对照

| 场景 | 评分请求 | 最终正文 | 观测状态 | 说明 |
|---|---|---|---|---|
| 正常弃选（全部低分） | 1 | 与 Native 逐字节一致 | `none_applicable:below_selection_threshold:none`；`adaptive_selection_none:no_increment` | 完成评估后无适用目标，不是超时 |
| 无可追加空间 | **0** | 与 Native 逐字节一致 | `skipped`；`adaptive_selection_skipped:no_appendable_gap` | Native 已占 1140/1250，剩余空间不足任何候选；**零评分请求** |
| 超时（relay 3 s 不应答） | 1 | 与 Native 逐字节一致 | `degraded`；`SELECTION_EXPIRED`；`cancelledAt` 已记录 | 发送后 **2007 ms** 取消（2 s 窗口）；与正常弃选可区分 |
| 关闭（flag off） | **0** | 与 Native 逐字节一致 | 无 Adaptive 诊断 | 默认关闭即 Native |
| 重新开启 | 1 | `SCOPE, DELIVERY` | 同 §2 | 关闭后恢复由正例臂承担 |
| 只有返回（C04 对照） | 0 | 仅 hook 返回 `SCOPE` 上下文 | `payload=returned`，无请求证据 | 同构建 hook 重放，不启动宿主请求 |

“无可追加空间”与“关闭”均为零评分请求且正文保持 Native；
“正常弃选”（1 次请求、主动判不适用）与“超时”（1 次请求、被截止取消）分开记录。

---

## 4. 时延（同一批，两臂保留绝对值）

| 观测点 | 值 |
|---|---|
| Native `spawn → 首个宿主请求` | 4452 ms |
| Adaptive `spawn → 首个宿主请求` | 4556 ms |
| 差值（Adaptive − Native） | +104 ms |
| `UserPromptSubmit` hook 完成 → 首个宿主请求 | +71 ms |
| 评分请求发送 → 首字节 | 20 ms |
| 评分请求发送 → 完整校验 | **23 ms**（远低于 2000 ms 窗口） |
| 超时臂发送 → 取消 | 2007 ms |

说明：同一构建的前一次重复运行得到 Native 4786 ms / Adaptive 4385 ms（差值 −401 ms），
因此单次差值落在 `codex exec` 启动抖动内，不能当作稳定增量；本文件只记录事实。
独立接收端（与 hook 不同进程、不同端口）确认目标正文确在**实际请求**中；
hook 完成时间早于该请求，动作顺序可证。主模型为本地 stub，因此“送达事实”成立，
“送达后模型是否照做”（动作关联）不成立。

---

## 5. C04 逐项

| 要求 | 本轮证据 | 结论 |
|---|---|---|
| 独立比对同一请求正文 | 接收端捕获两臂实际请求；同输入哈希一致；目标在 Adaptive 请求中恰好一次、Native 缺席 | 正例成立 |
| 配置身份 | 每臂记录 config SHA-256、安装包版本/哈希、实际加载 hook 哈希、判定版本；两臂仅 Adaptive flag 不同 | `partial`（宿主模型与真实评分服务不在范围内） |
| 行动顺序 | hook 完成 → 71 ms → 首个宿主请求（独立时间戳） | `timely`（对“请求”这一关键动作） |
| “只有返回”对照 | 同构建 hook 重放：有 returned 上下文、无任何请求证据 | 只能记 `returned` |
| 缺项 | 真实评分服务下的正例属 §8 的独立授权批次，不由本地回环冒充 | 可在同一隔离入口补齐（同一构建/入口/接收端） |

---

## 6. G1 逐项

| 要求 | 本轮证据 | 结论 |
|---|---|---|
| 真实适配器正常入口 | `codex exec` + 隔离 `CODEX_HOME` + 已安装 hook，实际请求被独立接收端捕获 | 成立（隔离路径） |
| 及时送达 | 目标完整正文在首个宿主请求内，且 hook 先完成 | 成立 |
| 后续动作关联 | 宿主模型为 stub，未产生真实后续动作 | **未建立** |
| 停用演练 | 关闭臂 0 评分请求、正文 Native；重新开启回到追加 | 成立 |

结论：G1 只签“送达 + 停用演练”，不宣称完整 G1。动作关联需真实宿主模型执行后续动作，
不能由本隔离入口的 stub 补齐；归 G2 或另一次带真实模型的有界运行。

---

## 7. 真实服务小批（未运行）

- 计划上限：2 次真实评分（1 例明确应追加 + 1 例无需追加对照），每例 1 次。
- 沿用既有端点/路由/合成数据/阈值/截止：`openrouter.ai/api/alpha/decisions`、
  `respan/span-01-lite:free`、仅 Respan、2000 ms、1 次/例。
- 实际：**0 次**。未找到覆盖**当前构建 + 端点 + 外发范围 + 预算**的书面授权；
  旧批件绑定旧构建/旧判定版本，不复用、不改写、额度未动。

需 Owner 一次性决定的三类不同范围（见 §8）。

---

## 8. 唯一待决动作与试用状态

当前**不能开启试用**：G2 需要限域书面授权，且用户可安装产物尚未包含本实现（§1）。

待决范围（互相独立，需分别批准）：

| 动作 | 范围 | 可执行命令 | 通过线 |
|---|---|---|---|
| A. 真实评分小批 | 绑定 §1 构建指纹 `ebb388b4…`；端点 `openrouter.ai/api/alpha/decisions`；模型 `respan/span-01-lite:free`；仅 Respan；外发 = 任务文本 + 候选正文 + `replaces`（本轮为空）；2000 ms；2 次上限（1 正例 + 1 对照）；有效期由 Owner 填 | 冻结 `cases-append-real.json`（append + pure-ack，`requestBudget.total=2`）后：`node scripts/dev/adaptive-activation/run-cases.mjs --approved --manifest docs/implementation-reports/adaptive-activation-v3/cases-append-real.json` | 正例在 2000 ms 内完成校验并选中，最终正文追加目标恰好一次；对照 0 次评分且正文等于 Native；额度用完即止，不重跑、不调阈值、不换模型 |
| B. 试用启用（G2） | 指定真实工作区；Codex `exec`；只追加（省略 `replaceableActivationIds`）；建议 1–2 周；记录起止日期、暴露次数、命中/遗漏/无变化/伤害/未知 | 在目标工作区写 §8 配置并把 `host.codex.adaptive_activation.enabled` 置 `true`；停用改回 `false`；每轮按 SPEC §6.3 归档 | 窗口内自动采集可读；停用后复跑“关闭”路径得到 0 评分请求 + Native 正文；到期形成一次复盘，不自动续期 |
| C. 发布 | 版本提升 + 发布 host-runtime/codex-adapter + 重建 `create-principles-disciple` bundle | `npx changeset add`（minor/patch 按包）→ `npm run build` → 按仓库发布流程 publish 两个包 → 重建并发布 bundle；用户经 `npx create-principles-disciple` 升级 | 用户安装后 `~/.pd/runtime/codex-adapter` 加载的协议为 `v3-20261112`，且实际 hook 哈希与本节记录一致；仓库构建、npm 发布、用户加载三者分别核对 |

以上任一项未获批前：保持默认关闭，不发真实评分，不发布，不启用试用。

试用配置与停用（获批后使用，当前保持默认关闭）：

```yaml
features:
  host.codex.enabled: true
  host.codex.adaptive_activation:
    enabled: true          # 停用：改回 false（默认即关闭）
adaptiveActivation:
  endpoint: https://openrouter.ai/api/alpha/decisions
  model: respan/span-01-lite:free
  provider: Respan
  apiKeyEnv: OPENROUTER_API_KEY
  # 只追加：省略/清空 replaceableActivationIds
```

停用：把 `host.codex.adaptive_activation.enabled` 置 `false`（或回退到上一安装版本）；
`host.codex.enabled` 保持原值即可让普通 hook 继续工作。停用后应按 §3 复核
“零评分请求 + 正文 Native”。

准入依据：PRI-1120 原先挂的 PRI-1119 是 OpenClaw 入口准备单（其 `Done` 仅指准备范围，
且 OpenClaw embedded 仍缺可信用户轮身份）；Codex 追加路径的准入依据应指向本记录
（§1–§4 的构建、正例、回退与停用证据），不再沿用 PRI-1119 的 OpenClaw 结论。

---

## 9. 证据索引

工作树内（`.tmp`，gitignored）：

- 汇总：`.tmp/pri-1116-append/out/append-acceptance.json`
- 各臂：`.tmp/pri-1116-append/out/{positive-native,positive-adaptive,none-applicable,no-space,no-space-native,timeout}/arm.json`
- 实际请求：同目录 `request-1.json`；评分请求：`decision-request.json`
- hook 记录：同目录 `hook-logs/*.json`（含实际加载 hook 路径与 SHA-256）
- 夹具：`.tmp/pri-1116-append/run-append.mjs`、`hook-tee.mjs`

归档（本地，gitignored）：`D:\Code\principles\artifacts\pri-1116-append\`（含索引与哈希）。
