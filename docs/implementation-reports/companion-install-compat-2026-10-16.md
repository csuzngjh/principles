# PD Companion 安装兼容性故障修复报告（2026-10-16）

任务：修复 PD 更新后桌面版报「未找到已安装的 PD / console_runtime_not_installed」，并消除同类前向不兼容与 Worker 误停风险。

> **RF 收口更新（同日第二轮，评审裁决后）**：本报告 §R 记录 RF-01～RF-05 的修复与验证；§7 的产物身份以 **RF 收口后重建的 0.1.2 版验证产物为准**（早前 0.1.3 预发布产物已被取代，保留 SHA 供追溯）。

- 分支：`ai/adhoc-20261016-companion-install-compat`（基于 origin/main f7d47ae0f）
- Fix B 独立工单：PRI-990（https://linear.app/principlesdisciple/issue/PRI-990 ）
- 产物：`pd-companion-0.1.3-setup.exe`（SHA256 见 §7）

## 1. 根因最终裁决（独立复核，全部实锤于已发布产物）

对安装版 `D:\Program Files\PD Companion\resources\app.asar`（0.1.2）解包核验：

1. 捆绑依赖为 `@principles/install-layout` **0.1.0**（`node_modules/@principles/install-layout/package.json`），其 `INSTALL_HOSTS = ['codex', 'openclaw']`（dist/index.js:4）。
2. 生产 `~/.pd/install.json`（只读核验）：`layoutVersion: 1`、`mode: canonical`、`hosts: ["openclaw","codex","workbuddy"]`。
3. 0.1.0 解析器对 hosts 做 `every(isHost)` 全量白名单校验（dist/index.js:50），含 `workbuddy` → 返回 `install_manifest_malformed: hosts must contain codex and/or openclaw`。
4. `resolveInstallLayout()`：`parsed.manifest` 为空 → 即使 `canonicalRuntimeExists=true` 也跳过 canonical 分支（dist/index.js:84）→ 落 legacy（本机存在 `~/.openclaw/extensions/principles-disciple`）。
5. legacy 模式下 `resolvePdCliEntry` 指向 `<扩展目录>/pd-cli/dist/index.js`，该文件不存在（AGENTS §1.1：扩展目录 core 为符号链接，无 pd-cli）→ Companion 报 `console_runtime_not_installed`。这就是 Owner 看到的报错。
6. 同一解析失败使捆绑版 `manifestCodexWorkspaces()` 返回 `[]`（asar dist/main/main.js:252），60 秒一次 `sync([])` 把在运行 Worker 记为 `removed_from_manifest` 全部停止——生产出现 9 条误停记录。
7. 时间线核验：故障自 WorkBuddy 安装（2026-10-15 20:47 左右写入 3 宿主清单）即触发，与「PD 2.3.5 更新（23:11）」无因果——任务书判断属实。

结论：**不是 PD 运行时损坏，是桌面端捆绑的旧解析器不认识新宿主**。运行时与清单始终健康。

## 2. 实际修改与原因

| 文件 | 修改 | 原因 |
| --- | --- | --- |
| `packages/install-layout/src/index.ts` | 未知宿主字符串 → `manifest.unknownHosts` + `install_manifest_unknown_host` 结构化告警，不再判 malformed；新增 `installManifestHostsForPersist()`；解析器幂等重读自己的输出；layoutVersion/结构损坏/非法路径保持 fail-closed | 修复 A 核心：未知宿主 ≠ 清单损坏 |
| `packages/create-principles-disciple/src/installer.ts` | `mergeInstallManifestHosts`/`writeInstallManifest` 经 `installManifestHostsForPersist` 写回，未知宿主注册不丢 | 要求 A5：写回不得过滤掉未知宿主（顺带修复：旧代码在含未知宿主清单上重装会直接抛错拒装） |
| `packages/create-principles-disciple/src/installers/workbuddy-host-installer.ts` | 同上，`mergeWorkbuddyIntoInstallManifest` 保未知宿主 | 同上 |
| `packages/create-principles-disciple/src/uninstaller.ts` | 卸载已知宿主时未知宿主注册保留；仅当已知+未知全部清空才移除共享运行时 | 保守卸载：未知宿主可能仍在使用共享运行时 |
| `packages/pd-companion/src/lib/workspace-workers.ts` | 新增 `WorkspaceManifestSource` 显式状态 + `syncFromManifest()`：不可读→保留全部 Worker + `workspace_worker_sync_skipped` 结构化日志；连续 10 次（≈10 分钟）→ 一次性 `workspace_worker_sync_unavailable_persistent` 升级事件；`syncUnavailable()` 纯读查询 | 修复 B（PRI-990）：不可读清单不是撤销授权的证据 |
| `packages/pd-companion/src/main/main.ts` | `readManifestWorkspacesForHost()` 返回显式 ok/unavailable；两个 registry 走 `syncFromManifest`；持续不可读 → 系统通知 + 托盘投影；`startSupervision` 按原因分流（`install_manifest_unsupported_version*` → 新降级键 `install_manifest_incompatible`；legacy 兜底原因透传，不再一律 `console_runtime_not_installed`）；未知宿主告警结构化去重日志 | 修复 B 装配 + 修复 A 消费侧（要求 A7：三类故障分别报告） |
| `packages/pd-companion/src/lib/supervisor.ts` | 新增降级键 `install_manifest_incompatible` + 原因映射 | 清单版本高于读取器 →「更新桌面端」而非「PD 未安装」 |
| `packages/pd-companion/src/lib/degraded.ts` | 新键文案（含 companion-v* 下载入口）；`buildSyncUnavailableTrayView`/`describeWorkspaceSyncUnavailable` | 要求 C7：不兼容提醒 + 升级入口；修复 B 的 Owner 可见面 |
| `packages/pd-companion/src/lib/locate.ts` | `resolveInstalledRuntime` 返回 `{runtime?, missing?, warnings?}`，missing 携带结构化原因 | 区分「不认识宿主」「清单损坏」「运行时缺失」三种原因 |
| `packages/pd-companion/scripts/verify-package.mjs` + `scripts/bundled-parser-compat.mjs` | 打包产物验证扩展：从 app.asar 提取捆绑解析器跑 6 行跨版本兼容矩阵；记录应用版本与捆绑 install-layout 版本 | 修复 C：验证产物而非仓库源码 |
| `.github/workflows/companion-release.yml` | 打包前跑包级测试；verify 步骤升级为「运行时依赖 + 清单跨版本兼容」门 | 修复 C CI 防线：禁止发布仍含旧校验器的 Companion |
| `packages/pd-companion/package.json` | 0.1.2（保持不变——N-version 门禁止普通 PR 改版本字段；0.1.3 由 changeset 在伴随流程/发版准备中推进） | 本地交付的 0.1.3 安装包为分支预发布产物，SHA 见 §7 |
| `.changeset/companion-install-compat-20261016.md` | install-layout minor + create-principles-disciple patch（私有 pd-companion 不可入 changeset，仅正文注记） | 版本火车推进 0.3.1 → 0.4.0；installer 写回修复声明发布意图 |

明确不做：未引入 `minReaderVersion` 协议（现有 `layoutVersion` + 未知宿主容忍已覆盖实际变更类）；未实现自动更新（降级页提供明确的 companion-v* 下载入口即可）。

## 3. 修复前后行为对比

| 场景 | 修复前（0.1.2 实测） | 修复后 |
| --- | --- | --- |
| 3 宿主清单（生产现状） | `install_manifest_malformed` → legacy 兜底 → `console_runtime_not_installed`；Worker 全停 | canonical 正常加载；无告警；Worker 正常 |
| 未来第 4 宿主 | 同上整砖 | 已知宿主照常工作 + `install_manifest_unknown_host` 告警 |
| `layoutVersion` 不兼容 | 报「PD 未安装」（错误归因） | 降级页「安装清单与 Companion 版本不兼容」+ 更新入口 |
| 清单损坏/字段非法 | 与「清单声明零工作区」不可区分，Worker 被清空 | fail-closed + 结构化 unavailable 状态，Worker 保持 |
| 清单临时读取失败 | `sync([])` 误停全部 Worker | Worker 保持 + 结构化日志 + 10 次后一次性升级通知 |
| 有效清单删除工作区 | 停止对应 Worker | 不变（显式撤销仍立即生效） |
| 有效空清单 | 同步为空 | 不变 |
| 清单恢复可读 | ——（已误停） | 下一次 sync 自动对齐 |

## 4. Worker 误停风险是否真正消除

**已消除，且有负控证明。** `workspace-workers-manifest-failure.test.ts` 以 2026-10-16 事故形状（好读 → 解析失败 → 好读）断言：零 `workspace_worker_stopped`、零重启、状态保持、恢复即对齐；并以模拟的 0.1.0 旧解析器为负控（该负控对修复前状态必然失败）。保守边界也如实披露：若清单永久不可读，Worker 会持续运行并每 10 分钟升级告警（执行正确性由 Runtime V2 任务租约与 Owner 审批权兜底，Companion 只拥有进程生命周期）——这优于基于「无证据」的停机。

## 5. 测试执行与结果（全部实跑）

| 套件 | 命令 | 结果 |
| --- | --- | --- |
| install-layout | `npx vitest run`（packages/install-layout） | 17/17 通过 |
| pd-companion | `npx vitest run`（packages/pd-companion） | 148/148 通过（含新回归 8 例 + 跨版本 6 例 + Junction 平台测试） |
| create-principles-disciple（相关面） | `npx vitest run workbuddy-host-installer uninstaller-runtime install-manifest` | 46/46 通过 |
| pd-cli（消费方） | 构建 + `npx vitest run` | 1943 通过 / 0 失败（未构建 dist 时 83 失败为环境性，构建后消失，已按 EP-10 要求留证） |
| host-runtime（消费方） | `npx vitest run` | 479/479 通过 |
| 产物门 | `npm run verify-package`（对真实 app.asar） | 通过：3 宿主解析/canonical 优先/未知 4 宿主告警/写回保全/v2 拒绝/损坏拒绝 六行全 ✓ |
| 合并门禁 | `npm run verify:merge` | **PASS（exit 0）**——历经 4 次修正后全绿：①installer 包需显式 changeset（N-3）；②普通 PR 不得改 version 字段（N-version，已撤销手动 bump 改走 changeset/发版准备）；③changeset 不得混入 changesets 忽略的私有包；④我的临时日志须进 `.tmp/`（repo-hygiene） |

生产清单只读副本回归样本：`packages/pd-companion/tests/fixtures/install-manifest/production-copy-20261016.json`（11 工作区、3 宿主的真实形状；README 注明来源与「不得为过测试而改样本」纪律）。生产清单本身零改动。

## 6. app.asar 捆绑依赖验证

对 `win-unpacked/resources/app.asar`（与 Setup.exe 内一致）解包核验：

- `node_modules/@principles/install-layout/package.json` → version **0.3.1**（当前 workspace 版本；changeset 将在发版火车推进 0.4.0，届时 CI 产物会随动）
- `dist/index.js` 含 `installManifestHostsForPersist` / `unknownHosts` / `install_manifest_unknown_host` / 三宿主 `INSTALL_HOSTS` ✓
- `dist/lib/workspace-workers.js` 含 `syncFromManifest` / 阈值常量 ✓；`dist/main/main.js` 含显式 unavailable 状态 / 持续告警通知 / 托盘投影 / `pd_runtime_unusable` ✓；`dist/lib/degraded.js` 含 `install_manifest_incompatible` + companion-v 入口 ✓
- verify-package 从提取产物实跑兼容矩阵全 ✓（这是 CI 将强制执行的同一道门）

## 7. Windows 安装包

### 7.1 RF 收口后验证产物（当前有效）

- 路径：`D:\Code\_worktrees\principles\adhoc-20261016-companion-install-compat\packages\pd-companion\release\pd-companion-0.1.2-setup.exe`
- SHA256：`3db30beefb820ac9cd5f305f57183407078d47415c2b4e5ad3a914436d8949a2`
- app.asar SHA256：`3d6e77ab6983370e31740b95ce6e6e872584925c2aee9a618c1400332dc15ac3`
- 应用版本 0.1.2（=仓库 package.json；版本一致性守卫实测 repo↔asar 一致）；捆绑 install-layout 0.3.1；包含全部 A/B/C + RF-01/RF-04 修复代码（asar 标记核验 4/4 PASS + 兼容矩阵 6/6）。
- 正式 0.1.3 安装包由 CI tag 流程产出，须通过新的版本一致性守卫（RF-03）。

### 7.2 已被取代的历史产物（仅追溯）

- `pd-companion-0.1.3-setup.exe`，SHA256 `850c79835d7d5e830fdfc49b2605fb372cea7880d52177e27f6f126fede3cadd`（asar `3a46ed46…f07f`）——第一轮交付物，**不含 RF-01/RF-04 修复**，不应再用于安装验证。
- 构建来源：分支 `ai/adhoc-20261016-companion-install-compat`（基点 origin/main f7d47ae0f）；首轮提交 273d20e08 / 4423545f2 / b69b7bef，RF 收口提交见 §R。

## 8. 验收状态（诚实分级）

| 层级 | 状态 |
| --- | --- |
| 源码修复 | **完成**（套件全绿 + 负控回归） |
| 安装包修复 | **BUILD_READY**（产物构建 + asar 代码级验证 + 产物级兼容矩阵通过） |
| 真实桌面环境恢复 | **NOT_RUN** —— 按边界约束未覆盖生产已安装的 Companion（不允许直接改 app.asar；未授权不自动执行覆盖生产应用的安装）。Owner 执行 §10 两步后即为 RUNTIME_VERIFIED |

## 9. 已完成 / 未完成

已完成：根因独立复核（产物级）、修复 A/B/C、全套测试矩阵、CI 防线、0.1.3 安装包、PRI-990 独立工单、changeset。

未完成 / 边界内不做：真实安装验收（Owner 动作）；install-layout 0.4.0 版本推进（发版火车）；未扩展 `create-principles-disciple` 的 release-locks 再生（main 上该锁本就滞后于包版本，属发版流程）。

## 10. Owner 最少操作

1. 运行 §7.1 的验证产物（官方 NSIS 安装器，覆盖安装即可，无需卸载；不需要重装 PD 运行时）。
2. 打开 PD Companion：窗口应进入控制台而非「未找到已安装的 PD」；托盘菜单出现「控制台运行中（端口 xxxx）」；Companion 日志（`%APPDATA%/pd-companion/logs/companion-main.log`）应出现 `console_started` 且不再有 `pd_not_installed`。
3. 之后 Worker 恢复由既有 sync 周期自动完成（无需任何手工干预）。

---

## R. RF 收口（2026-10-16 第二轮，评审裁决后）

### R.1 RF-01 — 不兼容清单绕过 fail-closed：FIXED_VERIFIED

- 修复：`resolveInstallLayout()` 新守卫——canonical 运行时存在 + 清单**已读到但不可解析**（版本不兼容或结构损坏）→ 整体拒绝（mode missing + 结构化原因），不再经 legacy 兜底启动不匹配协议的运行时；无清单文件（真 legacy-only）与 canonical 缺失的兜底路径原样保留。
- 红灯先行：install-layout 2 例先红后绿；端到端链路测试锁定 locate 拒绝 → supervisor 映射 `install_manifest_incompatible` → 降级页含 companion-v 升级入口（startSupervision 在 extDir 未解析时于任何 spawn 之前返回——由链路测试 + coexistence 特征化共同锁定）。
- 测试：install-layout 21/21、pd-companion 149→151（RF-01 链路 + RF-04）。

### R.2 RF-02 — installer 未知宿主写回契约：FIXED_VERIFIED（代码层）+ PUBLISH_BLOCKED（发布层，如实标注）

- registry 复核：`@principles/install-layout` 正式最新 = **0.3.1**（无 `installManifestHostsForPersist`）；workspace = 0.3.1 + 本地新导出（未发布）。npm installer 的前向兼容能力在 0.4.0 发布前**不具备写穿能力**，如实标注 PUBLISH_BLOCKED。
- 新增**双模 registry-parity 测试**（打包安装冒烟套件，对真实 registry 解析的依赖运行，非 workspace 符号链接）：
  - 负控（当前 0.3.x）：codex 合并对未知宿主清单**大声拒绝**（`install_manifest_malformed`，注册零丢失）；workbuddy 合并 `ok:false` 硬停**零修改**（文件字节不变）；卸载已知宿主时共享运行时保留；layoutVersion 2 危险写回两模式均拒绝。
  - 正控（0.4.0 发布后自动翻转）：未知宿主在 codex/workbuddy 安装与已知宿主卸载后全部保留；全部合法宿主卸载后按原规则允许清理。
- 本地正控预验（workspace 树等价探针）：5/5 PASS；负控分支由 CI 真实 registry 解析触发。
- changeset 注明：发布阻断状态、twin 退役条件、parity 测试自动翻转行为。

### R.3 RF-03 — 版本与 Tag 一致性：FIXED_VERIFIED（CI 守卫落地）

- 新增发布版本一致性守卫（脚本 + 7 测试）：`companion-vX.Y.Z` tag ↔ 仓库 package.json ↔ **app.asar 内嵌版本**三方强制一致，不一致 fail loudly 于任何上传/发布之前；`workflow_dispatch`（无 tag）强制 repo↔asar 一致且明确为手动测试产物（GitHub Release 步骤本就只在 companion-v* tag 触发）。
- 发版前置条件机械化：把 0.1.3 版本字段变更放在 tag 之前的 release-prep 变更中，tag 打错提交会被 CI 拒绝——不依赖人工记忆。
- 实战验证：新产物上 `check:release-version` 实跑 PASS（0.1.2 = 0.1.2）。

### R.4 RF-04 — Manifest 恢复后托盘未刷新：FIXED_VERIFIED

- `unavailable → ok` 转换发射一次性 `workspace_worker_sync_recovered`（携带 previousReason/unavailableReads，幂等：同周期只发一次）；Companion 两个 registry 均接事件立即重建托盘/tooltip（纯显示刷新，零 worker 重启）；再次故障建立新周期，阈值后可再次升级。
- 全生命周期测试：正常→持续失败→Owner 告警→恢复（事件一次、托盘投影清空、worker 无重启）→再次失败→二次升级。pd-companion 158/158。

### R.5 RF-05 — statSync 不确定状态误停：FOLLOW_UP（独立工单 PRI-993）

- 独立工单：https://linear.app/principlesdisciple/issue/PRI-993 （含最小复现、源码定位、三个候选修复方向、五条验收条件）。
- 本 PR 不扩大范围（评审明示不顺带重构 Worker Registry）。生产风险如实披露：stat 瞬时失败可致误停，路径恢复后自动重启（消耗重启预算）；PRI-990 的「清单不可读整体保持」不覆盖单条 stat 失败。

### R.6 RF 收口验证

- install-layout 21/21；pd-companion 158/158；installer 相关面 59/59；host-runtime 479/479；lint 11/11；`verify:merge` exit 0（RF 头）。
- 产物：§7.1（兼容矩阵 6/6、版本一致性 PASS、RF 标记 4/4）。
- PR CI：见 PR #2047 最新 runs（RF 收口 head）。

