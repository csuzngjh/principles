# WorkBuddy explicit Owner pain intake and plugin skills

Status: approved for implementation by the Owner on 2026-10-17 after the
directory and intake investigation. Runtime and delivery acceptance remain
separate from this approval.

## Problem

The WorkBuddy plugin ships hooks but no operational skills. An Owner asking
to record feedback has no discoverable PD procedure. The existing manual
CLI accepts only OpenClaw and Codex attribution, so copying another host's
skill cannot repair the workflow.

## Required behavior

1. The installed plugin contains `pd-record-pain`, `pd-status`, `pd-review`
   and `pd-disable` skills under its own `skills/` directory. They travel
   through the adapter package, installer payload, marketplace and versioned
   plugin cache. No independent user-level skill copy is maintained.
   Reinstallation must refresh a previously registered hook-only cache,
   including an unchanged plugin version. Registration alone is insufficient
   evidence of delivery; unrelated plugins and governance data must survive.
2. WorkBuddy accepts the current Owner message beginning exactly with
   `PD记录痛苦：`, followed by a nonempty statement of at most 500 characters.
   Oversized input is rejected, never silently truncated.
3. Native hook session and generation identities bind the submission. A
   missing identity or an internal continuation must not obtain Owner
   authority. No transcript content, latest-session scan, invented session
   identifier or text-only occurrence identity is used.
4. Existing admission, pain persistence and diagnostician task authorities
   own the result. Explicit feedback is an unverified `owner_statement`;
   model self-report is not promoted to verified fact or Owner policy.
5. A successful receipt names the real `painId`, `taskId` and WorkBuddy host.
   It guarantees registration and durable enqueue, not completed diagnosis,
   principle admission, approval, activation or improved behavior.
6. Replaying the same native occurrence is idempotent. Separate native
   turns remain distinct, including equal text. Existing Codex identities
   and behavior remain unchanged.
7. The existing `host.workbuddy` flag controls intake. Disabling it causes
   no new registration. Rejected submissions preserve the user's prompt and
   report a bounded reason through the verified prompt context channel.
8. All operations address the WorkBuddy governance workspace. Status and
   review use supported PD commands; disable delegates the installer-owned
   flag writer rather than introducing another configuration writer.

## Boundaries

No new LLM call is used for entry detection. Background diagnosis uses the
configured runtime and existing worker. Scoring, rate limits, approval
policy, transcript consent and governance ledgers retain their authorities.
The CLI may continue to reject WorkBuddy until a trustworthy manual binding
contract is implemented; skills must not advertise that rejected command.
No direct patch of installed runtime files or plugin caches is permitted.

## Verification and rollback

Production-hook tests must round-trip real SQLite pain/task persistence,
attribution, statement evidence, replay, separate turns, invalid input,
internal continuations and disabled state. Installer tests must reject an
incomplete skill payload and inspect skills after a real install boundary.
Package verification must inspect actual packed contents. Native WorkBuddy
skill discovery is a separate check; desktop submission, provider diagnosis
and Owner approval must never be replaced by source tests or seeded state.

Revert the source changes and deliver through the official installer/update
path. Existing Owner evidence remains preserved. No test approves or
activates a real Owner principle.
