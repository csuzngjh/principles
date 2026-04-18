/**
 * OpenClawPainAdapter Conformance Tests
 *
 * Runs the PainAdapterConformance suite against OpenClawPainAdapter.
 */
import { describePainAdapterConformance } from '../../conformance/pain-adapter-conformance.js';
import { OpenClawPainAdapter } from '../../../src/adapters/coding/openclaw-pain-adapter.js';
import type { PluginHookAfterToolCallEvent } from '../../../src/adapters/coding/openclaw-event-types.js';

describePainAdapterConformance<PluginHookAfterToolCallEvent>(
  'OpenClawPainAdapter',
  () => new OpenClawPainAdapter(),
  {
    validFailureEvent: {
      toolName: 'write',
      error: 'ENOENT: no such file or directory',
      params: { file_path: '/tmp/test.ts' },
      sessionId: 'sess-conf-1',
      agentId: 'builder',
    },
    nonFailureEvent: {
      toolName: 'read',
      result: { content: 'file contents' },
      sessionId: 'sess-conf-1',
      agentId: 'main',
    },
    malformedEvent: {
      error: 'has error but no toolName',
    } as any,
    domain: 'coding',
  },
);
