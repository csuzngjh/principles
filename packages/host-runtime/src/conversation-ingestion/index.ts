/**
 * Conversation-ingestion seam — public face (PRI-1171; SPEC v0.2 §4.1).
 *
 * The host-neutral minimal set: source contract + shared pipeline + consent
 * ledger v3 + text policy. Host decoders live in their own adapter packages
 * (AGENTS §8.2); a new host implements TranscriptSourceAdapter and calls
 * runConversationIngestion — zero changes to this package.
 */
export * from './source.js';
export * from './pipeline.js';
export * from './consent.js';
export * from './text-policy.js';
