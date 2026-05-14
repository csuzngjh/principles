import { useTranslation } from "react-i18next";
import type { PrincipleListItem } from "../api.js";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card.js";
import { Badge } from "./ui/badge.js";
import { Button } from "./ui/button.js";
import { ValueScoreBar, AdherenceBar } from "./ui/progress-bar.js";
import { X } from "lucide-react";
import { cn } from "../../../lib/utils.js";

const STATUS_COLORS: Record<string, string> = {
  candidate: "text-amber-500",
  probation: "text-blue-500",
  active: "text-primary",
  deprecated: "text-destructive",
  archived: "text-muted-foreground",
};

const PRIORITY_COLORS: Record<string, string> = {
  P0: "text-destructive",
  P1: "text-amber-500",
  P2: "text-muted-foreground",
};

interface CompareViewProps {
  principles: PrincipleListItem[];
  onClose: () => void;
}

function DiffRow({ label, left, right, highlight }: { label: string; left: string | number; right: string | number; highlight?: boolean }) {
  const isDifferent = String(left) !== String(right);
  return (
    <div className={cn("grid grid-cols-[1fr_2fr_2fr] gap-2 py-1.5 px-2 text-xs", isDifferent && highlight && "bg-amber-50 dark:bg-amber-950/20")}>
      <span className="text-muted-foreground font-medium">{label}</span>
      <span className={cn(isDifferent && highlight && "font-medium")}>{String(left) || "—"}</span>
      <span className={cn(isDifferent && highlight && "font-medium")}>{String(right) || "—"}</span>
    </div>
  );
}

export function CompareView({ principles, onClose }: CompareViewProps) {
  const { t } = useTranslation();

  if (principles.length !== 2) {
    return null;
  }

  const [a, b] = principles;

  return (
    <Card className="border-2 border-primary/20">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            {t("pages:principles.compareTitle")}
          </CardTitle>
          <Button variant="ghost" size="sm" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-[1fr_2fr_2fr] gap-2 mb-2 text-xs font-medium text-muted-foreground border-b border-border pb-2">
          <span>{t("pages:principles.compareField")}</span>
          <span className="flex items-center gap-1">
            <Badge variant="outline" className={cn("text-xs", STATUS_COLORS[a.status])}>{a.status}</Badge>
            {a.id}
          </span>
          <span className="flex items-center gap-1">
            <Badge variant="outline" className={cn("text-xs", STATUS_COLORS[b.status])}>{b.status}</Badge>
            {b.id}
          </span>
        </div>

        <div className="divide-y divide-border">
          <DiffRow label={t("pages:principles.text")} left={a.text} right={b.text} highlight />
          <DiffRow label={t("pages:principles.status")} left={a.status} right={b.status} highlight />
          <DiffRow label={t("pages:principles.priority")} left={a.priority} right={b.priority} highlight />
          <DiffRow label={t("pages:principles.scope")} left={a.scope + (a.domain ? ` / ${a.domain}` : "")} right={b.scope + (b.domain ? ` / ${b.domain}` : "")} highlight />
          <DiffRow label={t("pages:principles.evaluability")} left={a.evaluability} right={b.evaluability} highlight />
          <DiffRow label={t("pages:principles.triggerPattern")} left={a.triggerPattern} right={b.triggerPattern} highlight />
          <DiffRow label={t("pages:principles.action")} left={a.action} right={b.action} highlight />
        </div>

        <div className="grid grid-cols-[1fr_2fr_2fr] gap-2 mt-4 pt-4 border-t border-border">
          <span className="text-xs text-muted-foreground font-medium">{t("pages:principles.valueScore")}</span>
          <div><ValueScoreBar valueScore={a.valueScore} /></div>
          <div><ValueScoreBar valueScore={b.valueScore} /></div>

          <span className="text-xs text-muted-foreground font-medium">{t("pages:principles.adherence")}</span>
          <div><AdherenceBar adherenceRate={a.adherenceRate} /></div>
          <div><AdherenceBar adherenceRate={b.adherenceRate} /></div>

          <span className="text-xs text-muted-foreground font-medium">{t("pages:principles.painPrevented")}</span>
          <span className="text-xs">{a.painPreventedCount}</span>
          <span className="text-xs">{b.painPreventedCount}</span>

          <span className="text-xs text-muted-foreground font-medium">{t("pages:principles.rules")}</span>
          <span className="text-xs">{a.ruleCount}</span>
          <span className="text-xs">{b.ruleCount}</span>
        </div>
      </CardContent>
    </Card>
  );
}
