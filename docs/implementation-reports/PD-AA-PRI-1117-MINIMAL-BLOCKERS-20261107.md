# PD Adaptive Activation — PRI-1117 最小阻断清单

- 日期：2026-11-07
- 结论类型：**CONDITIONAL**
- Base：`9c07876207655b4ac9757fb3510a69f3bb9dfa30`（最新 `origin/main`，已 fetch 复核）
- 主报告：[PD-AA-PRI-1117-INDEPENDENT-REVIEW-20261107.md](PD-AA-PRI-1117-INDEPENDENT-REVIEW-20261107.md)
- 执行卡：[PD-AA-PRI-1117-OWNER-DECISION-CARD-20261107.md](PD-AA-PRI-1117-OWNER-DECISION-CARD-20261107.md)
- 原则：只列“不给触发条件就不算阻断”的项；不以“理论上可能”扩展清单；不含新架构设计。

---

## 0. 分类口径

| 类别 | 含义 | 是否阻断本轮结论 |
|---|---|---|
| **试用前必须修复** | 任何 G1/C04 签收前必须闭合 | 是（对“通过”类主张） |
| **只限制结论** | 不修复也能进入限域下一阶段，但不得扩大声明 | 否（但必须写入声明边界） |
| **后续研究** | 不影响本轮裁定 | 否 |

本清单只含前两类。后续研究见主报告 §6 “非阻断条件”与 §9。

---

## 1. 阻断项（3 项，按优先级）

### B1 — M2：请求与关键行动的固定身份/顺序未编码

| 字段 | 内容 |
|---|---|
| 类别 | **试用前必须修复**（仅针对 G1 `timely` / C04 行动顺序签收） |
| 触发条件 | 任何声称“原则正文先于关键行动送达”“timely confirmed”“C04 行动顺序 confirmed”的结论 |
| 已知事实 | 含 target 的请求 `http-003` `receivedAt=13:00:06.313Z`；工具执行 `13:00:06.671Z`，宿主事件日志 `toolCallId=call_1`、`toolCallIdRef=74196fe72e4c`；`74196fe72e4c = sha256("call_1")[:12]`；端点 `http-004` 的 `toolCallAttempts[0].toolCallId="call1"`；`run-record.json` 同为 `call1`，`recordedAt=13:00:06.713Z`；门禁 13 项无 ordering/时间先后检查；读模型 `ordering="unknown"`、`requestAssociation="unknown"` 为硬编码 |
| 可能解释 | 宿主把 OpenAI `call1` 规范化为 `call_1`（或反向），两侧各记一侧；时间/会话/工具名一致，很可能是同一行动 |
| 仍未知 | `call1` 与 `call_1` 的显式映射是否存在；端点请求与宿主 hook 是否存在同一 request ID 绑定 |
| 影响的主张 | G1 `timely` 签收；C04 “行动顺序”；任何“先送达后行动”的因果表述 |
| 位置 | `packages/host-runtime/src/adaptive-behavior-linkage.ts#L118-L132,L198-L209`；`scripts/dev/aa-controlled-admission/lib/gate.mjs#L177-L290`；原始证据 `aa-run-20261106T1258Z/evidence/positive.endpoint-requests.json`、`run-record.json`、`evidence/admission-consumed.json` |
| 最小验收办法 | ① 门禁新增 ordering 检查：`request(receivedAt, 含 target) < toolEvent(ts) < nextRequest(receivedAt)`；② 记录 `call1`↔`call_1` 的显式映射（保留两侧原值，不做归一化“修正”）；③ 用现有 1258 原始证据离线复核并归档；④ 读模型不得在无映射时升级 `ordering` |
| 是否阻断所提试用范围 | **阻断“签收”**；不阻断 positive-only 的离线复核与限域报告 |
| 是否需要新宿主调用 | **否**——现有原始证据足以离线补齐 |

---

### B2 — M3：原协议对照臂未执行，且无 control-only 执行路径

| 字段 | 内容 |
|---|---|
| 类别 | **试用前必须修复**（仅针对完整协议 / C04 control 主张） |
| 触发条件 | 任何“完整阳性/对照协议已执行”“control 只取 returned”“干预导致差异”的结论 |
| 已知事实 | 原始在线运行在 positive 阶段失败（`tool-invocation`、`admission-identity`）；control 从未执行；事后离线门禁 13/13 PASS 不改变原始失败判定；预算 caps `4 host/5 HTTP/2 tool/0 paid`，used `3/4/2/0`，remaining `1/1/0/0`；control 臂预算恰为 `1 host/1 HTTP/0 tool`；launcher `runPositiveThenControl` 总是先 positive 后 control，无 `--arm control` / resume 路径 |
| 可能解释 | control 未跑是 stop-on-positive-fail 的设计结果，不是预算不足；原始 positive 失败是门禁/身份缺陷 |
| 仍未知 | control 实际返回内容与“无原则”对照差异；能否在不重跑 positive 的前提下安全执行 control-only |
| 影响的主张 | 完整协议/paired 结论；C04 `control=returned`；任何“正例 vs 对照”的因果主张 |
| 位置 | `scripts/dev/aa-controlled-admission/lib/gate.mjs#L491`（`runPositiveThenControl`）；`aa-run-20261106T1258Z/plan.json`（预算与 caps）；`failure.json`（原始失败原因） |
| 最小验收办法 | ① 增加**仅 control** 的执行路径（小范围 orchestration，不改预算、不改冻结证据、不改历史判定）；② Owner 单独授权后，在剩余 `1 host/1 HTTP/0 tool` 内执行一次 control；③ 若 Owner 不接受，则**永久标注 M3 NOT_RUN** 并把结论收窄到 positive-only |
| 是否阻断所提试用范围 | 阻断完整协议；不阻断 positive-only 观察。剩余预算**不构成**恢复已停止实验的授权 |
| 是否需要新宿主调用 | 若选择补齐则需要 1 次受控宿主回合（Owner 授权）；若接受限制则不需要 |

---

### B3 — M1：端点用户消息摘要与冻结输入不同，字节级身份未解释

| 字段 | 内容 |
|---|---|
| 类别 | **只限制结论**（若试用范围要求字节级同一输入，则升级为必须修复） |
| 触发条件 | 任何“逐字节相同输入传输”“同一请求正文”“request-level C04”结论 |
| 已知事实 | 冻结 `input.txt` SHA-256 = `458dac4f7d14ebd159c38c27783e6d26ba553686b26f89343e1ca491da02cef7`；宿主 `transcript_events` row 5 用户消息内容 SHA-256 **等于** 该值；端点 `userMessageSha256` = `77f64517a091…`，**不同**；CRLF/trim/trim+NL 候选均不匹配，差异不是归一化；原始请求正文未保留（fake provider 只存摘要） |
| 可能解释 | 宿主在送入模型请求前注入包装（sender metadata / conversation info / turn 前缀）；或端点取到的首条 user message 不是本次输入 |
| 仍未知 | 包装的确切字节与代码路径；端点 `messages[0]` 是否包含冻结输入 |
| 影响的主张 | 字节级/同一请求正文/request-level C04 |
| 位置 | `aa-run-20261106T1258Z/input.txt`；`state/positive/agents/main/agent/openclaw-agent.sqlite`（只读）；`evidence/positive.endpoint-requests.json` |
| 最小验收办法 | ① 保存模型可见的首条 user message（或原始请求正文）并注明宿主包装来源；② 若无法采集，则**保持 unknown**，声明边界收窄到 “target body present + run-level association”；③ 不得用归一化“修正”到匹配 |
| 是否阻断所提试用范围 | **否**——不阻断 target-body/timely 的限域 positive；阻断字节级主张 |
| 是否需要新宿主调用 | 需要新运行才能补齐；不补齐则永久 unknown |

---

## 2. 非阻断条件（执行卡必须写入，不列为阻断）

| # | 条件 | 触发后果 | 最小动作 |
|---|---|---|---|
| N1 | 1258 事后生产库只读审计缺失 | 不能宣称“零生产写入” | 运行前后各一次只读快照/审计；`未搜到 runId` 不能单独作为证据 |
| N2 | 读模型 `hostVersion=unknown` | 身份链在产物中不完整 | 从 `plan.json` 把宿主/插件/config 身份传播到读模型；原始 `plan.json` 已固定 `2026.11.1`、cli sha `469e60c9…`、host identity sha `b62b2e28…` |
| N3 | 旧 G1 卡片写“无工具”，1258 实际使用 1 个只读 `read` | 授权口径冲突 | 新执行卡显式写“允许 1 次只读 `read`”或改为“无工具”；不得沿用旧表述 |
| N4 | 旧卡片“Owner 已确认” | 历史授权不覆盖新运行 | 每次新运行重新取得 Owner 授权 |
| N5 | 场景 marker 硬编码 `[PD-AA:delivery-review:v1]` | 不能解读为通用功能已开放 | 试验范围声明；配置化属后续研究 |

---

## 3. 不阻断本轮的问题

- 插件/MCP 解析路径的运行前检查已存在（P0 preflight：binding inside root、`pd-recall.enabled=false`、tools allowlist 精确 `[read]`）。
- 隔离机制（launcher → 子进程 env → workspace/config/state → 插件/MCP）已实质修复；仅缺 1258 事后审计（N1）。
- 授权重验、目标撤销、预算、默认关闭、软截止、异常回退、Native 恢复均有代码位点；见主报告 §2。
- C08 已知案例复核符合 SPEC 边界；T/V/O/D unknown 只限制覆盖率；未发现重复抬高验收。

---

## 4. 一句话结论

**B1 是唯一“可离线闭合”的阻断；B2 需要 Owner 授权与一条 control-only 路径；B3 只收窄声明、不需要修复即可限域推进。** 三项全部闭合前，不得宣告 G1/C04 通过，也不得启动 PRI-1119/Native 试用。
