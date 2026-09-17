import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WorkspaceContext } from '../../src/core/workspace-context.js';
import { EventLogService } from '../../src/core/event-log.js';

/**
 * PRI-824 integration: a gateway_start-like first hook whose host context
 * carries the OpenClaw home as stateDir must still bind the workspace
 * canonical state dir, and physical events must land under
 * <workspace>/.state/logs — never under the host home.
 */
describe('WorkspaceContext canonical stateDir binding (PRI-824 integration)', () => {
    const roots: string[] = [];

    function makeRoot(prefix: string): string {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
        roots.push(dir);
        return dir;
    }

    afterEach(() => {
        WorkspaceContext.clearCache();
        EventLogService.disposeAll();
        for (const dir of roots.splice(0).reverse()) {
            fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        }
    });

    it('first hook with host home stateDir writes events under the workspace, not the host home (T824-3)', () => {
        const workspace = makeRoot('pri824-ws-');
        const hostHome = makeRoot('pri824-home-');

        const wctx = WorkspaceContext.fromHookContext({ workspaceDir: workspace, stateDir: hostHome });

        expect(wctx.workspaceDir).toBe(path.resolve(workspace));
        expect(wctx.stateDir).toBe(path.join(path.resolve(workspace), '.state'));

        wctx.eventLog.recordHookExecution({ hook: 'before_tool_call' }, { flushImmediately: true });

        const workspaceLogsDir = path.join(workspace, '.state', 'logs');
        expect(fs.existsSync(workspaceLogsDir)).toBe(true);
        const eventFiles = fs.readdirSync(workspaceLogsDir).filter(name => /^events_.*\.jsonl$/.test(name));
        expect(eventFiles.length).toBeGreaterThan(0);
        const written = fs.readFileSync(path.join(workspaceLogsDir, eventFiles[0] as string), 'utf8');
        expect(written).toContain('hook_execution');

        expect(fs.existsSync(path.join(hostHome, 'logs'))).toBe(false);
    });

    it('cache identity stays workspace-scoped: a second clean hook reuses the canonical instance (T824-2 physical)', () => {
        const workspace = makeRoot('pri824-ws-');
        const hostHome = makeRoot('pri824-home-');

        const first = WorkspaceContext.fromHookContext({ workspaceDir: workspace, stateDir: hostHome });
        const second = WorkspaceContext.fromHookContext({ workspaceDir: workspace });

        expect(second).toBe(first);
        second.eventLog.recordHookExecution({ hook: 'after_tool_call' }, { flushImmediately: true });

        expect(fs.existsSync(path.join(workspace, '.state', 'logs'))).toBe(true);
        expect(fs.existsSync(path.join(hostHome, 'logs'))).toBe(false);
    });
});
