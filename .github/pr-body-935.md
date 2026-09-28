## Owner Review Card（agent 填）

### 1. Problem

控制台在批准原则后弹出「已批准，但暂未生效……需先停用被取代的旧原则，它才会开始影响智能体行为」。经三个独立子代理核验 + 在 Owner 真实工作区（`D:\.openclaw\workspace\.pd\state.db`，19 条活跃 prompt 激活）只读复算证实：**这是一条假阴性**。控制台的注入预算预测调用 `trimToBudget` 时漏传 `roundKey`，因此永远走 `legacy_fifo_prefix_v1`（贪心前缀装箱、首个装不下即 `break`），而生产路由 `openclaw-plugin/src/hooks/prompt.ts:668-676` 传了 `nextSessionTurnOrdinal(...)`，走 `fair_rotation_v1`（PRI-904）。legacy FIFO 在任何被截断的选集中都必然排除**最新**那条激活，于是控制台把「本轮不在窗口」误报成「永远不会生效」。

### 2. Before

现场实测（19 条候选 / 预算 2000）：

```
[控制台预测 legacy FIFO]  injected=9  chars=1893  newestPresent=false
[生产 fair_rotation]
  roundKey= 9  injected=8  newestPresent=false
  roundKey=10  injected=7  newestPresent=true   ← Owner 刚批准的那条
  roundKey=13  injected=5  newestPresent=true
```

即：生产第 10 轮就会注入，控制台却让 Owner 去停用健康原则。

### 3. After

- 投影接受调用方 `roundKey`，并回报 `selectionPolicy` / `eligibleCount` / `productionRotates` / `eventuallyInjectedActivationIds`。
- 新增 `injection_budget_queued`：仅当该激活「本轮不在窗口、但生产会轮转到」时触发，并给出有界事实（最多 N 个连续用户回合内自行进入），**明确写出不需要停用其他原则**。
- `injection_budget_excluded` 收敛为**真正饿死**（超预算、任何轮次都塞不进去）才使用。
- 中英混排：原始英文服务端文本改用原生 `<details>` 折叠，仍逐字保留（rc-9），Owner 先读人话。

### 4. Existing mechanism reused

复用了 `trimToBudget` 既有的 `roundKey` 位置参数（PRI-904 已加）与 `oversizedActivationIds` 语义，未新增选择器。`eventuallyInjectedActivationIds` 的计算放在投影层（而非控制台），使「可达性」仍以生产选择器算术为唯一权威。共享路由（Codex/host-shared）本来就不传 round key，`productionRotates: false` 如实反映，不宣称公平性。

### 5. Complexity Delta

* New durable source of truth: **NO**
* New persisted schema/state: **NO**
* New subsystem/service/background process: **NO**
* New public abstraction/interface: **YES** — 投影结果新增 4 个只读字段，`roundKey` 为可选入参。理由：控制台没有 session，拿不到生产 round key，**除非投影显式回报策略与可达性，控制台无法区分「排队」与「饿死」**。字段为纯派生投影，无持久化，缺省即退化为修复前行为（向后兼容）。
* New runtime feature flag: **NO**（§16 优先复用既有机制；这是修正确性，不是新可切换行为）
* New cross-package dependency: **NO**
* New host/platform-specific behavior: **NO**
* New external/network capability: **NO**

### 6. Verification

- **负向对照（EP-09 要求）**：把两个生产源文件 `git stash` 回退到修复前、保留新测试 → 4 个 projection 测试 + approve 集成测试**全部失败**（`expected undefined to be 'fair_rotation_v1'` 等）；`stash pop` 恢复后全绿。
- approve 集成测试走真实 HTTP 生产路径，断言告警码为 `injection_budget_queued` 且含 `deactivating older principles is NOT required`。
- `host-runtime` / `pd-console` typecheck 干净；`npm run lint` 0 errors（33 warnings 均为未触碰文件的既有 rc-5 提示）。
- `npm run check:error-handbook` PASS；`verify:merge` 在 pre-push hook 中 PASS。
- i18n key 集合在 zh-CN / en 完全一致（脚本校验）。

### 7. Risk

- 公平轮转的 bounded 保证限定在**一个持续推进的 OpenClaw session 内**（PRI-904 Phase-1 交付边界）。文案说的是「最多 N 个连续用户回合」，不是「一定会在 N 回合内」——若会话不推进则窗口不前移。
- 新增的 `eventuallyInjectedActivationIds` 会对环做 N 次重放（N = 候选数）。N 很大时有成本，当前量级（数十）可接受；未设上限，若候选数暴涨需重新评估。
- 我最初的一版实现有缺陷（控制台无 round key ⇒ 始终 legacy ⇒ 可达集恒空 ⇒ 谎报依旧存在），已在自查中改为按**生产策略**计算可达性；这正是负向对照测试所防回归的。

### 8. Rollback / recovery

纯代码回滚：`git revert addc7e70`。无 flag、无迁移、无持久化状态。旧 payload 缺新字段时 validator 按缺省处理并渲染策略无关文案，前后端可独立部署。

### 9. Follow-ups

- **PRI-930 `[P2] Cross-host Principle Injection Fairness Clock`（Backlog）**：本 PR 只让控制台如实描述当前 plugin-local 轮转；Codex / host-shared 路由仍不轮转（`productionRotates: false` 已如实标注），该缺口属 PRI-930 范围，未在本 PR 扩大。
- `eventuallyInjectedActivationIds` 的重放成本未设上限，候选数异常增长时应加界。
- 两个预存在失败用例（`receipt-semantics.test.ts`、`principle-governance-projection.test.ts` 引用不存在的 `src/ui/...` 路径）在干净 main 上同样失败，未修（见下）。

---

## 产品意图（agent 填，Owner 确认）

* 对应 Linear issue: **无**（新发现的偏差，未关联既有工单；`PRI-904` 已 `Done` 未改动，`PRI-930` 为跨 host 公平性的既有后续工单，未扩大其范围）
* 解决的产品问题（一句话）: 控制台对「批准后是否生效」的判断使用了与生产不同的选择策略，把排队误报为永久失效，诱导 Owner 停用健康原则。
* 工单状态对账（AGENTS.md §21 rules 9–11）: **无（已搜索检查）**——已用 `linear-cli search` 检索 `injection budget console rotation` / `PRI-904` / `Cross-host Principle Injection Fairness Clock`。`PRI-904` 状态 `Done`，本 PR 是其下游新发现缺陷，不重开、不改状态；`PRI-930`（`[P2] Cross-host Principle Injection Fairness Clock`，`Backlog`）范围为 Codex/host-shared 路由公平性，与本 PR 的控制台预测修复不同，未合并其状态。

### 是否触及产品边界

* [x] 否
* [ ] 是，需要 Owner/maintainer 明确批准

说明: 未新增 PD 能力边界，只修正既有告警对生产事实的描述。

---

## MVP Questions

#### `mvp-q-1-what-if-skip`

不做则控制台持续对 Owner 撒谎：每次批准新原则都显示「不会生效，需先停用旧原则」。Owner 会据此停用仍然有效、且被轮转机制正常保护的原则——这是**主动破坏有效治理状态**的引导。已在 Owner 真实工作区复现。

#### `mvp-q-2-how-observed`

批准一条 prompt 原则且注入窗口已满时：toast 标题由「已批准，但暂未生效」变为「已批准，正在排队生效」，正文说明最多 N 个连续回合内自行进入、**无需停用其他原则**，且不再出现「前往生效情况」的行动按钮（`activationAction: false`）。

#### `mvp-q-3-how-disabled`

* [ ] existing flag/config
* [ ] existing deactivation/state transition
* [x] backward-compatible revert
* [ ] new feature flag
* [ ] N/A — no meaningful runtime rollback requirement

说明: `git revert addc7e70`。无 flag / 无迁移 / 无持久化。旧 payload 缺新字段时 validator 缺省处理，前后端可独立部署。

#### `mvp-q-4-emotional-value`

* [x] Owner-facing change

降低：

* [x] 失控感
* [ ] 疲惫感
* [x] 重复纠正感
* [x] 信息过载
* [ ] 其他: ___

创造：

* [x] 安心感
* [x] 掌控感
* [ ] 沉淀感
* [x] 清醒感
* [ ] 其他: ___

说明: Owner 不再依据一条假警报去停用健康原则，也不再需要自己判断「排队」与「饿死」的区别；中英混排折叠后，先看到人话结论、需要时再展开原始证据，降低信息过载。**核心：消除因系统误报而产生的错误治理动作。**

---

## 变更概览（agent 填）

### 变更类型

* [x] 🐛 Bug 修复
* [x] 📝 文档
* [x] 🧪 测试

### 高层变更

1. 修复注入预算预测漏传 `roundKey` 导致策略与生产不一致的根因，并把选择策略 / 可达性作为数据返回。
2. 区分「排队等轮转」与「真正饿死」两种告警，中英文案不再谎称需要停用旧原则。
3. 折叠原始英文服务端文本，解决中英混排观感问题（rc-9 逐字保留不变）。

### 影响范围

* [x] host-runtime
* [x] pd-console

---

## Verification Evidence（agent 填）

### Targeted verification

| Command / scenario | Result | Why it matters |
| ------------------ | ----------- | -------------- |
| `npx vitest run packages/host-runtime/tests/prompt-injection-projection.test.ts` | PASS (9) | 含 4 个 PRI-935 新回归用例 |
| `npx vitest run packages/pd-console/tests/integration/governance-approve-activation.test.ts` | PASS (11) | 真实 HTTP 生产路径断言 `injection_budget_queued` |
| `npx vitest run .../approval-warning-localization.test.ts .../focus-page.test.ts .../cr10-api-validators.test.ts` | PASS (267) | 本地化、UI、validator 全覆盖 |
| **负向对照**：`git stash` 仅回退两个生产源文件后重跑 | **FAIL (5)** | 4 projection + 1 integration 用例失败，证明测试真能抓住该缺陷 |
| `npx tsc --noEmit -p packages/{host-runtime,pd-console}/tsconfig.json` | PASS | 类型干净 |
| `npm run lint` | PASS — 0 errors | 33 warnings 均为未触碰文件的既有 rc-5 |
| `npm run check:error-handbook` | PASS | 错误记录树与路由完整 |
| `npm run verify:merge`（pre-push hook 内执行） | PASS | 合并门禁 |
| i18n key 集合对比脚本（zh-CN vs en） | PASS | 两 locale key 完全一致 |

### Production-path evidence

* [x] 是
* [ ] 不适用

说明: 集成测试通过真实 HTTP `/api/v1/approvals/:id/approve` 打到真实 `ApprovalsConsoleModel`，而非直接调用 helper；`governance-approve-activation.test.ts` 使用真实 `SqliteConnection` 建表。现场另以只读方式对 Owner 真实 `state.db` 复算生产轮转行为。

### Merge gate

* [x] `npm run verify:merge` PASS
* [ ] 未通过，但确认是 pre-existing/environmental failure，并附证据

证据: pre-push hook 输出 `✓ verify-merge (191.79 seconds)`。

**已知预存在失败（与本 PR 无关，已在干净 main 上复现）**：`packages/pd-console/tests/ui/receipt-semantics.test.ts` 与 `principle-governance-projection.test.ts` 报 `ENOENT ... \src\ui\pages\principles\PrincipleDetailPage.tsx`（引用了不存在的仓库根 `src/` 路径）。在 `D:\Code\principles`（干净 main，不含本改动）运行同样失败，故未在本 PR 修复（§P3 最小改动面）。

---

## Error Experience / Task Risk Contract（0..N）

* Router command: `npm run error:context -- --paths "...prompt-injection-projection.ts,...ApprovalsConsoleModel.ts,...FocusPage.tsx" --signals "budget,rotation,forecast,projection,stale-copy"`（Pass 1）＋ `npm run error:context`（Pass 2，diff 模式）
* Router result: Pass 1 = `EP-03 HIGH, EP-02 MEDIUM, EP-06 MEDIUM, EP-11 MEDIUM, EP-13 MEDIUM`；Pass 2 新增 `EP-09 (8)`、`EP-01 (4)`
* Manual additions（router 未命中但人工判断相关）: `ERR-013 / rc-5`（lint warning 面，已确认无新增）
* Manual exclusions（router 命中但排除，HIGH 必须给理由）: 无

* Pattern: `EP-03 / rc-9` — Why relevant: 本 PR 改的正是 Owner 可见的降级/告警路径
  * Required evidence: 每次拒绝或降级都带结构化 reason + nextAction；失败不得伪装成成功
  * Evidence produced: 新增 `injection_budget_queued` 含 `nextAction=none; verify presence...`；`injection_budget_check_failed` 路径未动；投影抛错仍 fail-loud
  * Result: **PASS**

* Pattern: `EP-09` — Why relevant: 修 bug 必须有能失败的负向对照
  * Required evidence: 正向断言唯一确定执行路径；修复类回归测试须包含对修复前状态失败的负向对照；测试打生产边界
  * Evidence produced: `git stash` 仅回退 `prompt-injection-projection.ts` + `ApprovalsConsoleModel.ts` 后，4 个 projection 用例 + approve 集成用例失败（`expected undefined to be 'fair_rotation_v1'` 等），`stash pop` 后全绿；集成测试走真实 HTTP
  * Result: **PASS**

* Pattern: `EP-11` — Why relevant: 本 PR 新增 Owner 面向文案
  * Required evidence: i18n 组件中每条新用户可见字符串都经 `t()` 且 key 在所有 locale 文件存在
  * Evidence produced: 新增 `queuedTitle` / `queuedBody` / `queuedBodySimple` / `approveQueueBadgeRotation` 于 zh-CN 与 en；脚本比对两 locale key 集合差异为空
  * Result: **PASS**

* Pattern: `EP-01 / rc-1 / rc-2` — Why relevant: validator 处理服务端 payload
  * Required evidence: 不可信值保持 unknown 直到运行时守卫校验；输出路径只发出已校验对象
  * Evidence produced: `productionRotates` / `eligibleCount` 为可选字段，`Object.hasOwn` + `typeof` 守卫，非法值**丢弃而非透传**；新增测试 `drops a present-but-invalid rotation flag`
  * Result: **PASS**

* Pattern: `EP-02` — Why relevant: 跨包契约变更
  * Required evidence: 证明真实生产入口消费被改机制；共享契约变更需检查 consumer
  * Evidence produced: consumer 为 `ApprovalsConsoleModel` / `ApprovalsGroupedConsoleModel` / `validators` / `focus-validation` / `FocusPage`，全部经 typecheck + 集成/UI 测试覆盖
  * Result: **PASS**

* Pattern: `EP-06` — Why relevant: 触及 `src/ui/pages`
  * Required evidence: 改的是真源而非生成物
  * Evidence produced: 只改 `src/` 真源；i18n JSON 为真源，bundle 由既有 `build:ui` 产出，未手改产物
  * Result: **PASS**

* Pattern: `EP-13` — Why relevant: 新增 UI 元素
  * Required evidence: 使用 theme token 而非硬编码色值
  * Evidence produced: `<details>` 仅用既有 `text-[11.5px] opacity-80` / `max-h-40` 等工具类，**未引入任何 hex/rgb 字面量**
  * Result: **PASS**

### New reusable error lesson discovered?

* [x] 是，已按 Error Experience policy 记录/更新

说明: 根因是可复用的工程类别——**「预测/预报路径必须复用生产同一策略，否则缺省会系统性偏悲观并被当成事实呈现」**。已通过 `npm run error:record` 写入 structured records（`docs/process/error-management/records/`），含 `--invariant / --severity / --escaped / --caughtBy / --guard` 结构化字段；随后 `npm run check:error-handbook` PASS。

---
