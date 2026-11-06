import type { SqliteConnection } from '@principles/core/runtime';

export interface PromptActivationAuthority {
  authority?: 'owner' | 'system_policy';
  approvedBy?: string;
}

/** Read the existing approval row without changing how activation is granted. */
export function readPromptActivationAuthority(
  sqliteConn: Pick<SqliteConnection, 'getDb'>,
  artifactId: string,
  channel: string,
): PromptActivationAuthority {
  const row: unknown = sqliteConn.getDb().prepare(`
    SELECT decided_by FROM approvals
    WHERE artifact_id = ? AND channel = ? AND status = 'approved'
    ORDER BY decided_at DESC LIMIT 1
  `).get(artifactId, channel);
  if (row !== null && typeof row === 'object' && Object.hasOwn(row, 'decided_by')) {
    const decidedBy = (row as Record<string, unknown>).decided_by;
    return {
      authority: 'owner',
      approvedBy: typeof decidedBy === 'string' && decidedBy.length > 0 ? decidedBy : undefined,
    };
  }
  return { authority: 'system_policy' };
}
