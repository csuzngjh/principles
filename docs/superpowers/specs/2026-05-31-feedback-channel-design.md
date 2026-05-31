# PD MVP Feedback Channel Design

> Date: 2026-05-31
> Status: Draft approved for PRI-285 implementation planning
> Linear: PRI-285

## Context

PD is preparing for seed-customer validation. The product can now install, update, run the Console, capture pain signals, internalize principles, and activate behavior through the MVP channels. A critical gap remains: seed users and agents need a reliable, privacy-conscious way to report PD problems back to the maintainer.

This feature is not telemetry, analytics, or an automatic support system. It is a user-controlled feedback report generator. Reports are local drafts unless the user explicitly copies or submits them elsewhere.

## Product Boundary

PD owns the feedback report workflow only up to local draft generation and copy/export actions.

PD does not:

- silently upload logs;
- submit GitHub issues with a token;
- send email directly;
- collect analytics by default;
- attach raw prompts, raw chat, raw trajectories, file contents, environment variables, or secrets.

The first version supports both human users and agents, but the primary path is manual user feedback. Agents may generate local drafts; they must not send feedback automatically.

## User Flow

1. A user opens `Feedback / Report Problem` from the Console global entrypoint, or clicks `Report this problem` from an error, update failure, degraded health state, or other contextual surface.
2. The user selects a feedback type:
   - `bug`
   - `confusing`
   - `privacy_concern`
   - `feature_request`
   - `other`
3. The user fills in:
   - title;
   - description;
   - steps to reproduce;
   - expected behavior;
   - actual behavior;
   - optional severity.
4. PD attaches a low-sensitive diagnostic summary.
5. The user sees a privacy preview with included, excluded, and redacted sections.
6. The user saves a local draft under `<workspace>/.pd/feedback/drafts/`.
7. The Console offers:
   - copy full Markdown;
   - copy email-ready text;
   - open a GitHub issue draft URL containing only a short summary;
   - delete the draft.

## Agent Flow

OpenClaw or another agent may create a local feedback draft through the same contract. The agent can provide a summary, observed failure, and bounded command summary. The draft still goes through redaction and local storage. The user must review and copy or submit manually.

## Architecture

### Core Contract

Add a pure feedback report contract in `packages/principles-core/src/runtime-v2/feedback-report-contract.ts` or equivalent.

Responsibilities:

- define feedback report types;
- validate and normalize user/agent input;
- redact sensitive values;
- render stable Markdown and JSON;
- generate a bounded GitHub issue draft URL;
- provide safe serialization and bounded previews.

Constraints:

- no filesystem, process, database, or network imports;
- no OpenClaw imports;
- no unvalidated `as` casts on untrusted input.

### Server / I/O Layer

Add a pd-console server service and routes under `/api/feedback/reports/*`.

Responsibilities:

- collect low-sensitive diagnostic context;
- read version/platform/feature flag/canary summaries where available;
- write drafts to `<workspace>/.pd/feedback/drafts/`;
- list, read, and delete drafts;
- return structured failure reasons and next actions.

The existing `/api/feedback/gfi`, `/api/feedback/empathy-events`, and `/api/feedback/gate-blocks` endpoints remain internal signal views. The report API is separate to avoid mixing "system feedback signals" with "user feedback reports".

### Console UI

Add a Console feedback page or dialog with:

- feedback type selection;
- form fields;
- context preview;
- privacy preview;
- save draft;
- copy Markdown;
- copy email text;
- open GitHub issue draft URL;
- delete draft.

Contextual entrypoints should prefill source and reference IDs when available.

### Optional CLI

If it can be implemented without delaying the Console path, add `pd feedback draft`.

Constraints:

- `--json` prints exactly one JSON object;
- no automatic network submission;
- same core contract and redaction behavior as Console;
- useful for agents to create drafts.

If this expands the PR too much, defer the CLI as a follow-up. The Console + local draft path is the MVP requirement.

## Data Model

### FeedbackDraftInput

```ts
type FeedbackType =
  | "bug"
  | "confusing"
  | "privacy_concern"
  | "feature_request"
  | "other";

interface FeedbackDraftInput {
  type: FeedbackType;
  title: string;
  description: string;
  stepsToReproduce?: string;
  expectedBehavior?: string;
  actualBehavior?: string;
  userSeverity?: "low" | "medium" | "high";
  context?: {
    source: "console" | "cli" | "agent";
    page?: string;
    painId?: string;
    principleId?: string;
    approvalId?: string;
    activationId?: string;
    updateAttemptId?: string;
  };
  agentDraft?: {
    summary: string;
    observedFailure?: string;
    commandSummary?: string;
  };
}
```

### FeedbackReport

```ts
interface FeedbackReport {
  id: string;
  createdAt: string;
  type: FeedbackType;
  title: string;
  userText: {
    description: string;
    stepsToReproduce?: string;
    expectedBehavior?: string;
    actualBehavior?: string;
    userSeverity?: "low" | "medium" | "high";
  };
  diagnosticSummary: {
    versions: Record<string, unknown>;
    platform: Record<string, unknown>;
    featureFlags: Record<string, unknown>;
    canary: {
      status: "available" | "unavailable";
      summary?: string;
      unavailableReason?: string;
    };
    recentEvents: Array<{
      type: string;
      at: string;
      severity?: string;
      summary: string;
    }>;
  };
  contextRefs: Array<{
    kind: string;
    id: string;
    label?: string;
  }>;
  privacy: {
    excludedByDefault: string[];
    includedSections: string[];
    redactionNotes: string[];
  };
  outputs: {
    markdown: string;
    githubIssueUrl: string;
    emailText: string;
  };
}
```

The final names can follow existing project conventions, but the semantics must stay stable.

## Privacy Rules

Default allowed:

- package and plugin versions;
- OS, Node, and package manager versions;
- feature flag names and enabled states;
- health/canary statuses and bounded summaries;
- IDs and statuses for relevant PD objects;
- user-entered feedback text.

Default forbidden:

- raw prompt;
- raw chat;
- raw trajectory;
- file contents;
- full local absolute paths;
- environment variables;
- tokens, API keys, and credentials;
- full stack traces.

Allowed only as redacted summaries:

- absolute path -> basename or `<redacted-path>`;
- stack trace -> error name plus bounded top-frame basename;
- event log -> event type, timestamp, and bounded summary.

Every report must include privacy metadata showing what was included, excluded, and redacted.

## Storage

Drafts are stored under:

```text
<workspace>/.pd/feedback/drafts/
```

Each draft should have a stable local ID and at least a Markdown file. A JSON sibling is recommended if it helps Console listing and future automation.

The installer or docs must state that `.pd/feedback/` is local diagnostic material and should not be committed to git.

## Error Handling

- Version collection failure does not block draft creation; record `unavailableReason`.
- Feature flag/canary collection failure does not block draft creation; record `unavailableReason`.
- Draft write failure returns a structured error such as `feedback_draft_write_failed` with `reason` and `nextAction`.
- GitHub URL generation failure does not block Markdown generation; disable the URL action and show reason.
- Oversized fields are truncated with a redaction note.

No failure path may report success while skipping the draft.

## API Contract

Recommended routes:

- `POST /api/feedback/reports`
- `GET /api/feedback/reports`
- `GET /api/feedback/reports/:id`
- `DELETE /api/feedback/reports/:id`

The `POST` response should include:

- report ID;
- draft paths;
- privacy summary;
- markdown text or a retrieval link;
- email text;
- GitHub issue draft URL if generated.

## Testing

Core tests:

- redacts absolute paths, token-like values, and env-like values;
- rejects or normalizes malformed input;
- bounds Markdown and preview lengths;
- produces stable JSON shape;
- generates GitHub URL from short summary, not full report.

Server tests:

- `POST /api/feedback/reports` creates a draft;
- `GET /api/feedback/reports` lists drafts;
- `GET /api/feedback/reports/:id` reads one draft;
- `DELETE /api/feedback/reports/:id` deletes one draft;
- unavailable canary/features are recorded rather than fatal;
- write failure returns structured reason and next action.

Console tests:

- user can fill the feedback form;
- privacy preview displays included/excluded/redacted sections;
- contextual entrypoints prefill source/page/reference IDs;
- copy Markdown and email actions use generated output.

CLI tests, if CLI is included:

- `pd feedback draft --json` prints exactly one JSON object;
- no automatic submission;
- failure output includes reason and next action.

## Implementation Slices

1. Core report contract, redaction, rendering, and tests.
2. Server API and draft file storage.
3. Console feedback page/dialog and contextual entrypoints.
4. Optional CLI draft command and documentation.

The first PR may defer slice 4 if the Console path is complete and the CLI would expand scope too much.

## Acceptance Criteria

1. A seed user can create a local feedback report from Console.
2. Reports include enough diagnostic evidence for maintainer triage.
3. Reports default to privacy-preserving output.
4. Agent-generated feedback is draft-only and never sent automatically.
5. No network token is required.
6. Draft write and diagnostic collection failures fail loud with reason and next action.
7. The feature does not expand into telemetry, analytics, or automatic upload.

