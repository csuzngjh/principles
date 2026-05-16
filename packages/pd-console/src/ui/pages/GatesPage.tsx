import { useTranslation } from "react-i18next";
import { useAutoRefresh } from "../hooks/useAutoRefresh.js";
import { fetchGateStats, fetchGateBlocks } from "../api.js";
import type { GateStats, GateBlockItem } from "../api.js";
import { PageHeader } from "../components/page-header.js";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card.js";
import { Badge } from "../components/ui/badge.js";
import { Skeleton } from "../components/ui/skeleton.js";
import { formatDate } from "../utils/format.js";

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive"> = {
  healthy: "default",
  warning: "secondary",
  critical: "destructive",
};

export function GatesPage() {
  const { t } = useTranslation();
  const stats = useAutoRefresh<GateStats>(fetchGateStats, 30000);
  const blocks = useAutoRefresh<GateBlockItem[]>(() => fetchGateBlocks(50), 30000);

  const refreshAll = () => {
    stats.refresh();
    blocks.refresh();
  };

  if (stats.error && !stats.data) {
    return (
      <Card>
        <CardContent className="p-6">
          <p className="text-destructive">{stats.error}</p>
        </CardContent>
      </Card>
    );
  }

  if (!stats.data) {
    return (
      <div>
        <Skeleton className="h-8 w-48 mb-6" />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
          {Array.from({ length: 3 }).map((_, i) => (
            <Card key={i}>
              <CardContent className="p-6">
                <Skeleton className="h-4 w-24 mb-3" />
                <Skeleton className="h-8 w-20 mb-2" />
                <Skeleton className="h-3 w-32" />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  const statsData = stats.data;

  return (
    <div>
      <PageHeader
        title={t("pages:gates.title")}
        description={t("pages:gates.description")}
        onRefresh={refreshAll}
        lastUpdated={stats.lastUpdated ? new Date(stats.lastUpdated) : undefined}
      />

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <Card className="border-l-4 border-l-primary">
          <CardContent className="p-6">
            <p className="text-sm text-muted-foreground mb-2">
              {t("pages:gates.trustStatus")}
            </p>
            <div className="flex items-center gap-2">
              <span className="text-2xl font-bold capitalize">
                {statsData.trust.status}
              </span>
              <Badge variant={STATUS_VARIANT[statsData.trust.status] ?? "secondary"}>
                {statsData.trust.stage}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground mb-2">
              {t("pages:gates.score")} {statsData.trust.score}
            </p>
          </CardContent>
        </Card>

        <Card className="border-l-4 border-l-amber-500">
          <CardContent className="p-6">
            <p className="text-sm text-muted-foreground mb-2">{t("pages:gates.gfiLabel")}</p>
            <div className="text-2xl font-bold">{statsData.gfi.current}</div>
            <Badge variant="secondary" className="mt-1 capitalize">
              {statsData.gfi.stage}
            </Badge>
            <p className="text-xs text-muted-foreground mt-2">
              {t("pages:gates.peak")} {statsData.gfi.peakToday} | {t("pages:gates.threshold")} {statsData.gfi.threshold}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <p className="text-sm text-muted-foreground mb-2">{t("pages:gates.todayBlocks")}</p>
            <div className="space-y-1 text-sm">
              <div>
                {t("pages:gates.gfiBlocks")}: <strong>{statsData.today.gfiBlocks}</strong>
              </div>
              <div>
                {t("pages:gates.stageBlocks")}: <strong>{statsData.today.stageBlocks}</strong>
              </div>
              <div>
                {t("pages:gates.bypassAttempts")}: <strong>{statsData.today.bypassAttempts}</strong>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {Object.keys(statsData.gfi.sources).length > 0 && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>{t("pages:gates.sourceBreakdown")}</CardTitle>
          </CardHeader>
          <CardContent>
            {Object.entries(statsData.gfi.sources).map(([source, value]) => (
              <div
                key={source}
                className="flex justify-between py-2 border-b border-border last:border-0"
              >
                <span className="text-sm">{source}</span>
                <span className="text-sm font-bold">{value}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{t("pages:gates.blockHistory")}</CardTitle>
        </CardHeader>
        <CardContent>
          {blocks.error && (
            <p className="text-destructive mb-3">{blocks.error}</p>
          )}
          {!blocks.data || blocks.data.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">
              {t("components:zoneSection.empty")}
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              {blocks.data.map((block, i) => (
                <Card key={i} className="border-l-4 border-l-destructive">
                  <CardContent className="p-4">
                    <div className="flex justify-between items-center">
                      <span className="font-bold text-sm">{block.toolName}</span>
                      <span className="text-xs text-muted-foreground">
                        {formatDate(block.timestamp)}
                      </span>
                    </div>
                    <p className="mt-2 text-sm">{block.reason}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Type: {block.gateType} | GFI: {block.gfi} | Trust Stage:{" "}
                      {block.trustStage}
                      {block.filePath && <span> | File: {block.filePath}</span>}
                    </p>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
