import { describe, it, expect } from 'vitest';
import { generateFromTemplate, PainPattern } from '../../src/core/principle-compiler/template-generator';

describe('generateFromTemplate', () => {
  it('should generate code for a single tool with path pattern', () => {
    const patterns: PainPattern[] = [
      { toolName: 'write', pathRegex: 'secrets/.*\\.env' },
    ];

    const result = generateFromTemplate('P_066', 'Writing to secrets directory', patterns);

    expect(result).not.toBeNull();
    expect(result).toContain("export const meta");
    expect(result).toContain("export function evaluate(input)");
    expect(result).toContain('name: "Auto_P_066"');
    expect(result).toContain('ruleId: "R_P_066_auto"');
    expect(result).toContain('sourcePrincipleId: "P_066"');
    expect(result).toContain('coversCondition: "Writing to secrets directory"');
    expect(result).toContain('input.action.toolName === "write"');
    expect(result).toContain("secrets/.*\\\\.env");
    expect(result).toContain("input.action.normalizedPath");
    expect(result).toContain("decision: 'block'");
    expect(result).toContain("matched: true");
    expect(result).toContain("[P_066]");
  });

  it('should generate code for write tool with content pattern', () => {
    const patterns: PainPattern[] = [
      { toolName: 'write', contentRegex: 'BEGIN RSA PRIVATE KEY' },
    ];

    const result = generateFromTemplate('P_007', 'Writing private keys', patterns);

    expect(result).not.toBeNull();
    expect(result).toContain('input.action.toolName === "write"');
    expect(result).toContain("BEGIN RSA PRIVATE KEY");
    expect(result).toContain("paramsSummary.content");
  });

  it('should generate code for multiple tool patterns', () => {
    const patterns: PainPattern[] = [
      { toolName: 'bash', commandRegex: 'rm\\s+-rf\\s+/' },
      { toolName: 'write', pathRegex: 'secrets/', contentRegex: 'password' },
    ];

    const result = generateFromTemplate('P_010', 'Destructive operations', patterns);

    expect(result).not.toBeNull();
    expect(result).toContain('input.action.toolName === "bash"');
    expect(result).toContain("rm\\\\s+-rf\\\\s+/");
    expect(result).toContain("paramsSummary.command");
    expect(result).toContain('input.action.toolName === "write"');
    expect(result).toContain("secrets/");
    expect(result).toContain("password");
  });

  it('should return null when patterns array is empty', () => {
    const result = generateFromTemplate('P_066', 'some condition', []);
    expect(result).toBeNull();
  });

  it('should not contain forbidden patterns (require, import, fetch)', () => {
    const patterns: PainPattern[] = [
      { toolName: 'bash', commandRegex: 'dangerous' },
    ];

    const result = generateFromTemplate('P_099', 'Dangerous commands', patterns);

    expect(result).not.toBeNull();
    expect(result).not.toContain('require(');
    expect(result).not.toContain('import ');
    expect(result).not.toContain('fetch(');
  });

  it('should have proper structure with meta and evaluate function', () => {
    const patterns: PainPattern[] = [
      { toolName: 'edit', pathRegex: '\\.json$', contentRegex: 'admin.*true' },
    ];

    const result = generateFromTemplate('P_050', 'Modifying admin config', patterns);

    expect(result).not.toBeNull();

    // Check meta structure
    expect(result).toMatch(/export const meta = \{/);
    expect(result).toMatch(/name: "Auto_P_050"/);
    expect(result).toMatch(/version: '1\.0\.0'/);
    expect(result).toMatch(/ruleId: "R_P_050_auto"/);
    expect(result).toMatch(/sourcePrincipleId: "P_050"/);
    expect(result).toMatch(/compiledAt: "\d{4}-\d{2}-\d{2}T/);

    // Check evaluate function structure
    expect(result).toMatch(/export function evaluate\(input\)/);
    expect(result).toMatch(/decision: 'block'/);
    expect(result).toMatch(/matched: true/);
    expect(result).toMatch(/return \{ matched: false \}/);

    // Check edit tool uses new_string fallback
    expect(result).toContain("input.action.paramsSummary.content || input.action.paramsSummary.new_string");
  });
});
