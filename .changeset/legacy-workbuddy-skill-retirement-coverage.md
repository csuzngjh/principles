---
"create-principles-disciple": patch
---

安装/升级时一并退役全部旧版用户级 PD 技能，消除 WorkBuddy 宿主的同名技能竞争。

- 根因：`legacy-workbuddy-skill.ts` 的退役注册表只登记 `pd-record-pain`。`5c383e572`（2026-10-22「统一 PD 宿主技能」）删除/重写的 `pd-status` / `pd-setup` / `pd-disable` 与统一前的 `pd-review` 从未登记，升级后仍留在 `~/.workbuddy/skills/`；其中旧 `pd-review` 与插件内当前 `pd-review` 同名，宿主可能加载到指向 `~/.codex/plugins/cache/`、`host.codex`、Codex `/hooks` 的旧说明。
- 修复：注册表扩展为 5 个技能、11 个 git 历史 blob 的精确 SHA-256；新增 `deprecateAllLegacyWorkbuddySkills()` 在一次安装中遍历全部条目，安装器改调该函数；保留单技能 API 与 `published` 注入以兼容现有调用。沿用既有保护：只 rename 不删除、frontmatter `name` 必须匹配目录名、Owner 改过的副本保留并告警、幂等。`pd-review` 只收统一前的 blob，统一后仍随插件分发的 4 个 payload 明确排除，避免误伤有效技能。
- 回归：单测 13 个全绿（含真实残留 blob 归属、仍分发 payload 不被误退役、多技能一次退役与幂等）；用本机 4 个残留文件的真实字节做端到端验证，全部识别为 `deprecated` 并 rename，`SKILL.md` 不再被宿主发现。eslint / tsc 均 0 错误。
- 发布：改动只在 installer 包内，但它必须随新版发布才会到达已安装机器；不加 changeset 则历史残留永远清不掉。
