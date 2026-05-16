import { useTranslation } from "react-i18next";
import { useAutoRefresh } from "../hooks/useAutoRefresh.js";
import { fetchOverview, fetchSystemHealth } from "../api.js";
import type { OverviewData, SystemHealthStatus } from "../api.js";
import { PageHeader } from "../components/page-header.js";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card.js";
import { Badge } from "../components/ui/badge.js";
import { Skeleton } from "../components/ui/skeleton.js";
import { HealthDiagnosticCard } from "../components/health-diagnostic-card.js";
import { DataFreshnessIndicator } from "../components/data-freshness-indicator.js";

const STATUS_COLORS: Record<string, "default" | "secondary" | "destructive"> = {
  healthy: "default",
  degraded: "secondary",
  error: "destructive",
};

const STATUS_LABELS: Record<string, string> = {
  healthy: "pages:overview.healthy",
  degraded: "pages:overview.degraded",
  error: "pages:overview.error",
};

function HealthCard({ health }: { health: OverviewData["health"] }) {
  const { t } = useTranslation();
  const statusColor = STATUS_COLORS[health.status] || "secondary";

  return (
    <Card className="border-l-4 border-primary mb-6">
      <CardContent className="p-6">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-sm text-muted-foreground mb-2">
              {t("pages:overview.health")}
            </p>
            <div className="flex items-center gap-3">
              <span className="text-2xl font-bold capitalize">
                {t(STATUS_LABELS[health.status] || health.status)}
              </span>
              <Badge variant={statusColor}>{health.status.toUpperCase()}</Badge>
            </div>
            <p className="text-sm text-muted-foreground mt-2">
              GFI: {health.gfi.current} ({health.gfi.stage})
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function StatCard({ label, value }: { label: string; value: number | string }) {
  return (
    <Card className="transition-all duration-200 hover:shadow-md">
      <CardContent className="p-6">
        <p className="text-sm text-muted-foreground mb-2">{label}</p>
        <p className="text-3xl font-bold">{value}</p>
      </CardContent>
    </Card>
  );
}

function LoadingSkeleton() {
  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <Skeleton className="h-8 w-32" />
        <div className="flex items-center gap-4">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-8 w-20" />
        </div>
      </div>
      <Card className="border-l-4 border-primary mb-6">
        <CardContent className="p-6">
          <Skeleton className="h-4 w-24 mb-4" />
          <Skeleton className="h-8 w-32 mb-2" />
          <Skeleton className="h-4 w-48" />
        </CardContent>
      </Card>
      <Skeleton className="h-6 w-40 mb-4" />
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <Card key={i}>
            <CardContent className="p-6">
              <Skeleton className="h-4 w-24 mb-2" />
              <Skeleton className="h-8 w-full" />
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

export function OverviewPage() {
  const { t } = useTranslation();
  const { data, error, loading, refresh, lastUpdated } = useAutoRefresh<OverviewData>(
    fetchOverview,
    30000
  );
  const { 
    data: healthData, 
    error: healthError, 
    loading: healthLoading, 
    refresh: refreshHealth, 
    lastUpdated: healthLastUpdated 
  } = useAutoRefresh<SystemHealthStatus>(
    fetchSystemHealth,
    30000
  );

  if (loading && !data) {
    return <LoadingSkeleton />;
  }

  if (error && !data) {
    return (
      <Card>
        <CardContent className="p-6">
          <p className="text-destructive">{t("components:errorBoundary.title")}</p>
          <p className="text-muted-foreground mt-2">{error}</p>
        </CardContent>
      </Card>
    );
  }

  if (!data) {
    return (
      <Card>
        <CardContent className="p-6 text-center">
          <p className="text-muted-foreground">{t("common:loading")}</p>
        </CardContent>
      </Card>
    );
  }

  const handleRefreshAll = () => {
    refresh();
    refreshHealth();
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t("pages:overview.title")}
        description={t("pages:overview.description")}
        onRefresh={handleRefreshAll}
        lastUpdated={lastUpdated ? new Date(lastUpdated) : undefined}
      />

      {healthData && (
        <HealthDiagnosticCard
          overall={healthData.overall}
          checks={healthData.checks}
          onRefresh={refreshHealth}
          loading={healthLoading}
        />
      )}

      <div className="flex items-center gap-2 flex-wrap">
        {healthData?.pipeline.lastPainSignal && (
          <DataFreshnessIndicator 
            label={t("pages:overview.painSignals")} 
            lastUpdateTime={healthData.pipeline.lastPainSignal} 
          />
        )}
        {healthData?.pipeline.lastTaskCreated && (
          <DataFreshnessIndicator 
            label={t("pages:overview.tasks")} 
            lastUpdateTime={healthData.pipeline.lastTaskCreated} 
          />
        )}
        {healthData?.pipeline.lastCandidateGenerated && (
          <DataFreshnessIndicator 
            label={t("pages:overview.candidates")} 
            lastUpdateTime={healthData.pipeline.lastCandidateGenerated} 
          />
        )}
      </div>

      <HealthCard health={data.health} />

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>{t("pages:overview.stats")}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
            <StatCard label={t("pages:overview.principles")} value={data.summary.principleEventCount} />
            <StatCard label={t("pages:overview.painEvents")} value={data.summary.painEvents} />
            <StatCard label={t("pages:overview.pendingSamples")} value={data.summary.pendingSamples} />
            <StatCard label={t("pages:overview.approvedSamples")} value={data.summary.approvedSamples} />
            <StatCard label={t("pages:overview.taskOutcomes")} value={data.summary.taskOutcomes} />
            <StatCard label={t("pages:overview.gateBlocks")} value={data.summary.gateBlocks} />
          </div>
        </CardContent>
      </Card>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>{t("pages:overview.principles")}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <StatCard label={t("pages:overview.activePrinciples")} value={data.health.principles.active} />
            <StatCard label={t("pages:overview.candidatePrinciples")} value={data.health.principles.candidate} />
            <StatCard label={t("pages:overview.probationPrinciples")} value={data.health.principles.probation} />
            <StatCard label={t("pages:overview.deprecatedPrinciples")} value={data.health.principles.deprecated} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("pages:overview.queue")}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-4">
            <StatCard label={t("common:pending")} value={data.health.queue.pending} />
            <StatCard label={t("pages:overview.inProgress")} value={data.health.queue.inProgress} />
            <StatCard label={t("common:completed")} value={data.health.queue.completed} />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
