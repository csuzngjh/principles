import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./ui/dialog.js";
import { Button } from "./ui/button.js";

const MIN_REASON_LENGTH = 10;

export function RejectionReasonDialog({
  open,
  onOpenChange,
  onSubmit,
  loading,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (reason: string) => void;
  loading?: boolean;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState("");

  const isValid = reason.trim().length >= MIN_REASON_LENGTH;

  function handleSubmit() {
    if (!isValid) return;
    onSubmit(reason.trim());
    setReason("");
  }

  function handleCancel() {
    setReason("");
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen) setReason(""); onOpenChange(nextOpen); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("components:rejectionDialog.title")}</DialogTitle>
          <DialogDescription>
            {t("components:rejectionDialog.description", { min: MIN_REASON_LENGTH })}
          </DialogDescription>
        </DialogHeader>

        <textarea
          className="w-full min-h-[100px] rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          placeholder={t("components:rejectionDialog.placeholder")}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          disabled={loading}
        />

        {reason.length > 0 && !isValid && (
          <p className="text-xs text-amber-600">
            {t("components:rejectionDialog.tooShort", { min: MIN_REASON_LENGTH, current: reason.trim().length })}
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={handleCancel} disabled={loading}>
            {t("common:cancel")}
          </Button>
          <Button
            variant="destructive"
            onClick={handleSubmit}
            disabled={!isValid || loading}
          >
            {t("components:approvalCard.reject")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
