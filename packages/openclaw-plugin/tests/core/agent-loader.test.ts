/**
 * Tests for Agent Loader
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// Mock fs module
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readdirSync: vi.fn(),
  readFileSync: vi.fn(),
}));

// Mock path module for resolve
vi.mock('path', () => ({
  resolve: vi.fn((...args) => args.join('/')),
  join: vi.fn((...args) => args.join('/')),
  basename: vi.fn((p, ext) => {
    const parts = p.split('/');
    const name = parts[parts.length - 1];
    return ext ? name.replace(ext, '') : name;
  }),
}));

describe('AgentLoader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });



  describe('loadAgentDefinition', () => {
    it('should return null for non-existent agent', async () => {
      const { loadAgentDefinition } = await import('../../src/core/agent-loader.js');
      
      vi.mocked(fs.existsSync).mockReturnValue(false);
      
      const result = loadAgentDefinition('nonexistent');
      expect(result).toBeNull();
    });

    it('should parse agent with frontmatter (string tools)', async () => {
      const { loadAgentDefinition } = await import('../../src/core/agent-loader.js');
      
      // Use actual file format: tools as comma-separated string
      const mockContent = `---
name: Explorer
description: Fast evidence collector
tools: read_file, glob, search_file_content
model: default
---

# Explorer Agent

You are an evidence collector. Your job is to gather information quickly.`;

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(mockContent);
      
      const result = loadAgentDefinition('explorer');
      
      expect(result).not.toBeNull();
      expect(result?.name).toBe('Explorer');
      expect(result?.description).toBe('Fast evidence collector');
      expect(result?.tools).toEqual(['read_file', 'glob', 'search_file_content']);
      expect(result?.systemPrompt).toContain('Explorer Agent');
    });

    it('should parse agent with array tools in frontmatter', async () => {
      const { loadAgentDefinition } = await import('../../src/core/agent-loader.js');
      
      // Tools as YAML array
      const mockContent = `---
name: Diagnostician
description: Root cause analyzer
tools:
  - read_file
  - search_file_content
  - glob
---

# Diagnostician Agent

You analyze root causes.`;

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(mockContent);
      
      const result = loadAgentDefinition('diagnostician');
      
      expect(result).not.toBeNull();
      expect(result?.name).toBe('Diagnostician');
      expect(result?.tools).toEqual(['read_file', 'search_file_content', 'glob']);
    });

    it('should handle agent without frontmatter', async () => {
      const { loadAgentDefinition } = await import('../../src/core/agent-loader.js');
      
      const mockContent = `# Simple Agent

Just a simple system prompt.`;

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(mockContent);
      
      const result = loadAgentDefinition('simple');
      
      expect(result).not.toBeNull();
      expect(result?.name).toBe('simple'); // Falls back to filename
      expect(result?.description).toBe('');
      expect(result?.systemPrompt).toBe(mockContent.trim());
    });

    it('should handle read errors gracefully', async () => {
      const { loadAgentDefinition } = await import('../../src/core/agent-loader.js');
      
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error('Read error');
      });
      
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      
      const result = loadAgentDefinition('broken');
      expect(result).toBeNull();
      
      consoleSpy.mockRestore();
    });
  });

  describe('listAvailableAgents', () => {
    it('should return empty array when directory does not exist', async () => {
      const { listAvailableAgents } = await import('../../src/core/agent-loader.js');
      
      vi.mocked(fs.existsSync).mockReturnValue(false);
      
      const result = listAvailableAgents();
      expect(result).toEqual([]);
    });

    it('should list markdown files as agent names', async () => {
      const { listAvailableAgents } = await import('../../src/core/agent-loader.js');
      
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue([
        'explorer.md',
        'diagnostician.md',
        'auditor.md',
        'not-a-markdown.txt',
      ] as unknown as fs.Dirent[]);
      
      const result = listAvailableAgents();
      expect(result).toContain('explorer');
      expect(result).toContain('diagnostician');
      expect(result).toContain('auditor');
      expect(result).not.toContain('not-a-markdown');
    });
  });

  describe('loadAllAgents', () => {
    it('should load all available agents', async () => {
      const { loadAllAgents } = await import('../../src/core/agent-loader.js');
      
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue([
        'explorer.md',
        'planner.md',
      ] as unknown as fs.Dirent[]);
      
      vi.mocked(fs.readFileSync)
        .mockReturnValueOnce(`---
name: Explorer
description: Evidence collector
---

Explorer prompt`)
        .mockReturnValueOnce(`---
name: Planner
description: Plan creator
---

Planner prompt`);
      
      const result = loadAllAgents();
      
      expect(result.size).toBe(2);
      expect(result.has('explorer')).toBe(true);
      expect(result.has('planner')).toBe(true);
    });
  });
});
