import { describe, it, expect, vi } from 'vitest';
import { handleBeforeToolCall } from '../../src/hooks/gate';
import * as fs from 'fs';
import * as path from 'path';

vi.mock('fs');

describe('Pre-Write Gate Hook', () => {
  const workspaceDir = '/mock/workspace';
  
  it('should block risky write when plan is not READY', () => {
    const mockCtx = { workspaceDir };
    const mockEvent = { 
        toolName: 'write', 
        params: { file_path: 'src/db/user.ts' } 
    };

    const profilePath = path.join(workspaceDir, 'docs', 'PROFILE.json');
    const planPath = path.join(workspaceDir, 'docs', 'PLAN.md');

    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      if (p === profilePath) {
        return JSON.stringify({ risk_paths: ['src/db/'], gate: { require_plan_for_risk_paths: true } });
      }
      if (p === planPath) {
        return 'STATUS: DRAFT\n';
      }
      return '';
    });

    const result = handleBeforeToolCall(mockEvent as any, mockCtx as any);

    expect(result).toBeDefined();
    expect(result?.block).toBe(true);
    expect(result?.blockReason).toContain('Modification blocked');
  });

  it('should allow risky write when plan is READY', () => {
    const mockCtx = { workspaceDir };
    const mockEvent = { 
        toolName: 'write', 
        params: { file_path: 'src/db/user.ts' } 
    };

    const profilePath = path.join(workspaceDir, 'docs', 'PROFILE.json');
    const planPath = path.join(workspaceDir, 'docs', 'PLAN.md');

    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      if (p === profilePath) {
        return JSON.stringify({ risk_paths: ['src/db/'], gate: { require_plan_for_risk_paths: true } });
      }
      if (p === planPath) {
        return 'STATUS: READY\n';
      }
      return '';
    });

    const result = handleBeforeToolCall(mockEvent as any, mockCtx as any);

    expect(result).toBeUndefined();
  });

  it('should allow non-risky write regardless of plan', () => {
     const mockCtx = { workspaceDir };
     const mockEvent = { 
         toolName: 'write', 
         params: { file_path: 'src/components/button.ts' } 
     };
 
     const profilePath = path.join(workspaceDir, 'docs', 'PROFILE.json');
     const planPath = path.join(workspaceDir, 'docs', 'PLAN.md');
 
     vi.mocked(fs.existsSync).mockReturnValue(true);
     vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
       if (p === profilePath) {
         return JSON.stringify({ risk_paths: ['src/db/'], gate: { require_plan_for_risk_paths: true } });
       }
       if (p === planPath) {
         return 'STATUS: DRAFT\n';
       }
       return '';
     });
 
     const result = handleBeforeToolCall(mockEvent as any, mockCtx as any);
 
     expect(result).toBeUndefined();
  });

  describe('Path & Tool Regression Tests', () => {
    it('should intercept "exec" command creating a file in protected path', () => {
      const mockCtx = { workspaceDir };
      const mockEvent = { 
          toolName: 'exec', 
          params: { command: 'mkdir -p src/new_dir && echo "// test" >> src/new_dir/test.ts' } 
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        return JSON.stringify({ risk_paths: ['src/'], gate: { require_plan_for_risk_paths: true } });
      });

      const result = handleBeforeToolCall(mockEvent as any, mockCtx as any);

      expect(result).toBeDefined();
      expect(result?.block).toBe(true);
      expect(result?.blockReason).toContain('Modification blocked');
    });

    it('should NOT intercept "bash" read-only commands even with risky keywords', () => {
      const mockCtx = { workspaceDir };
      const mockEvent = { 
          toolName: 'bash', 
          params: { command: 'ls -R src/secret_logic' } 
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        return JSON.stringify({ risk_paths: ['src/'], gate: { require_plan_for_risk_paths: true } });
      });

      const result = handleBeforeToolCall(mockEvent as any, mockCtx as any);

      // Read-only commands should be allowed
      expect(result).toBeUndefined();
    });

    it('should intercept improved regex with multiple flags', () => {
      const mockCtx = { workspaceDir };
      const mockEvent = { 
          toolName: 'exec', 
          params: { command: 'mkdir -v -p src/test' } 
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        return JSON.stringify({ risk_paths: ['src/'], gate: { require_plan_for_risk_paths: true } });
      });

      const result = handleBeforeToolCall(mockEvent as any, mockCtx as any);

      expect(result).toBeDefined();
      expect(result?.block).toBe(true);
    });
  });
});
