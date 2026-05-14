import { useTranslation } from "react-i18next";
import { useAutoRefresh } from "../hooks/useAutoRefresh.js";
import { fetchFeedbackGfi, fetchEmpathyEvents, fetchFeedbackGateBlocks } from "../api.js";
import type { FeedbackGfi, EmpathyEvent, GateBlockItem } from "../api.js";
import { PageHeader } from "../components/page-header.js";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card.js";
import { Badge } from "../components/ui/badge.js";
import { Skeleton } from "../components/ui/skeleton.js";
import { Separator } from "../components/ui/separator.js";

const SEVERITY_VARIANT: Record<string, "default" | "secondary" | "destructive"> = {
  low: "default",
  medium: "secondary",
  high: "destructive",
};

function GfiGauge({ gfi }: { gfi: FeedbackGfi | null }) {
  const { t } = useTranslation();

  if (!gfi) {
    return (
      <Card className="mb-6">
        <CardContent className="p-6">
          <Skeleton className="h-4 w-32 mb-4" />
          <Skeleton className="h-10 w-20 mb-2" />
          <Skeleton className="h-3 w-full" />
        </CardContent>
      </Card>
    );
  }

  const threshold = gfi.threshold || 1;
  const percentage = Math.min((gfi.current / threshold) * 100, 100);
  const barColor =
    percentage < 50
      ? "bg-primary"
      : percentage < 80
        ? "bg-amber-500"
        : "bg-destructive";

  return (
    <Card className="mb-6">
      <CardContent className="p-6">
        <p className="text-sm text-muted-foreground mb-3">
          GFI (General Friction Index)
        </p>
        <div className="flex items-center gap-4">
          <div className="text-4xl font-bold text-primary">{gfi.current}</div>
          <div className="flex-1">
            <div className="h-3 rounded-full bg-muted overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-300 ${barColor}`}
                style={{ width: `${percentage}%` }}
              />
            </div>
            <div className="flex justify-between text-xs text-muted-foreground mt-1">
              <span>0</span>
              <span>{t("pages:feedback.source")}: {gfi.threshold}</span>
            </div>
          </div>
        </div>
        <p className="text-xs text-muted-foreground mt-2">
          Peak today: {gfi.peakToday}
        </p>
        {Object.keys(gfi.sources).length > 0 && (
          <div className="mt-4">
            <Separator className="mb-3" />
            <p className="text-xs text-muted-foreground mb-2">{t("pages:feedback.source")}</p>
            {Object.entries(gfi.sources).map(([source, value]) => (
              <div
                key={source}
                className="flex justify-between text-sm py-1"
              >
                <span>{source}</span>
                <span className="font-bold">{value}</span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function FeedbackPage() {
  const { t } = useTranslation();
  const gfi = useAutoRefresh<FeedbackGfi>(fetchFeedbackGfi, 30000);
  const empathy = useAutoRefresh<EmpathyEvent[]>(() => fetchEmpathyEvents(20), 30000);
  const blocks = useAutoRefresh<GateBlockItem[]>(() => fetchFeedbackGateBlocks(20), 30000);

  const refreshAll = () => {
    gfi.refresh();
    empathy.refresh();
    blocks.refresh();
  };

  const lastUpdated = gfi.lastUpdated ?? empathy.lastUpdated ?? blocks.lastUpdated;

  return (
    <div>
      <PageHeader
        title={t("pages:feedback.title")}
        description={t("pages:feedback.description")}
        onRefresh={refreshAll}
        lastUpdated={lastUpdated ? new Date(lastUpdated) : undefined}
      />

      <GfiGauge gfi={gfi.data} />

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>{t("pages:feedback.empathyEvents")}</CardTitle>
        </CardHeader>
        <CardContent>
          {empathy.error && (
            <p className="text-destructive mb-3">{empathy.error}</p>
          )}
          {!empathy.data || empathy.data.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">
              {t("components:zoneSection.empty")}
            </p>
          ) : (
            <div className="space-y-3">
              {empathy.data.map((event, i) => (
                <Card
                  key={i}
                  className={`border-l-4 ${
                    event.severity === "high"
                      ? "border-l-destructive"
                      : event.severity === "medium"
                        ? "border-l-amber-500"
                        : "border-l-primary"
                  }`}
                >
                  <CardContent className="p-4">
                    <div className="flex justify-between items-center">
                      <Badge variant={SEVERITY_VARIANT[event.severity] ?? "secondary"}>
                        {event.severity}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        {new Date(event.timestamp).toLocaleString()}
                      </span>
                    </div>
                    <p className="mt-2 text-sm">{event.reason}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Origin: {event.origin} | GFI after: {event.gfiAfter}
                    </p>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("pages:feedback.gateBlocks")}</CardTitle>
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
            <div className="space-y-3">
              {blocks.data.map((block, i) => (
                <Card key={i} className="border-l-4 border-l-destructive">
                  <CardContent className="p-4">
                    <div className="flex justify-between items-center">
                      <span className="font-bold text-sm">{block.toolName}</span>
                      <span className="text-xs text-muted-foreground">
                        {new Date(block.timestamp).toLocaleString()}
                      </span>
                    </div>
                    <p className="mt-2 text-sm">{block.reason}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Type: {block.gateType} | GFI: {block.gfi} | Trust Stage:{" "}
                      {block.trustStage}
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
