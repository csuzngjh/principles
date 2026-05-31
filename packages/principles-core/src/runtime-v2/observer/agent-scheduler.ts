import type { EmpathyObserverInput, EmpathyObserverOutputV1 } from './empathy-observer.js';
import type { CorrectionObserverPayload, CorrectionObserverOutputV1 } from './correction-observer.js';

// ── AgentTypeMap: SSOT for all Scheduler-routed Agent input/output contracts ──

export interface AgentTypeMap {
  'empathy-observer': { input: EmpathyObserverInput; output: EmpathyObserverOutputV1 };
  'correction-observer': { input: CorrectionObserverPayload; output: CorrectionObserverOutputV1 };
}

export type AgentScheduleMode = 'realtime' | 'periodic';

export interface ScheduledAgent<K extends keyof AgentTypeMap = keyof AgentTypeMap> {
  agentId: K;
  mode: AgentScheduleMode;
  runner: {
    run: (input: AgentTypeMap[K]['input']) => Promise<AgentTypeMap[K]['output']>;
  };
}

export class AgentScheduler {
  private readonly registry = new Map<string, ScheduledAgent<keyof AgentTypeMap>>();

  /**
   * Register a strongly-typed runner with its ID and execution mode
   */
  register<K extends keyof AgentTypeMap>(agent: ScheduledAgent<K>): void {
    this.registry.set(agent.agentId, agent as unknown as ScheduledAgent<keyof AgentTypeMap>);
  }

  /**
   * Dispatch execution to the registered runner with 100% type-safe input/output contracts.
   * Guarantees zero "as" casts in the public caller boundary (internal engine uses safe covariance casts).
   */
  async dispatch<K extends keyof AgentTypeMap>(
    agentId: K,
    input: AgentTypeMap[K]['input']
  ): Promise<AgentTypeMap[K]['output']> {
    const agent = this.registry.get(agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} is not registered in AgentScheduler`);
    }
    return agent.runner.run(input) as Promise<AgentTypeMap[K]['output']>;
  }

  /**
   * List all currently registered agents and their modes
   */
  getRegisteredAgents(): readonly { agentId: string; mode: AgentScheduleMode }[] {
    return Array.from(this.registry.values()).map((agent) => ({
      agentId: agent.agentId,
      mode: agent.mode,
    }));
  }
}
