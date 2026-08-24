import type { GovernanceActionEventData } from '@principles/core/runtime-v2';
import { EventLog } from './core/event-log.js';

export type GovernanceAuditWriter = (
  stateDir: string,
  data: GovernanceActionEventData,
) => void;

export const writeGovernanceAction: GovernanceAuditWriter = (stateDir, data) => {
  const eventLog = new EventLog(stateDir);
  try {
    eventLog.recordGovernanceAction(data, { flushImmediately: true });
  } finally {
    eventLog.dispose();
  }
};

export async function authorizeGovernanceAction<T>(
  stateDir: string,
  data: GovernanceActionEventData,
  mutation: () => Promise<T>,
  writer: GovernanceAuditWriter = writeGovernanceAction,
): Promise<T> {
  writer(stateDir, data);
  return mutation();
}

export type { GovernanceActionEventData } from '@principles/core/runtime-v2';
