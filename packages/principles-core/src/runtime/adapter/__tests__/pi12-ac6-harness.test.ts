import { describe, expect, it } from 'vitest';
import { observeRequest, startRecorder, wrapGetPiAiFetchForApi } from './pi12-ac6-harness.js';

function wire(messages: unknown[]) {
  return observeRequest('https://example.invalid/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: 'synthetic-secret-never-export' },
    body: JSON.stringify({ messages }),
  });
}

describe('AC-6 HTTP observation harness (offline)', () => {
  it('extracts Pi 1.2 Chat Completions message-object content', () => {
    const result = wire([
      { role: 'system', content: 'AC6-B1 DREAMER BASE ROLE LAYER -- Tool protocol (L2 mode)' },
      { role: 'user', content: 'taskId: ac6-test. Do the task.' },
    ]);
    expect(result.messageRoles).toEqual(['system', 'user']);
    expect(result.systemTextPreview).toContain('AC6-B1 DREAMER');
    expect(result.userTextPreview).toContain('taskId: ac6-test');
    expect(result.userTextPreviews).toEqual(['taskId: ac6-test. Do the task.']);
    expect(JSON.stringify(result)).not.toContain('synthetic-secret-never-export');
  });

  it('extracts first text block from multimodal content', () => {
    const result = wire([
      { role: 'system', content: [{ type: 'text', text: 'system instructions' }] },
      { role: 'user', content: [{ type: 'text', text: 'original task' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,test' } }] },
    ]);
    expect(result.systemTextPreview).toBe('system instructions');
    expect(result.userTextPreview).toBe('original task');
  });

  it('distinguishes Pi corrective turns from duplicated original tasks', () => {
    const result = wire([
      { role: 'system', content: 'instructions' },
      { role: 'user', content: 'taskId: ac6-artificer-real-1. Original task' },
      { role: 'assistant', content: 'Need tool call' },
      { role: 'user', content: 'Please use validate_rulecode' },
      { role: 'assistant', content: 'Need tool call' },
      { role: 'user', content: 'Please use submit_rulecode' },
    ]);
    expect(result.messageRoles.filter((role) => role === 'user')).toHaveLength(3);
    expect(result.userTextPreviews.filter((value) => value.startsWith('taskId: ac6-artificer-real-1.'))).toHaveLength(1);
  });

  it('bounds previews and safely degrades on malformed JSON', () => {
    const result = wire([{ role: 'system', content: 'x'.repeat(1200) }]);
    expect(result.systemTextPreview?.length).toBeLessThanOrEqual(601);
    const invalid = observeRequest('https://example.invalid', { method: 'POST', body: '{invalid' });
    expect(invalid.messageRoles).toEqual([]);
    expect(invalid.userTextPreviews).toEqual([]);
  });

  it('blocks requests over cap before network dispatch', async () => {
    let sent = 0;
    const wrapped = wrapGetPiAiFetchForApi(() => async () => {
      sent += 1;
      return new Response('{}');
    })('openai-completions');
    const recorder = startRecorder(2);
    try {
      const init = { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: 'test' }] }) };
      await wrapped('https://example.invalid', init);
      await wrapped('https://example.invalid', init);
      await expect(wrapped('https://example.invalid', init)).rejects.toThrow('hard request cap exceeded');
      expect(sent).toBe(2);
      expect(recorder.requests).toHaveLength(2);
    } finally {
      recorder.stop();
    }
  });
});
