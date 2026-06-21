# PD MVP 种子客户发布 Go/No-Go Checklist

> 发布前必须人工执行并签字。任何一项未勾选即 No-Go。
> 签字记录：在 PR 描述或 Linear issue 中注明执行人、日期、结果。

## 自动化门禁（CI 必须全绿）

- [ ] `verify-merge` 通过：`npm run verify:merge`
- [ ] `lint` 通过：`npm run lint`
- [ ] `check:error-handbook` 通过：`npm run check:error-handbook`
- [ ] CI `test-principles-core` 通过（含架构回归测试）
- [ ] CI `test-pd-cli` 通过（含 `cli-full-flow` E2E）
- [ ] CI `test-openclaw-plugin-unit` 通过
- [ ] CI `test-openclaw-plugin-integration` 通过
- [ ] CI `test-pd-console` 通过
- [ ] CI `test-create-principles-disciple` 通过（含 `smoke-packaged-install`）

## 发布包完整性（ERR-040）

- [ ] `npm pack --dry-run` 在 `packages/openclaw-plugin` 输出包含所有必需文件
- [ ] `cd packages/create-principles-disciple && npm test` 中 `smoke-packaged-install.test.ts` 通过
- [ ] 安装后 `pd --version` 在全新目录输出正确版本号
- [ ] 安装后 `pd runtime features --json` 在全新 workspace 返回默认配置

## Pain 捕获与原则生成

- [ ] `pd pain record --help` 显示用法（验证命令注册）
- [ ] `npm run e2e:story-a -- --trap trap-03` 产出真实 pain signal
- [ ] `pd diagnose run --task-id <id>` 完成诊断（或 `pd diagnose status --task-id <id>` 显示 succeeded）
- [ ] `pd candidate list --task-id <id>` 显示生成的 principle candidate

## Owner 审批操作（approve / edit / reject）

- [ ] `pd console` 启动后浏览器可访问 Console UI
- [ ] Console 中 pending approval 可见，可执行 approve 操作
- [ ] `pd runtime activation edit --help` 显示用法（owner edit 入口已注册）
- [ ] approve 后 `pd runtime activation list` 显示 active activation
- [ ] reject 后 `pd runtime activation list` 不显示该 activation

## SQLite 激活与 RuleHost 阻断

- [ ] `pd runtime activation dispatch --help` 显示用法
- [ ] dispatch 后 `pd runtime activation list --json` 返回非空 activations 数组
- [ ] RuleHost 对危险调用（如访问 `/etc/passwd`）被阻断：运行 `pd runtime internalization run-rulehost` 或对应 E2E 测试验证
- [ ] 安全调用（正常 tool call）不被 RuleHost 阻断

## Deactivate 回滚与持久化

- [ ] `pd runtime activation deactivate --help` 显示用法
- [ ] deactivate 后 `pd runtime activation list` 不再显示该 activation
- [ ] deactivate 后 RuleHost 不再拦截（行为回滚到激活前）
- [ ] 重启进程后 `pd runtime activation list` 结果与重启前一致（SQLite 持久化）

## Feature Flag 验证

- [ ] `pd runtime features --json` 中 MVP-Core flag 默认开（prompt / code_tool_hook / defer_archive）
- [ ] 所有 MVP-Gone flag 不可重新开启（nocturnal / idle_trigger / model_training / trainer）
- [ ] 每个 MVP-Core flag 的 `enabled: false` 关闭路径已验证零副作用

## 真实 LLM 验收

- [ ] SenseNova provider 验收：配置 `PD_SENSENOVA_API_KEY` 后 `pd diagnose run` 成功返回结构化输出
- [ ] LM Studio provider 验收：配置 `baseUrl=http://localhost:1234/v1` 后 `pd diagnose run` 成功返回结构化输出
- [ ] 两种 provider 的输出均通过 schema 验证（`status: succeeded`）

## 文档与 Issue 状态

- [ ] `npm run check:error-handbook` 通过
- [ ] Error Handbook 无 >90 天未归档条目
- [ ] 发布说明（changelog）已起草，含已知限制和回滚路径
- [ ] 无 P0 未修复 issue
- [ ] 无 P1 未修复 issue
- [ ] 所有 `lesson-learned` 标签的 issue 已有对应回归测试

## 回滚预案（ADR-0014 §5 要求）

- [ ] 每个 MVP-Core flag 都有 `enabled: false` 的关闭路径
- [ ] `npm unpublish` 流程已确认（npm 72 小时窗口）
- [ ] 版本回退流程已确认（git revert + 重新发布 patch 版本）
- [ ] 紧急联系渠道已告知种子客户

## 签字

- 执行人：_________________
- 日期：_________________
- 结果：☐ Go  ☐ No-Go
- 备注（若 No-Go，列出阻塞项）：_________________
