# PRI-1163 发布包轮次接线核查：3.1.3「仍走 FIFO」的证据化归因（2026-11-10）

- 文档 ID：`pri-1163-release-bundle-round-key-audit-20261110`；工单：PRI-1163（关联 PRI-1162 / PRI-1105）
- 性质：只读核查 + 隔离重建 + 离线对照。宿主启动 0、模型调用 0、安装/发版/生产写入 0、上游提交 0、合并 0。
- 基线：工作树 `ai/PRI-1163-release-round-key-audit`，base `4775f3bc5`（origin/main）。
- 待答问题：OpenClaw 已装 PD 3.1.3 仍走 `legacy_fifo_prefix_v1` 的原因，及有证据的修复归属。

## 1. 裁决（一轮对照后）

| 问题 | 裁决 |
|---|---|
| npm 3.1.3 发布 bundle 缺轮次键接线？ | **否**——静态+行为+重建三臂一致证明接线在位（§3/§4/§5） |
| 发布管线有产物分叉点？ | **否**——tag 源码 + tag 锁文件 + 官方构建序列在隔离目录重建出**逐字节一致**的 bundle.js（§5） |
| 生产为何仍观察到 FIFO？ | **按设计正确回退**：被观察的全部注入轮是**非用户交互轮**（自动化 ~60 分钟节奏），且自 2026-11-07 01:07Z 起该工作区**再无任何真实用户轮**（§6）——P1-3 门槛正确拒绝为无用户轮的回合签发轮次键 |
| 修复归属 | **无缺陷、无需修复、无需修复卡**。真实用户轮出现时 `fair_rotation_v1` 自动生效（§8 最低成本验证动作） |
| PRI-1162「stale bundle」推断 | **被否证**：其依据（函数名 `prepareOpenClawPromptRound`/`nextSessionTurnOrdinal` 在 bundle 中 0 命中）是 `esbuild --production` `minify:true` 的**预期符号改写**，非内容缺失（§3） |

整体状态：**READY_FOR_OWNER_DECISION**（裁决=确认无行动项；PRI-1162 的仓库侧结论不受影响，其遗留的「发布版本尚待验证」由本票闭合为「已验证：发布物正确」）。

## 2. 三份对照物（已固定）

| # | 对照物 | 版本 | 完整性/哈希 |
|---|---|---|---|
| A | npm 发布 tarball（`npm pack principles-disciple@3.1.3`） | 3.1.3 | tarball sha256 `213da943aad92ead53b6470b7a5667eb1114bee61bc882e10ed35c63fb155525`；`dist/bundle.js` sha256 `7301253d09d3c4a900bc3a44b4b3430b835b71d47161e6fdc94d8ff725f6546d`（4,856,581 字节） |
| B | 本机已装扩展 `~/.openclaw/extensions/principles-disciple` | 3.1.3 | `dist/bundle.js` sha256 = `7301253d…` **与 A 逐字节一致**；`node_modules/better-sqlite3@13.0.3`（prebuilds/win32-x64.node）在位 |
| C | 发布基线 | git tag `v3.1.3` = `e7c7e6bba35aa7d691496cf126b195ea3a70fef9`（#2453 version-packages） | `package-lock.json`（v3，esbuild 0.28.2）；正式构建命令 = `npm run build`（根）→ `npm run build:production --workspace=principles-disciple`（`.github/workflows/release-reproducibility-full.yml:58-59`）；打包入口 = `package.json` `openclaw.setupEntry`/`openclaw.extensions` = `./dist/bundle.js`（唯一运行入口；`main` 是其再导出 shim） |

包声明的实际运行入口与入口哈希已核对（A=发布物、B=本机、C=重建物，三者 bundle.js 同一 sha256）。

## 3. 静态臂：压缩不敏感字面量全在位；函数名 0 命中是 minify 伪象

发布构建 `minify: isProduction ? true : false`（`packages/openclaw-plugin/esbuild.config.js`）——**函数名必被改写**，字符串字面量与属性键存活。对 A 的 `dist/bundle.js`：

| 证据（轮次键路径专属、压缩后存活） | 命中 | 唯一出处 |
|---|---|---|
| `round key resolved: round=` | 1 | `prepareOpenClawPromptRound` 成功日志（`src/hooks/prompt.ts:524`） |
| `round key replayed for claimed run` | 1 | 同轮重放分支（`:439`） |
| `round key unavailable (trajectory DB unreadable)` | 1 | 降级分支（`:530`） |
| `user_turn_persisted` / `user_turn_persist_failed` | 1/1 | 收集器状态判定（`:499/:503`） |
| `roundKeyProvider`（属性键） | 3 | 注册点 `src/index.ts:475` + 共享消费侧 `host-runtime/src/index.ts:324` + 桥接 `openclaw-host-runtime.ts:143` |
| `legacy_fifo_prefix_v1` / `fair_rotation_v1` | 3/2 | 共享选择策略（`active-principle-prompt.ts:452/472`） |
| 函数名 `prepareOpenClawPromptRound`/`nextSessionTurnOrdinal`/`hasClaimedSignalRun`/… | 0 | **预期**——minify 改写；同一函数体以改写后名称在位（由上行字面量证明） |

PRI-1162 检查点（20261110T0230Z/0310Z）记录的「fresh build 含全部符号（b19f0ec1…）」应为其工作树**非 production 构建**（`minify:false` 保留函数名）——与发布物不可直接比较；其「发布物 stale」结论因此不成立。

## 4. 行为臂：发布 bundle 在忠实 2026.11.1 embedded 输入下推进轮次键

离线探针（脚本与完整结果见 §9 证据）：从包声明入口 `dist/bundle.js` 导入发布物默认导出插件对象，`register(fakeApi)` 捕获 `before_prompt_build` 钩子（镜像 `tests/hooks/phase-a-default-production-path.test.ts` 夹具），事件忠实模拟已装 OpenClaw 2026.11.1 embedded 形态（`context-engine-maintenance-*.mjs` 实测：事件恰为 `{prompt, messages}`，hookCtx 含 `runId/sessionKey/sessionId/agentId/workspaceDir/trigger`）；候选集复用 PRI-1162 冻结沙箱（state.db sha256 `830fbd24…`，18 候选）。

| 臂 | 输入 | 观测 |
|---|---|---|
| A1–A4 | `trigger:'user'`，连续 4 轮真实文本 | `user_turns` 每轮 +1（maxIdx 2→5）；日志 `[PD:Prompt] round key resolved: round=3/4/5/6`；钩子返回完整注入结果（`injectedExpectations` 等 4 字段）——**序数经提供方传入共享装配** |
| B1 | `trigger:'heartbeat'` | 零写入；日志 `non-interactive trigger (heartbeat) records no round → legacy_fifo_prefix_v1` |
| C1 | `sessionId` 缺失 | 零写入、无 round key（P1-3 门槛） |

推论：`fair_rotation_v1` 与 `legacy_fifo_prefix_v1` 的选择由提供方返回值派生（`host-runtime/src/index.ts:330` + `active-principle-prompt.ts:472-478`），A1–A4 即 fair 分支的行为证据（发布物本身），B1/C1 即设计回退。PRI-1162 源码侧覆盖矩阵（T1–T5+等价引用）继续有效，本臂把同一结论外推到**已发布字节**。

## 5. 重建臂：发布基线逐字节复现，无分叉点

隔离目录（`.pd-tmp` 管理根，非任何检出内）：`git archive e7c7e6bba` 解包 → `npm ci`（tag 锁文件）→ 官方序列 `npm run build` → `npm run build:production --workspace=principles-disciple`。

- 结果：重建 `dist/bundle.js` sha256 = `7301253d09d3c4a900bc3a44b4b3430b835b71d47161e6fdc94d8ff725f6546d` —— **与 A（npm 发布物）、B（本机扩展）逐字节一致**。
- 含义：构建（同源码+同锁文件+同命令）→ 打包（G3.1 immutable candidate：一次打包、验身份、发布该文件，publish 不跑生命周期脚本）→ 安装 全链无陈旧缓存/分叉。发布工作流无需修复。

## 6. 生产证据（只读）：被观察的 FIFO 轮全部是非用户轮

生产工作区 `D:/.openclaw/workspace`（只读取证，零写入；DB 先复制再查询）：

1. 事件日志（`.state/logs/events_*.jsonl`）：11-09 共 15 轮、11-10 共 3 轮 `runtime_v2_prompt_activations_injected`，全部 `selectionPolicy=legacy_fifo_prefix_v1`、无 `selectionRoundOrdinal`、`eligibleCount=18`（与冻结快照同源候选集）。
2. 轨迹库（`.state/trajectory.db` 副本）：`user_turns` 最后一行 = **2026-11-07T01:07:36Z**（测试会话 gate4-p3）；被审计会话 `8e64912c…` 的 user_turns 停在 **2026-11-02T13:16Z**（57 行），而其 `assistant_turns` 以 **~60±1 分钟**节奏持续到 11-10T02:46Z（共 717 行）。
3. 结论：11-09/10 的注入轮 = 自动化非用户轮（人不会以小时级精确节奏跨午夜连续发轮）；PD 插件对它们不写 `user_turns`（11-02 起该会话零写入为证）并按 P1-3 拒发轮次键 → 诚实回退 `legacy_fifo_prefix_v1`。**3.1.3 安装（11-09 22:53 本地）以来，该工作区尚未发生过任何一次真实用户轮**——fair_rotation 从未获得出现机会，非其失效。
4. 宿主侧交叉核对（已装 2026.11.1 dist，只读）：embedded 路径事件恰为 `{prompt, messages}`（`attempt-prompt-helpers.ts` 编译体）；hookCtx 透传 `run.trigger`（`transcript-policy` 编译体 `buildEmbeddedAgentHookContext`）。行为臂已证明该形态输入下接线工作。

残余未知（不阻断裁决）：自动化轮的具体驱动者未命名（`~/.openclaw/cron/jobs.json` 为 6 月遗留 daily 3am isolated 任务，与 ~60min 节奏不符；该会话不在 `agents/main` 会话库）。

## 7. 修复归属与不做

- **归属：无缺陷**。发布物正确、管线可复现、生产行为符合设计。无修复卡、无发布流程变更。
- PRI-1162 遗留的「发布版本尚待验证」**闭合**：已验证，发布物正确；其仓库侧结论（#2398 接线修复覆盖偏差）不受影响。其调查中「npm bundle stale」表述建议随其 PR #2460 评审更正（本卡 §3 为依据），不另开工单。
- 不动：生产配置/库、`LATEST.json` 与历史检查点、PRI-1162 工作树与其文件、canonical runtime（其 plugin 目录 3.1.1 落后壳 3.1.3 仍为观察项，与本裁决无关）。
- A 线提醒（不变）：本票的轮次序数是调度序数，**不得充当 PRI-1119 请求身份**。

## 8. Owner 决定与最低成本验证动作

**建议决定：无行动项，关闭本票**（PRI-1162 的发布侧疑问已由本卡回答）。

最低成本验证（下一次真实用户轮后，一条命令）：在该工作区跑任一真实用户对话轮，然后
`grep -h selectionPolicy D:/.openclaw/workspace/.state/logs/events_*.jsonl | tail` —— 应出现 `fair_rotation_v1` 且带 `selectionRoundOrdinal`；若仍是 `legacy_fifo_prefix_v1` 且该轮确为真实用户轮，则凭 §4 的 A1–A4 反例立即立案（届时责任位置在 §6.4 所列宿主输入形态与本卡假设的差异处）。

## 9. 证据索引

| 类型 | 位置 |
|---|---|
| 工作树/基线 | `ai/PRI-1163-release-round-key-audit` @ base `4775f3bc5`；tag `v3.1.3` = `e7c7e6bba` |
| npm tarball + 解包 | `.pd-tmp` 任务目录 `task-pri1162-release-audit-104223-769862/artifacts/npm-tarball/`（tarball sha256 `213da943…`；bundle `7301253d…`） |
| 离线行为探针 | 同目录 `probe-bundle-behavior.mjs` + `probe-results.json`（两轮运行；consumer 组装 = 发布物 + 已装扩展的 better-sqlite3 副本） |
| 冻结沙箱（候选源） | PRI-1162 工作树 `.tmp/pri-1162/ws-sandbox/.pd/state.db`（sha256 `830fbd24…`，只读复制使用） |
| 重建 | 同任务目录 `rebuild/tag-src/`（git archive + npm ci + 官方构建序列）+ `rebuild/root-build.log`、`rebuild/plugin-production.log` |
| 生产取证（只读副本） | 同任务目录 `prod-copy/trajectory.db`；原文件 `D:/.openclaw/workspace/.state/{logs,trajectory.db}` |
| 宿主侧（只读） | `AppData/Roaming/npm/node_modules/openclaw@2026.11.1/dist/`（`context-engine-maintenance-*.mjs`、`transcript-policy-*.mjs`、`attempt-system-prompt-prepare-*.mjs`） |
| 源码锚点 | `packages/openclaw-plugin/src/index.ts:475`（注册）；`src/hooks/prompt.ts:415-533`（提供方+P1-3 门槛）；`src/host-runtime/openclaw-host-runtime.ts:143`；`packages/host-runtime/src/index.ts:313-338`；`active-principle-prompt.ts:452,472-478` |
| 检查点 | `docs/implementation-reports/aa-handoff/20261110T0340Z-zcode-pri1163.{json,md}`（随本 PR 入库；`LATEST.json` 未修改） |
