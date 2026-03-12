import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';

// Test the new path resolution module
describe('PathResolver - TDD for Path Issues', () => {
    const originalEnv = { ...process.env };
    
    beforeEach(() => {
        vi.clearAllMocks();
        // Clear any cached modules
        vi.resetModules();
    });
    
    afterEach(() => {
        // Restore original env
        process.env = originalEnv;
    });

    describe('Environment Variable Priority', () => {
        it('should use PD_WORKSPACE_DIR env var when set', () => {
            process.env.PD_WORKSPACE_DIR = '/custom/workspace';
            
            // Re-import after env change
            const { PathResolver } = require('../../src/core/path-resolver.js');
            const resolver = new PathResolver();
            
            expect(resolver.getWorkspaceDir()).toBe('/custom/workspace');
        });
        
        it('should use PD_STATE_DIR env var when set', () => {
            process.env.PD_STATE_DIR = '/custom/state';
            
            const { PathResolver } = require('../../src/core/path-resolver.js');
            const resolver = new PathResolver();
            
            expect(resolver.getStateDir()).toBe('/custom/state');
        });
    });

    describe('Workspace Directory Resolution', () => {
        it('should normalize workspace directory path', () => {
            process.env.PD_WORKSPACE_DIR = '';
            delete process.env.PD_WORKSPACE_DIR;
            
            const { PathResolver } = require('../../src/core/path-resolver.js');
            const resolver = new PathResolver();
            
            // Should use home-based default
            const workspaceDir = resolver.getWorkspaceDir();
            expect(workspaceDir).toBeDefined();
            expect(workspaceDir).toContain('.openclaw');
        });
        
        it('should detect and strip subdirectory suffixes like /memory', () => {
            process.env.PD_WORKSPACE_DIR = '/home/user/clawd/memory';
            
            const { PathResolver } = require('../../src/core/path-resolver.js');
            const resolver = new PathResolver({ 
                workspaceDir: '/home/user/clawd/memory',
                normalizeWorkspace: true 
            });
            
            // Should normalize to parent directory
            const normalized = resolver.getWorkspaceDir();
            expect(normalized).not.toContain('/memory');
        });
    });

    describe('Path Logging', () => {
        it('should log path resolution decisions', () => {
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
            
            process.env.PD_WORKSPACE_DIR = '/test/workspace';
            process.env.DEBUG = 'true';
            
            const { PathResolver } = require('../../src/core/path-resolver.js');
            const resolver = new PathResolver();
            
            // Trigger path resolution
            resolver.getWorkspaceDir();
            resolver.getStateDir();
            
            // Should have logged resolution decisions
            expect(consoleSpy).toHaveBeenCalled();
            
            consoleSpy.mockRestore();
        });
    });
});

describe('Persistence Fix - Initial Save', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });
    
    describe('TrustEngine Persistence', () => {
        it('should persist scorecard on first load when file does not exist', async () => {
            const fsMock = {
                existsSync: vi.fn().mockReturnValue(false),
                mkdirSync: vi.fn(),
                writeFileSync: vi.fn(),
                readFileSync: vi.fn()
            };
            
            vi.doMock('fs', () => fsMock);
            
            const { TrustEngine } = require('../../src/core/trust-engine.js');
            
            // This test would verify the fix for PD-001
            // After implementation, trust engine should save on first load
        });
    });
    
    describe('PainDictionary Persistence', () => {
        it('should persist default rules on first load when file does not exist', () => {
            // This test would verify the fix for PD-002
        });
    });
    
    describe('PainConfig Persistence', () => {
        it('should have a save method', () => {
            const { PainConfig } = require('../../src/core/config.js');
            
            // After implementation, PainConfig should have save() method
            const config = new PainConfig('/test/state');
            expect(typeof config.save).toBe('function');
        });
    });
});
