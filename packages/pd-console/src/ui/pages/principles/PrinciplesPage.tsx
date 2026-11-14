import { useState, useEffect, useCallback, useRef } from "react";
import { Link, Outlet, useLocation, useMatch, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { PageShell } from "../../components/layout/page-shell.js";
import { Button } from "../../components/ui/button.js";
import { Skeleton } from "../../components/ui/skeleton.js";
import { StatePanel } from "../../components/ui/state-panel.js";
import {
  fetchPrinciples,
  fetchApprovalsGrouped,
  fetchOwnerDecisionLibrary,
} from "../../api.js";
import type {
  ApprovalGroup,
  PrincipleListItem,
  PrinciplesListData,
  ApprovalsGroupedData,
  OwnerDecisionLibraryData,
} from "../../api.js";
import { splitReadingTitleBody, truncateByCodePoints } from "../../utils/reading-layout.js";
import { PrinciplesViewNav } from "./PrinciplesViewNav.js";

// ── Status types for the review page ────────────────────────────────────────
type ReviewStatus = "pending" | "candidate" | "approved" | "rejected" | "parked";

// ── Merged principle + approval data ────────────────────────────────────────
interface PrincipleCard {
  principleId: string;
  title: string;
  searchText: string;
  text: string;
  status: ReviewStatus;
  /** Owner Decision Experience v1: backend-derived decision state (display only). */
  decisionState?: string;
  /** PRI-956 (F15): runtime authority revoked (activations deactivated) — the
   *  ledger status is asset lifecycle and never reflects deactivation. */
  runtimeDeactivated?: boolean;
  updatedAt: string;
  createdAt: string;
}

// ── Map principle status to review status ───────────────────────────────────
function toReviewStatus(
  principleStatus: string,
  approvalStatus?: string,
): ReviewStatus {
  if (approvalStatus === "approved") return "approved";
  if (approvalStatus === "rejected") return "rejected";
  if (principleStatus === "active") return "approved";
  if (principleStatus === "archived") return "parked";
  if (principleStatus === "deprecated") return "rejected";
  // PRI-629 INV-02: candidate/probation 是生命周期(内化进行中),不是"待你
  // 审查"。真实 Owner 决策只在治理焦点 Owner Inbox 呈现。
  return "candidate";
}

// ── Status visual mapping ───────────────────────────────────────────────────
const STATUS_BORDER: Record<ReviewStatus, string> = {
  pending: "border-l-gov",
  candidate: "border-l-ink-3",
  approved: "border-l-green",
  rejected: "border-l-danger",
  parked: "border-l-ink-3",
};

const STATUS_TEXT: Record<ReviewStatus, string> = {
  pending: "text-gov",
  candidate: "text-ink-3",
  approved: "text-green",
  rejected: "text-danger",
  parked: "text-ink-3",
};

// ── PRI-558: timeline node fill + status-driven copy (theme tokens, dark-mode safe) ──
const STATUS_DOT_BG: Record<ReviewStatus, string> = {
  pending: "bg-gov",
  candidate: "bg-ink-3",
  approved: "bg-green",
  rejected: "bg-danger",
  parked: "bg-ink-3",
};

// Governance decision row mirrors the true review status — rejected/parked must
// not read as "awaiting review" (labels reuse the existing status* keys).
const GOV_DECISION: Record<ReviewStatus, { glyph: string; labelKey: string }> = {
  approved: { glyph: "✓", labelKey: "principles.govApproved" },
  pending: { glyph: "⏳", labelKey: "principles.govPending" },
  candidate: { glyph: "○", labelKey: "principles.statusCandidate" },
  rejected: { glyph: "✗", labelKey: "principles.statusRejected" },
  parked: { glyph: "⏸", labelKey: "principles.statusParked" },
};

// ── Runtime validation helpers (H section) ──────────────────────────────────
function isString(v: unknown): v is string {
  return typeof v === "string";
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(isString);
}

function validatePrinciplesData(data: unknown): PrinciplesListData | null {
  if (!isRecord(data)) return null;
  if (!Object.hasOwn(data, "principles") || !Array.isArray(data.principles)) return null;
  // Validate each principle element has required string fields
  for (const item of data.principles) {
    if (!isRecord(item)) return null;
    if (!Object.hasOwn(item, "id") || !isString(item.id)) return null;
    if (!Object.hasOwn(item, "text") || !isString(item.text)) return null;
    if (!Object.hasOwn(item, "status") || !isString(item.status)) return null;
    if (!Object.hasOwn(item, "updatedAt") || !isString(item.updatedAt)) return null;
    if (!Object.hasOwn(item, "createdAt") || !isString(item.createdAt)) return null;
  }
  return data as unknown as PrinciplesListData;
}

function validateApprovalsGrouped(data: unknown): ApprovalsGroupedData | null {
  if (!isRecord(data)) return null;
  if (!Object.hasOwn(data, "groups") || !Array.isArray(data.groups)) return null;
  // Validate each group element
  for (const g of data.groups) {
    if (!isRecord(g)) return null;
    if (!Object.hasOwn(g, "principleId") || !isString(g.principleId)) return null;
    if (!Object.hasOwn(g, "status") || !isString(g.status)) return null;
    if (!Object.hasOwn(g, "records") || !Array.isArray(g.records)) return null;
    for (const r of g.records) {
      if (!isRecord(r)) return null;
      if (!Object.hasOwn(r, "id") || !isString(r.id)) return null;
      if (!Object.hasOwn(r, "channel") || !isString(r.channel)) return null;
    }
  }
  return data as unknown as ApprovalsGroupedData;
}

// ── Component ───────────────────────────────────────────────────────────────
export function PrinciplesPage() {
  const { t } = useTranslation("pages");

  const [principles, setPrinciples] = useState<PrincipleListItem[]>([]);
  const [approvalGroups, setApprovalGroups] = useState<ApprovalGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Search / filter / sort
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const selectedId = useMatch('/principles/:id')?.params.id;
  const updateQuery = (key: string, value: string) => {
    const next = new URLSearchParams(searchParams);
    next.set(key, value);
    setSearchParams(next, { replace: true, preventScrollReset: true, state: location.state });
  };
  const search = searchParams.get('q') ?? '';
  const setSearch = (value: string) => updateQuery('q', value);
  const statusParam = searchParams.get('status');
  const statusFilter: ReviewStatus | 'all' = statusParam === 'pending' || statusParam === 'candidate' || statusParam === 'approved' || statusParam === 'rejected' || statusParam === 'parked' ? statusParam : 'all';
  const setStatusFilter = (value: ReviewStatus | 'all') => updateQuery('status', value);
  const sortBy = searchParams.get('sort') === 'createdAt' ? 'createdAt' : 'updatedAt';
  const setSortBy = (value: 'createdAt' | 'updatedAt') => updateQuery('sort', value);
  // PRI-629 (INV-02): 默认展示全部 — candidate 是生命周期而非待办,
  // "只看待决策"不再作为默认视图 (真实决策在治理焦点)。
  const filterMode = searchParams.get('mode') === 'actionable' ? 'actionable' : 'all';
  const setFilterMode = (value: 'actionable' | 'all') => updateQuery('mode', value);
  const [categories, setCategories] = useState<Record<string, number> | undefined>();
  // Owner Decision Experience v1: backend semantic titles + decision states
  // (display-only — the page never re-derives decision qualification).
  const [ownerDecisionLibrary, setOwnerDecisionLibrary] = useState<OwnerDecisionLibraryData | null>(null);
  // PRI-956 (F15, D3): runtime status cannot be confirmed when set
  const [revocationUnavailable, setRevocationUnavailable] = useState<string | null>(null);

  const requestEpoch = useRef(0);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const refreshCatalog = useCallback(() => setRefreshVersion((version) => version + 1), []);

  // Fetch data
  const loadData = useCallback(async () => {
    const epoch = ++requestEpoch.current;
    setLoading(true);
    setError(null);
    try {
      const [pResult, aResult, dResult] = await Promise.all([
        fetchPrinciples(filterMode),
        fetchApprovalsGrouped(),
        fetchOwnerDecisionLibrary(),
      ]);

      if (epoch !== requestEpoch.current) return;
      setOwnerDecisionLibrary(dResult.success && dResult.data ? dResult.data : null);

      if (!pResult.success) {
        setError(pResult.error ?? "Failed to load principles");
        return;
      }

      const pData = validatePrinciplesData(pResult.data);
      if (!pData) {
        setError("Invalid principles data received");
        return;
      }
      setPrinciples(pData.principles);
      // PRI-330: Store categories for UI display
      setCategories(pData.categories);
      // PRI-956 (F15, D3): propagate revocation check unavailability
      setRevocationUnavailable(pData.revocationCheckUnavailable ?? null);

      const aData = aResult.success ? validateApprovalsGrouped(aResult.data) : null;
      setApprovalGroups(aData?.groups ?? []);
    } catch (err) {
      if (epoch !== requestEpoch.current) return;
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      if (epoch === requestEpoch.current) setLoading(false);
    }
  }, [filterMode]);

  useEffect(() => {
    void loadData();
    return () => { requestEpoch.current++; };
  }, [loadData, refreshVersion]);

  // Build approval lookup
  const approvalByPrinciple = new Map<string, ApprovalGroup>();
  for (const g of approvalGroups) {
    approvalByPrinciple.set(g.principleId, g);
  }

  // Merge principle + approval data into cards
  const cards: PrincipleCard[] = principles.map((p) => {
    const ag = approvalByPrinciple.get(p.id);
    // Owner Decision Experience v1 (SPEC §10/§11.2): the card title comes
    // from the backend Semantic Selector; when no readable principle exists
    // the card shows a NEUTRAL placeholder — original material stays available in the reader.
    const decision = ownerDecisionLibrary?.entries[p.id];
    const semanticTitle = decision?.learnedPrinciple.status === 'known' ? decision.learnedPrinciple.text : undefined;

    // PRI-332: Determine display title with bounded fallback for unreadable titles
    const rawTitle = p.triggerPattern || truncateByCodePoints(p.text, 80);
    const readWarningCode = p.readabilityWarningCode;
    let displayTitle = rawTitle;
    if (semanticTitle !== undefined) {
      displayTitle = semanticTitle;
    } else if (readWarningCode || decision !== undefined) {
      // No qualified semantic text: neutral placeholder instead of a
      // technical trigger as the Owner-facing title.
      displayTitle = t("principles.readabilityFallbackTitle");
    }

    return {
      principleId: p.id,
      title: splitReadingTitleBody(displayTitle).title,
      searchText: semanticTitle ?? rawTitle,
      text: p.text,
      status: toReviewStatus(p.status, ag?.status),
      decisionState: decision?.decisionState,
      runtimeDeactivated: p.runtimeDeactivated === true,
      updatedAt: p.updatedAt,
      createdAt: p.createdAt,
    };
  });

  // Filter + sort
  const filtered = cards
    .filter((c) => {
      if (statusFilter !== "all" && c.status !== statusFilter) return false;
      if (search) {
        const q = search.toLowerCase();
        if (!c.principleId.toLowerCase().includes(q) && !c.text.toLowerCase().includes(q) && !c.title.toLowerCase().includes(q) && !c.searchText.toLowerCase().includes(q))
          return false;
      }
      return true;
    })
    .sort((a, b) => {
      const key = sortBy === "updatedAt" ? "updatedAt" : "createdAt";
      return new Date(b[key]).getTime() - new Date(a[key]).getTime();
    });

  // 1B 注意力减法 (F-17): the same decision-state badge on every card becomes
  // background noise (11 × 「判断暂不可建立」). When one state dominates the
  // visible list, say it once above the list and only badge the exceptions.
  const decisionStateCounts = new Map<string, number>();
  for (const card of filtered) {
    if (card.decisionState !== undefined) {
      decisionStateCounts.set(card.decisionState, (decisionStateCounts.get(card.decisionState) ?? 0) + 1);
    }
  }
  let dominantState: string | null = null;
  let dominantCount = 0;
  for (const [state, count] of decisionStateCounts) {
    if (count > dominantCount) { dominantState = state; dominantCount = count; }
  }
  const suppressedDecisionState = dominantState !== null && dominantCount >= 3 && filtered.length > 1
    ? { state: dominantState, count: dominantCount }
    : null;

  const statusFilters: Array<{ value: ReviewStatus | "all"; label: string }> = [
    { value: "all", label: t("principles.allStatuses") },
    { value: "pending", label: t("principles.statusPending") },
    { value: "approved", label: t("principles.statusApproved") },
    { value: "rejected", label: t("principles.statusRejected") },
    { value: "parked", label: t("principles.statusParked") },
  ];

  return (
    <PageShell width="table" className="principle-library">
      <div className={selectedId === undefined ? 'principle-catalog' : 'principle-catalog principle-catalog-with-selection'} data-testid="principle-catalog">
      {/* PRI-956 (F15, D3): revocation status unavailability notice */}
      {revocationUnavailable && (
        <div className="mb-4 p-3 bg-amber-50 border border-amber-300 rounded-[var(--radius-md)] text-sm text-amber-800">
          {t("principles.revocationStatusUnknown")}
        </div>
      )}
      {/* Header */}
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h1 className="text-display font-semibold tracking-tight text-ink">
          {t("principles.libraryTitle")}
        </h1>
      </div>

      {/* PRI-641: Workspace Principles vs PD Core Principles internal nav */}
      <PrinciplesViewNav view="workspace" />

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3 mb-6 mt-4">
        {/* PRI-330: Actionable filter toggle */}
        <div className="flex gap-1" role="group" aria-label="Filter mode">
          <button
            onClick={() => setFilterMode('actionable')}
            aria-pressed={filterMode === 'actionable'}
            className={
              "font-mono text-eyebrow uppercase tracking-[0.02em] border rounded-[2px] px-2 py-1 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gov " +
              (filterMode === 'actionable'
                ? "bg-gov text-paper border-gov"
                : "bg-surface text-ink-3 border-line hover:border-line-2")
            }
          >
            {t("principles.filterActionable", { defaultValue: "Actionable" })}
            {categories?.owner_actionable ? ` (${categories.owner_actionable})` : ''}
          </button>
          <button
            onClick={() => setFilterMode('all')}
            aria-pressed={filterMode === 'all'}
            className={
              "font-mono text-eyebrow uppercase tracking-[0.02em] border rounded-[2px] px-2 py-1 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gov " +
              (filterMode === 'all'
                ? "bg-gov text-paper border-gov"
                : "bg-surface text-ink-3 border-line hover:border-line-2")
            }
          >
            {t("principles.filterAll", { defaultValue: "Show All" })}
            {categories ? ` (${Object.values(categories).reduce((a, b) => a + b, 0)})` : ''}
          </button>
        </div>

        {/* Search */}
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("principles.searchPlaceholder")}
          className="flex-1 min-w-[200px] border border-line rounded-[var(--radius-md)] bg-surface text-ink px-3 py-2 text-body focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gov"
          aria-label={t("principles.searchPlaceholder")}
        />

        {/* Status filter */}
        <div className="flex gap-1" role="group" aria-label="Status filter">
          {statusFilters.map((sf) => (
            <button
              key={sf.value}
              onClick={() => setStatusFilter(sf.value)}
              aria-pressed={statusFilter === sf.value}
              className={
                "font-mono text-eyebrow uppercase tracking-[0.02em] border rounded-[2px] px-2 py-1 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gov " +
                (statusFilter === sf.value
                  ? "bg-gov text-paper border-gov"
                  : "bg-surface text-ink-3 border-line hover:border-line-2")
              }
            >
              {sf.label}
            </button>
          ))}
        </div>

        {/* Sort */}
        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as "updatedAt" | "createdAt")}
          className="border border-line rounded-[var(--radius-md)] bg-surface text-ink-3 px-2 py-1 text-[12px] font-mono focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gov"
          aria-label="Sort order"
        >
          <option value="updatedAt">{t("principles.sortByUpdated")}</option>
          <option value="createdAt">{t("principles.sortByCreated")}</option>
        </select>
      </div>

      {/* Content */}
      {loading && (
        <div
          className="grid gap-3"
          role="status"
          aria-live="polite"
          aria-label={t("principles.loading", { defaultValue: "Loading…" })}
        >
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="bg-panel border border-line rounded-[var(--radius-md)] p-4 border-l-[3px] border-l-transparent"
            >
              <div className="flex items-start justify-between gap-3 mb-3">
                <Skeleton className="h-5 w-[55%] rounded-sm" />
                <Skeleton className="h-5 w-16 rounded-[2px]" />
              </div>
              <Skeleton className="h-4 w-full rounded-sm mb-2" />
              <Skeleton className="h-4 w-[80%] rounded-sm mb-4" />
              <div className="flex items-center gap-2">
                <Skeleton className="h-3.5 w-20 rounded-sm" />
                <Skeleton className="h-3.5 w-24 rounded-sm" />
              </div>
            </div>
          ))}
        </div>
      )}

      {error && (
        <div className="border border-danger/30 rounded-[var(--radius-md)] p-4 mb-4">
          <p className="text-danger text-sm">{error}</p>
          <Button variant="outline" size="sm" onClick={loadData} className="mt-2">
            {t("principles.retry", { defaultValue: "Retry" })}
          </Button>
        </div>
      )}

      {!loading && !error && filtered.length === 0 && principles.length === 0 && (
        <div className="py-6">
          <StatePanel
            kind="empty"
            title={t("principles.emptyTitle")}
            body={
              filterMode === 'actionable'
                ? t("principles.emptyActionable", { defaultValue: "No owner-actionable principles at this time. When PD captures behavior deviation signals, principle candidates will appear here for your review." })
                : t("principles.emptyDescription")
            }
            testId="principles-empty-state"
          />
          {categories && filterMode === 'actionable' && (
            <div className="flex justify-center gap-2 flex-wrap mt-4">
              {Object.entries(categories).map(([cat, count]) => (
                <span
                  key={cat}
                  className="font-mono text-eyebrow uppercase tracking-[0.02em] border border-line rounded-[2px] px-2 py-0.5 text-ink-4"
                >
                  {cat}: {count}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {!loading && !error && filtered.length === 0 && principles.length > 0 && (
        <p className="text-ink-3 text-sm">{t("principles.noResults")}</p>
      )}

      {!loading && !error && filtered.length > 0 && suppressedDecisionState && (
        <p className="text-caption leading-relaxed text-ink-3" data-testid="principles-dominant-state">
          {t("principles.ownerDecision.dominantNotice", {
            count: suppressedDecisionState.count,
            state: t(`principles.ownerDecision.state.${suppressedDecisionState.state}`, { defaultValue: suppressedDecisionState.state }),
          })}
        </p>
      )}

      {!loading && !error && filtered.length > 0 && (
        <div className="principle-catalog-list relative pl-6 grid gap-2">
          {/* timeline rail — centered under the status dots (dot centers sit at x≈13px) */}
          <span className="absolute left-[12.5px] top-3 bottom-3 w-px bg-line" aria-hidden="true" />
          {filtered.map((card) => {
            const decision = GOV_DECISION[card.status];
            return (
              <article
                key={card.principleId}
                data-selected={card.principleId === selectedId ? '' : undefined}
                className={
                  "relative bg-panel border border-line rounded-[var(--radius-md)] px-4 py-2 " +
                  "border-l-[3px] " +
                  STATUS_BORDER[card.status] + " " +
                  "transition-[border-color,background,transform] duration-150 " +
                  "hover:border-line-2 " +
                  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gov"
                }
              >
                {/* timeline node */}
                <span
                  className={
                    "absolute -left-[19px] top-3 h-2.5 w-2.5 rounded-full border-2 border-paper " +
                    STATUS_DOT_BG[card.status]
                  }
                  aria-hidden="true"
                />
                {/* One row shows the principle and the decision state. The reader owns the details. */}
                <div className="flex min-w-0 items-center gap-3">
                  <h3 className="min-w-0 flex-1 truncate text-body font-medium leading-6 text-ink">
                    <Link
                      className="rounded-sm after:absolute after:inset-0 after:content-[''] hover:text-gov focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gov"
                      to={{ pathname: `/principles/${encodeURIComponent(card.principleId)}`, search: searchParams.toString() }}
                      aria-current={card.principleId === selectedId ? 'page' : undefined}
                    >
                      {card.title}
                    </Link>
                  </h3>
                  {card.decisionState === suppressedDecisionState?.state
                    ? null
                    : <span className={`shrink-0 rounded-[3px] border px-2 py-0.5 text-caption ${STATUS_TEXT[card.status]}`}>{card.decisionState !== undefined ? t(`principles.ownerDecision.state.${card.decisionState}`, { defaultValue: card.decisionState }) : t(decision.labelKey)}</span>}
                </div>
                {card.runtimeDeactivated === true && <p className="text-caption text-amber">{t('principles.runtimeDeactivated')}</p>}
              </article>
            );
          })}
        </div>
      )}
      </div>
      <div className={selectedId === undefined ? 'principle-reader principle-reader-unselected' : 'principle-reader'} data-testid="principle-library-reader">
        {selectedId === undefined ? (
          <p className="principle-reader-prompt">{t('principles.libraryReadingPrompt')}</p>
        ) : <Outlet context={refreshCatalog} />}
      </div>
    </PageShell>
  );
}
