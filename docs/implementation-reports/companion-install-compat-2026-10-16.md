# PD Companion 安装兼容性故障修复报告（2026-10-16）

任务：修复 PD 更新后桌面版报「未找到已安装的 PD / console_runtime_not_installed」，并消除同类前向不兼容与 Worker 误停风险。

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
| `packages/pd-companion/package.json` | 0.1.2 → 0.1.3 | 交付可区分版本的修复安装包 |
| `.changeset/companion-install-compat-20261016.md` | install-layout minor | 版本火车推进 0.3.1 → 0.4.0 |

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
| 合并门禁 | `npm run verify:merge` | 见 PR 描述（提交前全绿） |

生产清单只读副本回归样本：`packages/pd-companion/tests/fixtures/install-manifest/production-copy-20261016.json`（11 工作区、3 宿主的真实形状；README 注明来源与「不得为过测试而改样本」纪律）。生产清单本身零改动。

## 6. app.asar 捆绑依赖验证

对 `win-unpacked/resources/app.asar`（与 Setup.exe 内一致）解包核验：

- `node_modules/@principles/install-layout/package.json` → version **0.3.1**（当前 workspace 版本；changeset 将在发版火车推进 0.4.0，届时 CI 产物会随动）
- `dist/index.js` 含 `installManifestHostsForPersist` / `unknownHosts` / `install_manifest_unknown_host` / 三宿主 `INSTALL_HOSTS` ✓
- `dist/lib/workspace-workers.js` 含 `syncFromManifest` / 阈值常量 ✓；`dist/main/main.js` 含显式 unavailable 状态 / 持续告警通知 / 托盘投影 / `pd_runtime_unusable` ✓；`dist/lib/degraded.js` 含 `install_manifest_incompatible` + companion-v 入口 ✓
- verify-package 从提取产物实跑兼容矩阵全 ✓（这是 CI 将强制执行的同一道门）

## 7. Windows 安装包

- 路径：`D:\Code\_worktrees\principles\adhoc-20261016-companion-install-compat\packages\pd-companion\release\pd-companion-0.1.3-setup.exe`
- SHA256：`850c79835d7d5e830fdfc49b2605fb372cea7880d52177e27f6f126fede3cadd`
- app.asar SHA256：`3a46ed46c9ebc22d1b36a264aed33b3d211b8b9d76695a0eb65c122964fbd07f`
- 应用版本 0.1.3；捆绑 install-layout 0.3.1；构建来源 commit：分支 `ai/adhoc-20261016-companion-install-compat`（基点 origin/main f7d47ae0f；提交 273d20e08 / 4423545f2 / b69b7bef，产物对应 head）
- asar 关键标记核验：16/17 PASS；唯一未命中项 `InstalledRuntimeOutcome` 为 TS 接口名（编译期擦除），运行时标记 `missing` 命中，非缺口

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

1. 运行 `pd-companion-0.1.3-setup.exe`（官方 NSIS 安装器，覆盖安装即可，无需卸载；不需要重装 PD 运行时）。
2. 打开 PD Companion：窗口应进入控制台而非「未找到已安装的 PD」；托盘菜单出现「控制台运行中（端口 xxxx）」；Companion 日志（`%APPDATA%/pd-companion/logs/companion-main.log`）应出现 `console_started` 且不再有 `pd_not_installed`。
3. 之后 Worker 恢复由既有 sync 周期自动完成（无需任何手工干预）。
