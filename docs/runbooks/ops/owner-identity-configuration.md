# Owner 身份配置（PD_OWNER_ID / PD_OWNER_CREDENTIAL_ID）

> **状态**: Active
> **最后更新**: 2026-08-29
> **关联代码**: `pd-console/src/server/routes/governance.ts`（`resolveOwnerConfigSnapshot`）、`pd-cli/src/commands/runtime-activation.ts`
> **关联工单**: PRI-578（Owner 身份引导式登记入口）、PRI-584~587（治理体验快照）
> **适用角色**: Owner / 控制台运维

---

## 1. 这是什么

Owner 身份是 PD 治理体系中的**唯一权威决策者**。`PD_OWNER_ID` 与 `PD_OWNER_CREDENTIAL_ID` 两个环境变量共同定义它：

- `PD_OWNER_ID`：Owner 的标识（如 `owner@example.com` 或 `owner-alice`）。
- `PD_OWNER_CREDENTIAL_ID`：Owner 的凭据标识。

判定逻辑（`resolveOwnerConfigSnapshot`）：

```
ownerIdentityConfiguration = 控制台令牌认证已启用 && PD_OWNER_ID 非空 && PD_OWNER_CREDENTIAL_ID 非空
                             ? 'configured'
                             : 'missing'
```

**三个条件缺一不可**：

1. 两个环境变量都已设置（非空）；
2. **PD 控制台的令牌认证已启用**——启动 `pd-console` 时传 `--token <value>`，或设置环境变量 `PD_CONSOLE_TOKEN`；
3. 重启控制台（环境变量只在进程启动时读取）。

## 2. 什么时候需要配

- 治理体验快照（Focus 页）显示「拥有者身份：未配置」；
- RuleCode 决策入口被阻塞，原因 `owner_identity_missing`；
- 需要行使 Owner 治理动作：审批/晋升 RuleCode 激活、紧急暂停等。

## 3. 如何配置

> 占位符 `<owner-id>` / `<credential-id>` 换成你自己的值。设置后**必须重启** OpenClaw 与 PD 控制台。

### Windows（PowerShell，用户级持久化）

```powershell
[Environment]::SetEnvironmentVariable('PD_OWNER_ID', '<owner-id>', 'User')
[Environment]::SetEnvironmentVariable('PD_OWNER_CREDENTIAL_ID', '<credential-id>', 'User')
```

写入的是当前 Windows 用户的持久环境变量，新开的进程都会继承。

### macOS / Linux（bash，写入 profile）

```bash
echo 'export PD_OWNER_ID="<owner-id>"' >> ~/.bashrc
echo 'export PD_OWNER_CREDENTIAL_ID="<credential-id>"' >> ~/.bashrc
source ~/.bashrc
```

使用 zsh 的用户把 `~/.bashrc` 换成 `~/.zshrc`。

### 启用控制台令牌认证

```bash
# 启动 pd-console 时带 --token，或设置环境变量
export PD_CONSOLE_TOKEN="<console-token>"
```

## 4. 如何验证

1. 重启 OpenClaw 与 PD 控制台；
2. 打开 Focus 页 → 治理体验摘要 → 身份行显示「拥有者身份：已配置」；
3. 治理动作明细中 `rulecode_owner_decision` 不再因 `owner_identity_missing` 被阻塞。

## 5. 安全注意

- `PD_CONSOLE_TOKEN` 是**敏感凭据**：不要提交进代码仓库、不要写进共享的配置文件、不要出现在截图或进程列表中。
- `PD_OWNER_CREDENTIAL_ID` 是凭据的**标识符/引用**（非密钥本身，见 ADR-0022）：它用于身份展示与审计，本身可随 `~/.pd/owner.json` 明文存放、可在控制台展示；但它字段名含 `credential` 段，仍会被 ERR-045 在日志/配置回显路径自动脱敏——这是纵深防御，属预期行为。
- 环境变量属于主机级配置，**不要**把它们写进 `.pd/config.yaml`（该文件不是凭据存放处）。
- 撤销 Owner 身份：删除 `~/.pd/owner.json`（文件登记）或对应环境变量（env 方式）并重启即可；无需其他操作。

## 6. 与其他文档的关系

- 治理体验快照的完整解释：`docs/implementation-reports/governance-experience-audit.md`（内部报告）。
- RuleHost 日常运维（激活、回滚、排障）：`docs/runbooks/ops/rulehost-owner-runbook.md`。
