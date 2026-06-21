# PD MVP 种子客户发布 Go/No-Go Checklist

> 发布前必须人工执行并签字。任何一项未勾选即 No-Go。
> 签字记录：在 PR 描述或 Linear issue 中注明执行人、日期、结果。

## 自动化门禁（CI 必须全绿）

- [ ] `test-principles-core` 通过（含架构回归测试 246 用例）
- [ ] `test-pd-cli` 通过
- [ ] `test-openclaw-plugin-unit` 通过
- [ ] `test-openclaw-plugin-integration` 通过
- [ ] `test-openclaw-plugin-coverage` 通过（覆盖率不低于阈值）
- [ ] `test-pd-console` 通过
- [ ] `test-create-principles-disciple` 通过（含 smoke-packaged-install）
- [ ] `lint` 通过
- [ ] `verify:merge` 通过（含 scan-runtime-contract-violations）
- [ ] 三条激活路径独立 E2E 通过（activation-prompt / activation-defer-archive / activation-rule-host）
- [ ] Story A 全链路测试通过（story-a-full-chain）
- [ ] CLI 端到端测试通过（cli-full-flow）

## 人工门禁（人工执行 + 签字）

### 真实环境验证
- [ ] `npm run e2e:story-a` 在 Linux 环境跑通，输出符合预期
- [ ] 在全新目录 `npm install principles-disciple` 成功
- [ ] `npx principles-disciple --version` 输出正确版本号
- [ ] `pd runtime features --json` 在全新 workspace 成功返回默认配置

### 三条激活路径真实场景
- [ ] prompt 通道：原则注入后，下次 prompt 构建可见原则指令
- [ ] defer_archive 通道：归档引用写入后可检索
- [ ] code_tool_hook 通道：RuleHost 拦截生效，匹配 tool call 被评估

### 可逆性验证
- [ ] owner rollback 后，prompt 读取器不再返回规则
- [ ] owner rollback 后，RuleHost 不再拦截
- [ ] owner rollback 后，defer_archive 引用不再可检索

### Feature Flag 验证
- [ ] `.pd/config.yaml` 中所有 MVP-Core flag 默认开（prompt / code_tool_hook / defer_archive / code_rule_capability）
- [ ] 所有 MVP-Gone flag 不可重新开启（nocturnal / idle_trigger / model_training / trainer）
- [ ] 每个 MVP-Core flag 的 `enabled: false` 关闭路径已验证零副作用

### 文档与错误手册
- [ ] `npm run check:error-handbook` 通过
- [ ] Error Handbook 无 >90 天未归档条目
- [ ] 发布说明（changelog）已起草，含已知限制和回滚路径

### Issue 状态
- [ ] 无 P0 未修复 issue
- [ ] 无 P1 未修复 issue
- [ ] 所有 lesson-learned 标签的 issue 已有对应回归测试

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
