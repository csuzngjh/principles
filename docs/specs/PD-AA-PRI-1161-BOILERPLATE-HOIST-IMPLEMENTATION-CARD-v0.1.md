# PRI-1161 实施卡 v0.1：把逐块重复的样板句合并到公共位置

状态：**待 Owner 书面批准（未编码）** · 工单：PRI-1161（关联 PRI-1105）· 测量：`docs/implementation-reports/pri-1161-boilerplate-measurement-20261110.json` · 基准：`origin/main` `e7c7e6bba` 渲染器，真实快照沙箱（归档 2026-11-09T13:21:39Z，18 条激活）

## 1. 已核实的重复（真实数据）

每条原则的指令块由 5 行组成；其中与原则**完全无关**的重复文本：

| 片段 | 准确文本 | 每块开销（含换行） | 实测次数（18 条轮 / FIFO 7 条轮） |
|---|---|---|---|
| 逐块说明行 | `Apply this as an active behavior constraint. Do not treat this as background context.` | 86 字符 | 18 次（1566 字符，占正文 17.0%）/ 7 次（609 字符，16.7%） |
| 结束标签 | `</directive>` | 13 字符 | 18 / 7 |
| 开标签内常量 | `source="runtime_v2_activation"` | 31 字符（在逐原则行内） | 18 / 7 |
| 正文前缀 | `MANDATORY: ` | 11 字符（在逐原则行内） | 18 / 7 |

**依赖原则信息、不能合并的**：id 属性值（转义后 principleId）、authority 属性（owner / system_policy / 缺省）、正文（转义）。**逐块语义无法保留、继续按块输出的**：`</directive>`（存在性取证切片 `indexOf('</directive>')` 与 Hook 终验 `includes(body)` 依赖这个边界）、开标签常量与 `MANDATORY: ` 前缀（都在逐原则行内）。渲染器不含版本号与 activationId。

## 2. 唯一改法

`packages/principles-core/src/runtime/activation/prompt-activation-reader-contract.ts` 的 `sharedDirectiveBlockLines` **删除常量说明行**（上表第 1 行，5 行块变 4 行），同一文件 `sharedDirectiveHeaderLines` 的既有公共行

> `These directives are mandatory for this session unless they conflict with safety, security, or higher-priority system policy.`（125 字符）

替换为

> `These directives are mandatory active behavior constraints for this session, not background context, unless they conflict with safety, security, or higher-priority system policy.`（178 字符）

原句的语义（mandatory + active constraint + not background context）完整并入公共位置一次，措辞吸收了被删行的两个要点。base 净增 53 字符；每块净减 86+1=87 字符。每轮净变化 = 53 − 87×N：N=1 时 −34，N=7 时 −556，N=18 时 −1513（15625 轮实测基线 9208 → 7695，−16.4%）。只改这两个 builder；`measureSharedDirectiveBlockChars` / `sharedDirectiveBaseChars` 由同一 builders 派生，预算算术自动同步，**不改任何选择逻辑**。

## 3. 影响的调用者（全部经同一 builders，自动一致）

生产：`host-runtime/active-principle-prompt.ts`（共享装配入口）、`host-runtime/prompt-activation-deliverability.ts`、`host-runtime/prompt-injection-projection.ts`、`core/adaptive-principle-intervention.ts`、`openclaw-plugin/hooks/prompt.ts`（targetBody / injectedExpectations 切片——只依赖 `<directive ` 与 `</directive>` 边界，边界保留）。测试：golden 特征化（golden 文本须更新——唯一必然变化的测试）、packing 属性测试（恒等式由 builders 派生，应保持全绿）。全仓只有 1 处生产源码和 1 处测试硬编码了被删句子（rg 已枚举）。

## 4. 通过线（冻结，实现前写定）

**硬失败（任一即弃）**：HF1 任一原则正文/id/authority 属性丢失、改写或双重转义；HF2 任意集合（空/单条/多条、含 XML 特殊字符 `&<>"'` 的夹具）违反 `render(S).length === base + Σ block`；HF3 存在性取证 `bodyComplete` 在未截断渲染中出现 false；HF4 builder 选择的集合渲染后超出 `budgetChars`；HF5 golden 更新后仍有任何测试为对齐而放宽断言。

**收益**：B1 相同集合下逐轮 `newChars = oldChars − 87×N + 53` 逐字节精确；B2 与冻结 PRI-1160 基线同快照 20 轮全部满足 B1；B3 15625 轮净减少 ≥ 15%（预期 −16.4%）；B4 4000 轮单独报告「样板减少 / 新原则补位 / 最终净变化」三列——补位可发生，任何新入选原则都必须能用预算算术解释，不把补位计为无条件收益。

**正确性**：C1 空集渲染 `''` 不变；C2 单条渲染含一次且仅一次公共说明；C3 self-report 页脚不受影响；C4 FIFO 缺轮次键现状单独记录，不夹带修复。

**计量**：字符为准；Token 未知（无可靠 tokenizer）。一轮同输入比较即裁决。

## 5. 交互与回滚

- **PRI-1160 交互**：其冻结基线（81,364 字符）由旧渲染器产出。若本卡先合并，PRI-1160 的治理后复测必须**先用新渲染器重冻 pre 基线**再比较，不得跨渲染器对比。
- **回滚**：revert PR 即可；无新 flag、无配置、无 schema 变更。golden 测试随 PR 一并回到原措辞。
- **changeset**：`@principles/core`（渲染文本变化）+ `@principles/host-runtime` + `principles-disciple` 与 `create-principles-disciple`（C4 隐性依赖）。
- **边界**：生产治理写入、宿主启动、真实模型调用、生产启用均为 0；零新存储；Complexity Delta 全 NO。
