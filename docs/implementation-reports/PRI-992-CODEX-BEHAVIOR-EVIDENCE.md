# PRI-992 Codex 行为样例证据接线

## 已批准范围与现实核查

Owner 已批准定点恢复、Codex 证据接线、复用成功草案与真实规则质量验证。本变更仅实现证据接线；定点恢复已有 PRI-991 / PR #2046，不再重复实现。core 已拥有 BehaviorEvidencePort、准入预检、Owner 标签选择、摘要和 CAS 恢复权威。缺口是 Codex workspace worker 没有注入端口，导致现有任务无法使用已有能力。

沿用 OpenClaw 现有组装逻辑，将组装与历史验证移至 host-runtime。OpenClaw 保留原入口、TrajectoryRegistry 生命周期和词表；Codex 传入自身词表。CLI evidence attach/resume 通过同一只读端口读取真实轨迹，使用宿主持久声明解析词表。未知宿主或缺声明不再猜成 OpenClaw，而是明确拒绝；旧工作区应通过已配置宿主正常启动刷新声明。没有直接修改生产安装、数据库或配置。

## 验收与边界

- 真实 SQLite 轨迹：明确标签形成有效包、历史只含选中调用之前的行、Codex Bash 映射 execute、跨会话与悬空引用拒绝。
- 缺失或损坏数据源是 evidence_source_error，不能误报 Owner 未标注；不存在的数据库不得被创建。
- 真实 worker：缺标签进入 needs_human_review，零模型调用、零 run、零 attempt；已有标签通过真实组装后才到模型边界。
- CLI 公共解析及既有 CAS/审计回归；OpenClaw 既有组装/上下文回归；发布 bundle satellite 纯度与大小守卫。
- 组装成功不等于生成成功，更不等于规则正确。现有 RuleContextV2 没有 Owner 批准事实，不能仅凭 git commit 与只读调用区别宣称“已批准正常开发放行”已得到证明。Codex V2 执行仍按现有不支持契约停用；不新增执行 provider，不部署规则。
- 对原痛苦信号的生产恢复/真实生成状态由外部运行验收另附证据；本报告不是生产成功证明。

## Complexity Delta

New durable source of truth: NO
New persisted schema/state: NO
New subsystem/service/background process: NO
New public abstraction/interface: YES — 现有组装能力迁至共享宿主边界，增加最小数据源接口和只读工厂，消除 Codex→OpenClaw 依赖；叶子导出避免 plugin satellite 拉入 LLM 图。
New runtime feature flag: NO
New cross-package dependency: NO — 四包已有依赖关系。
New host/platform-specific behavior: YES — 现有 Codex worker 注入自身词表与共享证据端口；真实 worker 回归验证。
New external/network capability: NO

可撤销方式：revert 本变更；无迁移、无治理数据重写。Owner 情绪价值：将无限 pending 区分为可操作的样例审批停点或可诊断的数据源故障，减少“到底有没有运行”的不确定感。

## 工程验证记录（2026-10-16）

- `npm run verify:merge` 完整 EXIT=0（8GB Node heap）。首次网站媒体校验失败于未拉取的 Git LFS 视频，执行 `git lfs pull` 后完整重跑通过；未修改网站或降低校验。
- host-runtime 全包 487/487 通过；随后按评审补充 4 项损坏 JSON / source 分类回归，两文件最终 23/23 通过（含三个 prototype 污染键的来源故障回归）。
- Codex workspace worker 30/30 通过，包含真实缺标签审批停点、真实 trajectory assembly 与 runner 依赖注入。临时移除 port 的原缺陷负控两例均失败，恢复后再验证通过。
- CLI evidence 公共解析/持久化回归 14/14，OpenClaw BEP/上下文兼容回归 31/31。
- 实际 plugin bundle 的 satellite forbidden dependencies 均 0，rulehost-evidence 474175 bytes < 553489 上限；未放松守卫。
- 所有源码修改仅位于隔离 Git 工作区；未写生产安装、状态库、标签、配置和激活状态。

ERR 路由复核：EP-02/03 由真实 worker、consumer、SQLite、typed storage fault 和全包构建验证；EP-04 由真实 Commander+CAS+JSON 原回归验证；EP-09 由移除接线的两条失败负控验证；EP-12 无新增宿主管理文件写入。叶子公开导出仅服务现有插件消费者，未引入第二套组装权威。

## 原痛苦信号副本验收（父代理独立执行）

原痛苦信号只读备份的隔离副本中，复用原 Scribe，完成单任务恢复 → 预检 NHR → 受托明确标签 attach → resume → ready；没有伪造或持久化生产标签。首次真实生成请求 HTTP 502；第二次确实运行 3 turn（28261 input / 2548 output tokens），在验收设置的 180000ms 有界预算处停止，结果 pd_budget_timeout、工件 0。这只证明本次有界试验没有产出，不证明原 profile 自身预算必定失败，也不能将第二次归因 provider 空响应。没有 RuleCode 正向质量结论。

隔离复核 COPY-ISOLATION-VERIFICATION.json 显示两副本除目标52d外 task 行相同、approvals/activations 逐行相同；生产目标两任务仍 failed 3/3。原始证据位于 D:/Code/pd-deliveries/codex-pain-recovery-20261015/，外部报告是运行验收证据，未作为代码或治理状态权威。

## 交付复核

提交后发布门检查发现 installer 发布意图缺失，已在同一 changeset 明确列入 create-principles-disciple，不绕过 N-5/C4。此前 working-tree 阶段的 merge gate 不能替代提交后发布意图验证；最终推送仍走完整门禁。

定点恢复 PR #2046 在本轮同时被另一会话更新至 ad729da39，已覆盖只读预检、坏 metadata 拒绝和审计保护。本轮本地重复补丁未推入远程，保留对方完整提交；独立复核最新提交 core 49/49、CLI 18/18 通过。最新源码 CLI 对原两任务只执行默认 dry-run，均 eligible_budget_reset_required、wouldWriteAudit=false，无生产恢复。ERR-001/023 两条复核记录经官方 writer 生成，原样保留于本 PR，避免随本地重复补丁废弃而丢失；未另造模式。
