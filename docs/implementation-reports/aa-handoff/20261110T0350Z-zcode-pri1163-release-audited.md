# 检查点 20261110T0350Z-zcode-pri1163-release-audited · PRI-1163

**裁决：发布包有接线——无缺陷、无需修复（三分支之第二分支）。** 机器可读版本见同名 `.json`；完整报告 `docs/implementation-reports/pri-1163-release-round-key-audit-20261110.md`。

## 结论分层

- **发布版本已验证**：npm 3.1.3 = tag `v3.1.3`(`e7c7e6bba`) 构建（`dist/bundle.js` sha256 `7301253d…6546d` 于 npm tarball / 本机安装 / 隔离重建三处逐字节一致；发布输入已确认：包内 gitHead + publish-npm run 42639299312 同 SHA success）；发布 bundle 内轮次接线**存在且功能正常**（假宿主夹具 6/6 PASS，退出码 0）。
- **生产用户轮轮转尚待观察**：3.1.3 安装（11-09 22:53 本地）后无任何真实用户轮发生（`user_turns` 全库末行 11-07；被观测会话末次真实用户轮 11-02）；观测到的注入轮全部是每小时心跳轮（`heartbeat.every="1h"`；宿主 v2026.11.1 源码传 `trigger='heartbeat'`）→ 无轮次记录 → `legacy_fifo_prefix_v1`（设计内回退，与夹具 A3 逐字一致）。
- **仓库共享入口已验证**：#2460 冻结证据保留，不受本票影响。

## 三份对照物

| 对照物 | 关键事实 |
| --- | --- |
| npm | SRI `sha512-VqLo…`（新下载复算 MATCH）/ shasum `3461c20c…` / 入口 `dist/bundle.js`（`openclaw.extensions` 唯一项）哈希 `7301253d…` / 包内 `gitHead=e7c7e6bba` |
| 安装 | 同一入口同一字节；版本 3.1.3；宿主 OpenClaw 2026.11.1(4ffdd20)；实际加载依赖 = better-sqlite3@13.0.3 native + Node 内建（host-runtime 半已内联 bundle） |
| 重建 | `git archive e7c7e6bba` + `npm ci` + build core/install-layout/host-runtime + `npm pack`（prepack=esbuild --production）→ **逐字节一致**（确定性复现，非参考对照） |

## 行为对照（发布 bundle，6/6 PASS）

连续用户轮 `fair_rotation_v1` ord 3→4 且选择集轮换；同 runId 重试 `round=4` 重放、装配逐字节一致、单次写入；heartbeat → `legacy_fifo_prefix_v1` + 零写入（与生产观测逐字一致）；trigger 缺省视作用户交互。

## 归因与更正

- 生产恒 FIFO 的条件 = 非用户轮（心跳）；11-03 同一心跳会话曾得到**恒 ord=72 的伪轮转**（不写 turn 读 MAX+1 常数键）——正是 #2398 doc comment 明言修复的缺陷，3.1.3 行为是修复后的正确形态。
- **PRI-1162 §3「疑似发布物与源码不一致」证伪撤销**：根因 = 对 `minify:true` 产物按函数名搜索的方法缺陷；压缩不敏感字面量（`roundKeyProvider`×3、`fair_rotation_v1`×2、`legacy_fifo_prefix_v1`×3、`selectionRoundOrdinal`×3、`user_turn_persisted`、`round key resolved`）在发布 bundle 中全部在场。#2460 源码验收结论与冻结证据继续有效。
- 最小修复方案：**无**（无缺陷）。心跳轮是否参与轮转公平属 PRI-930 设计问题，需 Owner 另行立项。最低成本补证：真实用户消息一条后读 `.state/logs/events_*.jsonl` 期待 `fair_rotation_v1` + 序数推进（本票边界禁宿主启动，不可代做）。
- A 线正交：夹具事件只含 `{prompt, messages}`（无显式身份）轮转照常——轮次键不依赖 PRI-1119 的用户消息身份。

## 边界与事故披露

宿主启动 0、模型调用 0、安装 0、发布 0。**事故 → 清理终态（Owner 批准后执行）**：夹具首次运行因插件把显式声明工作区（`principles-disciple.json` → `D:\.openclaw\workspace`）优先于 hook ctx 临时目录，向生产 `trajectory.db user_turns` 写入 3 行合成数据（id 1215/1216/1217，会话 `fixture-sess-0001`×2 + `dbg-sess`×1，内容为夹具测试文本）；events JSONL 零污染；per-session 隔离下对真实会话零影响。Owner 于 ~04:07Z 对话内批准「批准，现在清理」后执行：事务内 `changes=3` 恰好 3 行，总数 1216→**1213**、合成会话残留 0，独立只读复核一致；其他表零污染。**证据更正**：此前评论所称备份文件 `pre-delete-backup.db` 实为误建 0 字节空文件（备份 cp 被安全钩子拦截未执行）——真实保护=删前快照 `pre-delete-snapshot-20261110T0344Z.db`（03:44Z，sha256 `8ca0b808…21c95`，total=1216 含全部 3 行）+ 逐行留档 + 前序会话 02:58Z 副本证明事故前基线=1213；闭环链 1213+3=1216−3=1213。含生产数据的副本一律留在 gitignored `.tmp/` 永不入库，入库仅哈希/行数/合成行内容。Mimosa `scanner_enobufs` 风险照旧，不宣称安全结论。
