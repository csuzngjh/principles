# PRI-961 实施报告 — Type-aware ESLint OOM：逐包独立进程调度

- 工单：[PRI-961](https://linear.app/principlesdisciple/issue/PRI-961)（P1，Bug）
- 分支：`ai/PRI-961-eslint-oom`（worktree `D:\Code\_worktrees\principles\PRI-961-eslint-oom`，基于 origin/main `f82feeae`)
- 日期：2026-10-13
- 变更文件：`package.json`（lint / lint:fix 两条脚本）、`scripts/lint-by-package.mjs`（新增）、`scripts/__tests__/lint-by-package.test.mjs`（新增）、`.changeset/pri-961-eslint-oom-no-release.md`（新增，no-release）

## 1. 问题与根因

全量 `npm run lint` 在单个 ESLint 进程内以 type-aware 规则（`projectService: true`）扫描全部 `packages/**/*.ts`。跨包的 TypeScript 程序对象在同一进程内累积，Windows + Node 26.7.0（默认 V8 堆限制 4192 MiB）下触发
`FATAL ERROR: Ineffective mark-compacts near heap limit`，Exit 134（原始日志：`%TEMP%\pd957-logs\lint-mem-typeaware.log`，2026-10-13 @ main `b0f807b9`）。

**已证实**：单进程跨包内存累积与 OOM（本轮复测：单进程 8G 堆下 heap 峰值 4659 MB / RSS 峰值 5006 MB，探针轮 4937 MB——超出默认 4192 MiB 上限，即默认堆必然 OOM）。
**未证实（不在本票断言）**："9 个 TypeScript Program 永不卸载"或"内存泄漏"的具体内部机制。

## 2. 修复方案（A：顺序逐包独立进程）

`scripts/lint-by-package.mjs` 只做**调度**，不重新实现 lint：

- 从根 `package.json` 的 `workspaces` 模式动态发现包（当前 `packages/*`），字典序稳定排序；无硬编码包清单，新包自动纳入；无 package.json 的目录（如 `packages/dist`）排除。
- 每包启动一个 ESLint 子进程（`process.execPath` + `node_modules/eslint/bin/eslint.js`，`shell:false`、`stdio:inherit`、`cwd=仓库根`），**严格串行**，前一个退出才启动下一个。
- 每包参数 = `packages/<dir>/**/*.ts` + 原三条 `--ignore-pattern`（test/spec/d.ts）+ `--no-error-on-unmatched-pattern`（全部文件被配置忽略或无 .ts 的包安全跳过，如 `packages/website`）+ 透传参数（`--fix`）。
- `eslint.config.js` 仍是规则/忽略/`projectService`/`tsconfigRootDir: process.cwd()` 的唯一权威，语义零改动。
- 失败语义：任一包失败不中断其余包；汇总命名失败包并以非零退出；spawn 失败、信号杀死、Ctrl-C（杀掉运行中子进程后 130 退出）都不可能误报成功。

`package.json`：`lint` / `lint:fix` 保留原有三个构建前置（core / install-layout / host-runtime），仅将单进程 eslint 调用替换为 `node scripts/lint-by-package.mjs`（`lint:fix` 加 `--fix`）。

## 3. 验证证据（Windows 11，Node v26.7.0，默认堆 4192 MiB，NODE_OPTIONS 未设置）

### V1 红灯复现与修复闭环

- 红灯：工单内置原始 OOM 日志（Exit 134）；本轮旧路径复测 heap 峰值 4659/4937 MB > 默认上限，OOM 路径成立。
- 新版默认堆三连跑：`npm run lint` × 3 → 全部 **exit 0**、`10/10 packages ok`、无 OOM；耗时 68.5s / 67.6s / 66.0s（含三个构建前置）。

### V2 文件覆盖等价（脚本级集合对比，非退出码）

| 轮次 | 旧（单进程，8G 堆基线） | 新（逐包） | 判定 |
| --- | --- | --- | --- |
| 干净基线 | 810 files | 810 files，only-old=0 / only-new=0 | EQUIVALENT |
| 违规探针轮 | 811 files | 811 files，only-old=0 / only-new=0 | EQUIVALENT |

- 忽略规则一致性：`.test.ts` / `.spec.ts` / `.d.ts` 探针文件（内含违规）在新旧两侧文件清单中均为 0 条——忽略行为一致。
- `packages/website`（18 个 .ts 全部被全局 ignores 排除）安全跳过：无 flag 时 ESLint exit 2（`all files ignored`），调度器带 `--no-error-on-unmatched-pattern` 后 ok。
- 新包自动纳入：`discoverPackageRelDirs` 由 workspaces 派生（单元测试覆盖新增包即纳入）；810 快照仅作本轮参考，未硬编码。

### V3 规则结果等价（file|ruleId|severity|line|column|message 多重集）

| 轮次 | 旧 | 新 | 判定 |
| --- | --- | --- | --- |
| 干净基线 | 36 warnings（0 errors） | 36 warnings，missing=0 extra=0 | EQUIVALENT |
| 违规探针轮 | 43 条（6 errors + 37 warnings） | 43 条，missing=0 extra=0 | EQUIVALENT |

探针含**类型感知规则**且两侧同报：`@typescript-eslint/prefer-readonly`、`@typescript-eslint/await-thenable`，另有 `no-unused-vars`×3、`no-explicit-any`、rc-5 `no-restricted-syntax` warning——按包隔离未削弱任何类型感知检查。

### V4 lint:fix 等价

- 新调度器 `--fix`：类型感知可修复规则 `prefer-readonly` 被自动修复（`private` → `private readonly`）；被忽略探针文件零改动；仓库其余部分零改动（`git status` 仅探针自身）；剩余不可修复错误 → exit 1 且 summary 命名 `FAILED: packages/codex-adapter`。
- 旧命令（8G 堆 + `--fix`）对照：修复后探针文件与新版结果**逐字节一致**（sha256 `79af6473…` 两侧相同），退出语义一致（5 errors，exit 1）。

### V5 性能与资源实测（50ms 间隔采样子进程内存，取真峰值；非阶段末 heapUsed）

| 包 | files | heapPeak MB | rssPeak MB | secs |
| --- | --- | --- | --- | --- |
| codex-adapter | 18 | 467 | 610 | 2.9 |
| create-principles-disciple | 38 | 264 | 411 | 1.9 |
| host-runtime | 34 | 514 | 672 | 3.9 |
| install-layout | 1 | 71 | 213 | 1.1 |
| openclaw-plugin | 128 | 1473 | 1678 | 8.9 |
| pd-cli | 96 | 677 | 843 | 5.2 |
| pd-companion | 9 | 164 | 306 | 1.1 |
| pd-console | 98 | **1828** | **2013** | 13.6 |
| principles-core | 388 | 1219 | 1450 | 9.2 |
| website（安全跳过） | 0 | 0 | 0 | 0.4 |
| **合计** | **810** | max=1828 | max=2013 | **50.5** |

- 旧单进程（8G 堆）：heap 峰值 **4659 MB**、RSS 峰值 **5006 MB**、44.0s——跨包累积实锤。
- 新逐包：**任一子进程峰值 1828 MB heap / 2013 MB RSS，约为默认上限 4192 MiB 的 44%**；每包子进程退出即释放，后续包（如 388 文件的 principles-core）不再叠加。总耗时 +6.5s（逐包 ESLint 初始化开销），可接受。
- 测量方法注：heap/rss 为子进程内 50ms 采样峰值（真实峰值，非 heapUsed 端点值）；CLI 生产路径以 `npm run lint` 三连跑验证，测量 harness 用 ESLint API（与 CLI 同 config/cwd，文件数/警告数与 CLI 输出一致：810/36）。

### V6 测试与门禁

- 调度器回归测试 `scripts/__tests__/lint-by-package.test.mjs`：**13/13 绿**。覆盖：包发现（排序/无 package.json 排除/新包自动纳入/POSIX 路径）、参数构造（glob+三条忽略+unmatched flag+`--fix` 透传）、严格串行（无重叠存活）、lint 失败继续并命名、spawn 错误不算成功、信号杀死不算成功、SIGINT 杀子进程并中止且不报成功、ESLint CLI 缺失大声失败、repoRoot 解析。
- `npm run test:scripts` 全量：见 §5 记录。
- `npm run verify:merge`（含新版 `npm run lint`）：见 §5 记录。
- CI：PR 上 Ubuntu + Node 22 lint job 独立验证（本机 Windows 结果不替代 Linux CI）。

## 4. Complexity Delta

| 项 | 值 |
| --- | --- |
| 新持久化 schema/状态 | NO |
| 新子系统/后台进程 | NO（一次性 CLI 调度脚本） |
| 新公共抽象/接口 | NO（模块导出仅服务其自身测试） |
| 新运行时 feature flag | NO |
| 新跨包依赖 | NO |
| 新宿主/平台特有行为 | NO（shell:false + process.execPath + 正斜杠 glob，Windows/Linux 可移植） |
| 新外部/网络能力 | NO |
| 新第三方依赖 | NO |

新增：一个轻量根级调度脚本（约 200 行）+ 其测试。回滚 = 还原 `package.json` 两条脚本 + 删除调度脚本与 changeset，无数据迁移、无持久状态。

## 5. 门禁执行记录

- `npm run test:scripts`：**43 文件 / 736 测试全绿**（含新增 13 项调度器回归测试）。
- `npm run verify:merge`（含新版 `npm run lint`，实现提交 `c31b24d9` 上执行）：**exit 0 全绿**——release-intent / generated-artifacts / error-handbook / telemetry / repo-hygiene / runtime-contract / docs-structure / security-baseline / workspace-tools / guard-contracts / release-target-matrix / 全量构建 / website 测试 / 新版 lint（36 warnings, 0 errors）/ pipeline-contract / pd-cli+pd-console 构建 / workspace-artifacts / release-artifact-hygiene / 全部 typecheck / satellite-bundle-deps / runtime-writers 全部通过。
- `npm run check:error-handbook`（新增 ERR-159 落册后）：OK（119 active patterns / 14 routing cards）。

## 6. 残余风险与后续

- 逐包调度使总 lint 时间 +~15%（44.0s → 50.5s，纯 lint 段；含构建前置的 `npm run lint` 约 66–69s）。若未来包数/体量增长明显，可评估 `--cache` 等增量手段（本票未引入，保持语义最小变更）。
- CI Runner（Ubuntu/Node 22）未做内存插桩；由 lint job 全绿 + 本机等价性证据间接覆盖。若未来 CI 出现 OOM，逐包架构下单包峰值（实测最大 1828 MB）本身就是排查下界。
- 测量 harness（`%TEMP%\pd961-logs\`）为本机调查工件，未入库；`tsc --listFilesOnly` 等交叉复核沿用工单原始证据。
