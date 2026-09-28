# PRI-904 Phase D — Memory Manifest（开窗基线快照）

> 观察员产出 2/4。只读记录，时间 2026-09-23T02:0xZ。**只记录，不判断影响**（判定规则：协议 §2/§8；收口时按协议 §9-2 出 B/P 窗正式 Manifest，本文为开窗前快照+W-del 窗动态）。

## 文件清单

| 文件 | 路径 | 大小/字符 | mtime (local +08) | 含目标语义 |
|---|---|---|---|---|
| WORK_AGREEMENTS.md | `D:\.openclaw\workspace\WORK_AGREEMENTS.md` | 6045 B / 2839 c（hash 094605d7cfed4a39） | 09-22 03:42 | **是：A-007「汇报纪律：每个事实结论必须有本会话内实际查验的证据」**，含 Owner 原话逐字 + 三条规则（规则 3「验到哪一层」比原则正文更精细）。不自动注入（非 bootstrap 名单），仅经 read/exec 进 context |
| MEMORY.md | `D:\.openclaw\workspace\MEMORY.md` | 99227 B / 59444 c | 09-22 21:02 | 否：全文 grep「查验/未查验/可观察证据」= **0 命中**。可见窗口指纹：head7.5K=`74a819d8d73467a6`，tail2.5K=`4fcecfed145ca5a1`（尾部为 09-22 晋升条目：MV 定时发布等，无目标规则语义） |
| memory/ 日记 | `D:\.openclaw\workspace\memory\` | 123 文件 | — | 09-22/09-23 两篇 grep 目标语义 = **0 命中** |
| AGENTS.md | `D:\.openclaw\workspace\AGENTS.md` | 每轮全文注入 | — | 邻接非等价（「确定性执行/禁止基于猜测编程」，编码域），协议 F4 既定：不可消除，作底噪 |

## 窗口内读取活动（trajectory.db tool_calls，`params_json` 匹配）

| 目标文件 | 09-16 | 09-17 | 09-18 | 09-19 | 09-20 | 09-21 | 09-22 | 09-23 |
|---|---|---|---|---|---|---|---|---|
| WORK_AGREEMENTS | 0* | 0* | 0* | 7 | 1 | **15** | **0** | **2**（01:20:26Z、01:58:08Z，session `8c94c13a`） |
| MEMORY.md | 6* | 24* | 13* | 33 | 42 | 83 | 62 | 12 |
| memory/（日记） | 10* | 26* | 22* | 34 | 42 | 99 | 57 | 12 |

\* 源自 Phase 0 污染分析既有统计（09-19 前 WORK_AGREEMENTS 读取 09-16~18 未单独核，标 * 示引用非本轮现查；09-19 起为本轮现查）。

## 登记事实（不作判断）

1. **W-del（Principle OFF）窗内 WORK_AGREEMENTS 出现 2 次实际读取**（01:20Z / 01:58Z，同一 session `8c94c13a`）——A-007 等价规则在 OFF 窗经工具通道进入该会话 context 的事件已在案。
2. MEMORY.md 正文与近两日日记均无目标语义；09-22 13:02Z 尾部的邻接晋升（普适规则③）按 Phase 0 记录仍可能在 head/tail 可见窗内——tailHash 已锁定，B/P 窗 Manifest 以同法复测。
3. 09-23（至采数点）日记与 MEMORY 读取仍高频（各 12 次）——Memory 通道在 live 日常工作中的参与是常量，不随原则 OFF 改变。
