# PRI-1037 真实探针调用计数勘误与归因（S7）

> 本文档勘误 S6 报告中的「真实模型调用 15 次」表述。原始 attempt 记录（attempt-1/2/3-PRI-1037.json）原样保留。

## 1. 调用计数对账表

| 计数项 | attempt-1 | attempt-2 | attempt-3 | 诊断复现 | 合计 |
|---|---|---|---|---|---|
| CLI 启动尝试（spawn openclaw） | 1（拒参于 `--agent` 参数校验） | 1（拒参于 `--state-dir` ENOENT） | 5（全部启动，180s 超时被 SIGKILL） | 2（round-1 复现：`--agent` 拒参、`--state-dir` ENOENT 拒参） | **9** |
| 成功启动的 agent exec | 0 | 0 | 5 | 0 | **5** |
| transport 构造数 | 0（门先于 factory） | 0 | 1（构造后 5 轮共享） | 0 | **1** |
| 实际发起的模型请求数 | 0 | 0 | **不可证（0–5）** | 0 | **0–5** |
| 成功完成的模型请求数 | 0 | 0 | **0**（无 envelope 返回） | 0 | **0** |
| 超时数 | 0 | 0 | 5 | 0 | **5** |
| 拒参数 | 1 | 1 | 0 | 2 | **4** |
| 其他失败 | 0 | 0 | 0 | 0 | **0** |

**模型请求数为何不可证**：attempt-3 的五轮全部在 180s 预算内超时被 SIGKILL——超时点位于 state 初始化+插件安装阶段（state 内 plugin-captures 实据），无返回 envelope、无轨迹 JSONL、无服务端身份证据。因此「实际发起的模型请求数」无法归因到 0 或 5 中的任何一个。

**勘误**：S6 报告的「真实模型调用 15 次（3×5 轮全部拒参/超时）」**证据不支持**——正确表述为：**7 次 CLI 启动尝试（另加 2 次诊断复现）；5 次成功启动的 agent exec；成功完成的模型请求数 0；实际发起的模型请求数 0–5 不可证**。本勘误不修改任何 attempt 原始记录。

## 2. attempt-3 五轮超时根因

state 目录内 `tmp/plugin-captures/<uuid>/captures/openclaw-plugin-build-*/package-0/node_modules/principles-disciple/...` 实据：exec 对 pinned 配置执行了 **PD 插件的捕获式安装**（principles-disciple 包被完整安装进每轮独立的 state），该安装+state 初始化+配置迁移耗尽了 180s 预算。每轮独立 state 导致安装重复 5 次。

## 3. productionWrites=1 归因

扫描窗口内 `C:/Users/Administrator/.pd` 的变更文件（bounded-depth 扫描，maxdepth 3）：

| 文件 | mtime（本地） | 性质 |
|---|---|---|
| `active.json` | 18:01:45 | PD 安装器活动 |
| `transactions/update-1793181174713-d3b03af0.jsonl` | 18:01:45 | PD 更新事务（attempt-1 之前——18:01 < 首次探针 ~18:1X） |
| `install.json` | 18:02:55 | PD 安装器活动 |
| `channels/stable.json` | 18:35:52 | PD 渠道检查（attempt-3 窗口内） |
| `product-telemetry.json` | 18:40:55 | PD 产品遥测（attempt-3 窗口内） |

**归因**：全部为 **PD 安装器/更新器自身的活动**（文件名性质+时间分布跨探针窗口），非探针进程写入——探针 exec 的全部写入都在受控 rounds/ 内（含 state）。**处置**：这是多 Agent 环境的真实噪声；扫描器已补 `productionWriteSamples`（路径+时间）以便后续精确归因；生产写入检查的 fail-closed 语义不变。
