/**
 * Feedback submit-ladder shared contract — PRI-613 Schema→Type→Validator pilot.
 *
 * Canonical authority for the wire shapes shared by server and UI. The
 * TypeBox schemas here are the single source: the server's ChannelStatus
 * derives from them (type-only import), and the UI's validator data shapes
 * derive via `import type` — the browser bundle must NOT import this module
 * at runtime (it would bundle @sinclair/typebox, ~850KB; see
 * feedback-channel-ids.ts for the runtime-safe const).
 *
 * UI validators (ui/utils/validators.ts) are a machine-enforced mirror:
 * tests/integration/feedback-contract.test.ts asserts schema-vs-validator
 * equivalence on an accept/reject matrix, so drift is CI-detectable without
 * shipping typebox to the browser.
 *
 * Single direction: Schema → Static type. Do NOT add a parallel interface
 * next to these schemas.
 */
import { Type, type Static } from '@sinclair/typebox';
import { FEEDBACK_CHANNEL_IDS } from './feedback-channel-ids.js';

/**
 * Optional explanation fields are `string | null` on the wire: absent means
 * "no reason to show"; explicit null is accepted and normalized to absent by
 * the UI validator (legacy readNullableString semantics).
 */
const optionalNullableString = Type.Optional(Type.Union([Type.String(), Type.Null()]));

export const FeedbackChannelStatusSchema = Type.Object({
  id: Type.Union(FEEDBACK_CHANNEL_IDS.map((id) => Type.Literal(id))),
  available: Type.Boolean(),
  reason: optionalNullableString,
  nextAction: optionalNullableString,
});
export type FeedbackChannelStatus = Static<typeof FeedbackChannelStatusSchema>;

export const FeedbackChannelsDataSchema = Type.Object({
  channels: Type.Array(FeedbackChannelStatusSchema),
});
export type FeedbackChannelsData = Static<typeof FeedbackChannelsDataSchema>;

export const FeedbackSubmitResultSchema = Type.Object({
  ok: Type.Boolean(),
  alreadySubmitted: Type.Boolean(),
  status: Type.String(),
  submittedVia: optionalNullableString,
  trackingId: optionalNullableString,
  externalUrl: optionalNullableString,
  writeBackFailed: Type.Optional(Type.Boolean()),
  nextAction: optionalNullableString,
});
export type FeedbackSubmitResult = Static<typeof FeedbackSubmitResultSchema>;
