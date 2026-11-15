<!-- pd-error-record
{
  "schemaVersion": 1,
  "recordType": "pattern",
  "recordId": "P-ERR-206",
  "displayId": "ERR-206",
  "title": "A new diagnostic branch was written only for the reproduced input shape; the no-status branch dropped the cause chain and had no test",
  "status": "active",
  "category": "Missing Tests & Verification",
  "ep": "EP-03",
  "createdAt": "2026-11-15",
  "source": "PRI-1219 / PR #2656 self-review (commit 94d74e2f; fixed in 952237f8 with an ECONNREFUSED regression test)"
}
-->

新的诊断分支只为「作者复现过的那种输入形状」写，另一条分支静默丢掉了真实原因。

PRI-1219 把 「Release metadata could not be verified against the trusted root」这条会误导人的文案拆成两条：有 HTTP 状态码时报对象 + URL + 状态码，没有状态码时报 `no HTTP response`。第一条有测试覆盖（注入 503），第二条没有——而第二条恰恰是传输层故障（DNS 解析失败、TCP 拒绝、TLS 失败）走的路。

问题在于 Node 的 `fetch` 把真实原因放在 `cause` 里：顶层 message 只有 `fetch failed`，`connect ECONNREFUSED 127.0.0.1:PORT` 在下一层。原实现只取顶层 message，于是「载体坏掉」和「本机没网」在文案上无法区分——这正是这个函数存在的意义（帮 Owner 判断要不要去修网络）。旧代码至少完全不含细节，所以这不是回归，但它让新写的分支在一半输入上等于没写。

自查后改为：`describeErrorChain()` 沿 `cause` 链拼接最多 4 层并去重，两个分支都用它；新增用例「绑定后立即释放端口 → 连接被拒」，断言文案里保留 `ECONNREFUSED`。变异检验：把 `no HTTP response (${detail})` 改回不带 detail，该用例报 `expected 'Release metadata refresh failed while…' to contain 'ECONNREFUSED'`。

Must check: 每新增一条按输入形状分流的诊断/错误文案分支，测试里必须为**每条分支**各至少一个用例，且传输类输入的用例要断言底层错误码（`ECONNREFUSED` / `ENOTFOUND` / `ETIMEDOUT`）出现在最终文案里；凡是取 `error.message` 的地方先想一层 `cause`，Node/undici 与多数 SDK 都会把可操作信息下沉一层。
