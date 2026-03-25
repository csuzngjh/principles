/**
 * Build Artifacts Verification Tests
 *
 * These tests verify that the production build includes all required artifacts.
 * Unlike unit tests that mock file system, these tests check actual files.
 *
 * Run after: npm run build:production
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = join(__dirname, '..');

describe('Build Artifacts', () => {
  const isProductionBuild = existsSync(join(packageRoot, 'dist'));

  describe('Required paths', () => {
    const requiredPaths = [
      { path: 'dist/bundle.js', label: 'Main bundle' },
      { path: 'dist/openclaw.plugin.json', label: 'Plugin manifest' },
      { path: 'dist/templates', label: 'Templates directory' },
    ];

    for (const { path, label } of requiredPaths) {
      it(`should include ${label} (${path})`, () => {
        if (!isProductionBuild) return;
        const fullPath = join(packageRoot, path);
        expect(existsSync(fullPath), `${path} should exist after build`).toBe(true);
      });
    }
  });

  describe('Agent definitions', () => {
    const expectedAgents = [
      'diagnostician',
      'explorer',
      'auditor',
      'planner',
      'implementer',
      'reviewer',
      'reporter',
    ];

    it('should have agents directory with correct files', () => {
      const agentsDir = join(packageRoot, 'dist/agents');
      
      if (!existsSync(agentsDir)) {
        // Skip test if dist/agents doesn't exist (not a production build)
        return;
      }

      const files = readdirSync(agentsDir)
        .filter(f => f.endsWith('.md'))
        .map(f => f.replace('.md', ''));

      // At least 5 agents should be present
      expect(files.length, 'Should have at least 5 agent definitions').toBeGreaterThanOrEqual(5);
    });

    for (const agent of expectedAgents) {
      it(`should include ${agent}.md`, () => {
        const agentPath = join(packageRoot, `dist/agents/${agent}.md`);
        
        if (!existsSync(join(packageRoot, 'dist/agents'))) {
          return; // Skip if directory doesn't exist
        }

        expect(existsSync(agentPath), `${agent}.md should exist in dist/agents`).toBe(true);
      });
    }
  });

  describe('Templates', () => {
    it('should have templates directory with subdirectories', () => {
      const templatesDir = join(packageRoot, 'dist/templates');
      
      if (!existsSync(templatesDir)) {
        return; // Skip if not a production build
      }

      const entries = readdirSync(templatesDir, { withFileTypes: true });
      const directories = entries.filter(e => e.isDirectory());

      expect(directories.length, 'Templates should have language subdirectories').toBeGreaterThan(0);
    });
  });
});

describe('Agent Loader Integration', () => {
  it('should be able to import agent-loader from dist', async () => {
    const distPath = join(packageRoot, 'dist/core/agent-loader.js');
    
    if (!existsSync(distPath)) {
      return; // Skip if dist not built
    }

    // Dynamic import from dist
    const { listAvailableAgents } = await import(join(packageRoot, 'dist/core/agent-loader.js'));
    
    const agents = listAvailableAgents();
    
    expect(agents.length, 'listAvailableAgents should return at least 5 agents').toBeGreaterThanOrEqual(5);
    expect(agents, 'Should include diagnostician').toContain('diagnostician');
    expect(agents, 'Should include explorer').toContain('explorer');
  });
});
