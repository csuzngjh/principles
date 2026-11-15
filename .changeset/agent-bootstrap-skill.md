---
"create-principles-disciple": minor
---

pd-setup 预装技能（bootstrap 渠道）：新增宿主中立的单技能 `agent-skill/pd-setup/SKILL.md`（双语正文，指向 canonical 指南），随安装器包分发（files 新增 agent-skill）。新子命令 `npx create-principles-disciple agent-skill install|status|uninstall [--host openclaw|codex|workbuddy|all] [--json]`，把技能复制进各宿主**用户级**技能目录（OpenClaw `~/.openclaw/skills/`、Codex `~/.agents/skills/`、WorkBuddy `~/.workbuddy/skills/`，三宿主约定均实测）。归属标记门控：只创建/替换/删除带 `pd-agent-skill: pd-setup` 标记的文件，目标被第三方技能占用时明确拒绝（绝不覆盖）；幂等（同内容 unchanged）。刻意不入 skill-catalog/4 交付目录平价体系——bootstrap 渠道归安装器所有，与插件交付技能集是两条通道；smoke 契约新增"tarball 恰好携带 1 个 bootstrap 技能"断言。
