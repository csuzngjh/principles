# CNB Cloud Agent Worker — 接入与运行手册

> 状态：Phase 1（只读）
> 读者：Owner / 仓库维护者
> 设计：[`docs/audit/cnb-cloud-agent-architecture.md`](../audit/cnb-cloud-agent-architecture.md)
> 角色章程：[`.cnb/agents/pd-auditor.md`](../../.cnb/agents/pd-auditor.md)

---

## 0. 这份手册解决什么

`.cnb.yml` / `.ide/Dockerfile` / `.cnb/settings.yml` **只在 cnb.cool 侧的仓库分支上生效**。
把配置提交到 GitHub 只是"把配置放进仓库"，**不会自动让云端 Worker 跑起来**。

本手册给出从 GitHub 仓库到"云端 Worker 真正可用"的完整路径，以及验证清单。

---

## 1. Owner 前置清单（必须由人执行）

| # | 动作 | 为什么 Agent 做不了 |
|---|---|---|
| 1 | 注册/登录 [cnb.cool](https://cnb.cool/)（微信扫码 + 实名认证） | 涉及账号与实名主体 |
| 2 | 创建**组织**（CNB 无个人仓库概念） | 涉及组织归属 |
| 3 | 在组织下创建仓库（建议与 GitHub 同名 `principles`） | 涉及组织权限 |
| 4 | 把 GitHub 仓库镜像到 CNB | 涉及凭据 |
| 5 | 确认组织角色为 `owner` / `master`（否则定时任务与手动按钮不可用） | 权限主体 |

### 1.1 访问令牌权限要求（⚠️ 最常见的坑）

官方文档（`docs.cnb.cool/zh/guide/access-token.md`）明确：

> **默认权限**：访问令牌创建后，**公开**的组织/仓库/制品库/任务集默认拥有只读权限，
> **私有**仓库/制品库默认无权限，账号相关权限默认无权限。
> 如需操作私有资源，请额外勾选对应的授权范围。

⇒ **按默认参数创建的令牌无法 clone 私有仓库**（实测报
`您的凭据不具备拉取此仓库的 repo-code:r 权限`）。这是本次接入最容易被忽略的一步。

| 用途 | 必需的授权范围 | 说明 |
|---|---|---|
| git clone / push 镜像 | **代码仓库（读写）** = `repo-code:rw` | **必需**，缺了连 `git ls-remote` 都会 403 |
| 读仓库基本信息 | 基本信息只读 = `repo-basic-info:r` | 建议 |
| 由 Agent 通过 API 代建仓库 | **组织资源（读写）** = `group-resource:rw` | 可选；不给则在网页手动建仓库 |
| 读取用户资料 | `account-profile:r` | 可选，仅用于核对身份 |
| 推送开发环境镜像到制品库 | 制品库（读写）= `registry-package:rw` | 可选，后续需要时再加 |

**使用范围**（可访问的仓库类型）须包含**私有**仓库（或选"全部"），否则即使勾了授权范围也无效。

**到期时间**：建议设一个明确的有效期（如 90 天），到期由 Owner 按需续期。

### 1.2 令牌安全

* 令牌**只在创建时显示一次**，生成后立即复制保存。
* 任何明文出现在聊天记录 / 截图 / 文件里的令牌都应视为**已泄露**，用完即到
  `个人设置 → 访问令牌` 吊销并重新生成。
* 不要把令牌写进仓库文件、`.git/config` 的 remote URL、或任何会被提交的位置。
  本项目的令牌只用于 Owner 手动执行镜像（见 §2），**不进入 CI/流水线配置**
  （`.cnb.yml` 的 `CNB_TOKEN` 是平台自动注入的临时令牌，构建结束自动销毁，与个人令牌无关）。

---

## 2. 接入方式：推荐单向镜像

**CNB 不支持 SSH**；统一用 `https://cnb.cool/...` + 访问令牌认证。

### 方案 A（推荐）：GitHub → CNB 单向镜像

CNB 侧仓库只读跟随 GitHub，不产生第二个写入口。

**A-1 一次性全量迁移（保留全部历史）**

```bash
# 在 CNB 侧先建好空仓库与访问令牌
# 令牌位置：cnb.cool → 个人设置 → 访问令牌   （用户名固定为 cnb，密码填令牌）
git clone --bare https://github.com/csuzngjh/principles.git principles.git
cd principles.git
git push --mirror https://cnb.cool/<组织>/<仓库>.git
cd .. && rm -rf principles.git
```

**A-2 后续自动同步（可选，需凭据）**

用官方 `git-sync` 插件在 GitHub Actions 侧推送，或在 CNB 侧拉取。**注意**：这一步会引入访问令牌，与当前设计「云端零密钥」的姿态冲突——本节配置**不在本 PR 的交付范围内**，属于后续独立的凭据接入决策。

### 方案 B：双向同步

不推荐。会产生两个写入口，与 AGENTS.md **P4 单一事实源**冲突，且 CNB/GitHub 代码分叉风险高。

> **代价说明（方案 A）**：单向镜像下 CNB 侧没有 PR，因此 `@NPC` 评论触发不可用。可用触发面 = 定时任务 + 手动按钮。这是有意取舍，详见设计文档 §4.4。

---

## 3. 配置生效后的验证清单

镜像同步完成后，在 **CNB 侧仓库**逐项执行。

### 3.1 环境可用性

| # | 验证项 | 操作 | 预期 |
|---|---|---|---|
| V1 | 云原生开发可启动 | 分支页 → 右上角「云原生开发」 | 环境启动，出现 V1 阶段的「环境自检」输出 |
| V2 | 工具链版本正确 | 在 WebIDE 终端执行 | `node --version`→`v22.x`；`npm --version`；`git --version`；`git lfs version`；`rg --version`；`python3 --version` |
| V3 | 依赖可安装 | `npm ci` | 成功（首次约 10–25 分钟，属正常） |
| V4 | 原生模块可编译 | `npm rebuild better-sqlite3` | 成功（验证 `python3`/`make`/`g++` 齐备） |
| V5 | 测试可执行 | `npm run verify:merge` | 通过，或失败项与 GitHub Actions 现有红灯一致（见 §5） |

> **注意**：`pnpm test` 在本仓库**不适用**（根目录无 `test` 脚本，且 PD 使用 npm workspaces）。见 [`cnb-environment-compatibility-report.md`](../audit/cnb-environment-compatibility-report.md) §4.1。

### 3.2 Worker 行为

| # | 验证项 | 操作 | 预期 |
|---|---|---|---|
| V6 | PD Auditor 角色已注册 | 评论框输入 `@` | 选择器中出现 `PD Auditor` |
| V7 | 手动触发可用 | 分支页 → 「PD 云端审查」按钮 | 触发 `web_trigger_audit` |
| V8 | **只读姿态生效** | 观察 NPC 能力 | NPC **不能**推代码/建分支/开 PR |
| V9 | 定时任务已登记 | 仓库设置 → 云原生构建 → 定时任务 | 存在每周一 02:00 (Asia/Shanghai) 的任务 |
| V10 | 报告可下载 | 构建详情 → commit 附件 | 出现 `cloud-audit-report.md` / `cloud-audit-deterministic.md` |

### 3.3 ⚠️ 首个待确认项（U1）

**问题**：CNB 官方文档未说明 `npc:go` 的产物是否包含"在 workspace 写入文件"。

**影响**：定时任务（T2）的叙事报告 `cloud-audit-report.md` 依赖该行为。若 NPC 只以**评论**形式回复而不写文件，则 `校验报告已产出` 阶段会**失败并给出 nextAction**（这是有意设计的 fail-loud，不是缺陷）。

**兜底方案**（若 U1 为否）：

| 方案 | 做法 |
|---|---|
| B1 | 保留确定性报告（`cloud-audit-deterministic.md` 由脚本生成，不依赖 NPC 写文件）不动；叙事部分改为在任务描述里指定一个 Issue，让 NPC 评论到 Issue 下 |
| B2 | 构建自定义 NPC 镜像（`.ide/Dockerfile` + `@cnbcool/cnb-cli` + `skills`），由镜像内的 CLI 负责落盘 |
| B3 | 移除 `校验报告已产出` 阶段，接受"叙事报告仅存在于构建日志" |

**首次运行后请记录结论**，并据此更新 `.cnb.yml` 与设计文档 §7。

---

## 4. 日常使用

| 场景 | 入口 | 输出 |
|---|---|---|
| 每周自动架构体检 | 自动（周一 02:00） | `cloud-audit-report.md` + `cloud-audit-deterministic.md`（commit 附件） |
| 按需全仓审查 | 分支页「PD 云端审查」按钮 | NPC 回复（+ 报告附件） |
| PR 自动审查 | CNB 侧创建 PR 时 | PR 评论 |
| 人工深度调查 | 「云原生开发」→ WebIDE | 人工操作 |

**查看报告**：构建详情页 → 对应 commit → 附件区。
私有仓库下载附件需带令牌：

```bash
curl -L --fail \
  -H "Authorization: Bearer ${CNB_TOKEN}" \
  -H "Accept: application/vnd.cnb.api+json" \
  -o cloud-audit-report.md \
  "${CNB_API_ENDPOINT}/${CNB_REPO_SLUG}/-/commit-assets/download/${CNB_COMMIT}/cloud-audit-report.md"
```

---

## 5. 已知限制（会出现在每份报告中）

| 限制 | 原因 |
|---|---|
| Linear context 不可用 | 本阶段不引用任何密钥；CNB 侧无 Linear 集成 |
| 未执行全量 `verify:merge` | 首次 `npm install` 约 25 分钟，不纳入第一阶段流水线 |
| `@NPC` 评论触发不可用 | 单向镜像下 CNB 侧无 PR/Issue |
| GitHub 既有红灯会同样出现 | workflow `E2E Regression Test` / job `Nocturnal Pipeline Regression Test` 在 main 上自 ≥#1605 起连续失败，根因在 `packages/pd-cli/src/update/**`。**这是预先存在的红灯，不得归因于 CNB 接入** |

---

## 6. 定时任务的人事风险（重要）

CNB 定时任务的**执行身份 = 最后添加或修改该配置并推送的用户**（Last Modifier）。

- 若该用户被移出组织，**任务会执行失败**。
- 修复：由另一位有权限的成员修改并推送该配置，负责人随之转移。

→ 配置 `.cnb.yml` 中 `crontab` 段落的成员，应当是**长期在组织内**的人。

---

## 7. 回滚

| 场景 | 动作 |
|---|---|
| 云端行为不符预期 | 在 CNB 侧仓库移除/注释 `.cnb.yml` 中对应事件块 |
| 完全放弃 CNB | 删除 CNB 侧仓库，或停止镜像同步；GitHub 侧删除 4 个配置文件 |
| 仅为临时停用定时任务 | 从 `.cnb.yml` 移除 `crontab:` 条目（其他事件流水线不受影响） |

**无状态迁移、无 schema 变更、无 packages/** 改动** ⇒ 回滚是纯配置回退。

---

## 8. 与 PD 治理的边界（请勿越界）

| 约束 | 说明 |
|---|---|
| **不得**为该 NPC 开启「工作模式」 | 开启即授予代码/PR 写权限，破坏只读姿态 |
| **不得**在 `.cnb.yml` 中加入 `git:auto-merge` | 违反「不自动合并」 |
| **不得**引用密钥仓库文件 | 当前为「云端零密钥」姿态 |
| `.cnb/**` 是 CI 配置，**不是** PD 产品代码 | 与 `.github/workflows/` 同类；不得据此改动 `packages/**` |
| 报告**不得**提交回 `main` | 走 commit 附件，避免第二个写入口 |
