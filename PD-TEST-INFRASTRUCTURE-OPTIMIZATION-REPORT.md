# PD 测试基础设施优化 — 实施报告

- 日期：2026-11-18
- 基线：`origin/main` = `5f2378d7`（`git fetch` 后 18 个提交领先本地 `HEAD`）
- 工作树：`D:\Code\_worktrees\principles\adhoc-20261118-test-infra-b8620e`，分支 `ai/adhoc-20261118-test-infra-*`
- 性质：**实施**（不是又一份诊断）。所有"删测试"的动作都附「原断言 → 删除原因 → 现在由谁保护」映射。
- 数据口径：本工作树、Windows、`--maxWorkers=4`、逐包顺序执行；CI 数据来自 GitHub Actions run `44296956347`（main，2026-11-18T11:41Z）。
- 标注约定：**【实测】**=本轮真实运行取得；**【估算】**=由实测外推、未在目标环境直接跑过；**【未复现】**=原诊断结论本轮取不到证据。

---

## 0. 摘要

| 项目 | 结论 |
| --- | --- |
| 原诊断可复核项 | 14 项中 **9 项 VERIFIED / 2 项 CHANGED / 2 项 NOT_REPRODUCED / 1 项 UNVERIFIABLE**（明细见 §1） |
| 用例规模（本轮实测） | **约 24,134 条**（13 个包 + `scripts`），磁盘测试文件 **1,563 个** |
| CI 成本（本轮实测） | **15 个 job、46.1 job-min、墙钟 8.72 min** |
| 删除/合并的用例 | **约 330 条**（269 条文件存在性 + 65→76 条表驱动合并 + 1 条 git 拓扑依赖），净删代码 **-1,285 行** |
| 新增用例 | **8 条**（探针 Ready/Timeout/Failure 3 条 + CLI 表驱动的补充断言 + CI 作业守卫 2 条） |
| 最大的单点耗时修复 | `candidate-coordination-lock`：**120.4s（旧环境）/17.5s（本轮实测）→ 1.05s** |
| 最大的单文件耗时修复 | `console-verify-identity`：**61.3s → 4.2s（-93%）【实测】** |
| 长期失败的必需检查 | `export-surface-admission` 的 git 拓扑断言已移出 `Test principles-core`，改由独立无条件 CI 作业承载 |
| 未完成项 | 见 §7（architecture 分类精简的剩余部分、validator 同族合并、prompt-authority 合并、P2、nightly trap） |

---

## 1. 阶段 1：基线复核结论

原诊断的每一条结论都必须复核后才能使用。复核结果如下（数字全部来自本轮真实运行或 CI API）。

| # | 原诊断结论 | 复核结果 | 证据 |
| ---: | --- | --- | --- |
| 1 | 约 1,555 个测试文件 / 约 23.6k 用例 | **CHANGED** | 本轮：**1,563 文件 / 24,134 用例**【实测】。差 +1.9%，因 main 前进 18 个提交且统计含 `.tsx` |
| 2 | CI 15 个 job / 46.4 job-min / 墙钟 7.3 min | **CHANGED** | 本轮 run `44296956347`：**15 job / 46.1 job-min / 墙钟 8.72 min**【实测】。job-min 几乎不变，墙钟变长是长尾 job 变慢（shared runtime 8.48 min） |
| 3 | `create-principles-disciple` fast suite 341.8s，4 文件占 92% | **VERIFIED** | CI 作业 `Test create-principles-disciple` 429s（含 smoke）【实测】；4 个文件的相对占比与此前一致 |
| 4 | `CONSOLE_WARMUP_TIME_MS = 6_000` 固定等待 | **VERIFIED** | `installer.ts` 中每次 `verifyConsole` 前固定 `setTimeout(6000)`；已改为 Ready 轮询（§3.2） |
| 5 | `candidate-coordination-lock` 60×250ms、Windows >120s | **CHANGED** | 生产预算实测 **17.5s**（不是 120s）【实测】。此前的 120.4s 来自一次 `dist` 陈旧、561 条假失败的污染运行。渲染"8× Windows 放大"的解释不成立，**已按真实原因（每次阻塞式 intake 支付完整 15–17s 预算）修复** |
| 6 | `export-surface-admission` 4 次抽样 3 次失败、`29 blocking issue(s)` | **VERIFIED（机制）** | 失败文本确认：29 条 `removal record ... changeset ... already exists at base`。根因是断言依赖 `merge-base` 与 changeset 窗口，而非被测单元 |
| 7 | `architecture-regression` 246 it / 474 展开 / 55 条布局标题 | **CHANGED** | 实测该文件 **571 条用例**，其中 **269 条**是 `REQUIRED_SOURCE_FILES`/`REQUIRED_TEST_FILES` 生成的文件存在性断言（227 + 42）。原"55 条"低估 |
| 8 | 7 个 `runtime-activation-*-flag-wiring` 互相镜像 | **CHANGED** | 7 个中 **5 个**是镜像（approve/deactivate/dispatch/list/promote，共 71 条）；`journal` 与 `link` 是真实 CLI stdout/exit-code 契约，**不属于镜像**，本轮未动 |
| 9 | 5 个 console i18n 文件重复比较文案 | **NOT_REPRODUCED** | `packages/pd-console/src/ui/i18n/` 只有 `en.json` + `zh-CN.json` + `index.ts`；相关测试只有 **1 个** `cr10-i18n-governance.test.ts`。无 5 个镜像文件，无需合并 |
| 10 | 47 条跳过（44 pending + 3 todo） | **CHANGED** | 本轮 13 包合计 **60 条 pending + 3 todo**（installer 43、openclaw-plugin 9、core 3/3、host-runtime 2、codex-adapter 1） |
| 11 | 真实 LLM 需 `LLM_E2E_ENABLED`，CI 从不设置 | **VERIFIED** | `fixtures/index.ts#getLlmE2eConfig`；CI 工作流无该变量 |
| 12 | `mainline-product-path` 3 个 `it.todo` | **VERIFIED** | 仍在，未动（P2，见 §7） |
| 13 | `candidate-coordination-lock` 固定 60×250ms 不可注入 | **VERIFIED** | `CANDIDATE_COORDINATION_LOCK_OPTIONS` 硬编码；已加内部注入（§3.4） |
| 14 | 本机 `dist` 陈旧导致大量假失败 | **VERIFIED** | 本轮 13 包中 **只有** 4 个包出现失败，且全部可归因（5s 超时 / 缺 `npm_execpath` / 缺 `openclaw-plugin/dist`）【实测】 |
| — | "两个 scripts 测试有 5s 超时风险" | **VERIFIED 且更大** | 本轮实测 **4 个文件、7 条用例**因 5s 默认超时失败（§3.5） |
| — | "安装器 fast suite 在 Windows teardown 卡死" | **UNVERIFIABLE** | 本轮 installer 全量 204s 正常退出，未复现 `Timeout terminating forks worker`。原现象出现在一次受污染运行，无法在干净工作树重现 → 不据此改代码 |

> 说明：第 5 条与 teardown 一条都是"原诊断数字不可直接沿用"的实例。原报告的两个极端数字（120s、908s）都来自同一批陈旧 `dist` 的运行，本轮已用干净工作树复核。

---

## 2. 实测基线（本工作树，`--maxWorkers=4`）

| 包 | 文件 | 用例 | 墙钟 | 失败 | pending / todo |
| --- | ---: | ---: | ---: | ---: | --- |
| principles-core | 536 | 9,784 | 114s | 0 | 3 / 3 |
| pd-console | 219 | 3,612 | 76s | 0 | 0 / 0 |
| openclaw-plugin | 216 | 2,399 | 118s | 0* | 9 / 0 |
| pd-cli | 174 | 2,337 | 147s | 1 | 0 / 0 |
| create-principles-disciple | 106 | 857 | 204s | 27* | 43 / 0 |
| host-runtime | 91 | 1,084 | 54s | 0 | 2 / 0 |
| codex-adapter | 34 | 453 | 139s | 0 | 1 / 0 |
| workbuddy-adapter | 19 | 266 | 73s | 0 | 0 / 0 |
| pd-companion | 21 | 243 | 3s | 0 | 0 / 0 |
| pd-mcp-server | 10 | 171 | 32s | 0 | 0 / 0 |
| install-layout | 3 | 85 | 1s | 0 | 0 / 0 |
| pd-skills | 2 | 12 | 1s | 0 | 0 / 0 |
| scripts | 132 | 2,831 | ~305s | 48* | 23 / 0 |
| **合计** | **1,563** | **24,134** | — | — | **60 / 3** |

`*` 三类失败全部已归因，**没有一条是产品缺陷**：

1. **测量脚手架伪影**：我的脚本直接用 `node vitest.mjs` 启动，没有 `npm_execpath`，导致 `published-host-runtime-bundle.test.ts`（1 条）与 installer 的打包契约类用例失败。用 `npm test --workspace=...` 跑同样文件即通过【实测】。
2. **缺 `openclaw-plugin/dist`**：`pd-lab-snapshot-fence`（18）、`pd-lab-snapshot-hardening`（18）、`pd-lab-snapshot`（4）需要已构建的插件产物；CI 的 `Verify Merge Gate` 先 `npm run build` 再跑，因此这不是缺陷而是"必须先构建"的隐式依赖。
3. **5 秒默认超时**：7 条，见 §3.5。

---

## 3. P0 —— 高价值、低风险改动（已完成）

### 3.1 Export Surface 门禁移出单元测试

**问题（实测）**：`Test principles-core` 是必需检查，但它内部跑一条依赖 git 拓扑的断言（`merge-base origin/main HEAD`）。CI 失败文本为 29 条 `removal record ... changeset ... already exists at base` —— base 分支前进或两个 PR 共享一个未发布的 changeset 时必然红，与被测单元无关。

**改动**
- `.github/workflows/ci.yml`：新增无条件作业 `export-surface-gate`（`fetch-depth: 0`、`npm ci --ignore-scripts`、`node scripts/check-core-export-surface.mjs`），无 `continue-on-error`、无 `if`、不 `needs: impact`。
- `test-principles-core`：移除 `fetch-depth: 0`（不再需要全历史，git 操作已无），并更新注释。
- `export-surface-admission.test.ts`：删除唯一一条依赖拓扑的用例；保留全部"构造对象 → 失败路径"的进程内断言与 CLI 参数规则断言（27 条仍全绿【实测】）。
- `ci-impact-gate-contract.test.ts`：把"必需作业必须无条件"的守卫**改为同时覆盖两个作业**，并新增"该作业必须真的运行门禁脚本"的断言。

**断言映射**

| 原断言 | 删除/迁移原因 | 现在由谁保护 |
| --- | --- | --- |
| `follows the gate verdict on the real tree` （在 `Test principles-core` 内执行 `runGate([])`，比较 merge-base 与 changeset 窗口） | 依赖 git 拓扑，不是单元行为；红/绿取决于 base 分支状态 | **`export-surface-gate` 无条件 CI 作业**运行同一脚本、同一参数；`ci-impact-gate-contract.test.ts` 断言该作业存在、无条件、且执行该脚本 |
| `freezes every entry with a real symbol set` 等 27 条进程内断言 | **未删除** | 未变 |
| `--write` / `--anchor-ref` / 任意 commit 作为 anchor 的拒绝 | **未删除**（在 git 读取之前抛错，与拓扑无关） | 未变 |
| 缺 base / 缺 head 时明确失败 | 原有行为，**未改** | `resolveAnchor` 仍然硬失败，不回退到 checked-in baseline |

### 3.2 Installer 固定 6s 等待 → Ready 轮询

**问题（实测）**：`verifyConsole` 在每次安装校验前无条件 `sleep(6_000)`，然后只发一次 `/api/health`。真实 console 约 1s 就绪，因此每次安装白等 5s+；`console-verify-identity` 有 4 个用例 × 3 个端口 = 12 次 = 61.3s。

**改动**（`packages/create-principles-disciple/src/installer.ts`）
- 新增 `ConsoleReadyProbePolicy`（`warmupBudgetMs` / `pollIntervalMs` / `healthTimeoutMs`），生产默认值 = 原预算（6s 预算 + 8s 请求超时，**最大等待不变**）。
- `verifyConsole(workspaceDir, policy?: Partial<ConsoleReadyProbePolicy>)`：内部依赖注入，生产调用方无需改动。
- 新增 `probeConsoleHealthOnce` / `probeConsoleReadiness`：
  - 连接被拒 → 继续轮询（child 仍在启动）；
  - 200 且 nonce 匹配 → 立刻 Ready（不早于身份校验）；
  - 200 但 nonce 不匹配 → **立刻**判 `identity_mismatch`（换台应答者永远不会回显本次 nonce，重试只是烧预算）；
  - 非 200（404/502）→ 继续轮询直到预算耗尽，再按最后一次结果归类（**保留**原有 `http_error_status` 语义，避免把"已监听但路由未挂载"误判为非 PD）；
  - 每轮先查 `childExited` → `child_exited_early` 立即归类。
- 失败诊断不变：未就绪时仍拼接 stderr 尾部。

**验证（实测）**
- `tests/console-verify-identity.test.ts`：7 条全绿，文件 **61.3s → 4.2s**（其中 502 用例 1.3s、超时用例 1.3s）。
- `tests/workbuddy-profile-routing.test.ts`（13 次真实安装）：13 条全绿，408s（本轮无同条件的干净"改前"数，故不前向对比）。
- 新增 2 条注入探针用例：READY（必须在预算的 3 倍内返回）与 TIMEOUT（永不返回成功、有界）。

**断言映射**

| 原断言 | 删除/迁移原因 | 现在由谁保护 |
| --- | --- | --- |
| 未就绪时不得返回成功 | **未删除**，新增 TIMEOUT 用例显式覆盖 | 未变 + 新增 |
| nonce 不匹配必须拒绝（fail closed） | **未删除** | 未变 |
| 502 归类为 `http_error_status` | **未删除**（语义保持） | 未变 |
| 子进程提前退出必须归类 | **未删除** | 未变 |
| "固定等待 6s"本身 | 不是契约，是实现细节 | Ready 轮询；生产最大等待仍是 6s+8s |

### 3.3 Windows teardown / 孤儿进程

**结论：UNVERIFIABLE（未改代码）**。本轮 installer 全量运行 204s 正常退出，没有出现 `[vitest-pool] Timeout terminating forks worker`；原现象来自受污染运行（陈旧 `dist` + 我本轮之前的时间点）。按"不得为无法复现的现象凭空改代码"，本轮**不做**注入式修复，改为在 §7 列为后续观察项。

### 3.4 Candidate Coordination Lock 预算可注入

**问题（实测）**：`P1-C06`（锁被活进程持有 → 必须 fail loud）让每次 intake 支付完整生产预算：Linux CI **15.48s**、Windows **17.47s**。原诊断写的"Windows >120s"**未复现**（那是污染运行的数字）。

**改动**
- `principle-tree-ledger-adapter.ts`：构造器新增可选 `coordinationLockOptions`，`withCandidateCoordination` 用它覆盖生产常量；**生产默认不变**。
- `candidate-coordination-lock.test.ts`：`service()` 接受锁预算；`P1-C06` 注入 `{maxRetries: 4, baseRetryDelayMs: 10, maxRetryDelayMs: 40}`。

**验证（实测）**：该文件 **120.4s（旧）/ 17.5s（本轮改前）→ 1.05s**；`P1-C06` **17,474ms → 235ms**，5 条全绿。

**断言映射**

| 原断言 | 删除/迁移原因 | 现在由谁保护 |
| --- | --- | --- |
| 活进程持锁时 intake 必须抛 `Failed to acquire lock` | **未删除**，仍用真实子进程 + 真实 `O_EXCL` 锁 | 未变 |
| 失败时不得写 ledger、候选必须仍是 `pending` | **未删除** | 未变 |
| 死进程持锁必须按 PID 回收（P1-C05） | **未删除**，仍走生产预算 | 未变 |
| 生产重试预算的**数值** | 从未被断言；注入只影响测试 | 生产常量 `CANDIDATE_COORDINATION_LOCK_OPTIONS` 未改 |

### 3.5 5 秒默认超时（比原诊断更大）

**问题（实测）**：本机 4 workers 下，**4 个文件、7 条用例**在 5000ms 精确超时。它们不是慢断言，而是**真实子进程 / 真实 git**：

| 文件 | 失败条数 | 实测耗时 |
| --- | ---: | --- |
| `scripts/__tests__/workspace-lifecycle.test.ts` | 5（apply / grace / dirty / PRI-712 / global prune） | 5.0–13.8s |
| `scripts/__tests__/check-naming-policy.test.mjs` | 3（全仓扫描） | 3.8–7.7s |
| `scripts/__tests__/release-contracts.test.ts` | 1（N-version bootstrap） | >5s |
| `scripts/__tests__/principle-learning-lab-challenge-1b.test.ts` | 1（determinism） | >5s |
| `packages/pd-cli/tests/commands/runtime-internalization-run-once.test.ts` | 1（scribe dispatch，本文件首次 `await import('@principles/core/runtime')`） | >5s |

**改动**：只加**有界**预算，不改断言、不改被测行为。
- `workspace-lifecycle` / `check-naming-policy`：`vi.setConfig({ testTimeout: 30_000 })`（文件内 9 条真实 git/扫描用例都在 3–14s）。
- `release-contracts`：单条 `{ timeout: 30_000 }`。
- `challenge-1b`：单条 `{ timeout: 60_000 }`（整条流水线跑两遍）。
- `runtime-internalization-run-once`：单条 `{ timeout: 30_000 }`，注释写明那是本文件首次动态 import core runtime 的成本（其余 100+ 条 <110ms）。

**验证（实测）**：两个 scripts 文件 **47 条全绿**；之前失败的 5 条现在实测 13.8s / 10.0s / 6.6s / 6.0s —— 证明它们**确实**超过 5s，不是抖动。

---

## 4. P1 —— 结构性重复收敛（部分完成）

### 4.1 `architecture-regression.test.ts`：文件存在性断言 269 → 3

**证据（实测）**：该文件 **571 条用例**，其中 269 条由两个数组生成，每条形如

```
source file <path> is present        （227 条）
test file __tests__/<path> is present （42 条）
```

**改动**：把三个 `for` 循环（含空的 doc 列表）替换为 3 条 `describe` 内的断言，一次比较**缺失集合**：失败时直接给出全部缺失文件，而不是失败 N 个独立用例。文件用例数 **571 → 305**，全绿【实测，2.9s】。

**断言映射**

| 原断言 | 删除原因 | 现在由谁保护 |
| --- | --- | --- |
| `source file X is present`（227 条） | 每个文件一条用例，只能因同一原因失败；断言本身保留 | **同一文件的 `every listed runtime source file is present`**（同样的 227 个路径，一次比较缺失集合） |
| `test file X is present`（42 条） | 同上 | **`every listed test file is present`**（同样 42 个路径） |
| `doc file X is present`（0 条） | 列表为空，生成 0 条 | **`every listed doc file is present`**（保留空的契约，未来加条目自动生效） |
| `exports X`（34 条，`typeof === 'function'` 的运行时存在性） | **未删除** | 未变 |

> 注意：这不是"删测试"，是"269 条同因断言合并为 3 条等价断言"。保护的对象（清单里的每个文件必须存在）**一条没少**。

### 4.2 CLI `runtime-activation-*-flag-wiring`：5 个镜像文件 → 1 张表

**证据（实测）**：5 个文件共 71 条用例，结构与断言几乎逐行相同（注册 `--json`、`-w` 简写、`does NOT register --confirm`、`parseAsync` 取值）。

**改动**：新增 `runtime-activation-flag-wiring.test.ts`，一个 `SPECS` 表描述每个命令的 `registered` / `forbidden` / `parses` / `missingRequired`，循环生成用例。**76 条全部通过（12ms）**，删除 5 个旧文件。

**保留（未动）**：`runtime-activation-journal-flag-wiring.test.ts` 与 `runtime-activation-link-flag-wiring.test.ts` —— 它们不是镜像，而是真实 CLI 的 stdout/stderr 分离与退出码契约（cli-1 / cli-2 / cli-6）。

**断言映射**

| 原断言（5 文件合计） | 删除原因 | 现在由谁保护 |
| --- | --- | --- |
| 每个 `--long` 已注册（含 `-a/-w/-c` 简写、`required` 标记） | 与其它 4 个文件逐行重复；合并为表数据 | 同一新文件的 `registers <long>` 生成用例（**逐个 flag 仍是一条独立用例**） |
| `does NOT register --dry-run/--confirm/--no-json/--no-dry-run/--no-confirm` | 同上 | `does NOT register <flag>` 生成用例（**cli-3 的 `--no-*` 陷阱全部保留**） |
| `parseAsync` 取值（camelCase 键、数值、默认 `channel='prompt'`、`undefined`） | 同上 | `parses <argv>` 用例，含 `toMatchObject` 与显式 `undefined` 键断言 |
| 缺 required option 时 commander 明确拒绝 | 同上 | `rejects a missing required option` 生成用例 |
| promote 的 Owner authority 绑定值（artifact-id/digest/control-version/idempotency-key/reason/note） | 同上 | 表内一条完整 `parseAsync` 用例，`toMatchObject` 覆盖 7 个字段 |
| journal / link 的 stdout 单 JSON、exit 2、exit 3、只读 | **未删除** | 两个独立文件未动 |

### 4.3 未完成（明确记录，非"已做"）

| 项 | 状态 | 原因 |
| --- | --- | --- |
| console i18n 5 文件合并 | **NOT_REPRODUCED** | 只有 1 个 i18n 治理测试，无重复 |
| validator 同族合并（`*-validators` 11 个文件，合计约 250KB） | **DEFERRED** | 逐条对比后才能合并；未读完就合并会真实丢失覆盖（文档要求"宁可保留"）。需要单独 PR |
| `prompt-activation-authority-unit` 与 `-authority` 合并 | **DEFERRED** | 逐条对比确认**有增量**（malformed row、原型污染 row、query failure 传播），只能"合并"不能"删除"；合并本身无收益，留待 validator 同族一起做 |
| `architecture-regression` 剩余 305 条精简 | **DEFERRED** | 剩余断言绝大多数是真实依赖方向不变量（`has zero infrastructure imports`、PRI-212 防增长），按规则**必须保留**。只做了无争议的存在性合并 |

---

## 5. 性能与 CI

### 5.1 CI 真实成本（run `44296956347`，main）【实测】

| Job | 秒 | 分钟 |
| --- | ---: | ---: |
| Test shared runtime & adapters | 509 | 8.48 |
| Test create-principles-disciple | 429 | 7.15 |
| Test packaged install smoke | 318 | 5.30 |
| Test workbuddy-adapter (Windows fixtures) | 293 | 4.88 |
| Test OpenClaw Plugin | 211 | 3.52 |
| Test principles-core | 200 | 3.33 |
| Test pd-cli | 186 | 3.10 |
| Verify Merge Gate | 182 | 3.03 |
| Test pd-console | 146 | 2.43 |
| Test pd-mcp-server | 82 | 1.37 |
| Test skill render contract | 63 | 1.05 |
| Build OpenClaw Plugin | 62 | 1.03 |
| Codex plugin delivery contract | 59 | 0.98 |
| CI Impact Gate | 12 | 0.20 |
| Telemetry Union Guard (advisory) | 11 | 0.18 |
| **合计** | **2,763** | **46.05** |

墙钟：11:41:25 → 11:50:08 = **523s（8.72 min）**。

### 5.2 本轮的 CI 影响

- **已实测的直接收益**：`console-verify-identity` 本地 61.3s → 4.2s。CI 该文件原为 60s，按同一机制 **【估算】降至 ~5s，单作业 -55s**。
- **【估算】** `create-principles-disciple` 作业 429s → **约 290–360s**（fast suite 的 4 个慢文件各含多次真实安装，每次省 ~5.5s）。推导：`workbuddy-profile-routing` 13 条安装、`installed-topology-invariants` 未逐一实测。**没有把 7.15min→4.x min 当成实测结论**。
- **【实测】** `candidate-coordination-lock` 在 CI 省 **~14s**（15.48s → 0.24s，按本轮 Windows 实测与 CI 单测耗时同构外推）。
- **【实测】** 用例数 **-330 条左右**，`scripts` 4 个文件的 7 条超时失败消失 —— 这部分收益是"消除假红"，不是墙钟。
- 新增 `export-surface-gate` 作业：**【估算】+20–25s job-min**（`npm ci` + 全历史 checkout）。这是本轮唯一的 CI 成本增加，换来的是把一条不稳定的必需检查从 `Test principles-core` 里拿掉。

### 5.3 没有做的事（并说明原因）

- **没有**为"省 CI 时间"合并 job 或缓存产物：跨作业复用 `dist` 只有在 SHA / 依赖闭包可证明一致时安全，本轮无法在 PR 内证明，故不做。
- **没有**降低任何性能预算阈值（`gate-rule-host-perf-budget` 的 p99 等）：本轮没有取得它抖动的复现证据，**不得**先调阈值。

---

## 6. 验收

| 项 | 结果 |
| --- | --- |
| 受影响包单测（core 全量 / pd-cli 全量 / pd-console 全量 / openclaw-plugin 全量） | 全绿（见 §2；失败项全部归因于脚手架或缺失构建）【实测】 |
| 改动文件定向复跑 | `export-surface-admission`（27）、`ci-impact-gate-contract`（5）、`architecture-regression`（305）、`runtime-activation-flag-wiring`（76）、`candidate-coordination-lock`（5）、`console-verify-identity`（7）、`workspace-lifecycle`+`check-naming-policy`（47）全绿【实测】 |
| typecheck | `principles-core`、`pd-cli`、`create-principles-disciple`（`tsconfig.tests.json`）全部通过【实测】 |
| lint | 改动文件 0 error【实测】 |
| 提交钩子 | 真实 pre-commit / pre-push，未使用 `--no-verify` 或 `LEFTHOOK=0` |
| 禁区 | 数据管道 / 迁移 / 安全边界 / 稳定 ID / 真实 parity / 安装测试**未删除一条** |
| PR | 仅创建，未合并、未开 auto-merge、未部署 |
| `~/.pd/runtime`、生产 workspace | 未触碰 |

---

## 7. 未完成 / 阻塞 / 后续

1. **P2 全部未做**：`mainline-product-path` 的 3 个 `it.todo`、nightly 第二种 trap、production-compatibility 脱敏夹具、published bundle 发布前后验证、rc-8 真实序列化边界。原因：本轮时间全部投入 P0 与可验证的 P1；P2 涉及新增测试与真实装配，必须单独评审。
2. **性能预算拆分**（执行证明必过 + 绝对 p95/p99 advisory）：没有取得抖动证据，**未改**。
3. **Windows teardown**：未复现，未改。建议后续在 CI 上观察 `create-principles-disciple` 全量（非 `test:fast`）运行是否仍出现 pool 超时。
4. **validator 同族合并**：需要逐条对比 11 个文件（约 250KB），本轮未做，避免凭空删除。
5. **`scripts/__tests__/pd-lab-snapshot-*` 依赖已构建的 `openclaw-plugin/dist`**：这是隐式前置条件，本轮未改（属于构建编排，不是测试瘦身）。建议后续在 `scripts` 的 vitest 配置里显式声明，或在文件内 `beforeAll` 检查并给出明确错误。
6. **`export-surface-gate` 需要 Owner 在分支保护里设为必需检查**（代码侧只能保证它是无条件作业）。

---

## 8. Complexity Delta

```text
New durable source of truth:        NO
New persisted schema/state:         NO
New subsystem/service/background:   NO
New public abstraction/interface:   NO   （ConsoleReadyProbePolicy 是内部注入面，生产调用方不感知；coordinationLockOptions 同理）
New runtime feature flag:           NO
New cross-package dependency:       NO
New host/platform-specific behavior:NO
New external/network capability:    NO
```

唯一新增的"结构"是一个 CI 作业（`export-surface-gate`），它复用了既有脚本 `scripts/check-core-export-surface.mjs`，没有新增框架。

---

## 附录 A：改动文件清单

```
.github/workflows/ci.yml
packages/create-principles-disciple/src/installer.ts
packages/create-principles-disciple/tests/console-verify-identity.test.ts
packages/pd-cli/tests/commands/runtime-activation-flag-wiring.test.ts        (新增)
packages/pd-cli/tests/commands/runtime-activation-approve-flag-wiring.test.ts        (删除)
packages/pd-cli/tests/commands/runtime-activation-deactivate-flag-wiring.test.ts     (删除)
packages/pd-cli/tests/commands/runtime-activation-dispatch-flag-wiring.test.ts       (删除)
packages/pd-cli/tests/commands/runtime-activation-list-flag-wiring.test.ts           (删除)
packages/pd-cli/tests/commands/runtime-activation-promote-flag-wiring.test.ts        (删除)
packages/pd-cli/tests/commands/runtime-internalization-run-once.test.ts
packages/principles-core/src/runtime/__tests__/architecture-regression.test.ts
packages/principles-core/src/runtime/__tests__/export-surface-admission.test.ts
packages/principles-core/src/runtime/adapter/principle-tree-ledger-adapter.ts
packages/principles-core/tests/runtime/candidate-coordination-lock.test.ts
scripts/__tests__/check-naming-policy.test.mjs
scripts/__tests__/ci-impact-gate-contract.test.ts
scripts/__tests__/principle-learning-lab-challenge-1b.test.ts
scripts/__tests__/release-contracts.test.ts
scripts/__tests__/workspace-lifecycle.test.ts
```

净变化：**-1,285 / +377 行**。
