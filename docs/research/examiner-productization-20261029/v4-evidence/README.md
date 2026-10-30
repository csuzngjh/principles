# v4 原始验证日志

最终完整本地脚本执行：final-serial-tests.txt（91 文件，1688 通过，零失败/跳过）；随后新增的审核表绑定回归随 final-freeze-tests.txt 执行（7/7，含 1 项新增）。最终源码/新主干构建后的完整相关集合：final-related-tests.txt（38 文件，751 通过，零失败/跳过）。集合存在重叠，不把多次执行相加宣称独立测试数。

final-lint.txt：最新主干构建后 11/11 包通过，原有告警保留。implementation-lint 与 final-implementation-lint 是本轮新增/修改 mjs 的定向检查，空文件表示该次零诊断，而非未运行。

首次 all-script-tests.txt 失败：并发构建 dist 时被读取、过载超时；完成构建后 all-script-tests-isolated.txt 1685/1685。final-all-script-tests.txt 另有 1 个 dev-concurrency 竞态断言失败；race-scope.txt 列出该模块和测试与 origin/main 一致，无 Examiner 导入。最终串行完整重跑全部通过，不通过删除或跳过测试规避。保留全部这些失败记录。

human-gate.txt 是预期退出 1 的正式人审拒绝：PENDING 是正确安全结果；它与 replay.txt 记录的都是修复前的 v4 冻结（packageHash 10c3c88b…、reportHash c3a5c8b6…、subjectHash d41aa703…），原文未改。post-review-fix-freeze.txt 是修复后 v4 重新生成的实跑记录：重放、人审门、三组冻结/入口/接入测试与盲审 ZIP 校验，其 subjectHash d6b08e05… 与当前包、ZIP 内 receipts.template.json 一致。该文件在分支刷新到当前 main 后重跑：main 期间修改了 `lib/challenge-openclaw-host.mjs`，而冻结绑定完整 lib 实现，因此按同一规则再次重新生成；两次重生成之间 executions 与报告各行逐字节不变，仅实现绑定 hash 及其派生 hash 移动。historical-freeze.txt 检查 CEB 三研究及旧版 EXM 原始哈希；旧包不以当前实现冒充重放。committed-bytes-before-fix.txt 记录发现历史日志被 Git 换行转换，随后通过仅研究证据目录的 -text 和重新暂存原文修复，原始日志文件未编辑。最终日志 SHA256SUMS.json 可校验全部证据。

命令、准入矩阵及范围见 ../../EXAMINER-v4-OFFLINE-ACCEPTANCE.md；正式独立人审材料见 ../../EXAMINER-v4-HUMAN-REVIEW.md。所有执行只用本地 Mock/测试负控，未启动真实实验。
## CI 与跨平台范围

PR #2224 修复提交 932b0670ff 的干净 Ubuntu / Node 22 CI：脚本套件 91 文件，1680 通过、0 失败、8 跳过（总 1688）。其中 openclaw-child-temp-env 6 项和 worktree-root 1 项是 Windows 专属；pipeline-evolution-evidence 1 项因私有 PRI-653 lab 原始材料未包含在 CI checkout 而跳过。这 8 项均已在本地 Windows 全套执行通过；不是 Examiner 验收的未执行项。Companion 的 7 项平台专属跳过属于未修改的其他包，其 Windows manifest/junction 语义不能在 Linux 伪造通过，不计为 Examiner 校准证据。CodeRabbit 未自动审查（仓库策略），CI failure reminder 在无失败时跳过，二者不是跳过测试。

CI 同一提交完整 scripts 套件已从 Git 冻结输入执行 v4，因而还证明 Node22 与本地 Node26 的报告/执行 hash 一致；跨平台差异仅在明确平台测试收集。ci-shared-runtime.txt 保留完整 CI 构建、脚本及相关包验证日志。
