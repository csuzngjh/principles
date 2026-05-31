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
import { Loader2, CheckCircle2, XCircle } from "lucide-react";

export type UpdateStatus = "checking" | "downloading" | "applying" | "completed" | "failed";

interface UpdateProgressDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  status: UpdateStatus;
  currentVersion: string;
  targetVersion: string;
  errorMessage?: string;
  onRollback?: () => void;
}

const STATUS_ICONS: Record<UpdateStatus, React.ReactNode> = {
  checking: <Loader2 className="h-5 w-5 animate-spin text-primary" />,
  downloading: <Loader2 className="h-5 w-5 animate-spin text-primary" />,
  applying: <Loader2 className="h-5 w-5 animate-spin text-primary" />,
  completed: <CheckCircle2 className="h-5 w-5 text-green-600" />,
  failed: <XCircle className="h-5 w-5 text-destructive" />,
};

export function UpdateProgressDialog({
  open,
  onOpenChange,
  status,
  currentVersion,
  targetVersion,
  errorMessage,
  onRollback,
}: UpdateProgressDialogProps) {
  const { t } = useTranslation();

  const isActive = status === "checking" || status === "downloading" || status === "applying";
  const isDone = status === "completed" || status === "failed";

  const statusLabels: Record<UpdateStatus, string> = {
    checking: t("components:updateProgress.checking", { defaultValue: "正在检查更新..." }),
    downloading: t("components:updateProgress.downloading", { defaultValue: "正在下载更新包..." }),
    applying: t("components:updateProgress.applying", { defaultValue: "正在应用更新..." }),
    completed: t("components:updateProgress.completed", { defaultValue: "更新完成！" }),
    failed: t("components:updateProgress.failed", { defaultValue: "更新失败" }),
  };

  return (
    <Dialog open={open} onOpenChange={isDone ? onOpenChange : undefined}>
      <DialogContent className="max-w-md" onPointerDownOutside={(e) => { if (isActive) e.preventDefault(); }}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {STATUS_ICONS[status]}
            {statusLabels[status]}
          </DialogTitle>
          <DialogDescription>
            <span className="font-mono text-sm">
              v{currentVersion} → v{targetVersion}
            </span>
          </DialogDescription>
        </DialogHeader>

        {status === "failed" && errorMessage && (
          <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
            {errorMessage}
          </div>
        )}

        {isActive && (
          <div className="space-y-2">
            <div className="h-2 rounded-full bg-muted overflow-hidden">
              <div
                className="h-full bg-primary rounded-full transition-all duration-500"
                style={{
                  width: status === "checking" ? "30%" : status === "downloading" ? "60%" : "85%",
                }}
              />
            </div>
          </div>
        )}

        <DialogFooter>
          {status === "failed" && onRollback && (
            <Button variant="outline" onClick={onRollback}>
              {t("components:updateProgress.rollback", { defaultValue: "回滚" })}
            </Button>
          )}
          {isDone && (
            <Button onClick={() => onOpenChange(false)}>
              {t("common:close", { defaultValue: "关闭" })}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
