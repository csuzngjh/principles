# Principles Disciple 文档索引

> 本文件是 docs/ 目录的导航索引。公开 docs 全部被 git 跟踪;私人 docs 在独立仓库,通过 `docs/.private/` junction 透明访问。

## 公开文档(本仓库)

### architecture/
系统设计文档:PD_ARCHITECTURE_OVERVIEW、DOMAIN_MODEL、COMPONENTS、DATA_ARCHITECTURE、OBSERVABILITY_ARCHITECTURE、SECURITY_ARCHITECTURE、AGENT_SOFTWARE_CONTRACT、ACTIVATION_CHANNELS、INTERNALIZATION_PIPELINE、PRUNING_PIPELINE、ERROR_ARCHITECTURE、CODEX_CLI_ADAPTER_DESIGN、CONFIGURATION_ARCHITECTURE、GLOSSARY、PERFORMANCE_BUDGETS、VERSIONING_AND_COMPATIBILITY、pd-task-manager、PD_Owner_Reader_Companion、PD_Pain_Signal_Audit、PD_SYSTEM_ARCHITECTURE、PD_System_Dynamics_Model、README、unified-friction-observer、AGENT_VALUE_PROP、ARCHITECTURE、WEBSITE_SPEC、runtime-v2-principle-lifecycle-review

### adr/
架构决策记录(ADR-0001 起,持续累积)

### brand/
品牌设计:PD_BRAND_CONSTITUTION、PD_UX_PRINCIPLES

### product/
产品定义:PRODUCT_IDENTITY

### superpowers/
设计 spec 与 plan(原位保留)

### plans/
历史 plan 归档(原位保留)

### process/
- `error-management/` — 错误三件套:ERROR_PATTERN_INDEX、ERROR_EXPERIENCE_HANDBOOK、ERROR_ARCHIVE
- `release/` — 发布流程:release-go-no-go-checklist、RELEASE_PROCESS(中英)
- `contributing/` — 贡献规范:CONTRIBUTING(中英)
- `DEVELOPMENT.md`、`TESTING.md`

### runbooks/
用户操作手册:USER_GUIDE(中英)、VALUE_PROPOSITION(中英)

### archive/
历史归档:
- `LEGACY_ENTRYPOINT_CENSUS.md`
- `architecture-audit-2026-06.md`
- `post-commit-bug-analysis/2026-06-28-report.md`
- `reviews/`(3 个 2026-05 评审:plugin-core-inventory、phase-1a-rulehost-activation-retrospective、document-vs-code-drift)
- `reports/production-e2e-low-risk-activation-2026-05-17.md`
- `pd-runtime-v2/NOCTURNAL_MIGRATION_MAP.md`

## 私人文档(独立仓库)

私人 docs 在独立 git 仓库 `D:/Code/principles-private/`,通过 `docs/.private/` junction 透明访问。

子目录:agents/、articles/、configuration/、design/、exemplars/、memory/、okr/、operator/、pd-runtime-v2/、product/、prototypes/、quality-reports/、reports/、reviews/、runbooks/、troubleshooting/、user/

常用私人 docs:
- `docs/.private/agents/issue-tracker.md` — Linear 工作流
- `docs/.private/agents/triage-labels.md` — 分诊标签
- `docs/.private/agents/domain.md` — 领域文档工作流
- `docs/.private/product/emotional-value.md` — 情绪价值设计准则
- `docs/.private/exemplars/` — PR review exemplars

## AI 助手访问规则

- 公开 docs:直接通过 `docs/<path>` 访问
- 私人 docs:通过 `docs/.private/<path>` junction 访问
- **禁止**在主 worktree 运行 `git clean -fdx`、`git stash -a`、`git checkout -f`(会破坏 junction 和未跟踪私人 docs)
- 如果 `docs/.private/` 丢失,运行 `.\scripts\setup-private-docs-symlink.ps1` 重建
