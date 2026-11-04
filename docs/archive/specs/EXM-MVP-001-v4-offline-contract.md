# EXM-MVP-001-v4 离线实现契约

本轮依据 Owner 2026-10-30 明确的 v4 研发与交付要求，增量实施已批准 v0.5。仅离线；不构成 Gold 批准或研究执行授权。v3、旧 EXM 和 CEB 冻结文件不变。

## 最小改动、输入输出与失败

复用 env/scorer/validator/ActorLoop/replay/freeze。v4 在 gold 增加 `assessmentContract=structured.v1`；inferred 提交结构化 `assessment={observedEventRefs,tentativeDirection,nextSteps}`，unknown 提交 `uncertainty={reasonCode,nextSteps}`。nextSteps 是已注册观察/问答动作，不能是任意命令。自由 narrative 不参加验收；旧 minimalSteps 保留为兼容说明。

路径阻断事件与是否违规分离。v4 gold.pathConstraints 为已绑定来源的逐路径 BLOCK_FORBIDDEN/BLOCK_REQUIRED/BLOCK_ALLOWED 契约；没有契约不得猜测违规。DETECTED 负迁移只由明确禁止且实际发生的阻断等冻结事件定义；合法阻断为 NOT_DETECTED，缺判据为 UNKNOWN。因果结论始终 NOT_ESTIMABLE（Mock 不证明 Principle 导致行为）。

refusedCount 保留原含义：预算拒绝次数。新增 refusalActionCount 表示环境记录的 refuse 动作次数，报告两者独立。来源可明确标 STALE/REVOKED，观察仍可记录但不得支持当前事实；来源/对象/版本/hash/事件不匹配进入结构化 evidenceValidation。

## 正式人工审核的可信入口

审核工具只读，使用 Node 标准 Ed25519 验签，不增加服务、网络或依赖。Owner 在研究包外维护审核权限文件，操作员通过独立核对的 canonical SHA-256 固定该文件；这个 pin 不能从模型候选、receipt 或研究包中自动读取。权限列明 HUMAN、独立性、可审核 schema、审核 subjectHash、审核者公钥、有效期和撤销状态。默认无权限文件、无 pin 时拒绝。

人审 receipt 保留现有字段，增加 subjectHash 和 signature。签名覆盖除 signature 外的完整 canonical JSON；使用权限表中公钥，而非 receipt 自带密钥。subjectHash 绑定题集、Gold、真实来源、评分实现和运行配置，计算时排除人审 receipt，避免哈希循环。Mapping 与逐题 Gold 都须各自签名，原有 mapping/gold/source 哈希检查继续生效。

将 `reviewTrust` 作为离线操作员的可信输入传给现有 gate，绝不加入模型 spec 或 sourceBundle；校准模式的 FIXTURE receipt 永不晋升为正式有效题。只读 CLI 验证整个审核集合，缺一题即不能 READY。权限文件未配置时只输出 READY_FOR_INDEPENDENT_HUMAN_REVIEW，不伪造人类或签名。本轮没有发现可直接使用的已授权 Gold 审核者；发布签名 TUF key 不具有 Gold 审核权限，不能挪用。

调用链：冻结输入/subject → 独立盲审 → 人类用自己的私钥签名 receipt → 操作员固定 Owner 权限文件 hash → 只读审核集合验证 → 既有正式 Gold gate。签名证明来源完整性；人工身份与独立性由 Owner 的权限指定负责，密码学不证明语义判断正确。

## 验收、成本与回滚

验证结构化不确定性正反例、合法/非法/未知阻断、预算拒绝与动作计数、stale-source 及 source/hash/对象/版本/事件负控；真实临时测试密钥只存在测试隔离目录，不进入研究审核记录。签名正例及权限不足、未知签名者、撤销、过期、错 subject、错题 hash、篡改和缺 receipt 均测试。

完整 Lab、定向 lint、九题/六策略重放、报告复算、旧冻结原文校验和 CI 都须实际执行。v4 manifest 在源码最终稳定后生成，任何实现变化必须显式重新版本化。成本仅本地测试和人工审核时间，无模型费用。回滚停用 v4，不迁移生产数据，不改旧文件。

Complexity Delta：既有研究持久契约和公开模块接口增量 YES；新 durable authority NO（复用 Owner 指定权）、新服务 NO、flag NO、跨包依赖 NO、宿主能力 NO、网络能力 NO。审核工具不能签发 Stage G/R/F2 或运行真实 transport。
