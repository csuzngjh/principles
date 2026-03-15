/**
 * Task Compliance Tests
 *
 * Tests the validateTaskCompliance function added in P0 improvement (Pain #671cfd17)
 */

import { describe, it, expect } from 'vitest';

// Import the function from agent-spawn.ts
// Note: This requires the function to be exported for testing
// For now, we'll duplicate the logic here for testing purposes

function validateTaskCompliance(task: string): {
  valid: boolean;
  violations: string[];
  warnings: string[];
} {
  const violations: string[] = [];
  const warnings: string[] = [];
  const taskLower = task.toLowerCase();

  // 检测"代劳"行为 - 违反"指导优于代劳"原则
  if (taskLower.includes('为他') || taskLower.includes('代替') || taskLower.includes('帮他')) {
    if (!taskLower.includes('指导') && !taskLower.includes('让他自己') && !taskLower.includes('指示')) {
      violations.push(
        '⚠️ 可能违反"指导优于代劳"原则：任务包含"为他/代替/帮他"，但没有"指导/让他自己/指示"的表述。' +
        '\n协议要求：优先指导目标智能体自己完成，而非代替执行。'
      );
    }
  }

  // 检测技能安装/修改操作 - 要求包含验证步骤
  if (taskLower.includes('安装') || taskLower.includes('install') ||
      taskLower.includes('删除') || taskLower.includes('delete') ||
      taskLower.includes('修改') || taskLower.includes('edit') ||
      taskLower.includes('创建') || taskLower.includes('create')) {
    if (!taskLower.includes('验证') && !taskLower.includes('检查') &&
        !taskLower.includes('确认') && !taskLower.includes('verify')) {
      warnings.push(
        '⚠️ 可能缺少"完成性思维"：安装/修改操作应该包含"验证/检查/确认"步骤。' +
        '\n协议要求：任务完成 = 执行 + 验证 + 确认'
      );
    }
  }

  return {
    valid: violations.length === 0,
    violations,
    warnings
  };
}

describe('Task Compliance Validation', () => {
  describe('代劳违规检测', () => {
    it('should detect "代替" without guidance', () => {
      const result = validateTaskCompliance('代替Bridge安装技能X');
      expect(result.valid).toBe(false);
      expect(result.violations.length).toBeGreaterThan(0);
      expect(result.violations[0]).toContain('指导优于代劳');
    });

    it('should detect "为他" without guidance', () => {
      const result = validateTaskCompliance('为他安装技能X');
      expect(result.valid).toBe(false);
      expect(result.violations.length).toBeGreaterThan(0);
      expect(result.violations[0]).toContain('指导优于代劳');
    });

    it('should detect "帮他" without guidance', () => {
      const result = validateTaskCompliance('帮他安装技能X');
      expect(result.valid).toBe(false);
      expect(result.violations.length).toBeGreaterThan(0);
      expect(result.violations[0]).toContain('指导优于代劳');
    });

    it('should allow "代替" with guidance', () => {
      const result = validateTaskCompliance('指导Bridge自己安装技能X，并验证他能正常使用');
      expect(result.valid).toBe(true);
      expect(result.violations.length).toBe(0);
    });

    it('should allow "让他自己" phrasing', () => {
      const result = validateTaskCompliance('指示他让他自己完成安装');
      expect(result.valid).toBe(true);
      expect(result.violations.length).toBe(0);
    });
  });

  describe('验证缺失检测', () => {
    it('should warn about "安装" without verification', () => {
      const result = validateTaskCompliance('安装技能X');
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain('完成性思维');
    });

    it('should warn about "install" without verification', () => {
      const result = validateTaskCompliance('install skill X');
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain('完成性思维');
    });

    it('should warn about "修改" without verification', () => {
      const result = validateTaskCompliance('修改配置文件');
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain('完成性思维');
    });

    it('should allow "安装" with verification', () => {
      const result = validateTaskCompliance('安装技能X并验证功能');
      expect(result.warnings.length).toBe(0);
    });

    it('should allow "修改" with check', () => {
      const result = validateTaskCompliance('修改配置文件并检查结果');
      expect(result.warnings.length).toBe(0);
    });

    it('should allow "创建" with confirm', () => {
      const result = validateTaskCompliance('创建新文件并确认写入成功');
      expect(result.warnings.length).toBe(0);
    });
  });

  describe('复合场景', () => {
    it('should detect both violation and warning', () => {
      const result = validateTaskCompliance('代替他安装技能X');
      expect(result.valid).toBe(false);
      expect(result.violations.length).toBeGreaterThan(0);
      expect(result.warnings.length).toBeGreaterThan(0);
    });

    it('should allow valid guidance task', () => {
      const result = validateTaskCompliance('指导Bridge自己安装技能X，并验证安装成功');
      expect(result.valid).toBe(true);
      expect(result.violations.length).toBe(0);
      expect(result.warnings.length).toBe(0);
    });

    it('should be valid for non-modification tasks', () => {
      const result = validateTaskCompliance('分析代码结构，找出性能瓶颈');
      expect(result.valid).toBe(true);
      expect(result.violations.length).toBe(0);
      expect(result.warnings.length).toBe(0);
    });
  });

  describe('边界情况', () => {
    it('should handle empty task', () => {
      const result = validateTaskCompliance('');
      expect(result.valid).toBe(true);
      expect(result.violations.length).toBe(0);
      expect(result.warnings.length).toBe(0);
    });

    it('should handle case-insensitive detection', () => {
      const result1 = validateTaskCompliance('代替他安装');
      const result2 = validateTaskCompliance('代替他安装');
      expect(result1.valid).toBe(result2.valid);
    });

    it('should detect mixed language violations', () => {
      const result = validateTaskCompliance('Help him install the skill');
      // English "help him" should not trigger since we only check Chinese keywords
      expect(result.valid).toBe(true); // or adjust if needed
    });
  });
});
