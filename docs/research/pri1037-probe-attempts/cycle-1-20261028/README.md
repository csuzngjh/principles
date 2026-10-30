# PRI-1037 Cycle 1 失败探针证据归档（2026-10-28）

## 这是什么

本目录归档**授权周期 1**（2026-10-28）的 PRI-1037 真实宿主隔离探针证据。它是历史证据，
**不代表当前运行状态**，也不是任何当前授权、探针结论或实验进度的权威来源。

当前状态请读：

- `../CYCLE-2-REPORT.md` — 周期 2（2026-10-29/30）真实宿主隔离探针结果；
- `../../PL-PROJECT-STATE.md` — 项目状态时间线（S8 → S9 → F2）；
- `../../../../scripts/dev/principle-learning-lab/challenge-studies/CEB-001/probe-authorization.json`
  — **当前**授权记录（周期 2）。

## 周期 1 实际发生了什么

| 项 | 事实 |
| --- | --- |
| 授权 | `issuedBy=owner-goal-20261028-final`，`issuedAt=2026-10-28T15:08:19Z`，窗口 15:10Z–21:10Z，5 轮 × 每轮 600s |
| attempt-4 | `executedAt=2026-10-28T15:11:28Z`，**status=FAILED**，**round-1 即触发停止条件**（failFast 生效，rounds 2–5 未执行） |
| 故障 | OpenClaw ambient 插件加载全部抛 `FsSafeError: copy path changed during operation`，exec 以 `status=error, kind=exception` 退出 |
| 宿主诊断 | 宿主卡死于半更新状态（七插件 data/settings upgrade 未完成 + 一条 abandoned update 事务）；官方修复路径 `openclaw update repair` + `doctor --fix` |
| 修复执行 | Owner 批准后执行：`update repair` 与 `doctor --fix` 均在 plugin-install-index 迁移处 fail-closed 拒绝；vendor 根因 = `plugins/installs.json` 早于 2026-07 支持窗口，官方前置 = 回退 2026.9.5 带备份执行 `doctor --fix` 再升级。修复后 exec 仍失败、版本仍 2026.10.5 |
| 真实模型请求 | **0**（exec 在模型调用之前即失败） |
| 授权终态 | 周期 1 **REVOKED**（`revokedAt=2026-10-28T15:40:00Z`） |
| 停点 | `BLOCKED_ON_OWNER_DECISION`：修复=共享生产宿主降级+备份+重升级，触及自主执行停止条件「重大数据风险」 |

## 与周期 2 的关系（关键：两个 attempt-4 不是同一次实验）

周期 1 与周期 2 各有一个 `attempt-4`。它们属于**不同的授权周期**，编号只是各自周期内的第 4 次尝试，
内容与结论互不继承：

```text
Cycle 1 attempt-4 FAILED（2026-10-28，round-1 停止，真实请求 0，授权 REVOKED）
    ↓
OpenClaw 宿主故障诊断及修复（update repair / doctor --fix → vendor 根因落地，Owner 决策）
    ↓
Cycle 2 attempt-4 PASSED（2026-10-29T20:37Z，9/9 检查全过，深验 ok，真实请求 8）
    ↓
F2 36/36 SUCCEEDED（2026-10-30，97 真实请求，批次 2 副本 1793322627130）
    ↓
realHostBaseline PASS（机器派生，deriveRealHostBaselineFromStudy）
```

周期 1 的 FAILED **不是**周期 2 结论的反例或抵消证据；周期 2 的 PASSED **不抹除**周期 1 的失败记录。
周期 1 归档的意义在于保留停止条件真实生效的现场与宿主卡死诊断（S8）；周期 2 的根因结论
（信封 pretty-print 解析、逐轮插件安装耗尽预算）由周期 2 自己的取证得出，本归档不为二者建立因果推断。

## 文件清单与完整性对账

三份文件均从 PR #2216 的 HEAD 提交 `34652891d0cafe61839c2b3316471257c1606842` 以 blob 原字节导出，
**未修改任何字段**（唯一变化是文件名）。SHA-256 为 sha256 over 文件原字节：

| 归档文件 | 原始路径（PR #2216 HEAD） | SHA-256 | 字节数 |
| --- | --- | --- | --- |
| `attempt-4-PRI-1037-FAILED.json` | `docs/research/pri1037-probe-attempts/attempt-4-PRI-1037.json` | `ed0e53a89a25045d44afa28890016acce0b7cad5ba46edd39adc08c0185cd429` | 3986 |
| `probe-authorization-PRI-1037-REVOKED.json` | `scripts/dev/principle-learning-lab/challenge-studies/CEB-001/probe-authorization.json` | `7902f492b1cc5725292309c2f716f81bcc3619bd96e251b3094f4c17423766de` | 2325 |
| `HOST-REPAIR-DECISION.md` | `docs/research/pri1037-probe-attempts/HOST-REPAIR-DECISION.md` | `bb00016280c8787322cc27d7afb6f882d92159a684c2202144ee904b91c5ab05` | 5202 |

`probe-authorization-PRI-1037-REVOKED.json` 是**周期 1 的历史授权快照**，其 `status=REVOKED`。
主干上的同名文件是周期 2 的当前授权，本归档不替换、不参与任何门禁读取——
授权门禁只读 `challenge-studies/CEB-001/probe-authorization.json`。

## 为什么以归档方式入库，而不是合并 PR #2216

PR #2216 的分支基点早于周期 2 与 F2 的落地。它同批修改了主干上已被后续成果覆写的两份文件
（当前授权记录与 `attempt-4-PRI-1037.json`），合并会把周期 2 的 PASSED 记录与当前授权状态
倒退回周期 1 的 FAILED/REVOKED。因此只把不可重现的历史证据取出归档，实验结论与授权保持原样。
