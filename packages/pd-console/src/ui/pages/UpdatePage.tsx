import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { PageHeader } from "../components/page-header.js";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../components/ui/card.js";
import { Button } from "../components/ui/button.js";
import { Badge } from "../components/ui/badge.js";
import { Separator } from "../components/ui/separator.js";
import { UpdateProgressDialog, type UpdateStatus } from "../components/UpdateProgressDialog.js";
import { RefreshCw, Download, Shield, CheckCircle2 } from "lucide-react";

interface UpdateInfo {
  hasUpdate: boolean;
  currentVersion: string;
  latestVersion?: string;
  error?: string;
}

type MergeStrategy = "smart" | "overwrite" | "keep";

function isValidUpdateInfo(data: unknown): data is UpdateInfo {
  if (typeof data !== "object" || data === null) return false;
  const obj = data as Record<string, unknown>;
  return typeof obj.hasUpdate === "boolean" && typeof obj.currentVersion === "string";
}

function isApiResponse(value: unknown): value is { success: boolean; data?: unknown; error?: string } {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.success === "boolean";
}

const MERGE_STRATEGY_DESCRIPTIONS: Record<MergeStrategy, string> = {
  smart: "生成 .update 文件供手动合并",
  overwrite: "直接覆盖用户文件",
  keep: "保留用户文件不变",
};

export function UpdatePage() {
  const { t } = useTranslation();
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [mergeStrategy, setMergeStrategy] = useState<MergeStrategy>("smart");
  const [createBackup, setCreateBackup] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogStatus, setDialogStatus] = useState<UpdateStatus>("checking");
  const [dialogError, setDialogError] = useState<string | undefined>();
  const [updateCompleted, setUpdateCompleted] = useState(false);
  const [lastBackupPath, setLastBackupPath] = useState<string | undefined>();

  useEffect(() => {
    checkForUpdates();
  }, []);

  async function checkForUpdates() {
    setChecking(true);
    try {
      const response = await fetch("/api/update/check");
      const result: unknown = await response.json();
      if (!isApiResponse(result)) {
        console.error("[UpdatePage] Invalid response shape from /api/update/check:", result);
        return;
      }
      if (result.success && isValidUpdateInfo(result.data)) {
        setUpdateInfo(result.data);
      }
    } catch (err) {
      console.error("[UpdatePage] Failed to check for updates:", err);
    } finally {
      setChecking(false);
    }
  }

  async function handleUpdate() {
    setDialogError(undefined);
    setUpdateCompleted(false);
    setDialogOpen(true);
    setDialogStatus("checking");

    // Brief checking phase
    await new Promise((r) => setTimeout(r, 800));
    setDialogStatus("downloading");

    try {
      const response = await fetch("/api/update/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mergeStrategy,
          createBackup,
        }),
      });
      const result: unknown = await response.json();

      if (!isApiResponse(result)) {
        setDialogStatus("failed");
        setDialogError("Invalid response from server");
        return;
      }

      const data = result.data as Record<string, unknown> | undefined;
      if (result.success && data && data.success === true) {
        if (typeof data.backupPath === "string") {
          setLastBackupPath(data.backupPath);
        }
        setDialogStatus("applying");
        await new Promise((r) => setTimeout(r, 600));
        setDialogStatus("completed");
        setUpdateCompleted(true);
      } else {
        setDialogStatus("failed");
        const message = (data && typeof data.message === "string") ? data.message
          : (typeof result.error === "string" ? result.error : "Unknown error");
        setDialogError(message);
      }
    } catch (err) {
      setDialogStatus("failed");
      setDialogError(err instanceof Error ? err.message : "Network error");
    }
  }

  async function handleRollback() {
    try {
      const response = await fetch("/api/update/rollback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          backupDir: lastBackupPath || "",
        }),
      });
      const result: unknown = await response.json();
      if (isApiResponse(result) && result.success) {
        setDialogOpen(false);
        setUpdateCompleted(false);
        checkForUpdates();
      } else {
        const msg = (result && typeof result === "object" && Object.hasOwn(result, "error"))
          ? (result as Record<string, unknown>).error : "Rollback failed";
        setDialogError(typeof msg === "string" ? msg : "Rollback failed");
        setDialogStatus("failed");
      }
    } catch (err) {
      console.error("[UpdatePage] Rollback failed:", err);
      setDialogError(err instanceof Error ? err.message : "Rollback network error");
      setDialogStatus("failed");
    }
  }

  return (
    <>
      <PageHeader title={t("pages:update.title", { defaultValue: "更新" })} />

      {updateCompleted && (
        <Card className="mb-6 border-green-200 bg-green-50">
          <CardContent className="flex items-center gap-3 pt-6">
            <CheckCircle2 className="h-5 w-5 text-green-600" />
            <span className="text-sm text-green-800">
              {t("pages:update.success", { defaultValue: "更新已成功应用！请重启 Gateway 以使更改生效。" })}
            </span>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 max-w-2xl">
        {/* Version Info */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <RefreshCw className="h-4 w-4" />
              {t("pages:update.versionInfo", { defaultValue: "版本信息" })}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">
                {t("pages:update.currentVersion", { defaultValue: "当前版本" })}
              </span>
              <Badge variant="outline">{updateInfo?.currentVersion ?? "—"}</Badge>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">
                {t("pages:update.latestVersion", { defaultValue: "最新版本" })}
              </span>
              <Badge variant={updateInfo?.hasUpdate ? "default" : "outline"}>
                {updateInfo?.latestVersion ?? "—"}
              </Badge>
            </div>
            {updateInfo?.hasUpdate && (
              <div className="rounded-md bg-primary/5 p-3 text-sm text-primary">
                {t("pages:update.updateAvailable", { defaultValue: "有新版本可用！" })}
              </div>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={checkForUpdates}
              disabled={checking}
            >
              <RefreshCw className={`mr-2 h-3 w-3 ${checking ? "animate-spin" : ""}`} />
              {checking
                ? t("pages:update.checking", { defaultValue: "检查中..." })
                : t("pages:update.checkForUpdates", { defaultValue: "检查更新" })}
            </Button>
          </CardContent>
        </Card>

        {/* Update Settings */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Shield className="h-4 w-4" />
              {t("pages:update.settings", { defaultValue: "更新设置" })}
            </CardTitle>
            <CardDescription>
              {t("pages:update.settingsDescription", { defaultValue: "配置更新行为和文件处理策略" })}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Backup toggle */}
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={createBackup}
                onChange={(e) => setCreateBackup(e.target.checked)}
                className="h-4 w-4 rounded border-input"
              />
              <div>
                <span className="text-sm font-medium">
                  {t("pages:update.createBackup", { defaultValue: "更新前创建备份" })}
                </span>
                <p className="text-xs text-muted-foreground">
                  {t("pages:update.createBackupHint", { defaultValue: "允许在更新失败时回滚" })}
                </p>
              </div>
            </label>

            <Separator />

            {/* Merge strategy */}
            <div>
              <p className="text-sm font-medium mb-3">
                {t("pages:update.workspaceFileHandling", { defaultValue: "工作区文件处理" })}
              </p>
              <div className="space-y-2">
                {(Object.entries(MERGE_STRATEGY_DESCRIPTIONS) as [MergeStrategy, string][]).map(
                  ([strategy, description]) => (
                    <label
                      key={strategy}
                      className={`flex items-start gap-3 p-3 rounded-md border cursor-pointer transition-colors ${
                        mergeStrategy === strategy
                          ? "border-primary bg-primary/5"
                          : "border-border hover:bg-muted/50"
                      }`}
                    >
                      <input
                        type="radio"
                        name="mergeStrategy"
                        value={strategy}
                        checked={mergeStrategy === strategy}
                        onChange={() => setMergeStrategy(strategy)}
                        className="mt-0.5"
                      />
                      <div>
                        <span className="text-sm font-medium capitalize">{strategy}</span>
                        <p className="text-xs text-muted-foreground">
                          {t(`pages:update.merge.${strategy}`, { defaultValue: description })}
                        </p>
                      </div>
                    </label>
                  ),
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Update Action */}
        <Card>
          <CardContent className="pt-6">
            <Button
              className="w-full"
              size="lg"
              disabled={!updateInfo?.hasUpdate || checking}
              onClick={handleUpdate}
            >
              <Download className="mr-2 h-4 w-4" />
              {updateInfo?.hasUpdate
                ? t("pages:update.updateTo", { version: updateInfo.latestVersion, defaultValue: `更新到 v${updateInfo.latestVersion}` })
                : t("pages:update.upToDate", { defaultValue: "已是最新版本" })}
            </Button>
          </CardContent>
        </Card>
      </div>

      <UpdateProgressDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        status={dialogStatus}
        currentVersion={updateInfo?.currentVersion ?? ""}
        targetVersion={updateInfo?.latestVersion ?? ""}
        errorMessage={dialogError}
        onRollback={handleRollback}
      />
    </>
  );
}
