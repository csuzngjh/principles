# PD Adaptive Activation — PRI-1117 Owner 执行决策卡

- 日期：2026-11-07
- 状态：**待 Owner 决定（未授权执行）**
- 依据：主报告 §0/§6/§9；[最小阻断清单](PD-AA-PRI-1117-MINIMAL-BLOCKERS-20261107.md)
- 本卡不启动任何宿主回合、不调用模型、不安装、不写生产库、不修改历史判定。

---

## 0. 需要 Owner 做的唯一决定

**在 A / B / C 中选一个。** 三选一即可，不需要逐项讨论。

| 选项 | 内容 | 新增宿主回合 | 新增预算 | 可得到的结论 | 不能得到的结论 |
|---|---|---|---|---|---|
| **A（推荐）** | 批准 B1 离线补齐 + B2 control-only（用剩余 `1 host/1 HTTP/0 tool`） | control 1 次 | 0（用剩余额度） | positive 限域事实 + control returned | G1/C04 完整通过；字节级同一输入 |
| **B** | 批准**新预算**与一次新 positive（含原始请求/首条 user message 捕获、显式工具 ID 映射），再跑 positive+control | 2 次 | 需新授权 | 有机会闭合 M1/M2/M3 | 行为收益（仍属 G2/G3） |
| **C** | 只接受当前证据，不新增运行；M2/M3 永久标注 NOT_RUN | 0 | 0 | positive 限域事实（不签收 timely/control） | 任何 G1/C04 通过、任何对照/因果 |

**若选 C，则下一阶段只能是文档/离线收尾，不得进入真实试用。**
**若选 A 或 B，本卡其余字段即为执行边界；任何越界都按 §7 硬停止。**

---

## 1. 唯一宿主 / 模式

| 项 | 固定值 |
|---|---|
| 宿主 | OpenClaw `2026.11.1`（仓库内既有受控 harness；cli sha `469e60c9…`，host identity sha `b62b2e28…`，以 `plan.json` 为准） |
| 模式 | OpenClaw **embedded**，`before_prompt_build` 受控准入路径 |
| Provider | 仅本地 fake `aa-fake`，`baseUrl http://127.0.0.1:6770/v1`，model `local-fake-model` |
| 付费 | **0**；禁止外部 provider、禁止真实模型 |
| 并发 | 单次、串行；无 fallback、无自动重试 |
| 通道 | 仅 prompt-hook 受控通道；**不得**用 `challenge-openclaw-host.mjs` 的 AGENTS 通道替代 prompt-hook 证据 |

---

## 2. 工作区

- 仅限本次 run 目录下的隔离工作区：`<runDir>/positive/workspace` 与 `<runDir>/control/workspace`。
- 禁止使用生产工作区 `D:\.openclaw\workspace`；禁止在仓库主工作树或他人工作树内产生运行产物。
- 所有 resolved 路径必须 inside experiment root（`assertPlanInsideExperimentRoot` 强制）。
- 运行产物写入 `.tmp`/run artifacts，不进入提交。

---

## 3. 版本与配置身份（运行前必须固化到产物）

| 身份 | 来源 | 要求 |
|---|---|---|
| admission manifest | `manifest.json` | `targetArtifactId=art-aa-20261106`、`targetActivationId=act-aa-20261106`、`sourceRef=PRI-1118` |
| 输入 | `input.txt` | SHA-256 记录；不得运行中改写 |
| config | `config.json` | SHA-256 记录（1258 为 `c77f6f0d…`）；`plugins.allow=["principles-disciple"]`、`load.paths` 指向隔离 bundle、`mcp.servers.pd-recall.enabled=false`、`tools.allow=["read"]` |
| plugin bundle | `packages/openclaw-plugin` | SHA-256 记录（1258 为 `fd0492d2…`）；必须来自本次工作树构建 |
| 宿主 / CLI | `plan.json` | 版本与 sha 记录 |
| 原则 body | 端点观察 / manifest | content sha 记录（不得只留摘要而声称字节级一致） |

**身份缺失任一项 → 不执行。**

---

## 4. 原则版本与具体决策场景

- 原则：`art-aa-20261106` / `act-aa-20261106`（PRI-1118 受控准入固定的单一有效原则），不更换、不改写。
- 场景 marker：`[PD-AA:delivery-review:v1]`。
- Positive 场景（1258 原样）：读取夹具 `fixture.txt`（`AA-FIXTURE-aa-run-20261106T1258Z`，sha `e27b4775…`），只允许调用一次只读工具 `read`。
- Control 场景：`control-input.txt`，同一 marker，指令为“不调用任何工具，只回答 `AA-DONE`”。
- 不新增第二种场景；不扩大工具集合。

---

## 5. 验证目的 / 明确不能得出的结论

**目的**

1. control 臂是否在无原则注入时返回 `AA-DONE` 且不使用工具；
2. 在**离线**补齐后，能否用固定身份与时间戳证明“含 target 的请求先于关键行动”；
3. 运行前后生产库只读审计是否存在可复核的零写入证据。

**明确不能得出的结论**

- 不能得出“G1/C04 完整通过”；
- 不能得出“逐字节同一输入 / 同一请求正文”（除非 B 且捕获到原始请求/首条 user message）；
- 不能得出“行为改善 / 原则内化”（属 G2/G3）；
- 不能得出“可推广到真实工作”；
- 不能以文档合并或 CI 通过替代实际运行结果。

---

## 6. 观察材料 / 机会样本 / 未知处理

**必须保留的观察材料**

- `plan.json`、`manifest.json`、`config.json`、`input.txt`、`control-input.txt`、`run-record.json`、`failure.json`
- `evidence/positive.endpoint-requests.json`（含 receivedAt、toolCallAttempts、toolResultContainsFixture）
- `evidence/positive.environment.json`（`PD_WORKSPACE_DIR` 移除 + 隔离值 + `insideExperimentRoot`）
- `evidence/admission-consumed.json`（一次性消费时间）
- `p0-inspect.json`（plugin source/origin/workspaceDir/trust）
- 宿主事件日志中的 `toolCallId` 与 `toolCallIdRef`（保留两侧原值）
- 运行前后生产库只读快照/审计输出

**机会样本**

- 本轮**不做机会普查（census）**；T/V/O/D 分母保持 `unknown`。
- 单次受控运行不是“机会样本”，不得据此估计覆盖率或行为效果。
- 若未来做 G2 观察，纳入/排除条件须在运行前预注册（PRI-1119 可并行准备，但不得提前启用生产）。

**未知处理**

- 缺原始请求 → 字节级身份 `unknown`，不推断。
- 缺工具 ID 映射 → `ordering=unknown`，不升级。
- 缺 control → 对照结论 `NOT_RUN`，不豁免、不推断。
- 审计缺失 → “零写入” `unknown`，不宣称。

---

## 7. 调用、费用、时间窗口、硬停止

**额度（沿用既有 caps，不修改）**

| 项 | caps | 已用 | 剩余 | 本卡允许 |
|---|---|---|---|---|
| host turn | 4 | 3 | 1 | A：1（control）；B：+新授权 |
| HTTP | 5 | 4 | 1 | A：1（control）；B：+新授权 |
| tool call | 2 | 2 | 0 | A/B：**0** |
| paid call | 0 | 0 | 0 | 0 |

**时间窗口（沿用 G1 卡片口径，执行前复核）**

- 配置预检 ≤ 25s；
- 宿主外层 ≤ 120s；
- Agent ≤ 45s；
- 软截止 = `min(start + softTimeoutMs, expiresAtMs)`；到期回退 Native。

**硬停止条件（任一触发即立即停止并记录）**

1. 任一身份（config / plugin bundle / manifest / 宿主版本）与固化值不符；
2. 任一路径解析到 experiment root 之外，或出现 `PRIMARY_LEAKAGE`；
3. 子进程环境仍含 host-overridable key（尤其 `PD_WORKSPACE_DIR`）；
4. 出现第二次 host turn、第二个 HTTP 请求或任何 tool call（超出本卡额度）；
5. 出现外部 provider、付费调用或非 `127.0.0.1` 端点；
6. admission 未被一次性消费，或出现 `ambiguous_admission` / `ambiguous_identity`；
7. 生产库出现任何本 run 的写入迹象；
8. 超时、异常回退无法解释或出现静默 fallback。

---

## 8. 隔离 / 停用 / 事故升级 / 证据保留

**隔离**

- launcher → 子进程 env → workspace/config/state → 插件/MCP 全链路使用 `buildIsolatedHostEnv` + `assertPlanInsideExperimentRoot`；
- 移除全部 host-overridable key 后显式设置隔离值；
- `pd-recall` 禁用；tools allowlist 精确 `[read]`；
- 插件只从隔离 bundle 加载。

**停用**

- 移除 admission 文件 / 停止宿主进程 → 插件自动回 Native；
- 不改生产配置、不写安装目录；
- 停用后验证一次普通 Native 路径仍可用（只读检查，不新增调用）。

**事故升级**

1. 立即停止宿主与端点；
2. 冻结该 run 目录，只读保存；
3. 记录触发条件、时间、路径、身份；
4. 生产库只读审计（不删除、不标注）；
5. 上报 Owner；未获指示前不重试。

**证据保留**

- 原始 run 资产只读保留，不覆盖、不改写、不清理；
- 派生报告与原始资产分开存放并互相引用；
- 哈希与身份固化在 `manifest.json` / `plan.json`；
- 不覆盖他人 `aa-handoff` 指针与 `LATEST.json`。

---

## 9. 安装 / 更新

- **本卡不需要安装或更新**：使用仓库工作树内构建的 plugin bundle + 隔离 config。
- 禁止运行 `npx create-principles-disciple`、禁止写 `~/.pd/runtime` 或 `~/.openclaw/extensions/principles-disciple`。
- 若未来确需安装：唯一官方路径是 installer（`npx create-principles-disciple`），由 Owner 单独授权；本卡不包含。

---

## 10. 执行后必须产出的判定（不得替代）

| 主张 | 允许状态 |
|---|---|
| positive：target body 出现在请求 | 可 `confirmed`（端点观察） |
| positive：run 级关联 | 可 `confirmed`（admission 消费 + hook 调用） |
| positive：`timely` | **仅** B1 离线补齐后可为 `confirmed`；否则 `unknown` |
| control：`returned` | **仅** B2 执行后可为 `confirmed`；否则 `NOT_RUN` |
| 字节级同一输入 | `unknown`（除 B 捕获原始请求） |
| 零生产写入 | 仅前后只读审计可支持；否则 `unknown` |
| 行为收益 | 一律 `NOT_APPLICABLE`（G2/G3） |

---

## 11. 一句话

**推荐 A：用剩余 1/1/0 预算只跑 control，M2 在现有证据上离线补齐，M1 收窄为 unknown；这样下一阶段可以开始，但不得宣告 G1/C04 通过。**
