import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { reconcileStartup } from '../../src/service/startup-reconciler.js';
import { readState, writeState } from '../../src/service/nocturnal-runtime.js';

let tmpDir: string;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-reconcile-test-'));
});

afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('startup-reconciler', () => {
    describe('reconcileStartup', () => {
        it('returns zero counts when no state exists', async () => {
            const result = await reconcileStartup(tmpDir);
            expect(result.cooldownsCleared).toBe(0);
            expect(result.orphansRemoved).toEqual([]);
            expect(result.stateReset).toBe(false);
        });

        it('clears expired cooldownUntil entries', async () => {
            const state = await readState(tmpDir);
            state.taskFailureState = {
                sleep_reflection: {
                    consecutiveFailures: 3,
                    escalationTier: 2,
                    cooldownUntil: new Date(Date.now() - 60000).toISOString(), // Expired 1 min ago
                },
                keyword_optimization: {
                    consecutiveFailures: 1,
                    escalationTier: 1,
                    cooldownUntil: new Date(Date.now() + 3600000).toISOString(), // Still active (1h from now)
                },
            };
            await writeState(tmpDir, state);

            const result = await reconcileStartup(tmpDir);
            expect(result.cooldownsCleared).toBe(1);

            const updated = await readState(tmpDir);
            expect(updated.taskFailureState!['sleep_reflection'].cooldownUntil).toBeUndefined();
            expect(updated.taskFailureState!['sleep_reflection'].escalationTier).toBe(2); // Preserved
            expect(updated.taskFailureState!['keyword_optimization'].cooldownUntil).toBeDefined(); // Not cleared
        });

        it('preserves escalation history when clearing cooldowns', async () => {
            const state = await readState(tmpDir);
            state.taskFailureState = {
                sleep_reflection: {
                    consecutiveFailures: 5,
                    escalationTier: 3,
                    cooldownUntil: new Date(Date.now() - 1000).toISOString(),
                },
            };
            await writeState(tmpDir, state);

            await reconcileStartup(tmpDir);

            const updated = await readState(tmpDir);
            expect(updated.taskFailureState!['sleep_reflection'].consecutiveFailures).toBe(5);
            expect(updated.taskFailureState!['sleep_reflection'].escalationTier).toBe(3);
            expect(updated.taskFailureState!['sleep_reflection'].cooldownUntil).toBeUndefined();
        });

        it('removes orphan .tmp files', async () => {
            // Create a .tmp file without corresponding target
            const orphanPath = path.join(tmpDir, 'orphan.tmp');
            fs.writeFileSync(orphanPath, 'stale data');

            // Create a .tmp file WITH corresponding target (not orphan)
            const validTmpPath = path.join(tmpDir, 'valid-data.json.tmp');
            const validTargetPath = path.join(tmpDir, 'valid-data.json');
            fs.writeFileSync(validTmpPath, 'temp');
            fs.writeFileSync(validTargetPath, 'real');

            const result = await reconcileStartup(tmpDir);
            expect(result.orphansRemoved).toEqual(['orphan.tmp']);
            expect(fs.existsSync(orphanPath)).toBe(false);
            expect(fs.existsSync(validTmpPath)).toBe(true); // Not removed — target exists
        });

        it('resets corrupted state file', async () => {
            const statePath = path.join(tmpDir, 'nocturnal-runtime.json');
            fs.writeFileSync(statePath, '{corrupted json!!!', 'utf8');

            const result = await reconcileStartup(tmpDir);
            expect(result.stateReset).toBe(true);

            // State should be readable after reset
            const state = await readState(tmpDir);
            expect(state.principleCooldowns).toEqual({});
        });

        it('reports stateReset=false for valid state', async () => {
            const state = await readState(tmpDir); // Creates valid state
            state.globalCooldownUntil = new Date(Date.now() + 60000).toISOString();
            await writeState(tmpDir, state);

            const result = await reconcileStartup(tmpDir);
            expect(result.stateReset).toBe(false);
        });

        it('handles multiple expired cooldowns across task kinds', async () => {
            const state = await readState(tmpDir);
            state.taskFailureState = {
                sleep_reflection: {
                    consecutiveFailures: 3,
                    escalationTier: 2,
                    cooldownUntil: new Date(Date.now() - 1000).toISOString(),
                },
                keyword_optimization: {
                    consecutiveFailures: 4,
                    escalationTier: 3,
                    cooldownUntil: new Date(Date.now() - 2000).toISOString(),
                },
            };
            await writeState(tmpDir, state);

            const result = await reconcileStartup(tmpDir);
            expect(result.cooldownsCleared).toBe(2);
        });

        it('is idempotent — safe to call multiple times', async () => {
            const state = await readState(tmpDir);
            state.taskFailureState = {
                sleep_reflection: {
                    consecutiveFailures: 2,
                    escalationTier: 1,
                    cooldownUntil: new Date(Date.now() - 1000).toISOString(),
                },
            };
            await writeState(tmpDir, state);

            const result1 = await reconcileStartup(tmpDir);
            expect(result1.cooldownsCleared).toBe(1);

            const result2 = await reconcileStartup(tmpDir);
            expect(result2.cooldownsCleared).toBe(0); // Already cleared
        });
    });
});
