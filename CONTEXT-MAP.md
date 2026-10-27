# Context Map

Navigation entry for this repository: what each package owns, where its
production entry and tests live, and which docs/ADRs go deeper. Every target
below was verified against source (baseline `9bbb041e4`, 2026-09-06;
install/update and pain-evidence paths re-verified 2026-10-27).

Read-first global entry points:

- `docs/architecture/PD_ARCHITECTURE_OVERVIEW.md` — architecture SSoT entry (ADR-0014-aligned)
- `docs/adr/` — decision records; check status / superseding ADRs before relying on one
- `docs/product/PRODUCT_IDENTITY.md` — product boundary
- `AGENTS.md` — engineering constitution

## Package map

| Domain | Responsibility | Production entry | Verification | Deeper docs |
| --- | --- | --- | --- | --- |
| principles-core | Domain language and pure domain/runtime logic (Pain → Principle → reversible activation); core I/O only via registered seams | `src/index.ts` (public exports) | `tests/` + colocated `src/**/*.test.ts` | `packages/principles-core/CONTEXT.md` (domain language); ADR-0015, ADR-0017; `io-seam-registry.json` |
| host-runtime | Host-neutral runtime services shared by host adapters (pain evidence enrichment, host tool semantics, governance stores) | `src/index.ts` | `tests/` | — |
| openclaw-plugin | OpenClaw host plugin: hooks, `/pd-pain` command, RuleHost wiring | `openclaw.plugin.json` + `src/index.ts` → bundled `dist/bundle.js` | `tests/` | package `README.md` |
| codex-adapter | Codex CLI host adapter (`pd-hook`, tool semantics, ingestion) | `src/index.ts` | `tests/` | ADR-0020 |
| pd-cli | `pd` operator CLI | `src/index.ts` (commander; commands under `src/commands/`) | `tests/` | CLI contract: AGENTS.md §10 |
| pd-console | Web Console: `node:http` server (`src/server/`, routes under `src/server/routes/`) + browser UI (`src/ui/`) | `src/server.ts` → `src/server/index.ts` | `tests/server/`, `tests/ui/`, `tests/bdd/` | — |
| create-principles-disciple | Installer/updater package (`npx create-principles-disciple`): direct artifact deployment authority + transactional update subsystem | `src/index.ts` (bin) → `src/installer.ts`; update subsystem `src/update/` | `tests/` (installer\*, installer-journal\*, release-manager\*) | ADR-0023, ADR-0024; `docs/architecture/PRI-661-release-manager-adoption-analysis.md` |
| install-layout | Shared install layout / path resolution (`~/.pd` layout, dual-slot paths) | `src/index.ts` | `src/index.test.ts` | ADR-0023 |
| pd-companion | Electron desktop tray shell (PD Companion) | `src/main/` → `dist/main/main.js` | `tests/` | — |
| website | Public docs / marketing site (VitePress) | package root | `npm run test:website` | — |

## Task-oriented paths (spot-checked 2026-09-06; install/update and pain-evidence re-verified 2026-10-27)

- **Console requests**: browser callers → `packages/pd-console/src/ui/api.ts` (shared request transport) → `src/server/routes/*.ts`; response validators in `src/ui/utils/validators.ts`. Tests: `tests/ui/*.test.ts`, `tests/server/routes/*.test.ts`.
- **Install / update**: Console trigger/presentation `packages/pd-console/src/server/routes/update.ts` (+ `update-transaction.ts`, `update-history.ts`) → ReleaseManager authority (`packages/create-principles-disciple/src/update/release-manager-authority.ts`; `check` + `apply-full`) → deployment authority `packages/create-principles-disciple/src/installer.ts`; transaction journal `src/update/transaction-journal.ts`. Tests: `packages/pd-console/tests/server/routes/update*.test.ts`, `packages/pd-console/tests/server/update/`, installer/journal/release-manager tests in create-principles-disciple.
- **Pain evidence**: host events → `packages/openclaw-plugin/src/hooks/pain.ts` + `src/commands/pain.ts` (OpenClaw) and `packages/pd-cli/src/commands/pain-record.ts` (CLI) → semantic authority `packages/principles-core/src/runtime-v2/pain-ingress.ts`; persistence via runtime-v2 stores. Tests: colocated package tests + `tests/` in each package.

## Retired domains

- `conductor/` — orchestration experiment area, removed from the repository on 2026-03-15 (commit `1946667e4`) before the MVP pivot; no current consumer. Do not recreate (AGENTS.md §8.3).
- Legacy dev install chain — `scripts/install.mjs` and
  `packages/openclaw-plugin/scripts/sync-plugin.mjs`, deactivated by PRI-868
  (2026-09-20). Both entries now only print the deactivation notice and
  refuse; the former install bodies were removed on 2026-10-27. Authority for
  install/update is `create-principles-disciple` and the Console update page —
  do not recreate the old dev-write path into `~/.openclaw` / `~/.pd`.

## History note (2026-09-06 repair)

The original map (created 2026-05-13) registered per-package `CONTEXT.md`
targets that were never created for five of six domains — `conductor/` had in
fact already been removed two months before the map was written. This map now
points at existing, source-verified material instead of promised files.
`packages/principles-core/CONTEXT.md` remains the domain-language reference it
was written to be.
