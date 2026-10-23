# PRI-1019 Codex RuleCode本地闭环实施计划

> 执行：subagent-driven-development；Owner已在本会话明确批准SPEC，常规实现连续完成，不再分阶段征求批准。

**Goal:** 正式Owner声明、生成能力核验、共享运行时投影与真实Codex阻止/放行闭环；生产规则最终激活仍由Owner治理。

**Architecture:** 沿现有SQLite/Console身份/RuleContext/Runner/HostRuntime连接。只新增缺少的单一事实权威；不新增通用审批系统或逐工具模型调用。

**Tech Stack:** TypeScript、SQLite、Vitest、现有PD CLI/Console/Codex hooks。

## 1. 来源与数据契约（Luna facts）
- [x] 新增包内 `internalization/design-gate-facts.ts`：事实/声明schema、纯验证、四态语义。
- [x] 在既有SQLite seam新增 `store/design-gate/sqlite-design-gate-store.ts`，schema加法迁移；按现有connection取得DB，不增加I/O seam。
- [x] 服务端认证身份传入、revision CAS、撤回、幂等、原始记录保留；设计批准与原则approval隔离。
- [x] 真实SQLite往返与坏JSON/数组/冲突/失效/Owner身份负控。

## 2. 生成与评审（Luna generation）
- [x] 扩充 `artificer-intent-preflight.ts` 既有port：优先读取正式能力声明，保留旧调用兼容与负控；前置门/Runner镜像一致。
- [x] `artificer-prompt-builder.ts` 正式事实字段说明，不再要求读取不存在的事实或禁止读取已注入字段。
- [x] `evaluator-prompt-builder.ts` 模型展示投影有界，完整权威工件/回放仍由Runner消费；不提高50000上限、不改持久化样例。
- [x] 生成有能力/无能力、实际not_approved仍能生成；超长原材料与确定性回放内容保留回归。

## 3. 宿主事实（Luna host）
- [x] 复用 `workspace-rule-context.ts`/production factory现有入口，每次真实event绑定原生session、project workspace、SPEC字节摘要和声明scope。
- [x] 未登记/跨任务/跨项目/旧SPEC/来源故障为unknown，结构化暴露；显式受管未批准/撤回为not_approved。
- [x] read/search可信豁免；execute不能按命令前缀豁免，复合命令负控。
- [x] 同一事实契约用于消费能力port与Hook投影，不从tool params接入批准。

## 4. Owner入口与集成（root）
- [x] 复用Console Owner身份上下文，增加声明/查看/撤回API与就地可见表单；客户端identity字段不信任。
- [x] 服务端重算SPEC摘要、绑定已观察原生session/project；明确可机读scope不是自然语言语义证明。
- [x] 共享导出/consumer注入及最小架构registry更新由root统一完成，避免并发barrel冲突。
- [x] 接口真实route及UI交互测试，不直接写生产DB。

## 5. 验收与交付（root）
- [ ] 复用原实验隔离副本和21项外部回归，保留负控，另加未见情景。
- [ ] build顺序core→host-runtime→adapter/CLI/Console；不能在消费者测试期间clean依赖dist。
- [ ] 原生Codex实验先证明Hook子进程HOME/workspace隔离，再通过正式声明/审批API：未批准阻止写入；批准后同一动作落盘；撤回/跨范围/坏数据负控。
- [ ] 正规候选installer/setup交付并核查实际模块能力，原信号仅官方有界恢复；缺真实Owner输入/激活不伪造。
- [ ] Standards/Specification两轴评审；error router Pass2；精确head CI、commit/push/PR、Linear handoff与证据报告。

## 统一规则

主checkout只读，不改安装文件/生产DB。共享worktree按文件所有权分工，不相互reset/覆盖；root负责最终commit。预算30,000 tokens/session；到预算边界明确交接，不能假报完成。


最新核验与未闭合项见 `docs/implementation-reports/PRI-1019-codex-rulecode-local-closure-20261023.md`。未完成的原生/生产验收不以源码完成代替。
