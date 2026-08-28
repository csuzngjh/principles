/**
 * Feedback channel identity constants — PRI-613.
 *
 * Kept in a dependency-free module so the browser bundle can import the
 * runtime const WITHOUT pulling @sinclair/typebox in (the schema module
 * imports typebox; importing it at runtime from UI code would add ~850KB to
 * the browser bundle — measured, SPEC §10.5 stop condition). The schema
 * module derives its literal union from this const; the UI derives its
 * runtime channel-ID check from the same const. One authority, two safe
 * import contexts.
 */
export const FEEDBACK_CHANNEL_IDS = ['ingest', 'github', 'email', 'file'] as const;
export type FeedbackChannelId = (typeof FEEDBACK_CHANNEL_IDS)[number];
