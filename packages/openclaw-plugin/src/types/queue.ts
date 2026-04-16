/**
 * Branded types for queue and workflow domain identifiers.
 * These prevent accidental interchange of plain strings with domain-specific IDs.
 */

/**
 * Brand type constructor using intersection type pattern.
 * @example type UserId = Brand<string, 'UserId'>;
 */
export type Brand<T, B> = T & { readonly _brand: B };

/**
 * Queue item identifier — not interchangeable with plain string.
 */
export type QueueItemId = Brand<string, 'QueueItemId'>;

/**
 * Workflow identifier — not interchangeable with plain string.
 */
export type WorkflowId = Brand<string, 'WorkflowId'>;

/**
 * Session key — not interchangeable with plain string.
 */
export type SessionKey = Brand<string, 'SessionKey'>;

/**
 * Constructor for QueueItemId.
 * @param id - raw string ID from queue operations
 */
export function toQueueItemId(id: string): QueueItemId {
  return id as QueueItemId;
}

/**
 * Constructor for WorkflowId.
 * @param id - raw string ID from workflow operations
 */
export function toWorkflowId(id: string): WorkflowId {
  return id as WorkflowId;
}

/**
 * Constructor for SessionKey.
 * @param key - raw string key from session operations
 */
export function toSessionKey(key: string): SessionKey {
  return key as SessionKey;
}

/**
 * Type predicate: true if value is a QueueItemId.
 */
export function isQueueItemId(value: unknown): value is QueueItemId {
  return typeof value === 'string';
}

/**
 * Type predicate: true if value is a WorkflowId.
 */
export function isWorkflowId(value: unknown): value is WorkflowId {
  return typeof value === 'string';
}

/**
 * Type predicate: true if value is a SessionKey.
 */
export function isSessionKey(value: unknown): value is SessionKey {
  return typeof value === 'string';
}
