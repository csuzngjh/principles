# 检查点 — PD 架构减负 SPEC 执行 + PRI-698 Phase 1(2026-09-06,第二轮)

> 第一轮(S1/S2/S3)检查点见 `D:\Code\principles-adhoc-20260906-nav-map-repair\CHECKPOINT.md`。

## 本轮:PRI-698 Phase 1(Owner 下达实施指令后执行)

- worktree:`D:\Code\principles-PRI-698-rm-apply-orchestration`,branch `ai/PRI-698-rm-apply-orchestration`,commit `32b675f39`,基线 `9bbb041e4`,已推远端。lease 已释放。
- PR:**#1535**(标题按指令:PRI-698 Phase 1: ReleaseManager apply orchestration through installer)。
- Linear:PRI-698 已置 **In Review**,证据评论已附。
- Phase 0 文档:`docs/architecture/PRI-698-phase4-preflight-analysis.md`(随 PR 提交)。

## 已核实的关键机制事实(续跑必读)

- installer `install(options, pluginDir, mode, transaction?)` 第 4 参=采纳外部事务;独立路径字节不变。`InstallerJournal` 已导出,含 `generation`。
- RM.apply():journal 前阶段(refresh channel/ensure metadata)失败=未开事务的干净拒绝;journal planned 先行(Tier-1);获取失败 `ensureTerminalFailed` 补 failed;install 失败自身记 rolled_back/failed,RM 靠终态判断不双写。
- artifact TUF target 约定(Phase 1):`releases/<releaseId>/release-asset-<platform>-<arch>.tar.gz`,custom {releaseId, channel, platform},tarball 内容=asset 根目录(无包裹层)。发布管线对齐=flag 毕业前置。
- Console:双 flag(shadow+write_authority);apply-full RM handler 构造独立 authority;失败映射回 legacy `{success:false, reason, nextAction}` 体。
- fixture `createShadowFixture` 新参数:`candidateAsset`(平台匹配)+`artifact:()=>Buffer`(真实 tarball+签名 target,sha 先于 metadata 派生 releaseId 计算)。

## 测试与环境项

- RM apply 3/3、wiring 12/12、BDD 13/13、pd-console 全量 2484、core 全量 7806、installer 包 585/586。
- 环境失败(非回归,证据在 PR):`release-manager-install-smoke.test.ts` 假定机器无 live PD 安装;本机 `~/.pd/runtime/release-manager/dist/...` 存在使探针必过。CI 干净 runner 通过。
- worktree 全量验证前须补构建链:core/install-layout/host-runtime/codex-adapter/openclaw-plugin(tsc+build:bundle+build:types)/create-principles-disciple/pd-cli/pd-console(build:ui+tsc)。
- 陷阱:build 链会把 vendored 组件 package.json 版本戳成 live 版本、core 快照换行漂移——提交前 `git checkout --` 这六类文件。

## 状态速查

- PR #1533(S1 导航):OPEN 全绿,待 Owner 合并。
- PR #1535(PRI-698 Phase 1):OPEN,待 CI/评审收敛,待 Owner 合并。
- PRI-698:In Review。PRI-699(S2 不实施存证):Canceled。

## 续跑下一步

1. 收敛 PR #1535 评审/CI(若 main 前进,fetch+merge 远端再验,禁 force)。
2. Owner 合并 #1533 后按 git-8 清理 nav worktree;合并 #1535 后同法清理本 worktree。
3. Phase 2(rollback)开始前必须先证明:RM apply 产出可被同版本 rollback 恢复(PRI-698 票内约束)。
