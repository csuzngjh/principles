import { useTranslation } from "react-i18next";
import type { ApprovalRecord } from "../api.js";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./ui/dialog.js";
import { Button } from "./ui/button.js";
import { Badge } from "./ui/badge.js";
import { Separator } from "./ui/separator.js";
import { Check, X } from "lucide-react";

const CONFIDENCE_COLORS: Record<string, string> = {
  high: "bg-green-100 text-green-800 border-green-300",
  medium: "bg-amber-100 text-amber-800 border-amber-300",
  low: "bg-red-100 text-red-800 border-red-300",
};

export function ApprovalDetailDialog({
  approval,
  open,
  onOpenChange,
  onApprove,
  onReject,
  loading,
}: {
  approval: ApprovalRecord | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onApprove: () => void;
  onReject: () => void;
  loading?: boolean;
}) {
  const { t } = useTranslation();

  if (!approval) return null;

  const isPending = approval.status === "pending";
  const canAct = isPending && approval.isMvpProven !== false;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">
            {approval.summary ?? approval.approvalId}
          </DialogTitle>
          <DialogDescription>
            <div className="flex items-center gap-2 mt-1">
              <Badge variant="outline" className="text-xs">{t("components:approvalCard.channel." + approval.channel, approval.channel)}</Badge>
              <Badge className={"text-xs border " + (CONFIDENCE_COLORS[approval.confidenceLabel ?? 'medium'] ?? CONFIDENCE_COLORS.medium)}>
                {t("components:approvalCard.confidence." + (approval.confidenceLabel ?? 'medium'))}
              </Badge>
              {approval.riskLevel && (
                <Badge variant="secondary" className="text-xs">{t("components:approvalCard.riskLevel." + approval.riskLevel, approval.riskLevel)}</Badge>
              )}
            </div>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {approval.triggerReason && (
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1">
                {t("components:approvalDetail.whyRecommended")}
              </p>
              <p className="text-sm">{approval.triggerReason}</p>
            </div>
          )}

          {approval.confidenceExplanation && (
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1">
                {t("components:approvalDetail.confidenceExplanation")}
              </p>
              <p className="text-sm">{approval.confidenceExplanation}</p>
            </div>
          )}

          {approval.effectDescription && (
            <>
              <Separator />
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-1">
                  {t("components:approvalDetail.whatHappens")}
                </p>
                <p className="text-sm">{approval.effectDescription}</p>
              </div>
            </>
          )}

          {approval.rejectionEffect && (
            <div className="bg-red-50 dark:bg-red-950/20 rounded-md p-3">
              <p className="text-xs font-medium text-red-600 dark:text-red-400 mb-1">
                {t("components:approvalDetail.ifReject")}
              </p>
              <p className="text-sm text-red-700 dark:text-red-300">{approval.rejectionEffect}</p>
            </div>
          )}
        </div>

        {isPending && approval.isMvpProven === false && (
          <div className="text-xs text-muted-foreground italic pt-2">
            {t("components:approvalCard.channel." + approval.channel, approval.channel)} — {t("components:approvalCard.channel.retired", "retired")}
          </div>
        )}
        {canAct && (
          <DialogFooter>
            <Button
              variant="destructive"
              size="sm"
              onClick={onReject}
              disabled={loading}
              className="flex items-center gap-1"
            >
              <X className="h-3 w-3" />
              {t("components:approvalCard.reject")}
            </Button>
            <Button
              size="sm"
              onClick={onApprove}
              disabled={loading}
              className="flex items-center gap-1"
            >
              <Check className="h-3 w-3" />
              {t("components:approvalCard.approve")}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
