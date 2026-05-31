import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "./ui/badge.js";
import { RefreshCw, X } from "lucide-react";

interface UpdateInfo {
  hasUpdate: boolean;
  currentVersion: string;
  latestVersion?: string;
  error?: string;
}

export function UpdateBanner() {
  const { t } = useTranslation();
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    async function check() {
      try {
        const response = await fetch("/api/update/check");
        const result: unknown = await response.json();
        if (
          typeof result === "object" && result !== null &&
          Object.hasOwn(result, "success") && (result as Record<string, unknown>).success === true
        ) {
          const data = (result as Record<string, unknown>).data;
          if (
            typeof data === "object" && data !== null &&
            typeof (data as Record<string, unknown>).hasUpdate === "boolean" &&
            typeof (data as Record<string, unknown>).currentVersion === "string"
          ) {
            setUpdateInfo(data as unknown as UpdateInfo);
          } else {
            console.error("[UpdateBanner] Invalid data shape from /api/update/check:", data);
          }
        }
      } catch (err) {
        console.error("[UpdateBanner] Failed to check for updates:", err);
      }
    }
    check();
  }, []);

  if (!updateInfo?.hasUpdate || dismissed) {
    return null;
  }

  return (
    <div className="bg-primary/5 border-b border-primary/20 px-4 py-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <RefreshCw className="h-4 w-4 text-primary animate-spin" style={{ animationDuration: "3s" }} />
          <span className="text-sm">
            {t("components:updateBanner.newVersion", {
              version: updateInfo.latestVersion,
              defaultValue: `PD ${updateInfo.latestVersion} 可用`,
            })}
          </span>
          <Badge variant="outline" className="text-xs">
            {updateInfo.currentVersion} → {updateInfo.latestVersion}
          </Badge>
        </div>
        <div className="flex items-center gap-2">
          <a
            href="#/settings/update"
            className="text-sm font-medium text-primary hover:underline"
          >
            {t("components:updateBanner.updateNow", { defaultValue: "立即更新" })}
          </a>
          <button
            onClick={() => setDismissed(true)}
            className="p-1 text-muted-foreground hover:text-foreground"
            aria-label={t("common:dismiss", { defaultValue: "关闭" })}
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      </div>
    </div>
  );
}
