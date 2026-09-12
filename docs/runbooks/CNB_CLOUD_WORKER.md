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

**A-1 一次性全量迁移（保留全部历史 + LFS 资产）**

> ⚠️ **必须包含 LFS 步骤**。`git push --mirror` 只搬运 Git 引用与 LFS **指针文件**，
> 不搬运 LFS 对象本体。PD 的 `*.mp4` / `*.webm` / `*.webp` 走 LFS
> （`.gitattributes:46-50`），漏掉这一步会导致 CNB 侧 `test:website` 的
> 首页契约测试失败（资产变成 132 字节指针）。与 CNB 官方"裸库迁移"指引一致。

```bash
# 令牌位置：cnb.cool → 个人设置 → 访问令牌（用户名固定为 cnb，密码填令牌）
# 令牌需要 repo-code:rw + repo-basic-info:r；镜像含 LFS 时建议再给 registry 无关、无需额外权限
CNB_URL="https://cnb.cool/csuzngjh/principles.git"

mkdir empty && cd empty
git clone --bare https://github.com/csuzngjh/principles.git .
git lfs fetch origin --all          # ← 从 GitHub 拉取全部 LFS 对象（必需）
git push --mirror "$CNB_URL"        # 推送 refs
git lfs push "$CNB_URL" --all       # 推送 LFS 对象本体（必需）
cd .. && rm -rf empty
```

**A-2 持续同步（⚠️ 实为前置条件，非可选）**

> **这是 Codex 评审标记的 P1**：若只做 A-1 而不持续同步，CNB 侧 `main` 会立刻
> 落后于 GitHub（实测：一次性迁移完成后数分钟内，GitHub `main` 就已因新合并
> 前进了一个 commit）。定时审计会反复审查**过期的快照**，却把它当作"当前 main HEAD"
> ——这比没有审计更糟（制造虚假信心）。

因此**定时审计（T2）只在镜像保持同步的前提下有意义**。二选一：

| 选项 | 做法 | 代价 |
|---|---|---|
| **A-2a 自动同步（推荐）** | 新增一个 GitHub Actions workflow：`push` 到 `main` 时把仓库推送到 CNB | 需要 Owner 在 GitHub 仓库 Settings → Secrets 添加 `CNB_MIRROR_TOKEN`；会新增 `.github/workflows/**`（属于对本 PR 范围的扩展，需 Owner 批准） |
| **A-2b 手动定期同步** | Owner 每次合并后手动重跑 A-1 的 fetch+push（或交给 Agent 执行） | 无新增配置；依赖人工记得执行，容易遗漏 |

在 A-2 落地前，**请把 `.cnb.yml` 中 `crontab` 的定时审计视为"审计上次同步的快照"**，
其报告头部的 `CNB_COMMIT` 字段标明了实际审查的 commit —— 对比 GitHub 当前 `main`
即可判断是否过期。

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
| 按需全仓审查 | 分支页「PD 云端审查」按钮 | **NPC 回复（唯一输出）**——此流水线未配置附件上传阶段 |
| **远程 API 触发审计** | OpenAPI `POST /-/build/start`（`api_trigger_audit`） | NPC 回复（经 `buildLogUrl` 取日志） |
| PR 自动审查 | CNB 侧创建 PR 时 | PR 评论 |
| 人工深度调查 | 「云原生开发」→ WebIDE | 人工操作 |

> 只有**定时审计（T2）**产出可下载的报告附件；手动（T3）、远程 API（T3b）与 PR 审查（T1）的产出是对话/评论/日志本身。
> 这是**文档与流水线的刻意对齐**（Codex 评审 P2 指出此前二者不一致）：这些场景没有稳定的
> "落盘报告"依赖（`npc:go` 能否写文件本就是待确认项 U1），承诺附件反而会制造无法兑现的预期。

### 4.1 远程触发（`api_trigger_audit`，PRI-762）

T3 与 T3b 是**同一个流水线定义**（`.cnb.yml` 内以 YAML 锚点 `&pd-audit-entry` 共享，零复制）。
审计的单一事实源是 `.cnb/agents/pd-auditor.md`（章程）。

> ⚠️ **`env.userPrompt` 是必需参数**（实测）：`npc:go` 在非 NPC 事件下会硬校验 userPrompt，
> 缺失/为空时直接报 `npc:go requires "userPrompt" parameter for non-NPC events`，
> agent 根本不会启动。systemPrompt 里的"空则回退"救不了 —— 校验发生在 agent 启动前。

```bash
# 审计指令即 "audit mode"：想审什么就写什么；留空会导致 npc:go 校验失败
CNB_TOKEN=<repo-code:rw 的访问令牌>
AUDIT_PROMPT="对当前分支做一次全仓架构健康检查，按 .cnb/agents/pd-auditor.md 的 D1–D5 五个维度输出发现。"
BRANCH="main"

# 用 node 做真正的 JSON 编码（Codex 评审 P2）：审计指令里出现引号/反斜杠/换行时，
# shell 直接插值进 JSON 字符串会产生非法 body，请求在到达流水线前就失败。
PAYLOAD="$(node -e '
  const branch = process.argv[1];   // node -e 模式下 argv 不含脚本身：[execPath, branch, prompt]
  const prompt = process.argv[2];
  process.stdout.write(JSON.stringify({
    event: "api_trigger_audit",
    branch,
    env: { userPrompt: prompt },
  }));
' "$BRANCH" "$AUDIT_PROMPT")"

# --fail-with-body（curl ≥ 7.76，Codex 评审 P2）：HTTP 4xx/5xx（令牌过期/权限不足等）
# 时退出码非 0 但仍打印响应体 —— 避免把被拒绝的触发误判为已受理。
curl -sS --fail-with-body -X POST "https://api.cnb.cool/csuzngjh/principles/-/build/start" \
  -H "Authorization: Bearer $CNB_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD"
```

响应（实测）：

```json
{"sn":"cnb-js8-1k2abof41","buildLogUrl":"https://cnb.cool/csuzngjh/principles/-/build/logs/cnb-js8-1k2abof41",
 "event":"api_trigger_audit","message":"cnb received, but didn't finish build yet","success":true}
```

* `sn` = 流水线 ID；`buildLogUrl` = 审计输出所在（NPC 回复写在构建日志里，
  可经 `GET /{repo}/-/build/logs/stage/{sn}/{pipelineId}/{stageId}` 读取）
* `branch` 决定审计对象（CNB 会 checkout 该 ref 并读取其 `.cnb.yml`）
* `env.userPrompt` 即 **audit mode**：调用方决定审什么、审多深
* 判读：HTTP 失败时 `curl` 退出码非 0（`--fail-with-body`）；受理成功的响应含
  `"success":true`（`message` 此刻仅表示"已受理，尚未跑完"，结果看 `buildLogUrl`）
* 消耗：CI CPU（核时）+ AI Credits（可在 `组织 → 设置 → 用量管理`、
  `GET /{slug}/-/charge/quota` 与 `GET /{repo}/-/build/logs/ai-audit/{sn}/{pipelineId}` 查明细，
  后者需要 `repo-cnb-history:r` 权限）

**权限边界（如实陈述）**：`api_trigger` 在 CNB 属**可信事件**，平台自动注入的临时令牌
`CNB_TOKEN` 因此持有 `repo-code:rw` 等完整权限（`docs/audit/cnb-capability-validation-report.md`
§5.4；令牌构建结束自动销毁）。本流水线的"只读"是**治理级约束，不是凭证级隔离**：

* `.cnb/settings.yml` 明文禁止 NPC 角色开启「工作模式」；章程（`.cnb/agents/pd-auditor.md`）
  约束审计行为（只读、不 push、不建分支、不引用任何密钥文件）；T3/T3b 不挂任何写/上传 stage；
* 触发端本身需要持有仓库写权限的凭证（CNB 平台限制），非授权主体无法发起；
* **残余风险**：npc 容器内进程可访问该临时令牌 ⇒ 只读边界最终依赖上述治理约束而非平台强制；
  现有仓库证据（能力报告 §5.4）未覆盖"可信事件下 `npc:go` 阶段的令牌是否被工作模式收窄"
  这一层，在补齐该证据前按此保守口径理解。

**实测记录（2026-09-12）**：

| 次 | 传参 | 结果 | 说明 |
|---|---|---|---|
| 1 | 无 env | ❌ npc go error（856ms） | `npc:go requires "userPrompt" parameter for non-NPC events` |
| 2 | `env.userPrompt`="连接测试：请只回复 PONG" | ✅ pipeline success | agent 启动、role=PD Auditor 解析成功、模型 `deepseek-v4.1-flash`、回复 PONG；token in=11061/out=2；**AI Credits 消耗 0** |

**查看报告**：构建详情页 → 对应 commit → 附件区。
私有仓库下载附件需带令牌：

```bash
curl -L --fail \
  -H "Authorization: Bearer ${CNB_TOKEN}" \
  -H "Accept: application/vnd.cnb.api+json" \
  -o cloud-audit-report.md \
  "${CNB_API_ENDPOINT}/${CNB_REPO_SLUG}/-/commit-assets/download/${CNB_COMMIT}/cloud-audit-report.md"
```

### 4.2 每周治理循环（PRI-766）

CNB Cloud Auditor 的每周运行不是"又一个定时任务"，而是一条**证据链**：
定时触发 → 上下文准备（元数据 + 漂移检测）→ D1–D5 审计 → 报告落盘 → **人工/AI 发布到 Linear**。
契约的单一事实源是章程 `.cnb/agents/pd-auditor.md`（§6 v2 输出契约）。

**每周期自动发生（CNB 侧，零密钥）**：

1. `"crontab: 0 2 * * 1"`（周一 02:00，Asia/Shanghai）触发 T2 双流水线（§3）；
2. "审计上下文准备"阶段写入 `cloud-audit-context.md`：实际审计 commit、触发事件、
   章程版本，并用 GitHub 匿名 API 比对镜像漂移——
   漂移时生成 `Warning: Audit source differs from GitHub main`（API 不可达则如实留痕）；
3. 叙事审计产出 `cloud-audit-report.md`（v2 格式：Metadata / Summary / Findings 含
   Severity·Category·Evidence·Impact·Recommendation·Confidence / Integrity Check），
   Agent 已按章程 §6.2 做计数自检、§6.3 做证据质量门；
4. 两份报告挂到对应 commit 的附件（ttl 30 天）。

**每周期人工/AI 完成（证据发布，不可自动化省略）**：

1. 从构建日志或 commit 附件取出 `cloud-audit-report.md` 全文；
2. 在 Linear 周审计工单发**中文证据评论**，必须包含：
   `Pipeline sn + buildLogUrl`（Agent 无法得知自己的 sn，由发布者补记）、
   报告的 Metadata 与 Summary 计数、每条 Finding 一行（含 Confidence）、
   Integrity Check 结果、以及 **Drift Warning（若存在——漂移周的结论按局限对待）**；
3. 审计发现**只记录、不顺手修**：P0/P1 由 Owner 决定是否立单；AI 不得把审计发现
   自动转化为代码 PR（审计证据是观察结果，不是施工指令）；
4. **禁止把周报写进 main 的产品文档**——证据进 Linear / 附件，不污染仓库
   （`docs/audit/` 仅收审计基础设施文档，不收周期性审计结果）。

**漂移升级路径**：Drift Warning 仅在**审计对象为 main** 时出现（分支审计给的是中性
INFO 说明——分支与 main 有差异属预期）。若周报带该 Warning，先按 §2 方案A 手动同步
镜像，同步后用 T3b（`api_trigger_audit`，branch=main）复审一次，再发布证据——
带漂移警告的报告不得作为治理决策依据，只作记录。

**验证点**（本循环 v1 于 2026-09-12 经两次真实模拟验证，见 Linear PRI-766）：
触发 ✓ / 上下文与漂移检测（含分支语义区分）✓ / v2 报告与完整性自检 ✓（模拟运行中
Agent 的 Summary 首次计数错误被 §6.2 自检当场抓住并修正）/ 附件与日志证据 ✓ /
Linear 记录 ✓。
已知边界：上下文脚本内联于 `.cnb.yml`，`verify:merge` 与 `test:scripts` 均覆盖不到
（后续工单建议：抽为 `scripts/cnb-audit-context.mjs` 并补三分支测试）。

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
