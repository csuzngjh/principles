/** Console-facing update surface — the registered public seam between the
 * Console server (`@principles/pd-console`) and the installer/update package.
 *
 * ADR-0024 D-1: ReleaseManager is the sole update authority. This module is
 * that authority's *registered boundary*: the Console consumes update
 * operations exclusively through `create-principles-disciple/update-console`
 * (see the package `exports` map), never through `dist/` deep imports, so the
 * internals of `src/update/` stay free to reorganize without breaking the
 * Console — and a second, ungoverned updater cannot silently reappear.
 *
 * Deliberately minimal: only the symbols the Console update routes and their
 * tests consume are re-exported here. Adding a symbol to this surface is a
 * cross-package contract decision — check the consumers first.
 */

export {
  createReleaseManagerAuthority,
  mapReleaseManagerError,
  type ReleaseManagerAuthority,
  type ReleaseManagerAuthorityOptions,
  type ReleaseManagerAuthorityKind,
  type ReleaseManagerAuthorityReason,
  type ReleaseManagerAuthorityReadiness,
} from './release-manager-authority.js';

export {
  readTransactionJournalForRecovery,
  recoverUnfinishedTransaction,
  isTerminalTransactionState,
  readActiveRecord,
  type ActiveRecord,
  type JournalTransition,
  type RecoveryAwareJournalRead,
  type RecoveryOutcome,
  type TransactionState,
} from './transaction-journal.js';

export {
  resolvePdHomePaths,
  type PdHomePaths,
} from './install-layout.js';

export { ReleaseManagerError } from './release-manager.js';
