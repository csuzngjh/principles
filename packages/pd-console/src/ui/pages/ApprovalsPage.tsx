import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { fetchApprovals, fetchApprovalDetail, approveApproval, rejectApproval } from "../api.js";
import type { ApprovalRecord } from "../api.js";
import { PageHeader } from "../components/page-header.js";
import { Card, CardContent } from "../components/ui/card.js";
import { Button } from "../components/ui/button.js";
import { Badge } from "../components/ui/badge.js";
import { Skeleton } from "../components/ui/skeleton.js";
import { ShieldCheck } from "lucide-react";
import { ApprovalCard } from "../components/approval-card.js";
import { ApprovalDetailDialog } from "../components/approval-detail-dialog.js";
import { RejectionReasonDialog } from "../components/rejection-reason-dialog.js";

export function ApprovalsPage() {
  const { t } = useTranslation();
  const [approvals, setApprovals] = useState<ApprovalRecord[]>([]);
  const [approvalStats, setApprovalStats] = useState({ pending: 0, approved: 0, rejected: 0, cancelled: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [detailApproval, setDetailApproval] = useState<ApprovalRecord | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [rejectTarget, setRejectTarget] = useState<ApprovalRecord | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const loadApprovals = useCallback(async () => {
    try {
      const result = await fetchApprovals();
      if (!result.success) {
        setError(result.error ?? t("pages:approvals.loadFailed"));
        return;
      }
      setApprovals(result.data.items);
      setApprovalStats(result.data.stats);
      setLastUpdated(new Date());
      setError(null);
    } catch {
      setError(t("pages:approvals.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    loadApprovals();
    const id = setInterval(loadApprovals, 15_000);
    return () => clearInterval(id);
  }, [loadApprovals]);

  async function handleApprovalDetail(approvalId: string) {
    setActionLoading(approvalId);
    try {
      const result = await fetchApprovalDetail(approvalId);
      if (!result.success) { setError(result.error); return; }
      setDetailApproval(result.data);
      setDetailOpen(true);
    } catch {
      setError(t("pages:approvals.detailFailed"));
    } finally {
      setActionLoading(null);
    }
  }

  async function handleApprovalApprove(approvalId: string) {
    setActionLoading(approvalId);
    setDetailOpen(false);
    try {
      const result = await approveApproval(approvalId);
      if (!result.success) { setError(result.error); return; }
      await loadApprovals();
    } catch {
      setError(t("pages:approvals.approveFailed"));
    } finally {
      setActionLoading(null);
    }
  }

  function handleApprovalRejectClick(approval: ApprovalRecord) {
    setRejectTarget(approval);
    setRejectOpen(true);
  }

  async function handleApprovalRejectSubmit(reason: string) {
    if (!rejectTarget) return;
    setActionLoading(rejectTarget.approvalId);
    setRejectOpen(false);
    setDetailOpen(false);
    try {
      const result = await rejectApproval(rejectTarget.approvalId, reason);
      if (!result.success) { setError(result.error); return; }
      await loadApprovals();
    } catch {
      setError(t("pages:approvals.rejectFailed"));
    } finally {
      setRejectTarget(null);
      setActionLoading(null);
    }
  }

  if (loading) {
    return (
      <div>
        <PageHeader title={t("pages:approvals.title")} description={t("pages:approvals.description")} />
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Card key={i}><CardContent className="p-4"><Skeleton className="h-16 w-full" /></CardContent></Card>
          ))}
        </div>
      </div>
    );
  }

  if (error && approvals.length === 0) {
    return (
      <div>
        <PageHeader title={t("pages:approvals.title")} description={t("pages:approvals.description")} />
        <Card>
          <CardContent className="p-6 text-center">
            <p className="text-destructive text-sm">{error}</p>
            <Button variant="outline" className="mt-4" onClick={loadApprovals}>
              {t("common:refresh")}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title={t("pages:approvals.title")}
        description={t("pages:approvals.description")}
        onRefresh={loadApprovals}
        lastUpdated={lastUpdated ?? undefined}
      />

      <div className="flex items-center gap-3 mb-4">
        <Badge variant="outline">{t("components:approvalCard.stats.pending")}: {approvalStats.pending}</Badge>
        <Badge variant="outline">{t("components:approvalCard.stats.approved")}: {approvalStats.approved}</Badge>
        <Badge variant="outline">{t("components:approvalCard.stats.rejected")}: {approvalStats.rejected}</Badge>
      </div>

      {approvals.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <ShieldCheck className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">{t("components:approvalCard.empty")}</p>
            <p className="text-xs text-muted-foreground mt-1">{t("pages:approvals.emptyHint")}</p>
          </CardContent>
        </Card>
      ) : (
        approvals.map((a) => (
          <ApprovalCard
            key={a.approvalId}
            approval={a}
            loading={actionLoading === a.approvalId}
            onViewDetail={() => handleApprovalDetail(a.approvalId)}
            onApprove={() => handleApprovalApprove(a.approvalId)}
            onReject={() => handleApprovalRejectClick(a)}
          />
        ))
      )}

      <ApprovalDetailDialog
        approval={detailApproval}
        open={detailOpen}
        onOpenChange={setDetailOpen}
        onApprove={() => { if (detailApproval) handleApprovalApprove(detailApproval.approvalId); }}
        onReject={() => { if (detailApproval) { setDetailOpen(false); handleApprovalRejectClick(detailApproval); } }}
        loading={actionLoading !== null}
      />
      <RejectionReasonDialog
        open={rejectOpen}
        onOpenChange={setRejectOpen}
        onSubmit={handleApprovalRejectSubmit}
        loading={actionLoading !== null}
      />
    </div>
  );
}
