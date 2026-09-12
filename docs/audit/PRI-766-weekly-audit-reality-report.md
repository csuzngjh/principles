# PRI-766 — Weekly Audit Reality Report（Phase 0 现实审计）

- 日期：2026-09-12
- 调查人：AI（PRI-766 任务，P1 Evidence Over Assumption / P2.1 Reality Audit）
- 调查对象：GitHub `main` @ `98e8f2e94`（PR #1636/#1637 合并后）+ CNB 镜像 live 状态
- 结论先行：**周定时骨架已存在（CNB 原生 crontab），缺口在"证据链"——元数据契约、漂移警告、完整性自检、Linear 证据发布均未建立，且 CNB main 镜像正处于漂移状态。**

---

## 任务书四问

### 1. 当前 trigger 能否定时运行？

**能——已存在，且是 CNB 原生调度，不需要外部 crontab。**

- 证据：`.cnb.yml:151` `"crontab: 0 2 * * 1"`（`main:` 段，周一 02:00 Asia/Shanghai，CNB 平台限制最小间隔 5 分钟）。
- 该事件挂两条流水线：A 确定性检查（`.ide/Dockerfile` 镜像，零依赖 `check:*` 脚本）+ B 叙事审计（NPC 镜像，D1–D5）。
- ⚠️ 既有人事风险（架构文档 U3，runbook §6）：**执行身份 = 最后修改并推送该配置的用户**，被移出组织则任务静默失败。
- ⚠️ 核心缺口：定时审计的**对象是 CNB main 镜像**，而镜像同步是单向手动的——见第 5 节。

### 2. 当前 audit report 输出位置？

| 流水线 | 输出 | 位置 | 持久性 |
|---|---|---|---|
| T2-A 确定性 | `cloud-audit-deterministic.md` | commit 附件 | ttl 30 天 |
| T2-B 叙事 | `cloud-audit-report.md` | commit 附件 + 构建日志 | 附件 ttl 30 天，日志长期 |
| T3/T3b 按需 | NPC 回复 | 仅构建日志（`buildLogUrl`） | 长期但难检索 |

- Trial-002 反证据：`npc:go` **能**写文件（242 行报告成功落盘），T2-B 的 `校验报告已产出` 硬校验成立。
- 缺口：报告无统一元数据契约（此前 v1 模板缺 Pipeline/Model/Duration/Context Version/漂移警告），无完整性自检（Trial-002 实测出现"摘要计数 ≠ 正文计数"的自计 undercount）。

### 3. 当前 Linear 更新方式？

- **CNB 侧零密钥 ⇒ 不存在 CNB→Linear 自动集成**（架构文档 §8 已声明为已知局限）。
- 现行方式：AI 会话事后用 `linear-cli`（`~/.agents/skills/linear-cli/`）发中文证据评论。本战役已实证三次（PRI-764 收敛轮、PRI-765 建单+结果评论、本单）。
- 结论：Evidence Publishing 的"最小方案"= 把这条已验证的人工/AI 步骤**契约化写进 runbook**（发布者补记 Pipeline sn、必须携带漂移警告），而不是新建自动化——新建自动化反而要引入 Linear 凭据，违反零密钥姿态。

### 4. 当前权限边界？

- `api_trigger` / `crontab` 属 CNB **可信事件**：流水线自动注入的 `CNB_TOKEN` 持 `repo-code:rw` 等完整权限（能力报告 §5.4，PR #1636 评审已如实化写入 runbook §4.1）。
- 只读姿态是**治理级**：`.cnb/settings.yml` 禁开工作模式 + 章程 §2 H1–H7 + 流水线无写/上传 stage + 触发端需仓库写权限凭证；残余风险（npc 容器内进程可访问临时令牌）已显式声明。
- 本任务新增的漂移检测**不引入任何新凭证**：GitHub 仓库为 public（`gh api repos/csuzngjh/principles` → `private:false` 实证），匿名 API 即可读 `main` SHA。

---

## 镜像漂移现状（本报告的核心发现）

| ref | SHA | 状态 |
|---|---|---|
| GitHub main | `1ed2f298b` → `98e8f2e94`（调查期间前进，热 main） | 权威源 |
| CNB main | `f9e9dfd7` | **漂移中**（F-001，Trial-001 发现，至今未解决） |
| CNB feat/pri-762-cnb-api-trigger | `27697c4e` | PR #1636 合并前的 head，评审修复 `598fa5d9b` 未同步 |

**后果**：T2 每周定时审计此刻审计的是过期快照，且无任何警告——这正是 Phase 2"必须记录实际审计 commit + 漂移警告"的动因。同步修复本身（A-2a GHA / A-2b 手动，runbook §2）属既有 follow-up，不在本任务范围（本任务只保证"漂移可被看见"）。

## 缺口 → 本次交付映射

| 缺口 | 交付（本任务） |
|---|---|
| 报告无元数据契约 | 章程 §6.1 v2 模板（Repository/Commit/Branch/Trigger/Pipeline/Model/Duration/Context Version/Generated） |
| 报告无完整性自检 | 章程 §6.2 Finding Counter Validation + Integrity Check 节 + Report Integrity Warning |
| 证据无质量门 | 章程 §6.3 Evidence Quality Gate（File:Line:Commit 缺失 → Confidence 降级/不得成 Finding） |
| 漂移不可见 | `.cnb.yml` "审计上下文准备"阶段（锚点复用于 T2/T3/T3b）：记录实际 commit + 匿名 GitHub API 漂移比对 + verbatim Warning |
| 证据发布无契约 | runbook §4.2：Linear 中文证据评论工作流（Pipeline sn 补记、漂移升级路径、禁止写 main 文档） |

## 范围与边界

- 只动 `.cnb.yml`、`.cnb/**`、`docs/runbooks/CNB_CLOUD_WORKER.md`、本报告；**不动 `packages/**`、不动 `.github/**`**（任务 Non-Goals）。
- 不修任何 Trial-002 发现（如 `web_trigger.yml` 描述矛盾、U1 三处文档统一）——那是审计发现的修复，属后续工单。
- 不新建 Agent 框架/编排层；上下文阶段是既有确定性 stage 模式的延伸（P2 连接优先于创建）。
