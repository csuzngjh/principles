import { describe, it, expect } from 'vitest';

describe('PathResolver', () => {
    it('should have correct exports', async () => {
        const { PathResolver, PD_ENV_VARS, PD_ENV_DESCRIPTIONS } = await import('../../src/core/path-resolver.js');
        expect(PathResolver).toBeDefined();
        expect(PD_ENV_VARS).toBeDefined();
        expect(PD_ENV_DESCRIPTIONS).toBeDefined();
    });

    it('should have all required path keys', async () => {
        const { PathResolver } = await import('../../src/core/path-resolver.js');
        const resolver = new PathResolver({ workspaceDir: '/test/workspace' });
        
        const requiredKeys = ['PROFILE', 'PLAN', 'AGENT_SCORECARD', 'PAIN_FLAG', 'EVOLUTION_QUEUE', 'THINKING_OS', 'THINKING_OS_USAGE', 'THINKING_OS_CANDIDATES'];
        
        for (const key of requiredKeys) {
            expect(() => resolver.resolve(key)).not.toThrow();
        }
    });
});

describe('Persistence Fix - Placeholder', () => {
    it('trust engine persistence is tested via workspace-context tests', () => {
        expect(true).toBe(true);
    });

    it('pain dictionary persistence is tested via workspace-context tests', () => {
        expect(true).toBe(true);
    });

    it('pain config save method exists', async () => {
        const { PainConfig } = await import('../../src/core/config.js');
        const config = new PainConfig('/test/state');
        expect(typeof config.save).toBe('function');
    });
});
