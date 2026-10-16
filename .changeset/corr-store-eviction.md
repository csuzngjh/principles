---
'@principles/core': patch
'principles-disciple': patch
'create-principles-disciple': patch
---

修正纠正词库到顶后学习通道冻结的根因：满 200 词时按证据淘汰最没用的学习词（seed/user 永不被淘汰），不再抛错；UPDATE/REMOVE 与 ADD 共用同一条词身份规则，未命中只记一次可读跳过；拒绝把动作词当 term 入库；学习不再删除 Owner 播种词；每次词库变更进 SYSTEM 日志。Stage2 回写不再用判词覆盖命中词，观察员据此拿到真实的 REMOVE 证据。
