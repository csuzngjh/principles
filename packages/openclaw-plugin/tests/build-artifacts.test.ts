/**
 * Build Artifacts Verification Tests
 *
 * These tests verify that the production build includes all required artifacts.
 * Unlike unit tests that mock file system, these tests check actual files.
 *
 * Run after: npm run build:production
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync } from 'fs';
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

  // NOTE: agents/ directory was removed in favor of embedded prompts.
  // All role prompts are now inlined in nocturnal-trinity.ts at build time.
  // See: nocturnal-trinity.ts NOCTURNAL_DREAMER_PROMPT, etc.

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

