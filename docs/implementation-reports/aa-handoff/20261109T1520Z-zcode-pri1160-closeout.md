# 检查点 20261109T1520Z-zcode-pri1160-closeout · PRI-1160 收口

**结论：KEEP_NATIVE。** 实际治理变更为 0，治理后复测为 NOT RUN，没有实测节省。四条存量「建议保留」只是建议，**Owner 的逐条裁决待定**。机器可读版本见同名 `.json`。`LATEST.json` 未改动。

## 收口口径（以此为准）

- **L1、L3、L4**：在副本上验证了恢复请求可以入队。重新生效还需要 Console 批准，本轮未验证经 Console 批准后能否重新生效。
- **L2**：在当前版本下，已验证的派发、重开审批和修订三条路径都无法恢复它。
- **合并备选**：先把 L2 的独有约束纳入 L3，经 Owner 批准并确认新版已生效后，再由 Owner 决定是否停用 L2。

以上更正以追加形式写入：治理清单 MD/JSON、1440Z 检查点 MD/JSON。原记录逐行未改。

## 证据交付方式（实际执行）

- **可审阅 PR**：[#2454](https://github.com/csuzngjh/principles/pull/2454)，分支 `ai/PRI-1105-aa-b-optional-trim`，已按 git-7 合并 main `e7c7e6bba`。入库的是脱敏文档、脱敏证据 JSON、冻结的治理前基线，以及 `scripts/dev/aa-selector/` 下的两份离线脚本。
- **本机托管归档**（git-16）：`D:\Code\principles\artifacts\pri-1160-legacy-governance-evidence\`。
  - 共 96 个文件、178,937,265 字节，逐文件 SHA-256 一致，附 README 索引和 `SHA256SUMS.json`。
  - 已用 `git check-ignore` 证实被 `/artifacts/` 规则忽略，不会入库。
  - 内容包含真实工作区快照，**只能保留在本机**。
  - 源文件未删除，随工作树清理时移除。

## 回滚

交付物是文档和离线复测工具，revert 对应提交即可，不影响运行时。以下文件未改动：冻结基线、原始证据、B 线基线报告、`LATEST.json`。

## 验证

- 合并 main 后重跑复测：20/20 轮与冻结基线一致（合计 81,364 字符）。
- 本地发布意图守卫：PASS，结论为不需要 changeset。
- `workspace-tools` 守卫：PASS，21/21。
- eslint：exit 0。
- CI：以 PR 页面为准。

## 未执行

- 治理后复测
- Console 界面操作
- 恢复请求经 Console 批准后的重新生效
- 修订版本的批准
- Token

## 并行会话（2026-11-09T15:20Z 发现，追加记录）

另有一个会话在独立工作树 `PRI-1160-governance-refresh`（分支 `ai/PRI-1160-governance-refresh`，提交 `270c5406a`，以 `2308a677d` 为基）补交了三份材料：复核文档 `pri-1160-governance-refresh-20261109.md`，以及检查点 `20261109T1515Z-zcode-pri1160.{md,json}`。它还在本机做了归档 `artifacts/pri-1160/`。该会话遵守了本工作树的租约，没有写入。两边新增的文件互不重叠。

- 本会话**没有合并、也没有改动**该分支。理由：git-2 规定每个工作树只能有一个写者；该分支的写者租约有效到 19:03Z，可能仍在工作。
- 该文档中「L1/L3/L4 可恢复」「最后再停用 L2」两处表述，以本检查点的收口口径为准。治理清单的更正段第 6 条已作说明。
- 是否把该分支并入 #2454，由 Owner 决定。
