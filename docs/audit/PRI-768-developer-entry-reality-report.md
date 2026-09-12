# PRI-768 — CNB Developer Entry Reality Report（Phase 0 现实审计 + 可行性确认）

- 日期：2026-09-12
- 调查人：AI（PRI-768 任务，P1 Evidence Over Assumption / P2.1 Reality Audit）
- 基线：GitHub `main` @ `fbdc56332`（PRI-766 PR #1640 已合并）
- **结论先行：任务书全部假设与 CNB 官方能力一致，可行性成立，无需触发"停止"分支。** 关键澄清：Developer 的写能力**不依赖**「替我上班」工作模式——它来自流水线自身的 CNB_TOKEN（Owner 触发的可信事件，平台将上限压到 Developer 角色）。

---

## 任务书四问

### 1. 当前已有 trigger 类型？

`.cnb.yml` 现存 5 类（全部实证）：

| 键 | 事件 | 用途 | 角色 |
|---|---|---|---|
| `$:` `vscode` | WebIDE | T4 云原生开发环境（人工） | — |
| `$:` `pull_request` | PR | T1 只读代码审查 | PD Auditor |
| `$:` `web_trigger_audit` | 分支页按钮 | T3 按需审计 | PD Auditor |
| `$:` `api_trigger_audit` | OpenAPI | T3b 远程触发审计（锚点复用 T3） | PD Auditor |
| `main:` `"crontab: 0 2 * * 1"` | 周定时 | T2 每周治理审计 | PD Auditor |

**缺失的正是本任务要加的**：Owner 主动下达开发任务的入口。

### 2. 当前 npc:go 使用方式？

统一形态：`role` + `systemPrompt`（定位 + 硬约束 + 指向章程）+ `userPrompt`（web_trigger 场景为 `$userPrompt` 页面输入直传）。
官方文档（docs.cnb.cool/zh/build/npc.html）**示例 2 即本模式**：web_trigger 触发时页面输入 `userPrompt` 作为 NPC 任务描述——`$userPrompt` 直传是被文档明确支持的标准用法，已由 T3 实证（PRI-759）。

### 3. 当前 role 定义方式？

`.cnb/settings.yml` 的 `npc.roles[]`（name / slogan / prompt），生效范围仅 cnb.cool 侧。角色与流水线解耦：`.cnb.yml` 的 `role:` 按名引用。新增角色 = 追加一个数组元素，零改动既有 PD Auditor。

### 4. 当前权限边界？

- **PD Auditor 只读**：`.cnb/settings.yml` 明文不开「工作模式」+ 章程 §2 H1–H7 + 流水线无写 stage。本任务**不触碰**该角色。
- **凭证模型**（能力报告 §5.4 + PR #1636 如实化结论 + 官方文档）：
  - 非 NPC 事件（web_trigger/api_trigger/crontab）的流水线持有 `CNB_TOKEN`（可信事件，repo-code:rw）；
  - 官方明确：**触发用户 ≤ Owner 时，CNB_TOKEN 上限角色 = Developer**——天然无 master/owner 级能力；
  - **「替我上班」工作模式是 Issue/PR 评论入口的 UI 开关**（官方 NPC 文档），不适用于也不需要被 npc:go 流水线使用——Developer 的写能力直接来自流水线令牌，不引入工作模式，Auditor 的只读姿态因此不受任何影响。

## Developer 能力的官方依据（可行性核心）

| 需求 | CNB 官方支持 | 证据 |
|---|---|---|
| 页面输入 userPrompt 触发 npc:go | web_trigger + `$userPrompt` 是官方文档示例 2 | docs.cnb.cool/zh/build/npc.html |
| 写代码 / 推分支 / **发 PR** | npc 镜像内置 `cnb-code-commit`、`cnb-api`、`cnb-pr-*` 技能（Trial-002 运行时清单实证）；流水线 CNB_TOKEN（repo-code:rw）可推分支、调 OpenAPI 建 PR | Trial-002 日志 skills 清单；能力报告 §4.3 L2 |
| 无 master 级权限（不 merge/不 release） | CNB_TOKEN 上限 = Developer 角色（触发者 ≤ Owner 时） | 官方触发/权限文档 |
| 无 main 直推 | 治理级约束（章程 D3）+ Owner PR Review 兜底；平台级分支保护未配置（如实声明，非已验证强制） | 本报告 §边界 |

**不使用「替我上班」**：那是 Issue/PR 评论区 UI 开关（官方文档原文），与本入口无关。设置文件中 Auditor 的"禁开工作模式"守卫原样保留。

## 必须如实声明的架构后果

**Developer 产出的 PR 落在 CNB 镜像仓库，不在 GitHub。** PD 权威仓库是 GitHub（单向镜像 GitHub → CNB，零密钥姿态下云端无 GitHub 凭据）。因此生命周期为：
CNB 分支 + CNB PR（提案载体，Owner 在 cnb.cool 评审）→ **Owner 认可后人工移植到 GitHub**（fetch CNB 分支 → push GitHub → 开 GitHub PR）→ Owner 合并。
移植是人工/授权会话步骤，Developer 与流水线均无法完成——这是单向镜像模型的直接推论，不是缺陷，但必须在章程与 runbook 中显式声明，避免 Owner 误以为 CNB PR 即最终落地。

## 范围与边界

- 只动 `.cnb.yml`、`.cnb/web_trigger.yml`、`.cnb/settings.yml`、`.cnb/agents/pd-developer.md`（新增）、`docs/runbooks/CNB_CLOUD_WORKER.md`、本报告；
- 不动 `packages/**`、`.github/**`；不改 PD Auditor 的任何定义（Phase 4 有专项验证）；
- `src/**` 说明：仓库无根级 `src/`，包源码均在 `packages/*/src/`——对 `packages/**` 的禁止已覆盖；章程仍按任务书原文双列。

---

## 附录（测试执行后的补充事实，2026-09-12）

### 第一轮测试：章程的"停止请求澄清"被真实触发

测试任务（`cnb-mrg-1k2alhdo7`，109 轮，success）暴露了本报告初版的盲区：**CNB main 镜像漂移已让 CNB 侧 PR 工作流结构性不可用**——镜像 main（`f9e9dfd7`）落后 36 个 commit 且不含整个 `.cnb/` 目录，任何以镜像 main 为 base 的 PR 都会是巨型失真 PR（5 个"新增".cnb 文件 + 62 个无关文件）。

PD Developer 的行为完全符合章程：P1 调查先行 → 发现基线异常 → **停止、不提交、不建 PR** → 给出 A/B/C 三选项与推荐（C：先修同步）→ 把 base 选择识别为治理决策（D9）不自行裁决。这不是测试失败，而是**章程防呆机制的实证**——它拒绝制造一个格式合规但语义错误的 PR。

### 镜像同步已执行（方案 A-2 手动档）

按 runbook §2 方案 A-2，以 PD-mirror 令牌将 CNB main **快进**至 GitHub main 的精确 SHA（`f9e9dfd7 → fbdc56332`，先验证祖先关系再推送，ls-remote 复核）。F-001 漂移在运维层面消除；T2 周定时审计自此审计当前 main。**持续同步机制（A-2a GHA）仍待 Owner 批准**——不建立它，漂移会重新累积。

### 第二轮测试：全链路通过（AC 达成）

测试任务（`cnb-2bf-1k2amca2k`，135s，success）在干净基线上完整走通：

- 建分支 `ai/cnb-dev/pri-768-section43-consistency`（章程命名规范 ✓）
- 提交 `a15b6f72e`：**仅改 `docs/runbooks/CNB_CLOUD_WORKER.md`**（范围合规 ✓，零 packages/** ✓），内容为 §4.3 的 4 处真实性遗漏补齐（头部双章程索引、§4 使用表补两行、T5 编号与锚点说明、api_trigger_dev 的 userPrompt 硬校验提示）
- **创建 CNB PR #1**（`is_npc: true`，base = 任务分支，mergeable）✓
- 提交信息含调查依据与验证记录（`check-docs-structure` OK、4 条相对链接核验）✓
- 全程零密钥、未触碰 Auditor 任何配置 ✓
