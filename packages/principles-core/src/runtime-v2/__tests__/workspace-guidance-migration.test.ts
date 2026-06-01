import { describe, it, expect } from 'vitest';
import {
  migrateWorkspaceGuidance,
  containsStalePlanMdGuidance,
  STALE_PLAN_MD_PATTERNS,
} from '../workspace-guidance-migration.js';

describe('workspace-guidance-migration', () => {
  describe('STALE_PLAN_MD_PATTERNS coverage', () => {
    it('has at least one rule per target filename suffix', () => {
      const targetSuffixes = [
        'AGENTS.md',
        'THINKING_OS.md',
        'MEMORY.md',
        'admin/SKILL.md',
        'reflection/SKILL.md',
        'report/SKILL.md',
        'pd-grooming/SKILL.md',
      ];
      for (const suffix of targetSuffixes) {
        const hasRule = STALE_PLAN_MD_PATTERNS.some(
          (p) => p.description.toLowerCase().includes(suffix.toLowerCase()),
        );
        expect(hasRule, `No rule targets ${suffix}`).toBe(true);
      }
    });
  });

  describe('AGENTS.md migration', () => {
    it('removes Physical interception line', () => {
      const input = 'Some text\nPhysical interception ensures safety.\nMore text';
      const result = migrateWorkspaceGuidance(input, 'AGENTS.md');
      expect(result.changed).toBe(true);
      expect(result.migrated).not.toContain('Physical interception');
      expect(result.migrated).toContain('Some text');
      expect(result.migrated).toContain('More text');
    });

    it('removes 物理拦截 line', () => {
      const input = 'Some text\n物理拦截确保安全。\nMore text';
      const result = migrateWorkspaceGuidance(input, 'AGENTS.md');
      expect(result.changed).toBe(true);
      expect(result.migrated).not.toContain('物理拦截');
    });

    it('removes Single source of truth PLAN line', () => {
      const input = 'Some text\nSingle source of truth: PLAN.md tracks all changes.\nMore text';
      const result = migrateWorkspaceGuidance(input, 'AGENTS.md');
      expect(result.changed).toBe(true);
      expect(result.migrated).not.toContain('Single source of truth');
      expect(result.migrated).not.toContain('PLAN.md');
    });

    it('removes PLAN.md status READY line', () => {
      const input = 'Some text\nWrite to `PLAN.md` (status: READY) before proceeding.\nMore text';
      const result = migrateWorkspaceGuidance(input, 'AGENTS.md');
      expect(result.changed).toBe(true);
      expect(result.migrated).not.toContain('PLAN.md` (status: READY)');
    });

    it('removes project physical plan line', () => {
      const input = 'Some text\nThe project physical plan governs all file writes.\nMore text';
      const result = migrateWorkspaceGuidance(input, 'AGENTS.md');
      expect(result.changed).toBe(true);
      expect(result.migrated).not.toContain('project physical plan');
    });

    it('removes 项目物理计划 line', () => {
      const input = 'Some text\n项目物理计划管理所有文件写入。\nMore text';
      const result = migrateWorkspaceGuidance(input, 'AGENTS.md');
      expect(result.changed).toBe(true);
      expect(result.migrated).not.toContain('项目物理计划');
    });

    it('removes L2 delegation line tied to PLAN.md', () => {
      const input = 'Some text\nL2 delegation through PLAN.md gate enforcement.\nMore text';
      const result = migrateWorkspaceGuidance(input, 'AGENTS.md');
      expect(result.changed).toBe(true);
      expect(result.migrated).not.toContain('L2 delegation');
    });

    it('removes L2 委派 line tied to PLAN.md', () => {
      const input = 'Some text\nL2 委派通过 PLAN.md 门控执行。\nMore text';
      const result = migrateWorkspaceGuidance(input, 'AGENTS.md');
      expect(result.changed).toBe(true);
      expect(result.migrated).not.toContain('L2 委派');
    });

    it('does not change clean AGENTS.md', () => {
      const input = '# Agent Instructions\n\nFollow the principles.\nNo gate references here.';
      const result = migrateWorkspaceGuidance(input, 'AGENTS.md');
      expect(result.changed).toBe(false);
      expect(result.migrated).toBe(input);
    });
  });

  describe('THINKING_OS.md migration', () => {
    it('removes " or `PLAN.md`" from T-02 directive', () => {
      const input =
        '<must>TRUST FILES, NOT YOUR CONTEXT WINDOW. You MUST actively write your intermediate conclusions, breakpoints, and next steps to `memory/.scratchpad.md` or `PLAN.md`.</must>';
      const result = migrateWorkspaceGuidance(input, 'THINKING_OS.md');
      expect(result.changed).toBe(true);
      expect(result.migrated).toContain('`memory/.scratchpad.md`');
      expect(result.migrated).not.toContain('or `PLAN.md`');
    });

    it('removes "或 `PLAN.md`" from T-02 directive (zh)', () => {
      const input =
        '<must>信任文件，而不是你的上下文窗口。你必须主动将中间结论、断点和后续步骤写入 `memory/.scratchpad.md` 或 `PLAN.md`。</must>';
      const result = migrateWorkspaceGuidance(input, 'THINKING_OS.md');
      expect(result.changed).toBe(true);
      expect(result.migrated).toContain('`memory/.scratchpad.md`');
      expect(result.migrated).not.toContain('或 `PLAN.md`');
    });

    it('removes PLAN.md status READY line', () => {
      const input = 'Some text\nWrite to `PLAN.md` (status: READY) for persistence.\nMore text';
      const result = migrateWorkspaceGuidance(input, 'THINKING_OS.md');
      expect(result.changed).toBe(true);
      expect(result.migrated).not.toContain('PLAN.md` (status: READY)');
    });

    it('does not change clean THINKING_OS.md', () => {
      const input =
        '<must>TRUST FILES, NOT YOUR CONTEXT WINDOW. You MUST actively write your intermediate conclusions, breakpoints, and next steps to `memory/.scratchpad.md`.</must>';
      const result = migrateWorkspaceGuidance(input, 'THINKING_OS.md');
      expect(result.changed).toBe(false);
    });
  });

  describe('MEMORY.md migration', () => {
    it('removes PLAN.md mechanism protects line', () => {
      const input = 'Some text\nThe PLAN.md mechanism protects critical files.\nMore text';
      const result = migrateWorkspaceGuidance(input, 'MEMORY.md');
      expect(result.changed).toBe(true);
      expect(result.migrated).not.toContain('PLAN.md mechanism protects');
    });

    it('removes PLAN.md 机制保护 line', () => {
      const input = 'Some text\nPLAN.md 机制保护关键文件。\nMore text';
      const result = migrateWorkspaceGuidance(input, 'MEMORY.md');
      expect(result.changed).toBe(true);
      expect(result.migrated).not.toContain('PLAN.md 机制保护');
    });

    it('removes STATUS: READY line', () => {
      const input = 'Some text\nRecover by setting STATUS: READY in PLAN.md.\nMore text';
      const result = migrateWorkspaceGuidance(input, 'MEMORY.md');
      expect(result.changed).toBe(true);
      expect(result.migrated).not.toContain('STATUS: READY');
    });

    it('appends historical note when content is removed', () => {
      const input = 'Some text\nThe PLAN.md mechanism protects critical files.\nMore text';
      const result = migrateWorkspaceGuidance(input, 'MEMORY.md');
      expect(result.changed).toBe(true);
      expect(result.migrated).toContain('[Historical: confirm-first gate was removed in PRI-286');
    });

    it('does not append historical note when no content is removed', () => {
      const input = 'Some text\nNo stale references here.\nMore text';
      const result = migrateWorkspaceGuidance(input, 'MEMORY.md');
      expect(result.changed).toBe(false);
      expect(result.migrated).not.toContain('[Historical');
    });
  });

  describe('admin/SKILL.md migration', () => {
    it('removes Ensure PLAN.md contains Target Files heading line', () => {
      const input =
        '- **Documentation Integrity**: Check if `.principles/PROFILE.json`, `PLAN.md` etc. exist.\n- **Structure Completion**: Ensure `PLAN.md` contains `## Target Files` heading.';
      const result = migrateWorkspaceGuidance(input, 'admin/SKILL.md');
      expect(result.changed).toBe(true);
      expect(result.migrated).not.toContain('Ensure `PLAN.md` contains `## Target Files`');
    });

    it('removes 确保 PLAN.md 包含 Target Files 标题 line', () => {
      const input =
        '- **文档完整性**: 检查 `.principles/PROFILE.json`, `PLAN.md` 等是否存在。\n- **结构补全**: 确保 `PLAN.md` 包含 `## Target Files` 标题。';
      const result = migrateWorkspaceGuidance(input, 'admin/SKILL.md');
      expect(result.changed).toBe(true);
      expect(result.migrated).not.toContain('确保 `PLAN.md` 包含 `## Target Files`');
    });

    it('removes PLAN.md from trailing list position', () => {
      const input = 'Check `.principles/PROFILE.json`, `PLAN.md` etc.';
      const result = migrateWorkspaceGuidance(input, 'admin/SKILL.md');
      expect(result.changed).toBe(true);
      expect(result.migrated).not.toContain('`PLAN.md`');
    });

    it('removes PLAN.md from leading list position', () => {
      const input = 'Check `PLAN.md`, `.principles/PROFILE.json` etc.';
      const result = migrateWorkspaceGuidance(input, 'admin/SKILL.md');
      expect(result.changed).toBe(true);
      expect(result.migrated).not.toContain('`PLAN.md`');
    });
  });

  describe('reflection/SKILL.md migration', () => {
    it('replaces Check PLAN.md or early conversation (en)', () => {
      const input = '- **Goal**: What was our original objective? (Check `PLAN.md` or early conversation)';
      const result = migrateWorkspaceGuidance(input, 'reflection/SKILL.md');
      expect(result.changed).toBe(true);
      expect(result.migrated).toContain('Check early conversation context');
      expect(result.migrated).not.toContain('`PLAN.md`');
    });

    it('replaces 检查 PLAN.md 或早期对话 (zh)', () => {
      const input = '- **Goal**: 我们最初的目标是什么？(检查 `PLAN.md` 或早期对话)';
      const result = migrateWorkspaceGuidance(input, 'reflection/SKILL.md');
      expect(result.changed).toBe(true);
      expect(result.migrated).toContain('检查早期对话上下文');
      expect(result.migrated).not.toContain('`PLAN.md`');
    });

    it('replaces Update PLAN.md (en)', () => {
      const input = '- Update `PLAN.md`, mark current progress, ensure seamless continuation after compaction.';
      const result = migrateWorkspaceGuidance(input, 'reflection/SKILL.md');
      expect(result.changed).toBe(true);
      expect(result.migrated).toContain('Update `memory/.scratchpad.md`');
      expect(result.migrated).not.toContain('Update `PLAN.md`');
    });

    it('replaces 更新 PLAN.md (zh)', () => {
      const input = '- 更新 `PLAN.md`，标记当前进度，确保压缩后能无缝衔接。';
      const result = migrateWorkspaceGuidance(input, 'reflection/SKILL.md');
      expect(result.changed).toBe(true);
      expect(result.migrated).toContain('更新 `memory/.scratchpad.md`');
      expect(result.migrated).not.toContain('更新 `PLAN.md`');
    });
  });

  describe('report/SKILL.md migration', () => {
    it('removes PLAN.md from task description (en)', () => {
      const input =
        'analyze current conversation context, `PLAN.md`, and recent `memory/ISSUE_LOG.md`';
      const result = migrateWorkspaceGuidance(input, 'report/SKILL.md');
      expect(result.changed).toBe(true);
      expect(result.migrated).not.toContain('`PLAN.md`');
      expect(result.migrated).toContain('analyze current conversation context and recent');
    });

    it('removes PLAN.md from task description (zh)', () => {
      const input = '分析当前的对话上下文、`PLAN.md` 和最近的 `memory/ISSUE_LOG.md`';
      const result = migrateWorkspaceGuidance(input, 'report/SKILL.md');
      expect(result.changed).toBe(true);
      expect(result.migrated).not.toContain('`PLAN.md`');
      expect(result.migrated).toContain('分析当前的对话上下文和最近的');
    });
  });

  describe('pd-grooming/SKILL.md migration', () => {
    it('removes PLAN.md from Core Assets trailing position', () => {
      const input = '- `README.md`, `PLAN.md`\n- `.principles/`, `.state/`';
      const result = migrateWorkspaceGuidance(input, 'pd-grooming/SKILL.md');
      expect(result.changed).toBe(true);
      expect(result.migrated).not.toContain('`PLAN.md`');
      expect(result.migrated).toContain('`README.md`');
    });

    it('removes PLAN.md from Core Assets leading position', () => {
      const input = '- `PLAN.md`, `README.md`\n- `.principles/`, `.state/`';
      const result = migrateWorkspaceGuidance(input, 'pd-grooming/SKILL.md');
      expect(result.changed).toBe(true);
      expect(result.migrated).not.toContain('`PLAN.md`');
      expect(result.migrated).toContain('`README.md`');
    });
  });

  describe('containsStalePlanMdGuidance', () => {
    it('returns true for AGENTS.md with stale content', () => {
      expect(containsStalePlanMdGuidance('Physical interception ensures safety.', 'AGENTS.md')).toBe(true);
    });

    it('returns false for AGENTS.md without stale content', () => {
      expect(containsStalePlanMdGuidance('Clean content here.', 'AGENTS.md')).toBe(false);
    });

    it('returns true for THINKING_OS.md with stale content', () => {
      expect(containsStalePlanMdGuidance('Write to `memory/.scratchpad.md` or `PLAN.md`.', 'THINKING_OS.md')).toBe(true);
    });

    it('returns true for MEMORY.md with stale content', () => {
      expect(containsStalePlanMdGuidance('The PLAN.md mechanism protects critical files.', 'MEMORY.md')).toBe(true);
    });

    it('returns true for skill SKILL.md with stale content', () => {
      expect(containsStalePlanMdGuidance('Ensure `PLAN.md` contains `## Target Files` heading.', 'admin/SKILL.md')).toBe(true);
    });

    it('returns false for unknown filename with PLAN.md mention', () => {
      expect(containsStalePlanMdGuidance('Some file mentions PLAN.md', 'RANDOM.md')).toBe(false);
    });
  });

  describe('fresh install verification', () => {
    it('current AGENTS.md templates contain no stale PLAN.md gate guidance', () => {
      const freshAgentsMd = `# Agent Instructions

Follow the principles and guidelines set by the owner.
No gate references here.
Use memory/.scratchpad.md for persistence.`;
      expect(containsStalePlanMdGuidance(freshAgentsMd, 'AGENTS.md')).toBe(false);
    });

    it('current THINKING_OS.md templates contain no stale PLAN.md gate guidance', () => {
      const freshThinkingOs = `<must>TRUST FILES, NOT YOUR CONTEXT WINDOW. You MUST actively write your intermediate conclusions, breakpoints, and next steps to \`memory/.scratchpad.md\`.</must>`;
      expect(containsStalePlanMdGuidance(freshThinkingOs, 'THINKING_OS.md')).toBe(false);
    });

    it('current MEMORY.md templates contain no stale PLAN.md gate guidance', () => {
      const freshMemory = `# Memory\n\nWorking memory and context tracking.\nNo stale references.`;
      expect(containsStalePlanMdGuidance(freshMemory, 'MEMORY.md')).toBe(false);
    });

    it('current admin/SKILL.md templates contain no stale PLAN.md gate guidance', () => {
      const freshAdmin = `- **Documentation Integrity**: Check if \`.principles/PROFILE.json\` etc. exist.\n- **Structure Completion**: Ensure workspace structure is complete.`;
      expect(containsStalePlanMdGuidance(freshAdmin, 'admin/SKILL.md')).toBe(false);
    });

    it('current reflection/SKILL.md templates contain no stale PLAN.md gate guidance', () => {
      const freshReflection = `- **Goal**: What was our original objective? (Check early conversation context)\n- Update \`memory/.scratchpad.md\`, mark current progress.`;
      expect(containsStalePlanMdGuidance(freshReflection, 'reflection/SKILL.md')).toBe(false);
    });

    it('current report/SKILL.md templates contain no stale PLAN.md gate guidance', () => {
      const freshReport = `analyze current conversation context and recent \`memory/ISSUE_LOG.md\``;
      expect(containsStalePlanMdGuidance(freshReport, 'report/SKILL.md')).toBe(false);
    });

    it('current pd-grooming/SKILL.md templates contain no stale PLAN.md gate guidance', () => {
      const freshGrooming = `- \`README.md\`\n- \`.principles/\`, \`.state/\``;
      expect(containsStalePlanMdGuidance(freshGrooming, 'pd-grooming/SKILL.md')).toBe(false);
    });
  });

  describe('upgrade migration preserves non-stale content', () => {
    it('preserves all non-stale lines in AGENTS.md', () => {
      const input = `# Agent Instructions

Follow the owner's principles.
Physical interception ensures safety.
Always verify before acting.
项目物理计划管理所有文件写入。
Keep workspace clean.`;
      const result = migrateWorkspaceGuidance(input, 'AGENTS.md');
      expect(result.changed).toBe(true);
      expect(result.migrated).toContain("Follow the owner's principles.");
      expect(result.migrated).toContain('Always verify before acting.');
      expect(result.migrated).toContain('Keep workspace clean.');
      expect(result.migrated).not.toContain('Physical interception');
      expect(result.migrated).not.toContain('项目物理计划');
    });

    it('preserves all non-stale lines in MEMORY.md and adds historical note', () => {
      const input = `# Memory

Working memory and context tracking.
The PLAN.md mechanism protects critical files.
Recover by setting STATUS: READY in PLAN.md.
Important operational notes here.`;
      const result = migrateWorkspaceGuidance(input, 'MEMORY.md');
      expect(result.changed).toBe(true);
      expect(result.migrated).toContain('Working memory and context tracking.');
      expect(result.migrated).toContain('Important operational notes here.');
      expect(result.migrated).not.toContain('PLAN.md mechanism protects');
      expect(result.migrated).not.toContain('STATUS: READY');
      expect(result.migrated).toContain('[Historical: confirm-first gate was removed in PRI-286');
    });

    it('handles full-path filenames (Windows and Unix)', () => {
      const input = 'Physical interception ensures safety.';
      const winResult = migrateWorkspaceGuidance(input, 'D:\\workspace\\AGENTS.md');
      expect(winResult.changed).toBe(true);
      const unixResult = migrateWorkspaceGuidance(input, '/home/user/workspace/AGENTS.md');
      expect(unixResult.changed).toBe(true);
    });

    it('handles skill files with full paths', () => {
      const input = 'Ensure `PLAN.md` contains `## Target Files` heading.';
      const result = migrateWorkspaceGuidance(input, '/workspace/.principles/skills/admin/SKILL.md');
      expect(result.changed).toBe(true);
      expect(result.migrated).not.toContain('Ensure `PLAN.md`');
    });
  });
});
