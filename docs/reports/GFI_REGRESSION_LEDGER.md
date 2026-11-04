# GFI 移除 —— 回归对照台账（Layer-by-layer Regression Ledger）

> 规则：每推进一层改动，用 `docs/reports/GFI_BEHAVIOR_BASELINE.md` 的同一组观测跑一次；
> 记录「层 → 对照结果 → 通过/不通过」。
> **任何一条不变量不通过 → 停在该层，禁止叠加下一层。**
> 允许差异只有两类：① 被移除对象自身的断言（如 `gfi_before/gfi_after`、`stats.gfi`）；
> ② 已记录的既有环境失败。其他数字变化一律按退化处理。

基线提交：`35d12815bc08e509c6e54fd908d0ae22b1395d2a`
基线副本：`.tmp/gfi-removal/baseline-35d12815bc`（自带 `node_modules` + `.git` 隔离标记）
观测口径：8 条不变量（I1–I8），40 个测试文件，571 个用例（基线实测全绿）

---

## 台账

| # | 层 / 阶段 | 代码状态 | 对照方式 | 实测（文件/用例） | 通过/不通过 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | **基线** `35d12815bc` | 无 GFI 移除 | 基线副本全量 8 类 | 40 文件 / 571 用例 / 0 失败 | **基线（基准值）** | 见 `GFI_BEHAVIOR_BASELINE.md` §3 |
| 1 | L1 core（`runtime-v2/gfi/` 删除、session tracker、tool execution、correction detection、schema/migration） | 已提交（`4b3ea5421`…`62e2cab15` 中 core 部分） | 待跑 8 类对照 | 待测 | **PENDING** | 需在隔离副本按层重建后测 |
| 2 | L2 openclaw-plugin（manual pain、LLM hook、/pd-status、event log、gate helper、templates） | 已提交（`fa86f0943`、`dcf53fba1`、`13c067e2f`、`36968fac4`、`3433204a1`、`c7ab619e9`） | 待跑 8 类对照 | 待测 | **PENDING** | 含 shipped 模板清理 |
| 3 | L3 host-runtime（`production-pain-evidence` 必需列/INSERT、`production-rulehost-gate` 输入、signal admission） | 已提交（`2bae37491` 等） | 待跑 8 类对照 | 待测 | **PENDING** | 含 D1 迁移缺口待补 |
| 4 | L4 pd-cli + pd-console（`runtime health gfi`、canary/diagnostics、GFI DTO） | 已提交（`8acd1027d`、`603af28d4`） | 待跑 8 类对照 | 待测 | **PENDING** | 非 I1–I8 直接承载，由 Stage 9 覆盖 |
| 5 | L5 installer（`create-principles-disciple` flags） | 已提交（`c7ab619e9` flags 部分） | 待跑 8 类对照 | 待测 | **PENDING** | `MVP_GONE_FLAGS` 含 `gfi` |
| 6 | 累计 HEAD（`60c44a346`，18 commits） | 全部已提交 | 8 类对照（同一观测集） | 待测 | **PENDING** | 分层对照的收口行 |

---

## 差异登记（允许差异 / 环境差异）

| 层 | 观测点 | 基线值 | 当前值 | 分类 | 说明 |
| --- | --- | --- | --- | --- | --- |
| — | — | — | — | — | 暂无（基线行未产生差异） |

---

## 对照执行记录（逐次追加，不覆盖）

（暂无。每次对照追加一段：`日期 / 层 / 命令 / 实际输出摘要 / 结论`。）
