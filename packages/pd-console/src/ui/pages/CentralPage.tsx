import { useTranslation } from "react-i18next";
import { useAutoRefresh } from "../hooks/useAutoRefresh.js";
import { fetchCentralOverview, fetchCentralHealth } from "../api.js";
import type { CentralOverview, CentralHealth } from "../api.js";
import { PageHeader } from "../components/page-header.js";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card.js";
import { Badge } from "../components/ui/badge.js";
import { Skeleton } from "../components/ui/skeleton.js";

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive"> = {
  healthy: "default",
  degraded: "secondary",
  error: "destructive",
};

function OverallStatusBadge({ status }: { status: string }) {
  return (
    <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-border">
      <div
        className={`w-2.5 h-2.5 rounded-full ${
          status === "healthy"
            ? "bg-primary animate-pulse"
            : status === "degraded"
              ? "bg-amber-500"
              : "bg-destructive"
        }`}
      />
      <Badge variant={STATUS_VARIANT[status] ?? "secondary"} className="capitalize">
        {status}
      </Badge>
    </div>
  );
}

function WorkspaceCard({ ws, t }: { ws: CentralOverview["workspaces"][number]; t: (key: string) => string }) {
  return (
    <Card
      className={`border-l-4 ${
        ws.status === "healthy"
          ? "border-l-primary"
          : ws.status === "degraded"
            ? "border-l-amber-500"
            : "border-l-destructive"
      }`}
    >
      <CardContent className="p-4">
        <div className="flex justify-between items-center">
          <div>
            <p className="font-semibold">{ws.name}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{ws.path}</p>
          </div>
          <div className="flex gap-6 items-center">
            <div className="text-center">
              <div className="text-xl font-bold">
                {ws.gfi >= 0 ? ws.gfi : "N/A"}
              </div>
              <div className="text-xs text-muted-foreground">{t("pages:central.gfiLabel")}</div>
            </div>
            <div className="text-center">
              <div className="text-xl font-bold">{ws.principleCount}</div>
              <div className="text-xs text-muted-foreground">{t("pages:central.principlesLabel")}</div>
            </div>
            <OverallStatusBadge status={ws.status} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function HealthDetailCard({ ws, t }: { ws: CentralHealth["workspaces"][number]; t: (key: string) => string }) {
  return (
    <Card
      className={`border-l-4 ${
        ws.status === "healthy"
          ? "border-l-primary"
          : ws.status === "degraded"
            ? "border-l-amber-500"
            : "border-l-destructive"
      }`}
    >
      <CardContent className="p-4">
        <div className="flex justify-between items-center mb-3">
          <span className="font-semibold">{ws.name}</span>
          <OverallStatusBadge status={ws.status} />
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div className="text-center p-2 rounded-md bg-muted/50">
            <div className="text-lg font-bold">{ws.gfi >= 0 ? ws.gfi : "N/A"}</div>
            <div className="text-xs text-muted-foreground">{t("pages:central.gfiLabel")}</div>
          </div>
          <div className="text-center p-2 rounded-md bg-muted/50">
            <div className="text-lg font-bold">{ws.activePrinciples}</div>
            <div className="text-xs text-muted-foreground">{t("pages:central.activeLabel")}</div>
          </div>
          <div className="text-center p-2 rounded-md bg-muted/50">
            <div className="text-lg font-bold">{ws.pendingTasks}</div>
            <div className="text-xs text-muted-foreground">{t("pages:central.pendingLabel")}</div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function CentralPage() {
  const { t } = useTranslation();
  const overview = useAutoRefresh<CentralOverview>(fetchCentralOverview, 30000);
  const health = useAutoRefresh<CentralHealth>(fetchCentralHealth, 30000);

  const overviewData = overview.data;
  const healthData = health.data;
  const isLoading = overview.loading && !overviewData;
  const hasError = overview.error && !overviewData;

  if (isLoading) {
    return (
      <div>
        <Skeleton className="h-8 w-48 mb-6" />
        <Card className="mb-6">
          <CardContent className="p-6">
            <Skeleton className="h-20 w-full" />
          </CardContent>
        </Card>
        {Array.from({ length: 3 }).map((_, i) => (
          <Card key={i} className="mb-3">
            <CardContent className="p-4">
              <Skeleton className="h-12 w-full" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  if (hasError) {
    return (
      <Card>
        <CardContent className="p-6">
          <p className="text-destructive">{overview.error}</p>
        </CardContent>
      </Card>
    );
  }

  if (!overviewData) {
    return (
      <Card>
        <CardContent className="p-6 text-center text-muted-foreground">
          {t("pages:central.noWorkspaceData")}
        </CardContent>
      </Card>
    );
  }

  const overallStatus = healthData?.overallStatus ?? "error";
  const healthyCount = overviewData.workspaces.filter((w) => w.status === "healthy").length;
  const degradedCount = overviewData.workspaces.filter((w) => w.status === "degraded").length;
  const errorCount = overviewData.workspaces.filter((w) => w.status === "error").length;

  return (
    <div>
      <PageHeader
        title={t("pages:central.title")}
        description={t("pages:central.description")}
        onRefresh={() => { overview.refresh(); health.refresh(); }}
        lastUpdated={overview.lastUpdated ? new Date(overview.lastUpdated) : undefined}
      />

      <Card className="mb-6">
        <CardContent className="p-6">
          <div className="flex justify-between items-center">
            <div>
              <p className="text-sm text-muted-foreground mb-2">
                {t("pages:central.overallStatus")}
              </p>
              <OverallStatusBadge status={overallStatus} />
            </div>
            <div className="flex gap-6">
              <div className="text-center">
                <div className="text-3xl font-bold text-primary">{healthyCount}</div>
                <div className="text-xs text-muted-foreground">{t("pages:central.healthy")}</div>
              </div>
              <div className="text-center">
                <div className="text-3xl font-bold text-amber-500">{degradedCount}</div>
                <div className="text-xs text-muted-foreground">{t("pages:central.degraded")}</div>
              </div>
              <div className="text-center">
                <div className="text-3xl font-bold text-destructive">{errorCount}</div>
                <div className="text-xs text-muted-foreground">{t("pages:central.error")}</div>
              </div>
              <div className="text-center">
                <div className="text-3xl font-bold">{overviewData.workspaceCount}</div>
                <div className="text-xs text-muted-foreground">{t("pages:central.total")}</div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>{t("pages:central.workspaces")}</CardTitle>
        </CardHeader>
        <CardContent>
          {overviewData.workspaces.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">
              {t("pages:central.noWorkspaces")}
            </p>
          ) : (
            <div className="space-y-3">
              {overviewData.workspaces.map((ws) => (
                <WorkspaceCard key={ws.name} ws={ws} t={t} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {healthData && healthData.workspaces.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>{t("pages:central.healthDetails")}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {healthData.workspaces.map((ws) => (
                <HealthDetailCard key={ws.name} ws={ws} t={t} />
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
