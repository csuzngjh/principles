import { useState, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { fetchSamples, fetchSampleDetail, reviewSample } from "../api.js";
import { PageHeader } from "../components/page-header.js";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../components/ui/card.js";
import { Button } from "../components/ui/button.js";
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from "../components/ui/select.js";
import { Badge } from "../components/ui/badge.js";
import { Skeleton } from "../components/ui/skeleton.js";
import { Separator } from "../components/ui/separator.js";
import { Check, X, ChevronLeft, ChevronRight, ClipboardList } from "lucide-react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "../components/ui/alert-dialog.js";
import { formatDate } from "../utils/format.js";

interface SampleListItem {
  sampleId: string;
  taskId: string;
  title: string;
  description: string;
  reviewStatus: "pending" | "approved" | "rejected";
  confidence: number | null;
  createdAt: string;
}

interface SampleDetail {
  sampleId: string;
  taskId: string;
  title: string;
  description: string;
  reviewStatus: "pending" | "approved" | "rejected";
  confidence: number | null;
  createdAt: string;
  artifactContent: Record<string, unknown> | null;
  recommendation: {
    title?: string;
    text?: string;
    triggerPattern?: string;
    action?: string;
    abstractedPrinciple?: string;
  } | null;
}

interface SamplesData {
  counters: Record<string, number>;
  items: SampleListItem[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  pending: "outline",
  approved: "default",
  rejected: "destructive",
};

export function SamplesPage() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [statusFilter, setStatusFilter] = useState(() => searchParams.get("status") ?? "all");
  const [page, setPage] = useState(() => {
    const p = searchParams.get("page");
    return p ? Math.max(1, parseInt(p, 10) || 1) : 1;
  });
  const [data, setData] = useState<SamplesData | null>(null);
  const [selected, setSelected] = useState<SampleDetail | null>(null);
  const [selectedId, setSelectedId] = useState(() => searchParams.get("id") ?? "");
  const [error, setError] = useState("");
  const [reviewLoading, setReviewLoading] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams();
    if (statusFilter !== "all") params.set("status", statusFilter);
    if (page > 1) params.set("page", String(page));
    if (selectedId) params.set("id", selectedId);
    setSearchParams(params, { replace: true });
  }, [statusFilter, page, selectedId, setSearchParams]);

  useEffect(() => {
    fetchSamples(statusFilter, page).then((result) => {
      if (result.success) {
        setData(result.data);
        setError("");
      } else {
        setError(result.error);
      }
    });
  }, [statusFilter, page]);

  useEffect(() => {
    if (!selectedId) {
      setSelected(null);
      return;
    }
    fetchSampleDetail(selectedId).then((result) => {
      if (result.success) {
        setSelected(result.data);
        setError("");
      } else {
        setError(result.error);
      }
    });
  }, [selectedId]);

  async function handleReview(decision: "approved" | "rejected") {
    if (!selected) return;
    setReviewLoading(true);
    try {
      const result = await reviewSample(selected.sampleId, decision);
      if (result.success) {
        const [samplesResult, detailResult] = await Promise.all([
          fetchSamples(statusFilter, page),
          fetchSampleDetail(selected.sampleId),
        ]);
        if (samplesResult.success) setData(samplesResult.data);
        if (detailResult.success) setSelected(detailResult.data);
      } else {
        setError(result.error);
      }
    } finally {
      setReviewLoading(false);
    }
  }

  if (error && !data) {
    return (
      <Card>
        <CardContent className="p-6">
          <p className="text-destructive">{error}</p>
          <Button variant="outline" className="mt-4" onClick={() => window.location.reload()}>
            {t("components:errorBoundary.retry")}
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (!data) {
    return (
      <div>
        <Skeleton className="h-8 w-48 mb-6" />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Card><CardContent className="p-6"><Skeleton className="h-40" /></CardContent></Card>
          <Card><CardContent className="p-6"><Skeleton className="h-40" /></CardContent></Card>
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title={t("pages:samples.title")}
        description={t("pages:samples.description")}
        actions={
          <div className="flex items-center gap-2">
            <label className="text-sm text-muted-foreground">{t("pages:samples.filterByStatus")}:</label>
            <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v); setPage(1); setSelectedId(""); }}>
              <SelectTrigger className="h-9 text-sm w-[130px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("common:all")}</SelectItem>
                <SelectItem value="pending">{t("common:pending")}</SelectItem>
                <SelectItem value="approved">{t("common:completed")}</SelectItem>
                <SelectItem value="rejected">{t("common:failed")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        }
      />

      {Object.keys(data.counters).length > 0 && (
        <div className="flex gap-2 mb-4 flex-wrap">
          {Object.entries(data.counters).map(([key, value]) => (
            <Badge key={key} variant="secondary">
              {key}: <strong className="ml-1">{value}</strong>
            </Badge>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">
              {t("pages:samples.title")} ({data.pagination.total})
            </CardTitle>
          </CardHeader>
          <CardContent className="max-h-[500px] overflow-y-auto">
            {data.items.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-8">
                {t("components:zoneSection.empty")}
              </p>
            )}
            {data.items.map((item) => (
              <div
                key={item.sampleId}
                onClick={() => setSelectedId(item.sampleId)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelectedId(item.sampleId); } }}
                className={`p-3 border-b border-border cursor-pointer transition-colors duration-150 ${
                  selectedId === item.sampleId
                    ? "bg-primary/5 border-l-2 border-l-primary"
                    : "hover:bg-accent"
                }`}
              >
                <div className="flex justify-between items-start">
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm truncate">
                      {item.title || item.sampleId}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                      {item.description}
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-1 ml-2">
                    <Badge variant={STATUS_VARIANT[item.reviewStatus] ?? "outline"}>
                      {item.reviewStatus}
                    </Badge>
                    {item.confidence !== null && (
                      <span className="text-xs text-muted-foreground">
                        {t("pages:samples.score")} {item.confidence}
                      </span>
                    )}
                  </div>
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  {formatDate(item.createdAt)}
                </p>
              </div>
            ))}
          </CardContent>
          {data.pagination.totalPages > 1 && (
            <div className="flex justify-center items-center gap-3 p-3 border-t border-border">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage(page - 1)}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="text-sm text-muted-foreground">
                {data.pagination.page} / {data.pagination.totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= data.pagination.totalPages}
                onClick={() => setPage(page + 1)}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          )}
        </Card>

        <Card>
          {!selected && (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
              <ClipboardList className="h-12 w-12 mb-3 opacity-50" />
              <p className="text-sm">{t("pages:samples.selectSample")}</p>
            </div>
          )}
          {selected && (
            <div>
              <div className="p-4 border-b border-border bg-muted/30">
                <div className="flex justify-between items-start">
                  <div>
                    <p className="font-semibold text-sm">
                      {selected.title || selected.sampleId}
                    </p>
                    <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
                      <span>{selected.sampleId.slice(0, 12)}…</span>
                      <Badge variant={STATUS_VARIANT[selected.reviewStatus] ?? "outline"}>
                        {selected.reviewStatus}
                      </Badge>
                      {selected.confidence !== null && (
                        <span>{t("pages:samples.score")} {selected.confidence}</span>
                      )}
                    </div>
                  </div>
                  {selected.reviewStatus === "pending" && (
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        onClick={() => handleReview("approved")}
                        disabled={reviewLoading}
                      >
                        <Check className="h-3 w-3 mr-1" />
                        {reviewLoading ? "…" : t("components:taskCard.approve")}
                      </Button>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            variant="destructive"
                            size="sm"
                            disabled={reviewLoading}
                          >
                            <X className="h-3 w-3 mr-1" />
                            {reviewLoading ? "…" : t("components:taskCard.reject")}
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>{t("pages:samples.confirmRejectTitle")}</AlertDialogTitle>
                            <AlertDialogDescription>{t("pages:samples.confirmRejectDescription")}</AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>{t("common:cancel")}</AlertDialogCancel>
                            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => handleReview("rejected")}>{t("common:confirm")}</AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  )}
                </div>
              </div>

              <div className="p-4 max-h-[450px] overflow-y-auto">
                {selected.description && (
                  <div className="mb-4">
                    <h4 className="text-xs font-medium text-muted-foreground mb-1">
                      {t("common:description")}
                    </h4>
                    <p className="text-sm leading-relaxed">{selected.description}</p>
                  </div>
                )}

                {selected.recommendation && (
                  <div className="mb-4">
                    <h4 className="text-xs font-medium text-muted-foreground mb-1">
                      {t("pages:samples.recommendation")}
                    </h4>
                    <div className="bg-muted/50 p-3 rounded-md text-sm flex flex-col gap-2">
                      {selected.recommendation.title && (
                        <div><strong>{t("pages:samples.titleLabel")}</strong> {selected.recommendation.title}</div>
                      )}
                      {selected.recommendation.text && (
                        <div><strong>{t("pages:samples.textLabel")}</strong> {selected.recommendation.text}</div>
                      )}
                      {selected.recommendation.triggerPattern && (
                        <div>
                          <strong>{t("pages:samples.triggerPatternLabel")}</strong>{" "}
                          <code className="bg-muted px-1.5 py-0.5 rounded text-xs">
                            {selected.recommendation.triggerPattern}
                          </code>
                        </div>
                      )}
                      {selected.recommendation.action && (
                        <div><strong>{t("pages:samples.actionLabel")}</strong> {selected.recommendation.action}</div>
                      )}
                      {selected.recommendation.abstractedPrinciple && (
                        <div><strong>{t("pages:samples.abstractedPrinciple")}</strong> {selected.recommendation.abstractedPrinciple}</div>
                      )}
                    </div>
                  </div>
                )}

                {selected.artifactContent && (
                  <div className="mb-4">
                    <h4 className="text-xs font-medium text-muted-foreground mb-1">
                      {t("pages:samples.artifactContent")}
                    </h4>
                    <pre className="bg-muted/50 p-3 rounded-md text-xs overflow-x-auto max-h-[200px]">
                      {JSON.stringify(selected.artifactContent, null, 2)}
                    </pre>
                  </div>
                )}

                <p className="text-xs text-muted-foreground mt-4">
                  {t("pages:samples.createdLabel")} {formatDate(selected.createdAt)} | {t("pages:samples.taskLabel")} {selected.taskId.slice(0, 12)}…
                </p>
              </div>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
