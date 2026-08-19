/**
 * Unit tests for pure-logic helpers extracted from prompt.ts (PRI-444).
 *
 * These tests verify the extracted functions in isolation, without any I/O
 * or module-level state. They lock down behavior that was previously only
 * tested through the full handleBeforePromptBuild() integration path.
 */

import { describe, it, expect } from 'vitest';
import {
  extractUserMessageFromPrompt,
  buildGovernanceContext,
  buildEmpathySilenceConstraint,
  assembleHeartbeatChecklist,
  formatCorePrinciples,
  formatEvolutionPrinciples,
  assembleAppendSystemContext,
  extractPhrasesFromReason,
} from '../../src/hooks/prompt-helpers.js';

// ─── extractUserMessageFromPrompt ───────────────────────────────────────────

describe('extractUserMessageFromPrompt', () => {
  it('returns clean message unchanged', () => {
    const result = extractUserMessageFromPrompt('Hello, how are you?', 'session-1');
    expect(result.message).toBe('Hello, how are you?');
    expect(result.isAgentToAgent).toBe(false);
    expect(result.isEmpathyPrompt).toBe(false);
  });

  it('returns empty message for boot check prompts', () => {
    const bootPrompt = 'You are running a boot check. Follow BOOT.md instructions exactly.';
    const result = extractUserMessageFromPrompt(bootPrompt, 'session-1');
    expect(result.message).toBe('');
    expect(result.isAgentToAgent).toBe(false);
  });

  it('returns empty message for boot check variant', () => {
    const bootPrompt = 'You are running a boot check. Follow BOOT.md and do something else.';
    const result = extractUserMessageFromPrompt(bootPrompt, 'session-1');
    expect(result.message).toBe('');
  });

  it('extracts message from Feishu Sender wrapper format', () => {
    const wrapped = 'Sender (untrusted metadata): ```json {"user":"alice"} ```  What is the weather?';
    const result = extractUserMessageFromPrompt(wrapped, 'session-1');
    expect(result.message).toBe('What is the weather?');
  });

  it('extracts message from Feishu Conversation info wrapper format', () => {
    // Original code requires message.length > 200 for Conversation info format
    const wrapped = 'Conversation info (untrusted metadata): ```json {"channel":"general"} ```  ' + 'Please help me debug this code. '.repeat(10) + 'The issue is in the authentication module where the token validation fails silently.';
    const result = extractUserMessageFromPrompt(wrapped, 'session-1');
    expect(result.message).toContain('Please help me debug this code');
  });

  it('keeps original message when Feishu wrapper has no content after', () => {
    const wrapped = 'Sender (untrusted metadata): ```json {} ```';
    const result = extractUserMessageFromPrompt(wrapped, 'session-1');
    // afterSender.length <= 3, so message stays as original
    expect(result.message).toBe(wrapped);
  });

  it('detects empathy observer output as isEmpathyPrompt', () => {
    const empathyOutput = 'The empathy observer analyzed the message. damageDetected: true, severity: high, confidence: 0.9';
    const result = extractUserMessageFromPrompt(empathyOutput, 'session-1');
    expect(result.isEmpathyPrompt).toBe(true);
    expect(result.isAgentToAgent).toBe(true); // isEmpathyPrompt implies isAgentToAgent
  });

  it('detects agent-to-agent via sourceSession=agent: prefix', () => {
    const agentMsg = 'sourceSession=agent:12345 Hello there';
    const result = extractUserMessageFromPrompt(agentMsg, 'session-1');
    expect(result.isAgentToAgent).toBe(true);
  });

  it('detects agent-to-agent via :subagent: in sessionId', () => {
    const result = extractUserMessageFromPrompt('Hello', 'session:subagent:12345');
    expect(result.isAgentToAgent).toBe(true);
  });

  it('does not flag normal message as empathy prompt', () => {
    const result = extractUserMessageFromPrompt('I feel empathy for the observer', 'session-1');
    // Has "empathy observer" but no damageDetected/severity/confidence
    expect(result.isEmpathyPrompt).toBe(false);
  });

  it('handles empty prompt', () => {
    const result = extractUserMessageFromPrompt('', 'session-1');
    expect(result.message).toBe('');
    expect(result.isAgentToAgent).toBe(false);
  });

  it('handles undefined sessionId for subagent check', () => {
    const result = extractUserMessageFromPrompt('Hello', undefined);
    expect(result.isAgentToAgent).toBe(false);
  });
});

// ─── buildGovernanceContext ─────────────────────────────────────────────────────

describe('buildGovernanceContext', () => {
  it('returns non-empty string with PD GOVERNANCE CONTEXT header', () => {
    const result = buildGovernanceContext();
    expect(result).toContain('## 【PD GOVERNANCE CONTEXT】');
    expect(result).toContain('governance boundaries');
    expect(result).toContain('Principles Disciple');
    expect(result.length).toBeGreaterThan(100);
  });

  it('includes Decision Framework', () => {
    const result = buildGovernanceContext();
    expect(result).toContain('Decision Framework');
    expect(result).toContain('Owner Governance');
    expect(result).toContain('Principles Override');
  });

  it('is deterministic (same output every call)', () => {
    expect(buildGovernanceContext()).toBe(buildGovernanceContext());
  });
});

// ─── buildEmpathySilenceConstraint ──────────────────────────────────────────

describe('buildEmpathySilenceConstraint', () => {
  it('returns EMPATHY OUTPUT RESTRICTION header', () => {
    const result = buildEmpathySilenceConstraint();
    expect(result).toContain('### 【EMPATHY OUTPUT RESTRICTION】');
    expect(result).toContain('Do NOT output empathy diagnostic text');
    expect(result).toContain('damageDetected');
  });

  it('is trimmed (no leading/trailing whitespace)', () => {
    const result = buildEmpathySilenceConstraint();
    expect(result).toBe(result.trim());
  });
});

// ─── assembleHeartbeatChecklist ─────────────────────────────────────────────

describe('assembleHeartbeatChecklist', () => {
  it('wraps content in heartbeat_checklist tags', () => {
    const result = assembleHeartbeatChecklist('Check server status');
    expect(result).toContain('<heartbeat_checklist>');
    expect(result).toContain('Check server status');
    expect(result).toContain('</heartbeat_checklist>');
    expect(result.endsWith('\n')).toBe(true);
  });

  it('returns empty string for empty content', () => {
    expect(assembleHeartbeatChecklist('')).toBe('');
    expect(assembleHeartbeatChecklist('   ')).toBe('');
  });
});

// ─── formatCorePrinciples ───────────────────────────────────────────────────

describe('formatCorePrinciples', () => {
  it('formats principles as bullet list with escaped IDs', () => {
    const principles = [
      { id: 'P001', text: 'Always validate input' },
      { id: 'P002', text: 'Never trust user data' },
    ];
    const result = formatCorePrinciples(principles);
    expect(result).toBe('- [P001] Always validate input\n- [P002] Never trust user data');
  });

  it('escapes XML special characters in id and text', () => {
    const principles = [
      { id: 'P<001>', text: 'Use < & > safely' },
    ];
    const result = formatCorePrinciples(principles);
    expect(result).toContain('&lt;');
    expect(result).toContain('&gt;');
    expect(result).toContain('&amp;');
    expect(result).not.toContain('<001>');
  });

  it('returns empty string for empty array', () => {
    expect(formatCorePrinciples([])).toBe('');
  });

  it('returns empty string for non-array input', () => {
    // @ts-expect-error intentional runtime invalid-input test
    expect(formatCorePrinciples(null)).toBe('');
    // @ts-expect-error intentional runtime invalid-input test
    expect(formatCorePrinciples(undefined)).toBe('');
  });

  it('handles single principle', () => {
    const result = formatCorePrinciples([{ id: 'P1', text: 'Solo' }]);
    expect(result).toBe('- [P1] Solo');
  });
});

// ─── formatEvolutionPrinciples ──────────────────────────────────────────────

describe('formatEvolutionPrinciples', () => {
  it('formats active principles with header', () => {
    const active = [{ id: 'A1', text: 'Active rule' }];
    const result = formatEvolutionPrinciples(active, []);
    expect(result).toContain('Active principles:');
    expect(result).toContain('- [A1] Active rule');
    expect(result).not.toContain('Probation');
  });

  it('formats probation principles with status tag', () => {
    const probation = [{ id: 'PB1', text: 'Probationary rule' }];
    const result = formatEvolutionPrinciples([], probation);
    expect(result).toContain('Probation principles (contextual, caution):');
    expect(result).toContain('<principle status="probation" id="PB1">Probationary rule</principle>');
  });

  it('formats both active and probation', () => {
    const active = [{ id: 'A1', text: 'Active' }];
    const probation = [{ id: 'PB1', text: 'Probation' }];
    const result = formatEvolutionPrinciples(active, probation);
    expect(result).toContain('Active principles:');
    expect(result).toContain('Probation principles');
    expect(result).toContain('- [A1] Active');
    expect(result).toContain('<principle status="probation" id="PB1">Probation</principle>');
  });

  it('returns empty string for both empty', () => {
    expect(formatEvolutionPrinciples([], [])).toBe('');
  });

  it('escapes XML in principle content', () => {
    const active = [{ id: 'A<&>', text: 'Use <tags>' }];
    const result = formatEvolutionPrinciples(active, []);
    expect(result).toContain('&lt;');
    expect(result).toContain('&gt;');
    expect(result).toContain('&amp;');
  });
});

// ─── assembleAppendSystemContext ────────────────────────────────────────────

describe('assembleAppendSystemContext', () => {
  it('returns empty string for empty parts', () => {
    expect(assembleAppendSystemContext({})).toBe('');
  });

  it('assembles all parts in correct order', () => {
    const result = assembleAppendSystemContext({
      behavioralConstraints: 'BC_CONTENT',
      projectContext: 'PC_CONTENT',
      workingMemory: 'WM_CONTENT',
      thinkingOs: 'TO_CONTENT',
      evolutionPrinciples: 'EP_CONTENT',
      corePrinciples: 'CP_CONTENT',
    });
    // Order: behavioral_constraints → project_context → working_memory → thinking_os → evolution_principles → core_principles
    const bcPos = result.indexOf('BC_CONTENT');
    const pcPos = result.indexOf('PC_CONTENT');
    const wmPos = result.indexOf('WM_CONTENT');
    const toPos = result.indexOf('TO_CONTENT');
    const epPos = result.indexOf('EP_CONTENT');
    const cpPos = result.indexOf('CP_CONTENT');
    expect(bcPos).toBeLessThan(pcPos);
    expect(pcPos).toBeLessThan(wmPos);
    expect(wmPos).toBeLessThan(toPos);
    expect(toPos).toBeLessThan(epPos);
    expect(epPos).toBeLessThan(cpPos);
  });

  it('wraps sections in XML tags', () => {
    const result = assembleAppendSystemContext({
      projectContext: 'PC',
      workingMemory: 'WM',
      thinkingOs: 'TO',
      evolutionPrinciples: 'EP',
      corePrinciples: 'CP',
    });
    expect(result).toContain('<project_context>\nPC\n</project_context>');
    expect(result).toContain('WM');
    expect(result).toContain('<thinking_os>\nTO\n</thinking_os>');
    expect(result).toContain('<evolution_principles>\nEP\n</evolution_principles>');
    expect(result).toContain('<core_principles>\nCP\n</core_principles>');
    expect(result).toContain('`<working_memory>`');
    expect(result).toContain('`<thinking_os>`');
  });

  it('wraps behavioral_constraints with empathy content', () => {
    const result = assembleAppendSystemContext({
      behavioralConstraints: 'Do not output JSON',
    });
    expect(result).toContain('<behavioral_constraints>\nDo not output JSON\n</behavioral_constraints>');
  });

  it('includes CONTEXT SECTIONS header when parts exist', () => {
    const result = assembleAppendSystemContext({
      corePrinciples: 'CP',
    });
    expect(result).toContain('## 【CONTEXT SECTIONS】');
    expect(result).toContain('Priority: Low → High');
  });

  it('includes EXECUTION RULES footer when parts exist', () => {
    const result = assembleAppendSystemContext({
      corePrinciples: 'CP',
    });
    expect(result).toContain('**【EXECUTION RULES】**');
    expect(result).not.toContain('`<behavioral_constraints>`');
    expect(result).not.toContain('`<working_memory>`');
    expect(result).not.toContain('`<thinking_os>`');
    expect(result).toContain('`<core_principles>`');
  });

  it('skips undefined parts', () => {
    const result = assembleAppendSystemContext({
      projectContext: 'PC',
      // thinkingOs undefined
      corePrinciples: 'CP',
    });
    expect(result).toContain('PC');
    expect(result).toContain('CP');
    expect(result).not.toContain('<thinking_os>\n');
  });

  it('skips empty string parts', () => {
    const result = assembleAppendSystemContext({
      projectContext: '',
      corePrinciples: 'CP',
    });
    // The actual <project_context> section tag should not appear (only in footer docs)
    expect(result).not.toContain('<project_context>\n');
    expect(result).toContain('<core_principles>\nCP\n</core_principles>');
  });
});

// ─── extractPhrasesFromReason ──────────────────────────────────────────────

describe('extractPhrasesFromReason', () => {
  it('extracts Chinese phrases from comma-separated reason', () => {
    const reason = '用户表达了强烈的挫败感，反复尝试仍然失败，情绪低落';
    const result = extractPhrasesFromReason(reason, 'zh');
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result).toContain('用户表达了强烈的挫败感');
    expect(result).toContain('反复尝试仍然失败');
    expect(result).toContain('情绪低落');
  });

  it('extracts English phrases from comma-separated reason', () => {
    const reason = 'user frustrated, repeated failures, giving up';
    const result = extractPhrasesFromReason(reason, 'en');
    expect(result).toHaveLength(3);
    expect(result).toContain('user frustrated');
    expect(result).toContain('repeated failures');
    expect(result).toContain('giving up');
  });

  it('returns at most 3 phrases', () => {
    const reason = '挫败感，不满，困惑，疲劳，放弃';
    const result = extractPhrasesFromReason(reason, 'zh');
    expect(result).toEqual(['挫败感', '不满', '困惑']);
  });

  it('deduplicates repeated phrases', () => {
    const reason = '挫败感，挫败感，用户不满';
    const result = extractPhrasesFromReason(reason, 'zh');
    expect(result).toHaveLength(2);
    expect(result).toContain('挫败感');
    expect(result).toContain('用户不满');
  });

  it('filters out segments shorter than MIN_LENGTH (zh=2)', () => {
    const reason = 'A，好，完成，任务执行失败';
    const result = extractPhrasesFromReason(reason, 'zh');
    // 'A' (1 char) and '好' (1 char) filtered out
    expect(result).not.toContain('A');
    expect(result).not.toContain('好');
    expect(result).toContain('完成');
    expect(result).toContain('任务执行失败');
  });

  it('filters out segments shorter than MIN_LENGTH (en=3)', () => {
    const reason = 'no, ok, yes, task failed completely';
    const result = extractPhrasesFromReason(reason, 'en');
    // 'no' (2 chars), 'ok' (2 chars), 'yes' (3 chars) - yes passes
    expect(result).not.toContain('no');
    expect(result).not.toContain('ok');
  });

  it('filters out segments longer than MAX_LENGTH (20)', () => {
    const reason = 'this is a very long segment that exceeds the maximum allowed length';
    const result = extractPhrasesFromReason(reason, 'en');
    expect(result).toHaveLength(0);
  });

  it('handles empty reason string', () => {
    const result = extractPhrasesFromReason('', 'zh');
    expect(result).toEqual([]);
  });

  it('splits on multiple delimiter types (caps at MAX_PHRASES=3)', () => {
    const reason = '挫败感。不满！困惑？疲劳；反复尝试\n最终放弃';
    const result = extractPhrasesFromReason(reason, 'zh');
    expect(result.length).toBeLessThanOrEqual(3);
    expect(result).toContain('挫败感');
    expect(result).toContain('不满');
    expect(result).toContain('困惑');
  });

  it('handles reason with only delimiters and no valid phrases', () => {
    const reason = '，。！';
    const result = extractPhrasesFromReason(reason, 'zh');
    expect(result).toEqual([]);
  });

  it('trims whitespace from segments', () => {
    const reason = '  挫败感  ，  不满  ';
    const result = extractPhrasesFromReason(reason, 'zh');
    expect(result).toContain('挫败感');
    expect(result).toContain('不满');
    expect(result.every(p => p === p.trim())).toBe(true);
  });
});
