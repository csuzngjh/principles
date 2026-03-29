import { describe, it, expect } from 'vitest';
import {
  detectOpportunity,
  detectViolation,
  computeCompliance,
  computeAllCompliance,
  groupEventsIntoSessions,
  type SessionEvents,
  type RawEventEntry,
} from '../../src/core/nocturnal-compliance.js';

// ---------------------------------------------------------------------------
// Test Utilities
// ---------------------------------------------------------------------------

function makeSession(overrides: Partial<SessionEvents> = {}): SessionEvents {
  return {
    sessionId: overrides.sessionId ?? 'session-1',
    toolCalls: overrides.toolCalls ?? [],
    painSignals: overrides.painSignals ?? [],
    gateBlocks: overrides.gateBlocks ?? [],
    userCorrections: overrides.userCorrections ?? [],
    planApprovals: overrides.planApprovals ?? [],
  };
}

// ---------------------------------------------------------------------------
// detectOpportunity — T-01
// ---------------------------------------------------------------------------

describe('detectOpportunity — T-01', () => {
  it('returns applicable on edit operations', () => {
    const session = makeSession({
      toolCalls: [{ toolName: 'edit_file', filePath: 'src/main.ts', outcome: 'success' }],
    });
    const result = detectOpportunity('T-01', session);
    expect(result.applicable).toBe(true);
  });

  it('returns applicable on write_to_file', () => {
    const session = makeSession({
      toolCalls: [{ toolName: 'write_to_file', filePath: 'src/new.ts', outcome: 'success' }],
    });
    expect(detectOpportunity('T-01', session).applicable).toBe(true);
  });

  it('returns not applicable when only read operations', () => {
    const session = makeSession({
      toolCalls: [{ toolName: 'read_file', filePath: 'src/main.ts', outcome: 'success' }],
    });
    const result = detectOpportunity('T-01', session);
    expect(result.applicable).toBe(false);
  });

  it('returns not applicable on empty session', () => {
    const session = makeSession({ toolCalls: [] });
    expect(detectOpportunity('T-01', session).applicable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// detectOpportunity — T-05
// ---------------------------------------------------------------------------

describe('detectOpportunity — T-05', () => {
  it('returns applicable when gate block fires', () => {
    const session = makeSession({
      gateBlocks: [{ toolName: 'delete_file', filePath: 'src/main.ts', reason: 'risky operation' }],
    });
    const result = detectOpportunity('T-05', session);
    expect(result.applicable).toBe(true);
  });

  it('returns applicable when risky tool is attempted', () => {
    const session = makeSession({
      toolCalls: [{ toolName: 'delete_file', outcome: 'blocked' }],
    });
    expect(detectOpportunity('T-05', session).applicable).toBe(true);
  });

  it('returns applicable for dangerous bash command', () => {
    const session = makeSession({
      toolCalls: [{ toolName: 'bash', outcome: 'failure', errorMessage: 'rm -rf /home' }],
    });
    expect(detectOpportunity('T-05', session).applicable).toBe(true);
  });

  it('returns not applicable when no risky operations', () => {
    const session = makeSession({
      toolCalls: [{ toolName: 'read_file', outcome: 'success' }],
    });
    const result = detectOpportunity('T-05', session);
    expect(result.applicable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// detectOpportunity — T-09
// ---------------------------------------------------------------------------

describe('detectOpportunity — T-09', () => {
  it('returns applicable when session has 5+ tool calls', () => {
    const calls = Array.from({ length: 6 }, (_, i) => ({
      toolName: 'read_file' as const,
      filePath: `src/file${i}.ts`,
      outcome: 'success' as const,
    }));
    const session = makeSession({ toolCalls: calls });
    expect(detectOpportunity('T-09', session).applicable).toBe(true);
  });

  it('returns applicable when 3+ files touched', () => {
    const session = makeSession({
      toolCalls: [
        { toolName: 'read_file', filePath: 'src/a.ts', outcome: 'success' },
        { toolName: 'read_file', filePath: 'src/b.ts', outcome: 'success' },
        { toolName: 'edit_file', filePath: 'src/c.ts', outcome: 'success' },
      ],
    });
    expect(detectOpportunity('T-09', session).applicable).toBe(true);
  });

  it('returns applicable when pain present on complex task', () => {
    const session = makeSession({
      toolCalls: [
        { toolName: 'edit_file', filePath: 'src/main.ts', outcome: 'failure' },
      ],
      painSignals: [{ source: 'edit', score: 60 }],
    });
    expect(detectOpportunity('T-09', session).applicable).toBe(true);
  });

  it('returns not applicable for short sessions', () => {
    const session = makeSession({
      toolCalls: [
        { toolName: 'read_file', filePath: 'src/main.ts', outcome: 'success' },
        { toolName: 'edit_file', filePath: 'src/main.ts', outcome: 'success' },
      ],
    });
    expect(detectOpportunity('T-09', session).applicable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// detectViolation — T-01
// ---------------------------------------------------------------------------

describe('detectViolation — T-01', () => {
  it('returns violated when editing unread file followed by pain', () => {
    const session = makeSession({
      toolCalls: [
        { toolName: 'edit_file', filePath: 'src/main.ts', outcome: 'failure' },
      ],
      painSignals: [
        { source: 'src/main.ts', score: 50, reason: 'edit without understanding structure' },
      ],
    });
    const result = detectViolation('T-01', session);
    expect(result.violated).toBe(true);
  });

  it('returns NOT violated when file was read before edit', () => {
    const session = makeSession({
      toolCalls: [
        { toolName: 'read_file', filePath: 'src/main.ts', outcome: 'success' },
        { toolName: 'edit_file', filePath: 'src/main.ts', outcome: 'success' },
      ],
    });
    const result = detectViolation('T-01', session);
    expect(result.violated).toBe(false);
  });

  it('returns violated when editing unread file followed by tool failure', () => {
    const session = makeSession({
      toolCalls: [
        { toolName: 'edit_file', filePath: 'src/main.ts', outcome: 'failure' },
      ],
    });
    const result = detectViolation('T-01', session);
    expect(result.violated).toBe(true);
    expect(result.reason).toContain('without understanding');
  });

  it('returns NOT violated when edit succeeds without prior read (but no pain)', () => {
    // No pain signal, no failure → can't confirm violation
    const session = makeSession({
      toolCalls: [
        { toolName: 'edit_file', filePath: 'src/main.ts', outcome: 'success' },
      ],
    });
    const result = detectViolation('T-01', session);
    expect(result.violated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// detectViolation — T-05
// ---------------------------------------------------------------------------

describe('detectViolation — T-05', () => {
  it('returns violated when gate block fires on risky operation', () => {
    const session = makeSession({
      gateBlocks: [{ toolName: 'bash', reason: 'rm -rf attempted', filePath: '/' }],
    });
    const result = detectViolation('T-05', session);
    expect(result.violated).toBe(true);
    expect(result.reason).toContain('safety rail not');
  });

  it('returns violated when gate block fires on delete_file', () => {
    const session = makeSession({
      gateBlocks: [{ toolName: 'delete_file', reason: 'risky', filePath: 'src/old.ts' }],
    });
    expect(detectViolation('T-05', session).violated).toBe(true);
  });

  it('returns NOT violated when no gate blocks', () => {
    const session = makeSession({
      toolCalls: [{ toolName: 'delete_file', outcome: 'success' }],
    });
    expect(detectViolation('T-05', session).violated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// detectViolation — T-09
// ---------------------------------------------------------------------------

describe('detectViolation — T-09', () => {
  it('returns violated on complex task with failure and no planning', () => {
    const calls = Array.from({ length: 6 }, (_, i) => ({
      toolName: 'edit_file' as const,
      filePath: `src/file${i}.ts`,
      outcome: 'failure' as const,
    }));
    const session = makeSession({ toolCalls: calls });
    const result = detectViolation('T-09', session);
    expect(result.violated).toBe(true);
  });

  it('returns NOT violated on complex task that has plan approval', () => {
    const calls = Array.from({ length: 6 }, (_, i) => ({
      toolName: 'edit_file' as const,
      filePath: `src/file${i}.ts`,
      outcome: 'failure' as const,
    }));
    const session = makeSession({
      toolCalls: calls,
      planApprovals: [{ toolName: 'edit_file', filePath: 'src/main.ts' }],
    });
    expect(detectViolation('T-09', session).violated).toBe(false);
  });

  it('returns NOT violated on non-complex session', () => {
    const session = makeSession({
      toolCalls: [
        { toolName: 'read_file', filePath: 'src/main.ts', outcome: 'success' },
        { toolName: 'edit_file', filePath: 'src/main.ts', outcome: 'success' },
      ],
    });
    expect(detectViolation('T-09', session).violated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// computeCompliance — basic
// ---------------------------------------------------------------------------

describe('computeCompliance — basic', () => {
  it('returns zero compliance when no sessions provided', () => {
    const result = computeCompliance('T-01', []);
    expect(result.principleId).toBe('T-01');
    expect(result.applicableOpportunityCount).toBe(0);
    expect(result.observedViolationCount).toBe(0);
    expect(result.complianceRate).toBe(0);
    expect(result.violationTrend).toBe(0);
  });

  it('returns compliance 1.0 when all opportunities compliant', () => {
    // T-01 applicable (has edit) but no violation (file was read first)
    const session = makeSession({
      toolCalls: [
        { toolName: 'read_file', filePath: 'src/main.ts', outcome: 'success' },
        { toolName: 'edit_file', filePath: 'src/main.ts', outcome: 'success' },
      ],
    });
    const result = computeCompliance('T-01', [session]);
    expect(result.complianceRate).toBe(1.0);
    expect(result.applicableOpportunityCount).toBe(1);
    expect(result.observedViolationCount).toBe(0);
  });

  it('returns compliance 0.0 when all opportunities violated', () => {
    // T-05: gate block fires (applicable) AND violated
    const session = makeSession({
      gateBlocks: [{ toolName: 'delete_file', reason: 'risky', filePath: 'src/old.ts' }],
    });
    const result = computeCompliance('T-05', [session]);
    expect(result.complianceRate).toBe(0);
    expect(result.applicableOpportunityCount).toBe(1);
    expect(result.observedViolationCount).toBe(1);
  });

  it('computes partial compliance correctly', () => {
    const compliant = makeSession({
      toolCalls: [
        { toolName: 'read_file', filePath: 'src/main.ts', outcome: 'success' },
        { toolName: 'edit_file', filePath: 'src/main.ts', outcome: 'success' },
      ],
    });
    const violated = makeSession({
      sessionId: 'session-2',
      toolCalls: [
        { toolName: 'edit_file', filePath: 'src/main.ts', outcome: 'failure' },
      ],
    });
    const result = computeCompliance('T-01', [compliant, violated]);
    // 2 applicable, 1 violated → compliance = (2-1)/2 = 0.5
    expect(result.complianceRate).toBe(0.5);
    expect(result.applicableOpportunityCount).toBe(2);
    expect(result.observedViolationCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// computeCompliance — dilution prevention
// ---------------------------------------------------------------------------

describe('computeCompliance — dilution prevention', () => {
  /**
   * The dilution prevention scenario:
   * T-05 is a LOW-frequency, HIGH-severity principle.
   * If we compute compliance over ALL sessions (including ones with no risky ops),
   * the compliance rate would be inflated because non-applicable sessions
   * count as "compliant by default" — which is WRONG.
   *
   * Our engine ONLY counts sessions where T-05 was applicable.
   */
  it('T-05 compliance ignores sessions with no risky operations', () => {
    // Session A: T-05 violated (gate block on delete)
    const sessionA = makeSession({
      sessionId: 'A',
      gateBlocks: [{ toolName: 'delete_file', reason: 'risky', filePath: 'src/old.ts' }],
    });

    // Session B: No gate blocks, no risky ops — T-05 NOT APPLICABLE
    const sessionB = makeSession({
      sessionId: 'B',
      toolCalls: [{ toolName: 'read_file', outcome: 'success' }],
    });

    // Session C: Another non-applicable session (only read ops)
    const sessionC = makeSession({
      sessionId: 'C',
      toolCalls: [{ toolName: 'grep', outcome: 'success' }],
    });

    // WRONG approach (session-average): (1 + 0 + 0) / 3 = 33% compliance
    // CORRECT approach (opportunity-based): only session A counts
    // Session A: applicable + violated → 0% compliance
    const result = computeCompliance('T-05', [sessionA, sessionB, sessionC]);

    expect(result.applicableOpportunityCount).toBe(1); // Only session A
    expect(result.observedViolationCount).toBe(1); // Session A violated
    expect(result.complianceRate).toBe(0); // 0% — not diluted by B and C

    // Explanation must mention dilution prevention
    expect(result.explanation).toContain('applicable opportunities');
  });

  it('T-01 compliance ignores sessions with no edit operations', () => {
    // Session A: T-01 applicable + violated
    const sessionA = makeSession({
      sessionId: 'A',
      toolCalls: [{ toolName: 'edit_file', filePath: 'src/main.ts', outcome: 'failure' }],
    });

    // Session B: No edits — T-01 NOT APPLICABLE
    const sessionB = makeSession({
      sessionId: 'B',
      toolCalls: [{ toolName: 'read_file', outcome: 'success' }],
    });

    // T-01 compliance = 0% (1 applicable, 1 violated), session B doesn't dilute
    const result = computeCompliance('T-01', [sessionA, sessionB]);

    expect(result.applicableOpportunityCount).toBe(1);
    expect(result.observedViolationCount).toBe(1);
    expect(result.complianceRate).toBe(0);
  });

  it('high-frequency principle (T-01) still gets high opportunity count across diverse sessions', () => {
    // Sessions with edit ops — all T-01 applicable
    const sessions = [
      makeSession({ sessionId: '1', toolCalls: [{ toolName: 'edit_file', filePath: 'a.ts', outcome: 'success' }] }),
      makeSession({ sessionId: '2', toolCalls: [{ toolName: 'edit_file', filePath: 'b.ts', outcome: 'failure' }] }),
      makeSession({ sessionId: '3', toolCalls: [{ toolName: 'write_to_file', filePath: 'c.ts', outcome: 'success' }] }),
    ];

    // Session with no edits — T-01 not applicable
    const noEdit = makeSession({ sessionId: '4', toolCalls: [{ toolName: 'grep', outcome: 'success' }] });

    const result = computeCompliance('T-01', [...sessions, noEdit]);
    expect(result.applicableOpportunityCount).toBe(3); // Only sessions with edits
  });
});

// ---------------------------------------------------------------------------
// computeCompliance — violationTrend
// ---------------------------------------------------------------------------

describe('computeCompliance — violationTrend', () => {
  function t01(opportunity: 'violated' | 'compliant'): SessionEvents {
    if (opportunity === 'violated') {
      return makeSession({
        sessionId: `s-${opportunity}`,
        toolCalls: [{ toolName: 'edit_file', filePath: 'src/main.ts', outcome: 'failure' }],
      });
    }
    return makeSession({
      sessionId: `s-${opportunity}`,
      toolCalls: [
        { toolName: 'read_file', filePath: 'src/main.ts', outcome: 'success' },
        { toolName: 'edit_file', filePath: 'src/main.ts', outcome: 'success' },
      ],
    });
  }

  it('returns trend = +1 (improving) when recent violations decrease', () => {
    // Most recent: compliant, compliant
    // Previous: violated, violated, violated
    // Recent rate = 0/2 = 0, Previous rate = 3/3 = 1
    // delta = 1 - 0 > 0.1 → improving (+1)
    const sessions = [
      t01('compliant'), // index 0 (most recent in input order)
      t01('compliant'), // index 1
      t01('violated'),  // index 2
      t01('violated'),  // index 3
      t01('violated'),  // index 4
    ];
    const result = computeCompliance('T-01', sessions, { trendWindowSize: 2 });
    expect(result.violationTrend).toBe(1);
  });

  it('returns trend = -1 (worsening) when recent violations increase', () => {
    // Most recent: violated, violated
    // Previous: compliant, compliant
    // Recent rate = 2/2 = 1, Previous rate = 0/2 = 0
    // delta = 0 - 1 = -1 < -0.1 → worsening (-1)
    const sessions = [
      t01('violated'),
      t01('violated'),
      t01('compliant'),
      t01('compliant'),
    ];
    const result = computeCompliance('T-01', sessions, { trendWindowSize: 2 });
    expect(result.violationTrend).toBe(-1);
  });

  it('returns trend = 0 when stable', () => {
    // 2 compliant, then 2 compliant
    const sessions = [t01('compliant'), t01('compliant'), t01('compliant'), t01('compliant')];
    const result = computeCompliance('T-01', sessions, { trendWindowSize: 2 });
    expect(result.violationTrend).toBe(0);
  });

  it('returns trend = 0 when only 1 applicable session', () => {
    const sessions = [t01('violated')];
    const result = computeCompliance('T-01', sessions);
    expect(result.violationTrend).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// computeAllCompliance
// ---------------------------------------------------------------------------

describe('computeAllCompliance', () => {
  it('returns results for all T-01 through T-09', () => {
    const results = computeAllCompliance([]);
    const ids = results.map((r) => r.principleId);
    expect(ids).toEqual(['T-01', 'T-02', 'T-03', 'T-04', 'T-05', 'T-06', 'T-07', 'T-08', 'T-09']);
  });

  it('each result has all required fields', () => {
    const results = computeAllCompliance([]);
    for (const result of results) {
      expect(result.principleId).toBeDefined();
      expect(result.applicableOpportunityCount).toBe(0);
      expect(result.observedViolationCount).toBe(0);
      expect(result.complianceRate).toBe(0);
      expect(result.violationTrend).toBe(0);
      expect(result.explanation).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// groupEventsIntoSessions
// ---------------------------------------------------------------------------

describe('groupEventsIntoSessions', () => {
  function event(type: string, sessionId: string, data: Record<string, unknown> = {}): RawEventEntry {
    return { ts: '2026-03-27T12:00:00Z', type, sessionId, data };
  }

  it('groups events by sessionId', () => {
    const events: RawEventEntry[] = [
      event('tool_call', 's1', { toolName: 'read_file', filePath: 'a.ts' }),
      event('tool_call', 's1', { toolName: 'edit_file', filePath: 'b.ts' }),
      event('tool_call', 's2', { toolName: 'read_file', filePath: 'c.ts' }),
    ];
    const sessions = groupEventsIntoSessions(events);
    expect(sessions.get('s1')!.toolCalls).toHaveLength(2);
    expect(sessions.get('s2')!.toolCalls).toHaveLength(1);
  });

  it('maps pain_signal events', () => {
    const events: RawEventEntry[] = [
      event('pain_signal', 's1', { source: 'edit', score: 50, severity: 'moderate' }),
    ];
    const sessions = groupEventsIntoSessions(events);
    expect(sessions.get('s1')!.painSignals).toHaveLength(1);
    expect(sessions.get('s1')!.painSignals[0].source).toBe('edit');
    expect(sessions.get('s1')!.painSignals[0].severity).toBe('moderate');
  });

  it('maps gate_block events', () => {
    const events: RawEventEntry[] = [
      event('gate_block', 's1', { toolName: 'bash', reason: 'dangerous command' }),
    ];
    const sessions = groupEventsIntoSessions(events);
    expect(sessions.get('s1')!.gateBlocks).toHaveLength(1);
    expect(sessions.get('s1')!.gateBlocks[0].toolName).toBe('bash');
  });

  it('maps plan_approval events', () => {
    const events: RawEventEntry[] = [
      event('plan_approval', 's1', { toolName: 'edit_file', filePath: 'src/main.ts' }),
    ];
    const sessions = groupEventsIntoSessions(events);
    expect(sessions.get('s1')!.planApprovals).toHaveLength(1);
  });

  it('groups events without sessionId into "unknown"', () => {
    const events: RawEventEntry[] = [
      { ts: '2026-03-27T12:00:00Z', type: 'tool_call', data: { toolName: 'read_file' } },
    ];
    const sessions = groupEventsIntoSessions(events);
    expect(sessions.get('unknown')!.toolCalls).toHaveLength(1);
  });

  it('correctly maps error field to outcome', () => {
    const events: RawEventEntry[] = [
      event('tool_call', 's1', { toolName: 'edit_file', error: 'file not found' }),
      event('tool_call', 's2', { toolName: 'read_file' }), // no error → success
    ];
    const sessions = groupEventsIntoSessions(events);
    expect(sessions.get('s1')!.toolCalls[0].outcome).toBe('failure');
    expect(sessions.get('s2')!.toolCalls[0].outcome).toBe('success');
  });
});

// ---------------------------------------------------------------------------
// Explanation is human-readable
// ---------------------------------------------------------------------------

describe('ComplianceResult — explanation', () => {
  it('explanation includes compliance rate and trend', () => {
    const session = makeSession({
      toolCalls: [
        { toolName: 'read_file', filePath: 'src/main.ts', outcome: 'success' },
        { toolName: 'edit_file', filePath: 'src/main.ts', outcome: 'success' },
      ],
    });
    const result = computeCompliance('T-01', [session]);
    expect(result.explanation).toContain('T-01');
    expect(result.explanation).toContain('applicable opportunities');
    expect(result.explanation).toContain('100.0%'); // compliance rate
  });

  it('explanation notes when no opportunities exist', () => {
    const result = computeCompliance('T-05', [
      makeSession({ toolCalls: [{ toolName: 'read_file', outcome: 'success' }] }),
    ]);
    expect(result.explanation).toContain('No applicable opportunities');
  });

  it('explanation includes sample violation reasons', () => {
    const session = makeSession({
      gateBlocks: [{ toolName: 'delete_file', reason: 'risky', filePath: 'src/old.ts' }],
    });
    const result = computeCompliance('T-05', [session]);
    expect(result.explanation).toContain('violation');
    expect(result.explanation).toContain('safety rail not');
  });
});

// ---------------------------------------------------------------------------
// Integration: full session list
// ---------------------------------------------------------------------------

describe('Full session integration — T-05 dilution scenario', () => {
  /**
   * Real-world scenario: 20 sessions in a day.
   * Only 2 sessions involve risky operations (T-05 applicable).
   * Both had gate blocks (violations).
   * 18 sessions had no risky operations (T-05 not applicable).
   *
   * If we averaged all 20 sessions: 2 violations / 20 = 90% compliance (wrong!)
   * With opportunity-based: 2 applicable / 2 violated = 0% compliance (correct!)
   */
  it('does not dilute low-frequency high-severity principle compliance', () => {
    function gateBlockSession(id: string): SessionEvents {
      return makeSession({
        sessionId: id,
        gateBlocks: [{ toolName: 'bash', reason: 'rm -rf attempted', filePath: '/' }],
      });
    }

    function safeSession(id: string): SessionEvents {
      return makeSession({
        sessionId: id,
        toolCalls: [{ toolName: 'read_file', outcome: 'success' }],
      });
    }

    const sessions: SessionEvents[] = [
      // Only 2 sessions where T-05 is applicable
      gateBlockSession('risky-1'),
      gateBlockSession('risky-2'),
      // 18 sessions where T-05 is NOT applicable (safe operations)
      ...Array.from({ length: 18 }, (_, i) => safeSession(`safe-${i}`)),
    ];

    const result = computeCompliance('T-05', sessions);

    // Only 2 applicable opportunities
    expect(result.applicableOpportunityCount).toBe(2);
    // Both were violated
    expect(result.observedViolationCount).toBe(2);
    // Compliance = 0% — NOT 90%
    expect(result.complianceRate).toBe(0);
    expect(result.explanation).toContain('applicable opportunities');
  });
});
