<!-- pd-error-record
{
  "schemaVersion": 1,
  "recordType": "pattern",
  "recordId": "P-ERR-204",
  "displayId": "ERR-204",
  "title": "Safety-relevant downgrade implemented as a silent swallow: the accepted failure leaves no trace on the success path",
  "status": "active",
  "category": "Security & Safety",
  "ep": "EP-03",
  "createdAt": "2026-11-15",
  "source": "PRI-1219 / PR #2656 self-review (commit 94d74e2f shipped the mapping with no observation surface; fixed in 952237f8)"
}
-->

一处安全相关的降级判断被实现成「静默吞掉故障」：根探测 5xx 被读成「无更新根」后，成功路径上没有任何记录，于是「根轮转没有传播到存量安装」这件事在 Owner 面上完全不可见。

PRI-1219 的客户端修复本身是对的：TUF 工作流 5.3.3 每次刷新都探测 `<已信任版本+1>.root.json`，只有 403/404 才算「已是最新根」，而载体给 5xx 会让健康安装的每次 update check 都失败。把根探测的持续 5xx 读成「无更新根」是合理取舍。问题在于这次取舍**只改了行为，没留观测面**：`ResilientTrustFetcher` 在 `guard()` 里把 503 映射成 404 抛给 tuf-js 的 `loadRoot`，`loadRoot` break 之后刷新继续成功，而 `resolveTrustedReleaseTarget` 的返回值里没有任何字段说明「这次没有检查新根」。首个提交（94d74e2f）就是这样落地的。

后果不是理论风险：本机复现时载体是 503，如果它永久不恢复，安装会一直钉在 root v1，而仓库那边即使做了轮转也不会有人知道没有生效。更糟的是第一个提交的注释把这个取舍写成「不会构成信任降级，因为真正轮转会在后续验签处 fail-closed」——这个断言只对「轮转到旧根不认识的新密钥」成立；PD 的发布器是单密钥签全部角色，仅换版本号、或换密钥同时保留签名密钥的吊销型轮转，会在持有旧根的情况下继续验签通过，也就是**被推迟而不是被拒绝**。

自查后改为：成功结果带 `retainedTrustAnchor`（probeUrl / statusCode / message / nextAction），注释把两种轮转形状分开写清楚，并新增一条真实仓库用例——轮转到新密钥的同时把探测打成 503，必须仍然拒绝。变异检验：移除 `retainedAnchorReport` 展开后该用例报 `expected undefined to match object { …(2) }`。

Must check: 任何把「故障」重新解释为「可接受状态」的分支，必须同时在成功路径上产出可观测结果（返回值字段、事件或结构化日志），并在测试里断言该结果存在；注释/文档里的安全论证必须按「哪一种输入下成立」分开写，禁止用一句 fail-closed 覆盖所有轮转形状。变异检验必须能证明这条观测断言是承重的（改回旧行为后测试必失败）。
