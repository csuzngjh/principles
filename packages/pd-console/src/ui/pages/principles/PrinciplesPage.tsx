import { useState, useEffect, useCallback, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { PageShell } from "../../components/layout/page-shell.js";
import { SectionTitle } from "../../components/layout/section-title.js";
import { Button } from "../../components/ui/button.js";
import { Skeleton } from "../../components/ui/skeleton.js";
import { ShinyText } from "../../components/ui/shiny-text.js";
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
import { enumLabel } from "../../utils/enum-labels.js";
import { formatDate } from "../../utils/format-date.js";

// ── Status types for the review page ────────────────────────────────────────
type ReviewStatus = "pending" | "candidate" | "approved" | "rejected" | "parked";

// ── Merged principle + approval data ────────────────────────────────────────
interface PrincipleCard {
  principleId: string;
  title: string;
  /** Original title before fallback (shown in details when title is unreadable). PRI-332 */
  originalTitle: string;
  /** Whether the title was replaced with a bounded fallback. PRI-332 */
  titleUsedFallback: boolean;
  text: string;
  /** Real behavior-change description (PrincipleListItem.action); empty when none recorded */
  action: string;
  status: ReviewStatus;
  channels: string[];
  confidence: string;
  updatedAt: string;
  createdAt: string;
  priority: string;
  /** PRI-332: detected language of the principle text */
  detectedLanguage: string;
  /** PRI-332 P1-5: structured readability warning code */
  readabilityWarningCode?: string;
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

const CHANNEL_LABELS: Record<string, string> = {
  prompt: "channelPrompt",
  defer_archive: "channelDeferArchive",
  code_tool_hook: "channelCodeToolHook",
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

const BLOCK_IMPACT_KEY: Record<ReviewStatus, string> = {
  approved: "principles.blockImpactActive",
  pending: "principles.blockImpactPending",
  candidate: "principles.blockImpactPending",
  rejected: "principles.blockImpactRejected",
  parked: "principles.blockImpactParked",
};

// Summary metric tile (one of the three numbers in the metrics bar)
function Metric({ num, label }: { num: string; label: string }) {
  return (
    <div className="flex-1 min-w-[120px] px-4 py-3 border-r border-line last:border-r-0">
      <div className="font-mono text-[22px] font-semibold text-gov leading-none">{num}</div>
      <div className="font-mono text-[11px] uppercase tracking-[0.02em] text-ink-3 mt-1.5">{label}</div>
    </div>
  );
}

// Evolution block rendered under each principle card
function EvolutionBlock({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mt-3 pt-3 border-t border-line/60">
      <div className="font-mono text-[11px] uppercase tracking-[0.02em] text-ink-4 mb-1">{label}</div>
      <div className="text-ink-3 text-[13px] leading-relaxed">{children}</div>
    </div>
  );
}

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
  const { t, i18n } = useTranslation("pages");
  const navigate = useNavigate();

  const [principles, setPrinciples] = useState<PrincipleListItem[]>([]);
  const [approvalGroups, setApprovalGroups] = useState<ApprovalGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // PRI-558: summary powers the metrics bar (already returned by /api/principles)
  const [summary, setSummary] = useState<PrinciplesListData["summary"] | null>(null);

  // Search / filter / sort
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<ReviewStatus | "all">("all");
  const [sortBy, setSortBy] = useState<"updatedAt" | "createdAt">("updatedAt");
  // PRI-629 (INV-02): 默认展示全部 — candidate 是生命周期而非待办,
  // "只看待决策"不再作为默认视图 (真实决策在治理焦点)。
  const [filterMode, setFilterMode] = useState<'actionable' | 'all'>('all');
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
      // PRI-558: expose summary for the metrics bar
      setSummary(pData.summary);

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

    // PRI-332: Determine display title with bounded fallback for unreadable titles
    const rawTitle = p.triggerPattern || p.text.slice(0, 80);
    const detectedLang = p.detectedLanguage ?? 'unknown';
    const readWarningCode = p.readabilityWarningCode;
    let displayTitle = rawTitle;
    let usedFallback = false;
    if (readWarningCode) {
      displayTitle = t("principles.readabilityFallbackTitle");
      usedFallback = true;
    }

    return {
      principleId: p.id,
      title: displayTitle,
      originalTitle: rawTitle,
      titleUsedFallback: usedFallback,
      text: p.text,
      action: p.action,
      status: toReviewStatus(p.status, ag?.status),
      channels: uniqueChannels,
      confidence,
      updatedAt: p.updatedAt,
      createdAt: p.createdAt,
      priority: p.priority,
      detectedLanguage: detectedLang,
      readabilityWarningCode: readWarningCode,
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

  // PRI-558: most recent update across loaded principles (drives "Last Updated" metric)
  const latestUpdatedAt = principles.reduce<string>(
    (max, p) => (new Date(p.updatedAt).getTime() > new Date(max).getTime() ? p.updatedAt : max),
    principles[0]?.updatedAt ?? "",
  );

  return (
    <PageShell>
      {/* Header */}
      <SectionTitle>{t("principles.reviewTitle")}</SectionTitle>
      <ShinyText
        as="h1"
        className="text-[29px] font-semibold tracking-tight text-ink mb-2"
        duration={4.5}
        brightness={0.5}
        disabled={!(filterMode === 'actionable' && (categories?.owner_actionable ?? 0) > 0)}
      >
        {t("principles.reviewSubtitle")}
      </ShinyText>
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

      {/* PRI-558: metrics bar — bound to existing summary + derived latest update */}
      {!loading && !error && summary && (
        <div className="flex flex-wrap border border-line rounded-[var(--radius-md)] bg-panel overflow-hidden mb-6">
          <Metric num={String(summary.total)} label={t("principles.metricDeposited")} />
          <Metric num={String(summary.active)} label={t("principles.metricActive")} />
          <Metric num={latestUpdatedAt ? formatDate(latestUpdatedAt, i18n.language) : "—"} label={t("principles.metricLatest")} />
        </div>
      )}

      {/* Content */}
      {loading && (
        <div
          className="grid gap-3 animate-[pdFadeIn_200ms_ease-out]"
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
        <div className="relative pl-6 grid gap-3 animate-[pdFadeIn_400ms_ease-out]">
          {/* timeline rail — centered under the status dots (dot centers sit at x≈13px) */}
          <span className="absolute left-[12.5px] top-3 bottom-3 w-px bg-line" aria-hidden="true" />
          {filtered.map((card) => {
            const ag = approvalByPrinciple.get(card.principleId);
            const decision = GOV_DECISION[card.status];
            const decisionRecord =
              ag?.records?.find((r) => r.status === ag.status) ?? ag?.records?.[0];
            const decisionDate = decisionRecord?.createdAt;
            return (
              <article
                key={card.principleId}
                onClick={() => navigate(`/principles/${card.principleId}`)}
                className={
                  "relative bg-panel border border-line rounded-[var(--radius-md)] p-4 cursor-pointer " +
                  "border-l-[3px] " +
                  STATUS_BORDER[card.status] + " " +
                  "transition-[border-color,background,transform] duration-150 " +
                  "hover:border-line-2 hover:bg-surface hover:-translate-y-px " +
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
                {/* timeline node */}
                <span
                  className={
                    "absolute -left-[19px] top-4 h-2.5 w-2.5 rounded-full border-2 border-paper " +
                    STATUS_DOT_BG[card.status]
                  }
                  aria-hidden="true"
                />
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
                      {/* Channel label via global enum resolver — never raw i18n key */}
                      {enumLabel('channel', ch, t)}
                    </span>
                  ))}
                  {/* PRI-332: Language hint badge when principle language differs from UI language */}
                  {card.detectedLanguage && card.detectedLanguage !== 'unknown' && (
                    <span className="font-mono text-[11px] tracking-[0.02em] border border-line rounded-[2px] px-2 py-0.5 text-ink-4">
                      {card.detectedLanguage === 'zh'
                        ? t("principles.languageHintZh")
                        : t("principles.languageHintEn")}
                    </span>
                  )}
                  <span className="font-mono text-[11px] text-ink-4">
                    {t("principles.confidence")}: {enumLabel('confidence', card.confidence, t)}
                  </span>
                </div>

                {/* PRI-332 P1-5: Readability warning — rendered via i18n code, never raw English string */}
                {card.readabilityWarningCode && (
                  <div className="mb-2 px-3 py-1.5 bg-amber/5 border border-amber/20 rounded-[3px] text-ink-3 text-[12px] leading-snug">
                    {t("principles.readabilityWarning." + card.readabilityWarningCode, { defaultValue: t("principles.readabilityFallbackTitle") })}
                  </div>
                )}

                {/* PRI-332: Language mismatch hint when principle language ≠ current UI language */}
                {card.detectedLanguage && card.detectedLanguage !== 'unknown' && i18n.language && !i18n.language.startsWith(card.detectedLanguage) && (
                  <div className="mb-2 px-3 py-1.5 bg-surface/60 border-l-2 border-line rounded-[3px] text-ink-4 text-[12px] leading-snug">
                    {t("principles.languageMismatchHint", { lang: card.detectedLanguage === 'en' ? 'English' : '中文' })}
                  </div>
                )}

                {/* Title */}
                <h3 className="font-semibold text-ink mb-1">{card.title}</h3>

                {/* PRI-332: When title used fallback, show original technical text in collapsed details */}
                {card.titleUsedFallback && card.originalTitle && (
                  <details className="mb-1">
                    <summary className="text-ink-4 text-[11px] font-mono cursor-pointer hover:underline">
                      {t("principles.readabilityOriginalLabel")}
                    </summary>
                    <div className="text-ink-4 text-[12px] leading-snug mt-1 font-mono bg-surface/40 px-2 py-1 rounded-[3px] break-all">
                      {card.originalTitle}
                    </div>
                  </details>
                )}

                {/* Text preview */}
                <p className="text-ink-3 text-[13px] line-clamp-3 leading-relaxed">
                  {card.text}
                </p>

                {/* Timestamp */}
                <p className="font-mono text-[11px] text-ink-4 mt-2">
                  {t("principles.updatedAt")}: {formatDate(card.updatedAt, i18n.language)}
                </p>

                {/* PRI-558: evolution narrative blocks (real fields or honest fallback) */}
                <EvolutionBlock label={t("principles.blockBasis")}>
                  {ag?.candidateDescription ?? t("principles.blockBasisFallback")}
                </EvolutionBlock>
                <EvolutionBlock label={t("principles.blockImpact")}>
                  {t(BLOCK_IMPACT_KEY[card.status])}
                </EvolutionBlock>
                <EvolutionBlock label={t("principles.blockBehavior")}>
                  {card.action ? card.action : t("principles.blockBehaviorFallback")}
                </EvolutionBlock>
                <div className="mt-3 pt-3 border-t border-line/60">
                  <div className="flex items-center justify-between gap-3 bg-gov/5 border border-line rounded-[3px] px-3 py-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono text-[11px] uppercase tracking-[0.02em] text-ink-4">
                        {t("principles.govDecision")}
                      </span>
                      <span
                        className={
                          "font-mono text-[11px] uppercase tracking-[0.02em] border rounded-[2px] px-2 py-0.5 " +
                          STATUS_TEXT[card.status] +
                          " border-current/20"
                        }
                      >
                        {decision.glyph} {t(decision.labelKey)}
                      </span>
                    </div>
                    {decisionDate && (
                      <span className="font-mono text-[11px] text-ink-4 whitespace-nowrap">
                        {formatDate(decisionDate, i18n.language)}
                      </span>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </PageShell>
  );
}
