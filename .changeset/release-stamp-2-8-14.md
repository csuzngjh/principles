---
"create-principles-disciple": patch
---

为产品版本 2.8.14 重铸安装器 payload 身份戳：2.8.13 的签名频道发布（seq-48）已将 data_schema_forward_readable_from 定格为 2.8.12，而 release 身份不可变使 floor 修正无法就地重做；持有 2.8.11 的安装因此无法跨边界普通更新。经对安装构建提交（5e3b8d53）至 main 全范围取证：零破坏性 DDL、迁移链纯附加，2.8.11 数据对新版本可读有证据保障。需要一个新的 patch cohort 让签名频道能以新的 release 身份发出 floor=2.8.11 的兼容声明。
