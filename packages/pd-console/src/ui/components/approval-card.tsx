import { useTranslation } from "react-i18next";
import type { ApprovalRecord } from "../api.js";
import { Card, CardContent } from "./ui/card.js";
import { Button } from "./ui/button.js";
import { Badge } from "./ui/badge.js";
import { Check, X, Eye } from "lucide-react";

function timeAgo(date: Date, t: (key: string, options?: Record<string, unknown>) => string): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return t("pages:tasks.secondsAgo", { count: seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t("pages:tasks.minutesAgo", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("pages:tasks.hoursAgo", { count: hours });
  const days = Math.floor(hours / 24);
  return t("components:pageHeader.daysAgo", { count: days });
}

const CONFIDENCE_COLORS: Record<string, string> = {
  high: "bg-green-100 text-green-800 border-green-300",
  medium: "bg-amber-100 text-amber-800 border-amber-300",
  low: "bg-red-100 text-red-800 border-red-300",
};

const RISK_COLORS: Record<string, string> = {
  low: "bg-green-50 text-green-700",
  medium: "bg-amber-50 text-amber-700",
  high: "bg-red-50 text-red-700",
};

function getChannelLabel(channel: string, t: (key: string) => string): string {
  const key = "components:approvalCard.channel." + channel;
  const translated = t(key);
  return translated !== key ? translated : channel;
}

export function ApprovalCard({
  approval,
  onApprove,
  onReject,
  onViewDetail,
  loading,
}: {
  approval: ApprovalRecord;
  onApprove: () => void;
  onReject: () => void;
  onViewDetail: () => void;
  loading?: boolean;
}) {
  const { t } = useTranslation();

  const isPending = approval.status === "pending";

  return (
    <Card className="mb-3 transition-all duration-200 hover:shadow-sm">
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1.5 flex-wrap">
              <Badge variant="outline" className="text-xs">
                {getChannelLabel(approval.channel, t)}
              </Badge>
              <Badge className={"text-xs border " + (CONFIDENCE_COLORS[approval.confidenceLabel] ?? CONFIDENCE_COLORS.medium)}>
                {t("components:approvalCard.confidence." + approval.confidenceLabel)}
              </Badge>
              {approval.riskLevel && (
                <Badge variant="secondary" className={"text-xs " + (RISK_COLORS[approval.riskLevel] ?? "")}>
                  {t("components:approvalCard.riskLevel." + approval.riskLevel, approval.riskLevel)}
                </Badge>
              )}
              <span className="text-xs text-muted-foreground">
                {timeAgo(new Date(approval.requestedAt), t)}
              </span>
            </div>
            <p className="font-medium text-sm line-clamp-2">
              {approval.summary ?? approval.approvalId}
            </p>
          </div>
        </div>

        {isPending && (
          <div className="flex items-center gap-2 mt-3 pt-3 border-t">
            <Button
              variant="outline"
              size="sm"
              onClick={onViewDetail}
              className="flex items-center gap-1"
              disabled={loading}
            >
              <Eye className="h-3 w-3" />
              {t("components:approvalCard.viewDetail")}
            </Button>
            <div className="flex-1" />
            <Button
              variant="destructive"
              size="sm"
              onClick={onReject}
              className="flex items-center gap-1"
              disabled={loading}
            >
              <X className="h-3 w-3" />
              {t("components:approvalCard.reject")}
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={onApprove}
              className="flex items-center gap-1"
              disabled={loading}
            >
              <Check className="h-3 w-3" />
              {t("components:approvalCard.approve")}
            </Button>
          </div>
        )}

        {!isPending && (
          <div className="flex items-center gap-2 mt-3 pt-3 border-t">
            <Badge variant={approval.status === "approved" ? "default" : "secondary"}>
              {t("components:approvalCard.status." + approval.status)}
            </Badge>
            {approval.decidedBy && (
              <span className="text-xs text-muted-foreground">
                {t("components:approvalCard.decidedBy", { by: approval.decidedBy })}
              </span>
            )}
            <div className="flex-1" />
            <Button variant="ghost" size="sm" onClick={onViewDetail} disabled={loading} aria-label={t("components:approvalCard.viewDetail")}>
              <Eye className="h-3 w-3" />
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
