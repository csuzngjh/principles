import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { PageShell } from "../../components/layout/page-shell.js";
import { SectionTitle } from "../../components/layout/section-title.js";
import { Button } from "../../components/ui/button.js";
import {
  fetchPrinciples,
  fetchApprovalsGrouped,
} from "../../api.js";
import type {
  ApprovalGroup,
  PrincipleListItem,
  PrinciplesListData,
  ApprovalsGroupedData,
} from "../../api.js";

// ── Status types for the review page ────────────────────────────────────────
type ReviewStatus = "pending" | "approved" | "rejected" | "parked";

// ── Merged principle + approval data ────────────────────────────────────────
interface PrincipleCard {
  principleId: string;
  title: string;
  text: string;
  status: ReviewStatus;
  channels: string[];
  confidence: string;
  updatedAt: string;
  createdAt: string;
  priority: string;
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
  if (principleStatus === "probation") return "pending";
  return "pending";
}

// ── Status visual mapping ───────────────────────────────────────────────────
const STATUS_BORDER: Record<ReviewStatus, string> = {
  pending: "border-l-gov",
  approved: "border-l-green",
  rejected: "border-l-danger",
  parked: "border-l-ink-3",
};

const STATUS_TEXT: Record<ReviewStatus, string> = {
  pending: "text-gov",
  approved: "text-green",
  rejected: "text-danger",
  parked: "text-ink-3",
};

const CHANNEL_LABELS: Record<string, string> = {
  prompt: "channelPrompt",
  defer_archive: "channelDeferArchive",
  code_tool_hook: "channelCodeToolHook",
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
  const navigate = useNavigate();

  const [principles, setPrinciples] = useState<PrincipleListItem[]>([]);
  const [approvalGroups, setApprovalGroups] = useState<ApprovalGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Search / filter / sort
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<ReviewStatus | "all">("all");
  const [sortBy, setSortBy] = useState<"updatedAt" | "createdAt">("updatedAt");
  // PRI-330: Default to actionable filter
  const [filterMode, setFilterMode] = useState<'actionable' | 'all'>('actionable');
  const [categories, setCategories] = useState<Record<string, number> | undefined>();

  // Fetch data
  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [pResult, aResult] = await Promise.all([
        fetchPrinciples(filterMode),
        fetchApprovalsGrouped(),
      ]);

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

      const aData = aResult.success ? validateApprovalsGrouped(aResult.data) : null;
      setApprovalGroups(aData?.groups ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [filterMode]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Build approval lookup
  const approvalByPrinciple = new Map<string, ApprovalGroup>();
  for (const g of approvalGroups) {
    approvalByPrinciple.set(g.principleId, g);
  }

  // Merge principle + approval data into cards
  const cards: PrincipleCard[] = principles.map((p) => {
    const ag = approvalByPrinciple.get(p.id);
    const channels = ag
      ? ag.records.map((r) => r.channel).filter(isString)
      : ["prompt"];
    const uniqueChannels = [...new Set(channels)];
    const confidence =
      p.evaluability === "deterministic"
        ? "high"
        : p.evaluability === "weak_heuristic"
          ? "low"
          : "medium";
    return {
      principleId: p.id,
      title: p.triggerPattern || p.text.slice(0, 80),
      text: p.text,
      status: toReviewStatus(p.status, ag?.status),
      channels: uniqueChannels,
      confidence,
      updatedAt: p.updatedAt,
      createdAt: p.createdAt,
      priority: p.priority,
    };
  });

  // Filter + sort
  const filtered = cards
    .filter((c) => {
      if (statusFilter !== "all" && c.status !== statusFilter) return false;
      if (search) {
        const q = search.toLowerCase();
        if (!c.text.toLowerCase().includes(q) && !c.title.toLowerCase().includes(q))
          return false;
      }
      return true;
    })
    .sort((a, b) => {
      const key = sortBy === "updatedAt" ? "updatedAt" : "createdAt";
      return new Date(b[key]).getTime() - new Date(a[key]).getTime();
    });

  const statusFilters: Array<{ value: ReviewStatus | "all"; label: string }> = [
    { value: "all", label: t("principles.allStatuses") },
    { value: "pending", label: t("principles.statusPending") },
    { value: "approved", label: t("principles.statusApproved") },
    { value: "rejected", label: t("principles.statusRejected") },
    { value: "parked", label: t("principles.statusParked") },
  ];

  return (
    <PageShell>
      {/* Header */}
      <SectionTitle>{t("principles.reviewTitle")}</SectionTitle>
      <h1 className="text-[29px] font-semibold tracking-tight text-ink mb-2">
        {t("principles.reviewSubtitle")}
      </h1>
      <p className="text-ink-3 text-[14px] leading-relaxed mb-6">
        {t("principles.reviewDescription")}
      </p>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3 mb-6">
        {/* PRI-330: Actionable filter toggle */}
        <div className="flex gap-1" role="group" aria-label="Filter mode">
          <button
            onClick={() => setFilterMode('actionable')}
            className={
              "font-mono text-[11px] uppercase tracking-[0.02em] border rounded-[2px] px-2 py-1 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gov " +
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
            className={
              "font-mono text-[11px] uppercase tracking-[0.02em] border rounded-[2px] px-2 py-1 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gov " +
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
          className="flex-1 min-w-[200px] border border-line rounded-[var(--radius-md)] bg-surface text-ink px-3 py-2 text-[13px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gov"
          aria-label={t("principles.searchPlaceholder")}
        />

        {/* Status filter */}
        <div className="flex gap-1" role="group" aria-label="Status filter">
          {statusFilters.map((sf) => (
            <button
              key={sf.value}
              onClick={() => setStatusFilter(sf.value)}
              className={
                "font-mono text-[11px] uppercase tracking-[0.02em] border rounded-[2px] px-2 py-1 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gov " +
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
        <p className="text-ink-3 text-sm">{t("principles.loading", { defaultValue: "Loading…" })}</p>
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
        <div className="text-center py-12">
          <h2 className="text-ink-2 text-lg font-semibold mb-2">
            {t("principles.emptyTitle")}
          </h2>
          <p className="text-ink-3 text-[14px] max-w-[480px] mx-auto leading-relaxed">
            {filterMode === 'actionable'
              ? t("principles.emptyActionable", { defaultValue: "No owner-actionable principles at this time. When PD captures behavior deviation signals, principle candidates will appear here for your review." })
              : t("principles.emptyDescription")}
          </p>
          {categories && filterMode === 'actionable' && (
            <div className="flex justify-center gap-2 flex-wrap mt-4">
              {Object.entries(categories).map(([cat, count]) => (
                <span
                  key={cat}
                  className="font-mono text-[11px] uppercase tracking-[0.02em] border border-line rounded-[2px] px-2 py-0.5 text-ink-4"
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

      {!loading && !error && filtered.length > 0 && (
        <div className="grid gap-3">
          {filtered.map((card) => (
            <article
              key={card.principleId}
              onClick={() => navigate(`/principles/${card.principleId}`)}
              className={
                "bg-panel border border-line rounded-[var(--radius-md)] p-4 cursor-pointer " +
                "border-l-[3px] " +
                STATUS_BORDER[card.status] + " " +
                "transition-[border-color,background] duration-150 " +
                "hover:border-line-2 hover:bg-surface " +
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gov"
              }
              tabIndex={0}
              role="link"
              aria-label={card.title}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  navigate(`/principles/${card.principleId}`);
                }
              }}
            >
              {/* Tags row */}
              <div className="flex items-center gap-2 mb-2 flex-wrap">
                <span
                  className={
                    "font-mono text-[11px] uppercase tracking-[0.02em] border rounded-[2px] px-2 py-0.5 " +
                    STATUS_TEXT[card.status] +
                    " border-current/20"
                  }
                >
                  {t("principles.status" + card.status.charAt(0).toUpperCase() + card.status.slice(1))}
                </span>
                {card.channels.map((ch) => (
                  <span
                    key={ch}
                    className="font-mono text-[11px] uppercase tracking-[0.02em] border border-line rounded-[2px] px-2 py-0.5 text-ink-3"
                  >
                    {t("principles." + (CHANNEL_LABELS[ch] ?? ch))}
                  </span>
                ))}
                <span className="font-mono text-[11px] text-ink-4">
                  {t("principles.confidence")}: {card.confidence}
                </span>
              </div>

              {/* Title */}
              <h3 className="font-semibold text-ink mb-1">{card.title}</h3>

              {/* Text preview */}
              <p className="text-ink-3 text-[13px] line-clamp-3 leading-relaxed">
                {card.text}
              </p>

              {/* Timestamp */}
              <p className="font-mono text-[11px] text-ink-4 mt-2">
                {t("principles.updatedAt")}: {new Date(card.updatedAt).toLocaleDateString()}
              </p>
            </article>
          ))}
        </div>
      )}
    </PageShell>
  );
}
