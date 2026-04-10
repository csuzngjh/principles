import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createPrinciplesConsoleRoute } from '../../src/http/principles-console-route.js';
import { ControlUiQueryService } from '../../src/service/control-ui-query-service.js';

vi.mock('../../src/service/control-ui-query-service.js');

// Store original env
const originalHome = process.env.HOME;

beforeEach(() => {
  // Set HOME to a non-existent path to prevent reading real config
  process.env.HOME = '/nonexistent-test-home';
});

afterEach(() => {
  process.env.HOME = originalHome;
});

class MockResponse extends EventEmitter {
  statusCode = 200;
  headers = new Map<string, string>();
  body = '';

  setHeader(name: string, value: string) {
    this.headers.set(name.toLowerCase(), value);
  }

  end(chunk?: Buffer | string) {
    if (chunk) {
      this.body += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    }
  }
}

function createRequest(method: string, url: string, body?: string, headers?: Record<string, string>): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage & AsyncIterable<Buffer>;
  (req as any).method = method;
  (req as any).url = url;
  (req as any).headers = headers || {};
  req[Symbol.asyncIterator] = async function* () {
    if (body) {
      yield Buffer.from(body);
    }
  };
  return req as IncomingMessage;
}

describe('principles-console-route', () => {
  const createApi = () => ({
    rootDir: '/plugin',
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    runtime: {
      agent: {
        resolveAgentWorkspaceDir: vi.fn(() => '/workspace'),
      },
    },
    config: {},
  });

  it('serves overview JSON from the plugin API route', async () => {
    vi.mocked(ControlUiQueryService).mockImplementation(function MockControlUiQueryService() {
      return {
        getOverview: () => ({ workspaceDir: '/workspace', generatedAt: 'now', dataFreshness: null }),
        dispose: vi.fn(),
      } as any;
    } as any);

    const api = createApi();
    const route = createPrinciplesConsoleRoute(api as any);

    const response = new MockResponse() as unknown as ServerResponse;
    const handled = await route.handler(
      createRequest('GET', '/plugins/principles/api/overview'),
      response,
    );

    expect(handled).toBe(true);
    expect((response as any).statusCode).toBe(200);
    expect((response as any).body).toContain('"workspaceDir": "/workspace"');
    expect(api.runtime.agent.resolveAgentWorkspaceDir).toHaveBeenCalled();
  });

  it('rejects unsupported asset methods with 405', async () => {
    const route = createPrinciplesConsoleRoute(createApi() as any);

    const response = new MockResponse() as unknown as ServerResponse;
    const handled = await route.handler(
      createRequest('POST', '/plugins/principles/assets/app.js'),
      response,
    );

    expect(handled).toBe(true);
    expect((response as any).statusCode).toBe(405);
  });

  it('returns 400 for invalid review JSON bodies', async () => {
    vi.mocked(ControlUiQueryService).mockImplementation(function MockControlUiQueryService() {
      return {
        dispose: vi.fn(),
      } as any;
    } as any);

    const route = createPrinciplesConsoleRoute(createApi() as any);

    const response = new MockResponse() as unknown as ServerResponse;
    const handled = await route.handler(
      createRequest('POST', '/plugins/principles/api/samples/sample-1/review', '{invalid'),
      response,
    );

    expect(handled).toBe(true);
    expect((response as any).statusCode).toBe(400);
    expect((response as any).body).toContain('valid JSON');
  });

  it('returns 404 for unknown thinking model details', async () => {
    vi.mocked(ControlUiQueryService).mockImplementation(function MockControlUiQueryService() {
      return {
        getThinkingModelDetail: () => null,
        dispose: vi.fn(),
      } as any;
    } as any);

    const route = createPrinciplesConsoleRoute(createApi() as any);

    const response = new MockResponse() as unknown as ServerResponse;
    const handled = await route.handler(
      createRequest('GET', '/plugins/principles/api/thinking/models/unknown'),
      response,
    );

    expect(handled).toBe(true);
    expect((response as any).statusCode).toBe(404);
  });

  it('fails fast when workspace resolution is unavailable', async () => {
    vi.mocked(ControlUiQueryService).mockImplementation(function MockControlUiQueryService() {
      return {
        getOverview: () => ({ workspaceDir: '/workspace', generatedAt: 'now', dataFreshness: null }),
        dispose: vi.fn(),
      } as any;
    } as any);

    const api = createApi();
    api.runtime.agent.resolveAgentWorkspaceDir = vi.fn(() => {
      throw new Error('workspace unavailable');
    });
    const route = createPrinciplesConsoleRoute(api as any);

    const response = new MockResponse() as unknown as ServerResponse;
    const handled = await route.handler(
      createRequest('GET', '/plugins/principles/api/overview'),
      response,
    );

    expect(handled).toBe(true);
    expect((response as any).statusCode).toBe(500);
    expect((response as any).body).toContain('unable to resolve a valid workspace directory');
  });
});
