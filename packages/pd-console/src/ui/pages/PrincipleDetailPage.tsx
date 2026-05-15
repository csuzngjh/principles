import { useState, useEffect } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { fetchPrincipleDetail } from "../api.js";
import type { PrincipleDetail, RuleItem } from "../api.js";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card.js";
import { Badge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import { Skeleton } from "../components/ui/skeleton.js";
import { ProgressBar, ValueScoreBar, AdherenceBar } from "../components/ui/progress-bar.js";
import { MarkdownRenderer, CollapsibleSection, TruncatedText } from "../components/ui/markdown.js";
import {
  ArrowLeft,
  ChevronRight,
  Copy,
  Check,
  Share2,
  Shield,
  AlertTriangle,
  Clock,
  Zap,
  Target,
  FileText,
} from "lucide-react";
import { cn } from "../../lib/utils.js";

type PrincipleStatus = PrincipleDetail["status"];
type PrinciplePriority = PrincipleDetail["priority"];
type PrincipleScope = PrincipleDetail["scope"];

const STATUS_COLORS: Record<PrincipleStatus, string> = {
  candidate: "text-amber-500",
  probation: "text-blue-500",
  active: "text-primary",
  deprecated: "text-destructive",
  archived: "text-muted-foreground",
};

const STATUS_BG: Record<PrincipleStatus, string> = {
  candidate: "bg-amber-50 dark:bg-amber-950/20",
  probation: "bg-blue-50 dark:bg-blue-950/20",
  active: "bg-primary/10",
  deprecated: "bg-destructive/10",
  archived: "bg-muted",
};

const PRIORITY_COLORS: Record<PrinciplePriority, string> = {
  P0: "text-destructive",
  P1: "text-amber-500",
  P2: "text-muted-foreground",
};

const ENFORCEMENT_COLORS: Record<string, string> = {
  block: "text-destructive",
  warn: "text-amber-500",
  log: "text-muted-foreground",
};

const RULE_TYPE_LABELS: Record<string, string> = {
  hook: "Hook",
  gate: "Gate",
  skill: "Skill",
  lora: "LoRA",
  test: "Test",
  prompt: "Prompt",
};

interface MetaCardProps {
  label: string;
  value: string | number | null | undefined;
  icon: React.ReactNode;
  bgClass?: string;
}

function MetaCard({ label, value, icon, bgClass = "" }: MetaCardProps) {
  return (
    <div className={cn("p-4 rounded-lg border border-border", bgClass)}>
      <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
        {icon}
        <span>{label}</span>
      </div>
      <div className="text-sm font-medium">
        {value !== null && value !== undefined && value !== "" ? String(value) : "—"}
      </div>
    </div>
  );
}

interface RuleCardProps {
  rule: RuleItem;
}

function RuleCard({ rule }: RuleCardProps) {
  const { t } = useTranslation();

  return (
    <div className="p-4 rounded-lg border border-border bg-card">
      <div className="flex items-center gap-3 mb-3">
        <Badge variant="outline" className="text-xs">
          {RULE_TYPE_LABELS[rule.type] ?? rule.type}
        </Badge>
        <Badge
          variant="outline"
          className={cn("text-xs", ENFORCEMENT_COLORS[rule.enforcement] ?? "")}
        >
          {rule.enforcement.toUpperCase()}
        </Badge>
        <Badge variant="secondary" className="text-xs">
          {rule.status}
        </Badge>
        <span className="text-sm font-medium ml-auto">{rule.name || rule.id}</span>
      </div>

      {rule.description && (
        <div className="text-xs text-muted-foreground mb-3">
          <MarkdownRenderer content={rule.description} />
        </div>
      )}

      <div className="space-y-2">
        {rule.triggerCondition && (
          <div className="flex items-start gap-2">
            <Target className="h-3 w-3 mt-0.5 text-muted-foreground flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <span className="text-xs text-muted-foreground font-medium">
                {t("pages:principles.triggerCondition")}:
              </span>
              <TruncatedText text={rule.triggerCondition} maxLines={3} className="text-xs text-foreground break-all" />
            </div>
          </div>
        )}
        {rule.action && (
          <div className="flex items-start gap-2">
            <Zap className="h-3 w-3 mt-0.5 text-muted-foreground flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <span className="text-xs text-muted-foreground font-medium">
                {t("pages:principles.action")}:
              </span>
              <TruncatedText text={rule.action} maxLines={3} className="text-xs text-foreground break-all" />
            </div>
          </div>
        )}
      </div>

      {(rule.coverageRate > 0 || rule.falsePositiveRate > 0) && (
        <div className="flex gap-4 mt-3 pt-3 border-t border-border">
          <div className="flex-1">
            <div className="text-xs text-muted-foreground mb-1">
              {t("pages:principles.coverageRate")}
            </div>
            <ProgressBar value={rule.coverageRate * 100} max={100} size="sm" showLabel />
          </div>
          <div className="flex-1">
            <div className="text-xs text-muted-foreground mb-1">
              {t("pages:principles.falsePositiveRate")}
            </div>
            <ProgressBar
              value={rule.falsePositiveRate * 100}
              max={100}
              size="sm"
              showLabel
            />
          </div>
        </div>
      )}
    </div>
  );
}

function NotFoundPage({ principleId }: { principleId: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  return (
    <div className="flex flex-col items-center justify-center py-16">
      <div className="w-16 h-16 rounded-full bg-destructive/10 flex items-center justify-center mb-4">
        <AlertTriangle className="h-8 w-8 text-destructive" />
      </div>
      <h2 className="text-xl font-semibold mb-2">{t("pages:principles.notFound")}</h2>
      <p className="text-sm text-muted-foreground mb-6">
        {t("pages:principles.notFoundDescription", { id: principleId })}
      </p>
      <div className="flex gap-3">
        <Button variant="outline" onClick={() => navigate("/principles")}>
          <ArrowLeft className="h-4 w-4 mr-2" />
          {t("pages:principles.backToList")}
        </Button>
        <Button onClick={() => navigate("/principles")}>
          {t("pages:principles.browsePrinciples")}
        </Button>
      </div>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Skeleton className="h-10 w-10" />
        <Skeleton className="h-8 w-48" />
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-24 w-full" />
        ))}
      </div>
      <Skeleton className="h-32 w-full" />
      <div className="space-y-3">
        {Array.from({ length: 2 }).map((_, i) => (
          <Skeleton key={i} className="h-32 w-full" />
        ))}
      </div>
    </div>
  );
}

export function PrincipleDetailPage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [principle, setPrinciple] = useState<PrincipleDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!id) {
      setError("No principle ID provided");
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setError(null);

    fetchPrincipleDetail(id)
      .then((result) => {
        if (controller.signal.aborted) return;
        if (result.success && result.data) {
          setPrinciple(result.data.principle);
        } else if (!result.success) {
          setError(result.error || "Failed to load principle");
        } else {
          setError("Failed to load principle");
        }
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : "Unknown error");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [id]);

  const handleCopyLink = () => {
    const url = `${window.location.origin}${window.location.pathname}#principles/${id}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {
      // clipboard API not available (e.g. non-HTTPS)
    });
  };

  const handleShare = async () => {
    if (!id) return;

    const url = `${window.location.origin}${window.location.pathname}#principles/${id}`;

    if (navigator.share) {
      try {
        await navigator.share({
          title: `${t("pages:principles.title")} - ${id}`,
          text: principle?.text || id,
          url,
        });
      } catch {
        // User cancelled or share failed
      }
    } else {
      handleCopyLink();
    }
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" className="mb-2" disabled>
          <ArrowLeft className="h-4 w-4 mr-2" />
          {t("pages:principles.backToList")}
        </Button>
        <LoadingSkeleton />
      </div>
    );
  }

  if (error || !principle) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" className="mb-2" onClick={() => navigate("/principles")}>
          <ArrowLeft className="h-4 w-4 mr-2" />
          {t("pages:principles.backToList")}
        </Button>
        <NotFoundPage principleId={id || "unknown"} />
      </div>
    );
  }

  const bgClass = STATUS_BG[principle.status];

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-sm text-muted-foreground mb-2">
        <Link
          to="/principles"
          className="hover:text-foreground transition-colors flex items-center gap-1"
        >
          {t("pages:principles.title")}
        </Link>
        <ChevronRight className="h-4 w-4" />
        <span className="text-foreground">{principle.id}</span>
      </div>

      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <Badge variant="outline" className={cn("text-sm px-3 py-1", STATUS_COLORS[principle.status])}>
            {principle.status}
          </Badge>
          <Badge variant="outline" className={cn("text-sm px-3 py-1", PRIORITY_COLORS[principle.priority])}>
            {principle.priority}
          </Badge>
          {principle.scope === "domain" && principle.domain && (
            <Badge variant="secondary" className="text-sm px-3 py-1">
              {principle.domain}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={handleCopyLink}>
            {copied ? (
              <>
                <Check className="h-4 w-4 mr-1" />
                {t("common:copied")}
              </>
            ) : (
              <>
                <Copy className="h-4 w-4 mr-1" />
                {t("pages:principles.copyLink")}
              </>
            )}
          </Button>
          <Button variant="outline" size="sm" onClick={handleShare}>
            <Share2 className="h-4 w-4 mr-1" />
            {t("pages:principles.share")}
          </Button>
        </div>
      </div>

      <Card className={cn("border-l-4", bgClass.includes("primary") ? "border-l-primary" : "")}>
        <CardContent className="p-6">
          <div className="flex items-start gap-3 mb-4">
            <FileText className="h-5 w-5 text-muted-foreground mt-0.5" />
            <div>
              <div className="mb-2">
                <MarkdownRenderer content={principle.text} />
              </div>
              <div className="flex items-center gap-4 text-xs text-muted-foreground">
                <span className="flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  {t("pages:principles.createdAt")}:{" "}
                  {principle.createdAt
                    ? new Date(principle.createdAt).toLocaleDateString()
                    : "—"}
                </span>
                <span>
                  {t("pages:principles.updatedAt")}:{" "}
                  {principle.updatedAt
                    ? new Date(principle.updatedAt).toLocaleDateString()
                    : "—"}
                </span>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <h3 className="text-sm font-medium mb-3">{t("pages:principles.valueMetrics")}</h3>
              <div className="space-y-3">
                <div>
                  <div className="text-xs text-muted-foreground mb-1">
                    {t("pages:principles.valueScore")}
                  </div>
                  <ValueScoreBar valueScore={principle.valueScore} />
                </div>
                <div>
                  <div className="text-xs text-muted-foreground mb-1">
                    {t("pages:principles.adherence")}
                  </div>
                  <AdherenceBar adherenceRate={principle.adherenceRate} />
                </div>
                <div>
                  <div className="text-xs text-muted-foreground mb-1">
                    {t("pages:principles.painPrevented")}
                  </div>
                  <div className="text-2xl font-bold">{principle.painPreventedCount}</div>
                </div>
              </div>
            </div>

            <div>
              <h3 className="text-sm font-medium mb-3">{t("pages:principles.quickStats")}</h3>
              <div className="grid grid-cols-2 gap-3">
                <div className="p-3 rounded-lg bg-muted/50">
                  <div className="text-xs text-muted-foreground">
                    {t("pages:principles.ruleCount")}
                  </div>
                  <div className="text-xl font-bold flex items-center gap-1">
                    <Shield className="h-4 w-4" />
                    {principle.ruleCount}
                  </div>
                </div>
                <div className="p-3 rounded-lg bg-muted/50">
                  <div className="text-xs text-muted-foreground">
                    {t("pages:principles.conflictCount")}
                  </div>
                  <div className="text-xl font-bold flex items-center gap-1">
                    <AlertTriangle className="h-4 w-4" />
                    {principle.conflictsWithPrincipleIds.length}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <MetaCard
          label={t("pages:principles.triggerPattern")}
          value={principle.triggerPattern}
          icon={<Target className="h-3 w-3" />}
          bgClass={bgClass}
        />
        <MetaCard
          label={t("pages:principles.action")}
          value={principle.action}
          icon={<Zap className="h-3 w-3" />}
          bgClass={bgClass}
        />
        <MetaCard
          label={t("pages:principles.evaluability")}
          value={principle.evaluability}
          icon={<Check className="h-3 w-3" />}
          bgClass={bgClass}
        />
        <MetaCard
          label={t("pages:principles.scope")}
          value={principle.scope + (principle.domain ? ` / ${principle.domain}` : "")}
          icon={<FileText className="h-3 w-3" />}
          bgClass={bgClass}
        />
      </div>

      {principle.coreAxiomId && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">{t("pages:principles.coreAxiom")}</CardTitle>
          </CardHeader>
          <CardContent>
            <Badge variant="outline">{principle.coreAxiomId}</Badge>
          </CardContent>
        </Card>
      )}

      {principle.supersedesPrincipleId && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">{t("pages:principles.supersedes")}</CardTitle>
          </CardHeader>
          <CardContent>
            <Link
              to={`/principles/${principle.supersedesPrincipleId}`}
              className="text-sm text-primary hover:underline"
            >
              {principle.supersedesPrincipleId}
            </Link>
          </CardContent>
        </Card>
      )}

      {principle.conflictsWithPrincipleIds.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-destructive" />
              {t("pages:principles.conflictsWith")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {principle.conflictsWithPrincipleIds.map((conflictId) => (
                <Link
                  key={conflictId}
                  to={`/principles/${conflictId}`}
                  className={cn(
                    "px-3 py-1 rounded-full text-sm border transition-colors",
                    "border-destructive/30 bg-destructive/5 text-destructive",
                    "hover:bg-destructive/10 hover:border-destructive/50"
                  )}
                >
                  {conflictId}
                </Link>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {principle.lastPainPreventedAt && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Clock className="h-4 w-4" />
              {t("pages:principles.lastPainPrevented")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm">
              {new Date(principle.lastPainPreventedAt).toLocaleString()}
            </p>
          </CardContent>
        </Card>
      )}

      <CollapsibleSection
        title={`${t("pages:principles.associatedRules")} (${principle.rules.length})`}
        defaultOpen={principle.rules.length <= 3}
      >
        {principle.rules.length === 0 ? (
          <div className="text-center py-6">
            <Shield className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">
              {t("pages:principles.noRules")}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {principle.rules.map((rule) => (
              <RuleCard key={rule.id} rule={rule} />
            ))}
          </div>
        )}
      </CollapsibleSection>

      {principle.derivedFromPainIds.length > 0 && (
        <CollapsibleSection
          title={`${t("pages:principles.derivedFromPain")} (${principle.derivedFromPainIds.length})`}
          defaultOpen={false}
        >
          <div className="flex flex-wrap gap-2">
            {principle.derivedFromPainIds.map((painId) => (
              <Badge key={painId} variant="secondary" className="text-xs">
                {painId}
              </Badge>
            ))}
          </div>
        </CollapsibleSection>
      )}
    </div>
  );
}
