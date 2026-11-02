# PD Release & Delivery Architecture Optimization --- SPEC Package v1.2

本套件围绕 Owner 已确认的三个目标：可靠、轻量、易维护。范围严格限定于 PD
发布、安装、更新及其直接依赖。

v1.2（2026-11-02）：**可靠性优先**修订。来源：PRI-1069 / PRI-1070 用户故障
报告及其源码核查评论、G0 只读调查报告（基线 `b98e7e339`）。修订明细见
`SPEC-V1.2-REVISION-NOTES.md`。

## 阅读顺序

1.  `SPEC-PD-RELEASE-DELIVERY-001.md` --- 总体目标、范围、不变量和阶段
    Gate。
2.  `SPEC-PD-RELEASE-RELIABILITY-001.md` ---
    安装、更新、备份、回滚和恢复。
3.  `SPEC-PD-RELEASE-FOOTPRINT-001.md` --- npm / Release / runtime /
    backup / 历史资产体积治理。
4.  `SPEC-PD-RELEASE-ARCH-SIMPLIFICATION-001.md` --- Release
    Check、Executor、依赖解析、状态与 pipeline 简化。
5.  `PD_RELEASE_DELIVERY_ACCEPTANCE_PLAN.md` ---
    平台、故障注入、浏览器和发布 Gate。
6.  `PD_RELEASE_DELIVERY_EXECUTION_RUNBOOK.md` --- 本地 AI / ZCode
    的逐步执行手册。
7.  `SPEC-SELF-REVIEW-AND-EVIDENCE-20261102.md` --- v1.0
    自评、代码抽查证据和未核实事项。

## Owner 战略基准

-   把 PD 建设成可靠、轻量、易维护的成熟产品。
-   保留有真实价值的安全机制，删除没有实际收益的复杂度。
-   聚焦发布、安装、更新及其直接依赖。

## 当前执行状态

**SPEC v1.2 修订 + G1 可靠性实施已授权**（Owner 指令，2026-11-02）。
G0 只读调查已完成并交付（基线 `b98e7e339`，R-1..R-4 全部
CONFIRMED_IN_CHECKOUT）。当前授权范围：

- SPEC v1.2 增量修订入库；
- G1 可靠性 P0 修复（P0-1 探针身份绑定、P0-2 子进程退出确认、
  P0-3 备份/恢复部分成功、P0-4 状态与物理一致性、P0-5 更新生命周期核验）；
- 测试、故障注入、CI 验证、提交与 PR 交付。

仍不授权：合并 PR、发布 npm/GitHub Release、部署公网、修改真实用户
`~/.pd` / `~/.openclaw` 安装、删除用户备份或历史 Release 资产、执行不可逆
生产操作、修改 AGENTS.md / 治理规则 / Linear 状态 / ERR 树状态。

G1 完成后停止，不自动进入 G2/G3。

## 重要原则

-   历史测量不是当前基线；
-   静态扫描不能单独证明运行时不可达；
-   lockfile 重复不等于物理重复；
-   多个 workflow 不等于过度设计；
-   可复现性双构建不应被误删；
-   必要安全能力不能为减量而降级；
-   主工作区和未知文件必须按 `AGENTS.md` 保护。
