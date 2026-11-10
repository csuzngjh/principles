# PRI-1163 发布包轮次接线核查报告 — 3.1.3 仍走 FIFO 的证据化归因（2026-11-10）

裁决：**发布包有接线（三分支之第二分支）——无缺陷、无需修复。** 生产恒 FIFO 的实际原因是：3.1.3 安装（2026-11-09 22:53 本地）以来观测到的全部注入轮均为 OpenClaw 心跳轮（非用户轮），按 #2398 设计**记录不了轮次、回退 `legacy_fifo_prefix_v1`**。PRI-1162 实施卡 §3 的「疑似发布物与源码不一致」**经三重哈希与行为对照证伪，正式撤销**。

结论分层（沿用 PRI-1162 验收说明 4 的口径）：

- **发布版本已验证**：发布物 = tag 源码构建（逐字节一致），发布物内接线存在且功能正常（离线夹具 6/6）。
- **生产用户轮轮转尚待观察**：3.1.3 安装后至今无任何真实用户轮发生（`user_turns` 全库最后一行 2026-11-07；被观测会话 `8e64912c` 最后真实用户轮 2026-11-02）。仓库侧轮转已由 PR #2460 验证，不受本结论影响。

---

## 1. 三份对照物（全部闭环）

### A. npm `principles-disciple@3.1.3`

| 事实 | 值 |
| --- | --- |
| registry integrity（SRI） | `sha512-VqLoENc1gSkqGfGJAxGR5qnYPY2yR2GzUDRwtbnnSF70vCK6p+3lYg/6TssdagCbwisl2k6YmEckAwExXK/a9g==`（本次新下载 tarball 逐字节复算 MATCH） |
| registry shasum（sha1） | `3461c20c8b0980a533185d368f6eba7f529c76cb`（MATCH） |
| 声明运行入口 | `package.json` `openclaw.extensions = ["./dist/bundle.js"]`（唯一项；`setupEntry` 同） |
| 入口哈希 | `dist/bundle.js` sha256 `7301253d09d3c4a900bc3a44b4b3430b835b71d47161e6fdc94d8ff725f6546d` |
| 发布基线 | 包内 `gitHead: e7c7e6bba35aa7d691496cf126b195ea3a70fef9` = tag `v3.1.3` |
| 发布溯源 | `publish-npm.yml` run `42639299312`，headSha `e7c7e6bba`，success，2026-11-09T14:54:45Z（与本机安装 mtime 22:53 +0800 同分钟，自动更新紧随发布） |

### B. 本机安装（只读核对）

| 事实 | 值 |
| --- | --- |
| 安装入口 | `~/.openclaw/extensions/principles-disciple/dist/bundle.js` |
| 入口哈希 | sha256 `7301253d…6546d` — **与 npm 发布包逐字节一致** |
| 插件清单 | `openclaw.plugin.json`（root 与 dist 副本 sha256 `3035935a…` 一致，npm 包同值）；无独立入口声明，宿主经 `openclaw.extensions` 加载 bundle |
| 版本 | principles-disciple `3.1.3`；宿主 OpenClaw `2026.11.1 (4ffdd20)`（与本次只读核对的宿主源码 tag 一致） |
| 实际加载依赖 | bundle 外部依赖仅 `better-sqlite3`（扩展自带 `node_modules/better-sqlite3@13.0.3` native）+ Node 内建模块；`@principles/host-runtime` 的消费半**已内联进 bundle**（`roundKeyProvider`×3、`fair_rotation_v1`×2、`legacy_fifo_prefix_v1`×3、`selectionRoundOrdinal`×3、`user_turn_persisted`、`round key resolved` 字面量全部在场——发布走 `esbuild --production`（`minify:true`），函数名被改写，按函数名搜索必然 0 命中） |

### C. 发布基线隔离重建（确定性复现，非参考对照）

- 基线：tag `v3.1.3` = `e7c7e6bba`（发布输入已确认：包内 gitHead + 同 SHA 的 publish run success）。
- 命令（隔离目录）：`git archive e7c7e6bba | tar -x` → `npm ci`（tag 的 package-lock）→ `npm run build --workspace=@principles/core` → `install-layout` → `host-runtime` → `cd packages/openclaw-plugin && npm pack`（prepack = `build:production` = `node esbuild.config.js --production && node scripts/verify-build.mjs`，再加 `build:types`；与发布管线同一 prepack）。
- 结果：重建 `dist/bundle.js` sha256 `7301253d…6546d` — **与发布包、安装包逐字节一致**（esbuild 同输入确定性输出）。
- 环境注意（复现坑）：本机 npm 新版默认拦截 install-scripts，需 `npm rebuild esbuild` 后再 pack；workspace 依赖包（core/install-layout/host-runtime）须先 build，否则 esbuild 无法解析 `@principles/host-runtime/*` 子路径。

---

## 2. 离线行为对照（假宿主夹具，加载发布 bundle，6/6 PASS，退出码 0）

夹具：临时工作区 + 冻结候选集快照（state.db sha256 `830fbd24…`，18 条候选，与 #2460 比较同源）+ 最小假宿主 api（捕获 `before_prompt_build`）；进程内 `PD_WORKSPACE_DIR` 钉到临时区（见 §5 事故与隔离修复）。断言面 = 生产同一可观察物（`runtime_v2_prompt_activations_injected` 事件 payload + `user_turns` 行 + provider 日志行）。

| 臂 | 结果 | 证据 |
| --- | --- | --- |
| A1 连续用户轮 | **PASS** | `fair_rotation_v1`，ord `3→4`，rotationStartIndex `3→4`，选中集轮换（两轮不同） |
| A2 同轮重试（同 runId） | **PASS** | `round key replayed: round=4`；policy/ord/选中集/字符数逐项一致，装配上下文逐字节相等，`user_turns` 单次写入 |
| A3 心跳轮（trigger=heartbeat） | **PASS** | `non-interactive trigger (heartbeat) records no round → legacy_fifo_prefix_v1`，ord=undefined，**零写入** |
| A4 trigger 缺省 | **PASS** | 视作用户交互（ord=5）——与 `isUserInteractionTrigger` 契约一致（user/api/undefined 均为用户交互） |

**正例判别力**：A1/A2（轮转+重试）与 A3（FIFO 回退）在**同一发布 bundle** 上分流，证明「接线存在且功能正常」可被行为区分，不依赖符号名。

---

## 3. 生产只读证据（归因闭环）

1. 3.1.3 安装（11-09 14:53Z）以来的全部注入事件（11-09 15:11Z 起 4 条）**全部** `legacy_fifo_prefix_v1` + `selectionRoundOrdinal=undefined`，同一会话 `8e64912c-…`，每小时 ~:45 一条。
2. `~/.openclaw/openclaw.json`：`heartbeat.every = "1h"` → 每小时轮为 OpenClaw 心跳；宿主源码 v2026.11.1 `src/agents/embedded-agent-runner/run/attempt-prompt-helpers.ts` 明证：心跳运行的 `hookCtx.trigger === "heartbeat"`。
3. 生产 `user_turns`（`.state/trajectory.db`，WAL 副本只读查询）：3.1.3 安装以来**零新增**；`8e64912c` 最后真实用户轮 2026-11-02T13:16Z。心跳轮被正确跳过写入——与夹具 A3 行为逐字一致。
4. **历史对照（旧实现缺陷的直接物证）**：11-03 同一心跳会话的注入事件为 `fair_rotation_v1` + **恒 `ord=72`**（`selectionRoundSource=session_user_turn_ordinal`），选择恒定（n=9、chars=1953 不变）——不写 turn 却读到 `MAX+1` 常数键的伪轮转。这正是 `prepareOpenClawPromptRound` doc comment 明言修复的缺陷（"a heartbeat could re-present the last window as a fresh fair rotation"），#2398 落地的 trigger 分类 + 「写入后才读序数」契约把它消灭。
5. A 线身份（PRI-1119）与调度序数正交：夹具事件只含 `{prompt, messages}`（embedded 路径无显式身份），轮转照常工作——轮次键不依赖 A 线的当前用户消息身份。

---

## 4. 裁决与最小修复方案

- **发布包有接线**（哈希三重一致 + 行为正例）→ 三分支之第二分支：定位实际触发条件 = **观测到的轮全部是非用户轮（心跳）**；回退原因可复现（夹具 A3 与生产观测逐字一致）；**应修的入口：没有——无缺陷，无需修复**。
- 可选（非本票、需 Owner 另行立项）：若 Owner 希望心跳/定时轮也参与轮转公平，属 PRI-930（跨宿主/跨 Session 公平时钟）的设计问题，不是缺陷修复。
- 最低成本补证（生产用户轮轮转终验）：在已装环境产生一条真实用户消息后，读 `D:\.openclaw\workspace\.state\logs\events_*.jsonl` 最新 `runtime_v2_prompt_activations_injected`，期待 `selectionPolicy=fair_rotation_v1` 且 `selectionRoundOrdinal` 较前一轮推进。（本票边界禁宿主启动，无法代做。）

---

## 5. 边界与事故披露

- 宿主启动 0、模型调用 0、安装 0、发布 0；生产工作区只读（trajectory/events 均走副本或只读 grep）。
- **事故（已披露）→ 清理终态（Owner 批准后执行）**：夹具首次运行（11-10 03:35Z 前后）发生非预期生产写入：插件把显式声明工作区（`~/.openclaw/principles-disciple.json` → `D:\.openclaw\workspace`）**优先于** hook ctx 的临时 workspaceDir，2 轮夹具轮次把 3 行合成 `user_turns` 写入生产 trajectory.db。事件日志**零污染**（缓冲未及落盘进程即退出）。影响评估：`user_turns` 按 session 隔离，合成会话永不复用，对真实会话与轮次序数**零影响**；仅构成治理数据噪声（1213→1216 行）。隔离修复：进程内 `PD_WORKSPACE_DIR` 钉到临时区后重跑，复核生产零新增。
  - **批准引用**：Owner 于 2026-11-10 ~04:07Z 在本会话内以结构化选项批准「批准，现在清理」（AskUserQuestion 回答，附「保留待审」处置 PR #2468）。
  - **执行**（04:12Z 前后，`DELETE FROM user_turns WHERE id IN (1215,1216,1217)`，事务内 `changes=3` 恰好 3 行）：删除前在该连接复核 3 行内容逐项吻合；删除后总数 1216→**1213**、合成会话残留 0；独立只读连接二次复核一致。范围核验同时确认无外键引用 `user_turns`、correction_samples/pain_events/signal_confirmations/task_outcomes/principle_events 零污染。
  - **精确范围（3 行全部内容）**：id 1215 / `fixture-sess-0001` / turn_index 2 / 03:35:12.377Z / "round one: please check the boundary cases"；id 1216 / `fixture-sess-0001` / turn_index 3 / 03:35:12.627Z / "round two: now extend the boundary matrix"；id 1217 / `dbg-sess` / turn_index 2 / 03:35:41.153Z / "hello world one"。
  - **备份与基线（含一处证据事故的诚实更正）**：此前 PR 评论所称「删除前全量备份 `pre-delete-backup.db` 留档」**不成立**——备份 cp 命令被 Mimosa 拦截未执行，同名文件是 check 脚本读写打开误建的 0 字节空库，已删除并在此更正。实际有效保护：①删前快照 `.tmp/pri-1163/prod-evidence/pre-delete-snapshot-20261110T0344Z.db`（03:44Z 取，42,373,120 字节，sha256 `8ca0b80846db67906604b6007d89aca2a7f79b7bfb4af61013fc7d2b02921c95`，total=1216、含全部 3 行）；②上述逐行内容完整留档；③前序会话证据目录 `D:/Code/.pd-tmp/principles/20261110/task-pri1162-release-audit-104223-769862/prod-copy/trajectory.db`（02:58Z，total=1213、零合成行）证明事故前基线=1213。闭环链：基线 1213 + 事故 3 = 删前 1216 − 删除 3 = 删后 1213，与基线精确一致。含生产数据的副本一律留在 gitignored 的 `.tmp/`，**永不入库**；入库证据仅限哈希、行数与合成行内容。

---

## 6. 对既有材料的更正

- PRI-1162 实施卡 §3 / PR #2460「疑似发布物与源码不一致」：**证伪撤销**。根因是调查方法缺陷（对 `minify:true` 的产物按函数名搜索）。#2460 的源码侧验收结论与冻结证据不受影响、继续有效。
- PRI-1139 记忆中「已安装 3.1.3 恒 FIFO 属疑似发布物不一致」同此更正。

## 7. 双会话交叉验证（过程披露）

本票在 2026-11-10 上午存在两个重叠执行窗：前序 zcode 会话（任务目录 `task-pri1162-release-audit-104223`，10:42 起）在停滞约 25 分钟后于 11:21-11:24 恢复并完成其三臂审计（提交 `7eef2fc8a`，检查点 `20261110T0321Z-zcode-pri1163`，零生产写入）；本会话（11:10 起接管判定持有进程死亡的工作树）独立完成同一审计（提交 `e69b187cc`，检查点 `20261110T0350Z`）。两审计**独立得出同一裁决**（发布物=tag 构建逐字节一致；接线在场且行为正常；生产 FIFO = 非用户轮设计内回退；PRI-1162 嫌疑证伪），互为交叉验证。互补增量：本会话补 SRI/publish-run 溯源、夹具事件 payload 级断言、11-03 恒 `ord=72` 历史物证与 §5 事故披露；前序会话补官方构建序列出处（`release-reproducibility-full.yml:58-59`）、assistant_turns 小时级节奏与宿主 dist 只读交叉核对。两份报告随本 PR 一并入库；生产写入事故（§5）归本会话，前序会话零写入。
