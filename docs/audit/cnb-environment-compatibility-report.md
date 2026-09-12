# CNB 环境兼容性报告（Phase 0）

> 状态：调查完成，供 Owner 评审
> 范围：`csuzngjh/principles` @ `492865e2`（CNB Cloud Agent Worker 立项前的仓库现实核查）
> 方法：以当前仓库真实产物为准（AGENTS.md P1 证据优先 / §3.2 Implementation Truth）
> 相关：[CNB 能力验证报告](./cnb-capability-validation-report.md)

---

## 0. 结论摘要

| 项 | 结论 |
|---|---|
| CNB 能否承载 PD 的只读分析型 Worker | **可以**，但需先把仓库镜像到 cnb.cool（见 §5.1） |
| 是否需要在 PD 核心代码上做任何改动 | **不需要**。零 `packages/**` 改动即可满足 |
| 是否存在阻塞级不兼容 | **无阻塞**。存在 3 项需要 Owner 决策/执行的前置条件（§5.4） |
| 任务书假设与仓库现实的冲突 | **2 处**（pnpm、`.ide/` 与 CNB 的关系），见 §4.1 |

---

## 1. 当前技术栈

| 维度 | 事实 | 证据 |
|---|---|---|
| 仓库形态 | npm workspaces 单仓多包（`packages/*`） | `package.json:7-9` |
| 包管理器 | **npm**（`workspaces` 字段 + `package-lock.json` 620 KB） | `package.json:7-9`；仓库根存在 `package-lock.json` |
| 语言 | TypeScript（源码）；脚本层混用 ESM `.mjs` / CJS `.cjs` | `package.json:6` `"type": "module"` |
| Node 版本约束 | `>=22.0.0` | `packages/create-principles-disciple/package.json:68-70` |
| 版本钉定文件 | **不存在** `.nvmrc` / `.node-version` / `.tool-versions` | 三者均 ABSENT |
| 包数量 | 11 个目录（`packages/`） | `packages/` 目录列表 |
| 原生模块 | `better-sqlite3@^13.0.3`（5 个包依赖） | `packages/{host-runtime,pd-cli,pd-console,principles-core,openclaw-plugin}/package.json` |
| Git LFS | 是。`*.mp4` / `*.webm` / `*.webp` 走 LFS | `.gitattributes:46-50` |
| 测试框架 | vitest ^5 | `package.json:71` |
| Lint | eslint ^10 + lefthook ^2（pre-commit / pre-push） | `package.json:65,68`；`lefthook.yml` |

**关键事实**：仓库**没有** `pnpm-lock.yaml`，也**没有** `pnpm-workspace.yaml`。任务书提到的 `pnpm-lock.yaml` 在真实仓库中不存在。

---

## 2. 必需依赖

### 2.1 运行时工具链

| 工具 | 最低要求 | 用途 | 证据 |
|---|---|---|---|
| Node.js | 22.x | 全部构建/测试 | `ci.yml:43` 等 21 处 `node-version: '22'` |
| npm | 随 Node 22 附带 | `npm ci` / workspace 脚本 | `ci.yml:87` |
| git | — | 仓库操作；`check:*` 脚本依赖 git 命令 | `scripts/check-repo-hygiene.js:79`、`check-docs-structure.cjs:25` |
| **git-lfs** | — | website 资产（`.mp4`/`.webp`） | `.gitattributes:44-50`；`ci.yml:81` `lfs: true` |
| **python3** | 3.x | `better-sqlite3` 原生编译（node-gyp） | `ci.yml:170` `npm rebuild better-sqlite3` |
| **make / g++** | — | 同上（node-gyp 需要 C++ 工具链） | 同上 |
| ripgrep | — | 代码检索（PD 约定常用） | AGENTS.md 工程约定；本任务 Phase 3 要求 |
| jq | — | 脚本内 JSON 处理 | PD 工具链约定 |

### 2.2 构建脚本依赖（`node_modules` 层）

- 根 `devDependencies`：`eslint@^10`、`vitest@^5`、`lefthook@^2`、`lint-staged@^17`、`@cucumber/*`、`semver`、`js-yaml`、`glob`
- **注意**：`scripts/check-*.{js,cjs}` 门禁脚本**只使用 Node 内建模块**，无需 `npm install` 即可运行：

  | 脚本 | 外部依赖 |
  |---|---|
  | `scripts/check-repo-hygiene.js` | 无（仅 `node:child_process`） |
  | `scripts/check-docs-structure.cjs` | 无（仅 `node:*`） |
  | `scripts/check-generated-artifacts.cjs` | 无（仅 git） |
  | `scripts/check-security-baseline.js` | 无（仅 `node:fs`/`node:path`） |
  | `scripts/check-error-handbook.cjs` | 仅本地 `./error-handbook-meta.cjs` |
  | `scripts/quality-report.mjs` | 无（仅 `node:*`） |

  这是本设计的一个关键杠杆：**云端可以零依赖执行 PD 自己的健康检查**（见 Phase 2 设计）。

---

## 3. CI 环境要求

| 维度 | 事实 | 证据 |
|---|---|---|
| 平台 | GitHub Actions（`ubuntu-latest`） | `.github/workflows/ci.yml` |
| Job 数 | **20 个 job** | `ci.yml` 顶层 job 键 |
| 触发 | `push`(main/develop)、`pull_request`(main)、`workflow_dispatch` | `ci.yml:3-11` |
| Node | 22（`.github/actions/setup-node` + `cache: npm`） | `ci.yml:43` |
| 安装方式 | `npm ci --ignore-scripts` | `ci.yml:87`、`ci.yml:108` |
| 原生构建 | 测试类 job 单独执行 `npm rebuild better-sqlite3` | `ci.yml:170-171` |
| 合并门禁 | `npm run verify:merge` | `ci.yml:90`；`package.json:39` |
| `verify:merge` 超时 | `timeout-minutes: 25` | `ci.yml:70` |
| LFS | checkout 时 `lfs: true`（`test:website` 需真实资产） | `ci.yml:75-81` |
| 权限 | `permissions: contents: read` | `ci.yml:22-23` |
| 并发 | PR 上 `cancel-in-progress: true` | `ci.yml:14-19` |

### 3.1 `verify:merge` 实际内容（`package.json:39`）

```
check:generated-artifacts → check:error-handbook → check:repo-hygiene
→ check:runtime-contract → check:docs-structure → check:security-baseline
→ test create-principles-disciple (release-target-matrix)
→ build @principles/core → test:website → lint → build
→ build @principles/pd-cli → typecheck:openclaw-plugin
→ typecheck:pd-console → typecheck:pd-companion
```

**注意**：`verify:merge` **不包含** pd-console 全量测试，也不包含 pd-companion/website 之外的 E2E。

### 3.2 根 `package.json` 没有 `test` 脚本

根 scripts 只有 `test:scripts`、`test:website`，**没有** `test`。因此任务书验收项里的 `pnpm test` / `npm test` 在 PD 上**本来就会失败**——这是任务书假设与仓库现实的冲突，见 §4.1。

---

## 4. 本地开发环境差异

### 4.1 任务书假设 vs 仓库现实（2 处冲突）

| # | 任务书假设 | 仓库现实 | 处置（依 P1 证据优先） |
|---|---|---|---|
| **C1** | 用 `pnpm-lock.yaml`，验证 `pnpm test` | 仓库是 **npm workspaces**，锁文件为 `package-lock.json`；无 `pnpm-lock.yaml`；根无 `test` 脚本 | **以仓库为准**：Dockerfile 以 npm 为权威链路。`pnpm` 仍按任务书要求预置（经 corepack），但只作为"任务书所要求的工具"存在，PD 的真实链路是 npm。真实门禁等价物 = `npm run verify:merge` |
| **C2** | 创建 `.ide/Dockerfile` 与 `.cnb.yml` | 二者均不存在（当前无任何 CNB 配置） | 属新建，无冲突；但 `.cnb.yml` **只在 cnb.cool 侧生效**，见 §5.1 |

### 4.2 本地开发环境特征（供容器对齐）

| 维度 | 本地（Windows 开发机） | CI（ubuntu-latest） | CNB 容器需对齐 |
|---|---|---|---|
| OS | Windows 10/11 | Ubuntu | Linux |
| 脚本 shell | 默认 `pwsh`（需覆写为 bash） | bash | bash |
| 已知本机噪音 | `health-check-model.test.ts` 恒失败；`workspace-lifecycle.test.ts` 5 fail（Windows EBUSY） | 无 | 容器内为 Linux ⇒ **不应复现** |
| cpd 全量基线 | 18 failed / 608 passed / 21 skipped（全部在 TUF 签名链与打包冒烟） | 同样存在 | 需用 pristine 对比判定 |
| 已知 CI 红灯 | workflow `E2E Regression Test` / job `Nocturnal Pipeline Regression Test` 在 main 上连续失败（根因 `packages/pd-cli/src/update/**` 缺 `@types/node` / `tuf-js`） | 同 | **预先存在的红灯，不得归因于本 PR** |

---

## 5. CNB 容器适配风险

### 5.1 【最高】仓库尚未托管在 cnb.cool —— 这是前置条件，不是技术风险

CNB 的 `.cnb.yml`、`.cnb/settings.yml`、`.ide/Dockerfile` **只在 cnb.cool 侧的仓库分支上被读取**。PD 仓库当前托管在 `github.com/csuzngjh/principles`（`git remote -v` 证据）。

含义：
1. 把配置文件提交到 GitHub 仓库**不会自动让 CNB 生效**——它们在下一次镜像同步后才被 CNB 读取。
2. 本 PR 交付的是"**已就绪的配置**"，其生效依赖 Owner 完成 CNB 侧接入。
3. CNB **不支持 SSH**，统一用 `https://cnb.cool/...` + 访问令牌；注册为微信扫码 + 实名认证；仓库必须归属于某个**组织**（无个人仓库概念）。

**推荐接入方式（最小风险）**：GitHub → CNB **单向镜像**（CNB 只读跟随）。理由：
- 与 Phase 2「CNB 第一阶段只读」完全一致；
- 不产生第二个写入口，不破坏 GitHub PR 流程（P4 单一事实源）；
- 避免双向同步的代码分叉风险。

**代价**：单向镜像下 CNB 侧不会产生 PR，因此 `pull_request.comment@npc` / `@NPC` 评论触发**不可用**。可行的触发面 = 定时任务（`crontab`）+ 手动触发（`web_trigger`）+ 若改为双向同步则再加 PR 事件。

### 5.2 【中】`better-sqlite3@13` 原生编译

- 需要 `python3` + `make` + `g++`；CI 里用 `npm ci --ignore-scripts` 跳过安装脚本，再显式 `npm rebuild better-sqlite3`。
- 容器内必须提供完整工具链，否则任何涉及 sqlite 的测试都会失败。
- **风险等级中**：只要 Dockerfile 装齐工具链即可消除；已在本设计覆盖。

### 5.3 【中】Git LFS

- PD 的 `packages/website/public/*.mp4`、`*.webp` 走 LFS；`test:website` 的首页契约测试依赖**真实资产**（非 132 字节指针文件）。
- CNB 侧需 `git-lfs` 已安装并执行 `git lfs pull`；CNB 提供 `CNB_HAS_LFS_FILES` 变量与 pipeline 的 `git.lfs` 配置项。
- 若在 CNB 上跑 `npm run verify:merge`，缺少 LFS 会导致 `test:website` 失败。

### 5.4 【中】三项需 Owner 决策/执行的前置条件

| # | 前置条件 | 为什么必须由 Owner 做 |
|---|---|---|
| P-a | 注册/登录 cnb.cool（微信扫码 + 实名认证）、创建组织 | 涉及账号与实名主体，Agent 无法代办 |
| P-b | 在 CNB 创建仓库并把 GitHub 仓库镜像过去（或配置同步流水线） | 涉及组织归属与凭据 |
| P-c | 在 CNB 仓库配置 `CNB_TOKEN` / 相关密钥 | 凭据仅 Owner 持有 |

在 P-a..P-c 完成前，**Phase 5 的 CNB 侧验证（workspace 可启动、流水线可运行）无法执行**。本 PR 只能交付配置 + 文档级验证。

### 5.5 【低】信任模型与权限边界

CNB 明确把 PR 事件、Issue 事件、NPC 事件列为**不可信事件**（untrusted events），并施加：
- `CNB_TOKEN` 权限收窄（未开工作模式的 NPC 事件：`repo-code:r`、`repo-pr:r`、`repo-issue:rw`、`repo-notes:rw`）；
- 不可信事件引用外部文件时，被引用文件必须通过 `allow_events` 显式声明。

**对本设计的正面意义**：CNB 原生就把「只读」做成默认姿态——未开启**工作模式**的 NPC **只能读代码、写评论**。这与本任务「Agent 默认只读」的要求天然同构，无需 PD 自建权限系统（P7 不新增抽象）。

**需提示的风险**：PR 类事件的流水线配置**取自源分支**，即未授权用户可通过 PR 修改 `.cnb.yml`。因此本设计的云端流水线**一律不持有写权限**，且不引用任何密钥文件。

### 5.6 【低】镜像与网络

- CNB 默认 NPC 镜像 `cnbcool/default-npc:latest`；默认开发镜像 `cnbcool/default-dev-env:latest`。
- 自定义 `.ide/Dockerfile` 构建失败时会回退默认镜像（官方行为），不会导致环境不可用。
- 构建期需拉取 npm registry（国内网络对 CNB 友好，属优势）。

### 5.7 【低】容器资源

- CNB 提供 `CNB_CPUS` / `CNB_MEMORY`，并可经 `runner.cpus` 申请（内存 = CPU 核数 × 2 GiB）。
- PD 的 `verify:merge` 在 GitHub 上给了 25 分钟预算，CNB 侧若跑全量需相应放宽。

---

## 6. 兼容性判定

| 维度 | 判定 | 说明 |
|---|---|---|
| Node 22 / npm workspaces | ✅ 兼容 | 官方 `node:22-bookworm-slim` 直接对齐 |
| 原生模块编译 | ✅ 可解 | Dockerfile 装 `python3 make g++` |
| Git LFS | ✅ 可解 | 装 `git-lfs` + pipeline `git.lfs` |
| PD 健康检查脚本 | ✅ 天然兼容 | 全部零外部依赖，容器内直接 `node scripts/...` |
| GitHub Actions | ✅ 无影响 | 不触碰 `.github/**`；CNB 与 GHA 互不感知 |
| 本地开发 | ✅ 无影响 | `.ide/`、`.cnb*` 无任何本地工具链引用（已验证） |
| OpenClaw 插件 / Companion / Console | ✅ 无影响 | 零 `packages/**` 改动；安装产物面不涉及 |
| PD runtime 状态 | ✅ 无影响 | 不写 `.pd/`、不写 `.state/`、不新增 DB |
| 全量 `verify:merge` 跑在 CNB | ⚠️ 成本高 | 首次 `npm install` 约 25 分钟；建议作为后续可选，不纳入第一阶段 |

**总体判定：CNB 可作为 PD 的只读分析型 Cloud Agent Worker。** 无阻塞级技术不兼容；阻塞项是**账号/仓库接入**这一 Owner 侧动作（§5.4）。

---

## 7. 下一步

1. Phase 1：CNB 官方能力验证（已完成，见配套报告）。
2. Phase 2：架构设计（Owner / 本地 / CNB 三面职责切分，只读边界）。
3. Phase 3/4：最小实现（`.ide/Dockerfile`、`.cnb.yml`、`.cnb/settings.yml`、审计员章程）。
4. Phase 5：本地可验证项全部验证；CNB 侧验证项**显式标注为待 Owner 接入后执行**。
5. Phase 6/7：PR + Linear。
