import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
// PRI-686: the os mock must be registered before src/index is imported, so
// this import + call sit above it. Command resolvers now prioritize PD
// explicit sources; hiding the host machine's real
// ~/.openclaw/principles-disciple.json keeps registered handlers on this
// suite's mock ctx.workspaceDir.
import { isolatePdCanonicalConfig } from './utils/isolate-pd-canonical.js';
isolatePdCanonicalConfig();
import plugin from '../src/index';
import { checkConversationAccessConfig } from '../src/index';
import type { PluginCommandDefinition, OpenClawPluginApi, PluginCommandContext } from '../src/openclaw-sdk.js';

function createMockApi(): { registeredCommands: PluginCommandDefinition[]; api: OpenClawPluginApi } {
  const registeredCommands: PluginCommandDefinition[] = [];
  const api: OpenClawPluginApi = {
    rootDir: '/mock',
    pluginConfig: { language: 'en' },
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    config: {},
    registerCommand: (cmd: PluginCommandDefinition) => {
      registeredCommands.push(cmd);
    },
    registerService: () => {},
    registerTool: () => {},
    registerHttpRoute: () => {},
    on: () => {},
  };
  return { registeredCommands, api };
}

describe('OpenClaw Plugin Scaffolding', () => {
  it('should export a valid register function', () => {
    expect(plugin).toBeDefined();
    expect(typeof plugin.register).toBe('function');
  });
});

describe('Command Registration', () => {
  it('registers /pd-pain with acceptsArgs: true', () => {
    const { registeredCommands, api } = createMockApi();
    plugin.register(api);

    const pdPain = registeredCommands.find((c) => c.name === 'pd-pain');
    expect(pdPain).toBeDefined();
    expect(pdPain!.acceptsArgs).toBe(true);
  });

  it('registers /pd-pain handler as async (always returns Promise)', async () => {
    const { registeredCommands, api } = createMockApi();
    plugin.register(api);

    const pdPain = registeredCommands.find((c) => c.name === 'pd-pain');
    expect(pdPain).toBeDefined();

    const ctx: PluginCommandContext = {
      sessionId: 'session-123',
      sessionKey: 'sk-123',
      args: 'test pain reason',
      config: { workspaceDir: '/mock', language: 'en' },
    };

    const result = pdPain!.handler(ctx);
    expect(result).toBeInstanceOf(Promise);
    await result;
  });

  it('returns error result when workspace resolution fails', async () => {
    const { registeredCommands, api } = createMockApi();
    plugin.register(api);

    const pdPain = registeredCommands.find((c) => c.name === 'pd-pain');
    expect(pdPain).toBeDefined();

    const ctx: PluginCommandContext = {
      sessionId: '',
      sessionKey: '',
      args: 'test pain reason',
      config: { language: 'en' },
    };

    const result = await pdPain!.handler(ctx);
    expect(result).toBeDefined();
    expect(result.text).toBeDefined();
  });

  it('passes workspaceDir to handler even when ctx.config is undefined', async () => {
    const { registeredCommands, api } = createMockApi();
    plugin.register(api);

    const pdPain = registeredCommands.find((c) => c.name === 'pd-pain');
    expect(pdPain).toBeDefined();

    const ctx: PluginCommandContext = {
      sessionId: '',
      sessionKey: 'sk-123',
      workspaceDir: '/mock/workspace',
      args: 'test pain reason',
    };

    const result = await pdPain!.handler(ctx);
    expect(result).toBeDefined();
    expect(result.text).toBeDefined();
    expect(ctx.workspaceDir).toBe('/mock/workspace');
  });
});

describe('/pd-help command', () => {
  it('returns Chinese command reference when language is zh', () => {
    const api: OpenClawPluginApi = {
      rootDir: '/mock',
      pluginConfig: { language: 'zh' },
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      config: {},
      registerCommand: () => {},
      registerService: () => {},
      registerTool: () => {},
      registerHttpRoute: () => {},
      on: () => {},
    };
    const registeredCommands: PluginCommandDefinition[] = [];
    api.registerCommand = (cmd: PluginCommandDefinition) => { registeredCommands.push(cmd); };

    plugin.register(api);

    const pdHelp = registeredCommands.find((c) => c.name === 'pd-help');
    expect(pdHelp).toBeDefined();

    const result = pdHelp!.handler({} as PluginCommandContext);
    expect(result.text).toContain('Principles Disciple 命令大全');
    expect(result.text).toContain('🚀 快速开始');
    expect(result.text).toContain('🔧 实现生命周期（半废弃）');
    // All previously-missing commands must appear (PRI-736: /pd-evolution-status removed,
    // PRI-737: /pd-workflow-debug removed)
    expect(result.text).toContain('/pd-pain');
    expect(result.text).toContain('/pd-promote-impl');
    expect(result.text).toContain('/pd-disable-impl');
    expect(result.text).toContain('/pd-archive-impl');
    expect(result.text).toContain('/pd-rollback-impl');
  });

  it('returns English command reference when language is en', () => {
    const { registeredCommands, api } = createMockApi();
    plugin.register(api);

    const pdHelp = registeredCommands.find((c) => c.name === 'pd-help');
    expect(pdHelp).toBeDefined();

    const result = pdHelp!.handler({} as PluginCommandContext);
    expect(result.text).toContain('Principles Disciple Command Reference');
    expect(result.text).toContain('🚀 Quick Start');
    expect(result.text).toContain('🔧 Implementation Lifecycle (Semi-deprecated)');
  });
});

/**
 * PRI-1278 (service-host-only consolidation) — anti-reintroduction guard.
 *
 * The OpenClaw Gateway's in-process internalization consumer timer chain is
 * DELETED (not gated): the PD Service Host is the only background runtime
 * and drives bounded cycles through `pd openclaw worker --once`. The Gateway
 * adapter survives as a pure capability adapter — hooks ingest evidence, the
 * tool declaration persists, non-consuming services run. These assertions
 * pin that shape so the consumer cannot silently grow back:
 *
 *  - behavior: plugin registration never hands a consuming service to the
 *    host (the exact registered-service set is pinned);
 *  - structure: the deleted consumer/lease/quiesce modules stay deleted, no
 *    src module references them, and ONLY src/openclaw-worker.ts — the
 *    Service-Host-invoked capability — may drive the shared consumer cycle.
 */
describe('PRI-1278 service-host-only anti-reintroduction guard', () => {
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  const packageRoot = path.resolve(thisDir, '..');
  const srcRoot = path.join(packageRoot, 'src');

  function collectTsFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...collectTsFiles(full));
      else if (entry.name.endsWith('.ts')) out.push(full);
    }
    return out;
  }

  it('plugin registration never registers a consuming service', () => {
    const registeredServices: Array<{ id?: string }> = [];
    const api: OpenClawPluginApi = {
      rootDir: '/mock',
      pluginConfig: { language: 'en' },
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      config: {},
      registerCommand: () => {},
      registerService: (service: { id?: string }) => { registeredServices.push(service); },
      registerTool: () => {},
      registerHttpRoute: () => {},
      on: () => {},
    };

    plugin.register(api);

    const ids = registeredServices.map((s) => s.id);
    // The legacy consumer can never come back as a registered service…
    expect(ids).not.toContain('principles-internalization-auto-consumer');
    // …and no NEW consuming service may appear either: registration is a
    // subset of the known non-consuming services. (guardService drops
    // surfaces disabled by default — e.g. pd-task — so the runtime set is a
    // subset, pinned to the allowlist either way.)
    const nonConsumingAllowlist = new Set([
      'principles-correction-observer',
      'principles-disciple-trajectory',
      'principles-disciple-task-manager',
    ]);
    expect(ids.every((id) => id !== undefined && nonConsumingAllowlist.has(id))).toBe(true);
    expect(ids.some((id) => typeof id === 'string' && id.includes('consumer'))).toBe(false);
  });

  it('the deleted consumer, lease and quiesce-ack modules stay deleted', () => {
    for (const deleted of [
      'service/internalization-auto-consumer-service.ts',
      'service/gateway-consumer-lease.ts',
      'service/gateway-quiesce-ack.ts',
    ]) {
      expect(fs.existsSync(path.join(srcRoot, deleted)), `${deleted} must stay deleted`).toBe(false);
    }
    // No surviving module may import them (a re-added importer would fail
    // compilation anyway; this scan makes the regression legible).
    const offenders: string[] = [];
    for (const file of collectTsFiles(srcRoot)) {
      const text = fs.readFileSync(file, 'utf8');
      if (/internalization-auto-consumer-service|gateway-consumer-lease|gateway-quiesce-ack/.test(text)) {
        offenders.push(path.relative(srcRoot, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('only the Service-Host-invoked worker may drive the shared consumer cycle', () => {
    // Consumption requires the shared host-runtime cycle. Inside this
    // package exactly ONE module may reference it: src/openclaw-worker.ts,
    // which runs OUTSIDE the Gateway process under `pd openclaw worker
    // --once` with the service_host_owned admission gate. Any other src
    // module referencing it means the Gateway grew a consumer back.
    const drivers: string[] = [];
    for (const file of collectTsFiles(srcRoot)) {
      const text = fs.readFileSync(file, 'utf8');
      if (text.includes('runInternalizationConsumerCycle')) {
        drivers.push(path.relative(srcRoot, file).replace(/\\/g, '/'));
      }
    }
    expect(drivers).toEqual(['openclaw-worker.ts']);
  });
});

describe('checkConversationAccessConfig — PRI-343', () => {
  it('returns authorized:false with reason and nextAction when allowConversationAccess is not true', () => {
    const result = checkConversationAccessConfig({ hooks: { allowConversationAccess: false } });
    expect(result.authorized).toBe(false);
    expect(result.reason).toBeDefined();
    expect(typeof result.reason).toBe('string');
    expect(result.reason!.length).toBeGreaterThan(0);
    expect(result.nextAction).toBeDefined();
    expect(typeof result.nextAction).toBe('string');
    expect(result.nextAction!.length).toBeGreaterThan(0);
  });

  it('returns authorized:true when allowConversationAccess is true', () => {
    const result = checkConversationAccessConfig({ hooks: { allowConversationAccess: true } });
    expect(result.authorized).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(result.nextAction).toBeUndefined();
  });

  it('returns authorized:false when hooks object is missing', () => {
    const result = checkConversationAccessConfig({ enabled: true });
    expect(result.authorized).toBe(false);
    expect(result.reason).toBeDefined();
    expect(result.nextAction).toBeDefined();
  });

  it('returns authorized:false when pluginConfig is null', () => {
    const result = checkConversationAccessConfig(null);
    expect(result.authorized).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it('returns authorized:false when pluginConfig is undefined', () => {
    const result = checkConversationAccessConfig(undefined);
    expect(result.authorized).toBe(false);
    expect(result.reason).toBeDefined();
  });
});
